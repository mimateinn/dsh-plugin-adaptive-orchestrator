> Read before implementation | Purpose: approved architecture and acceptance contract | Limit: 50 KB

# Adaptive Orchestrator for DSH — Design Specification

**Status:** Approved design; implementation pending  
**Date:** 2026-08-30  
**Audience:** DSH maintainers, plugin contributors, and operators

## Contents

1. Summary, goals, and non-goals
2. User experience
3. Architecture and contracts
4. Routing and adaptive concurrency
5. Model discovery and failure behavior
6. Security, testing, delivery, and decisions

## 1. Summary

dsh-plugin-adaptive-orchestrator turns a user-selected model into a dedicated captain and automatically routes all execution work to subscription-backed worker models. The user enables or disables the behavior once in Settings. No Skill invocation or per-task routing command is required.

The captain is immutable for the life of its session unless the user changes it. The plugin never upgrades, downgrades, or replaces the captain. While enabled, the captain may set direction, decompose work, define dependencies, supervise workers, resolve decisions, integrate results, and communicate with the user. It delegates code reading, external research, design production, implementation, test execution, and independent review.

Worker selection uses capability, safety policy, subscription usage, reset deadlines, observed health, and latency. Remaining capacity near reset creates pressure to execute more independent work in parallel, especially on user-favored Codex and Grok routes, but quota never bypasses capability or safety gates.

## 2. Goals

1. Apply orchestration globally after one Settings toggle is enabled.
2. Preserve the user-selected captain model without automatic escalation.
3. Require the captain to delegate execution through enforceable tool policy, not prompt text alone.
4. Read normalized subscription usage without accessing OAuth secrets.
5. Route workers by task capability, data policy, quota headroom, reset urgency, health, and latency.
6. Increase worker concurrency progressively when useful capacity would otherwise expire.
7. Share one concurrency governor across ordinary subagents and AgentTeams.
8. Discover new worker models, quarantine them, evaluate them with low-risk probes, and promote them only with evidence.
9. Keep every routing and scaling decision visible and auditable.
10. Fail safely when usage data, hooks, accounts, models, or workers fail.

## 3. Non-goals

- Automatically changing or escalating the captain.
- Treating concurrency as a substitute for quota or rate-limit accounting.
- Copying OAuth or provider implementation code from dsh-plugin-subscriptions.
- Reading or storing subscription access or refresh tokens.
- Silently sending sensitive work outside its model allowlist.
- Claiming global enforcement when required DSH capabilities are unavailable.
- Building a distributed scheduler or general external AI gateway in the first release.

## 4. User experience

### Global control

Settings exposes one **Adaptive orchestration** switch. On applies the policy to all newly created top-level work. Off bypasses the policy and restores ordinary DSH behavior. The durable global setting requires no Skill, profile, prompt prefix, or project file.

### Captain

The captain is whichever provider/model the user selects for the top-level conversation. Settings displays it but provides no automatic escalation.

When enabled, the captain can use planning, task, delegation, status, messaging, and result-integration tools. Direct filesystem mutation, codebase exploration, shell/test execution, browser research, design production, and review sign-off are denied. Denials explain that the action must be delegated and never suggest a shell or nested-tool workaround.

### Data policy

Cross-provider worker routing is allowed by default. Optional **Sensitive mode** restricts workers to a user-selected allowlist from the complete DSH model directory. If the allowlist is empty or all selected models are unavailable, routing fails closed.

### Operational visibility

Settings shows normalized remaining percentage, reset time, observation age, source/confidence, health/cooldown, learned safe slots, routing pressure, and recent route decisions with concise reason codes for each account/model quota class.

## 5. Architecture

### Deliverables and boundaries

The solution has two deliverables:

1. An independent plugin repository containing policy, quota, registry, routing, scheduling, settings UI, audit, and evaluation logic.
2. Thin generic DSH core hooks. Core contains no subscription-specific weights or routing policy.

Disabling or uninstalling the plugin restores normal DSH behavior.

### Components

| Component | Responsibility | Dependencies |
|---|---|---|
| OrchestrationPolicy | Global enablement, captain role, tool allow/deny | DSH system-prompt and pre-execute hooks |
| UsageSource | Normalized quota snapshots | Typed subscription usage service |
| ModelRegistry | Model/account capabilities and evaluation state | DSH model directory |
| RoutePlanner | Filter and score eligible workers | Registry, quota, safety, health |
| DelegationGovernor | Global, lane, provider, and account leases | Shared DSH scheduler hook |
| HealthController | Safe slots, cooldown, circuit state | Outcomes, Retry-After, latency |
| ModelEvaluator | Quarantine and probe new models | Low-risk deterministic probes |
| AuditStore | Bounded route and scaling explanations | Settings storage |
| SettingsClient | Toggle, allowlist, limits, live status | Typed RPC and client slots |

### Existing and required DSH seams

Packaged DSH directly verifies two candidate host seams:

- ctx.systemPrompt.section contributes scoped captain guidance.
- tools/pre-execute runs before prepared tool execution. Packaged code also shows nested run_code dispatch re-entering tool preparation.

These observations are not yet a global authorization guarantee. Implementation must build and execute a capability matrix for native, nested run_code, dynamic, MCP, and future tool entry points. Any entry point not proven to pass the pre-execute policy is unsupported and denied by disabling global mode with a visible compatibility error; prompt guidance alone must never be reported as enforcement.

A durable, immutable top-level role marker is required. Captain identity must never be inferred from labels, prompt strings, or tool availability.

#### Reproducible seam evidence

The initial evidence baseline is DSH Desktop 2.0.3 on Windows. The inspected packaged artifact is C:\Program Files\DSH Desktop\resources\app.asar with SHA-256 DA4147D0D638B138EE5929CB07714AE520FB18A8DA9741D251E6F0BD70BA5BDA. Evidence locations in the packaged JavaScript are:

- @deepseek-ai/dsh-system-prompt/lib/index.js: SystemPrompt service and section contribution.
- @deepseek-ai/dsh-tool-subagent/lib/index.js around 289-292: a concrete ctx.systemPrompt.section call.
- @deepseek-ai/dsh-tools/lib/index.js around 2986-2994 and 3086-3142: tool preparation/policy pipeline; around 3105: tools/pre-execute waterfall.
- @deepseek-ai/dsh-tools/lib/index.js around 1220 and 1271-1273: nested run_code tool calls re-enter preparation/dispatch.
- @deepseek-ai/dsh-subagent/lib/index.js around 2381 and 2564-2621: SubagentRuntime and named-provider dispatch.

Line numbers identify this exact artifact only. Source-checkout implementation must replace packaged evidence with source symbols, tests, and a new compatibility record. AgentTeams shared scheduling remains proposed and unverified.

To guarantee shared concurrency across subagents and AgentTeams, core needs a generic DelegationScheduler service with an acquire request containing delegation kind, parent agent ID, provider/model, interactive or background priority, and AbortSignal. It returns an idempotent lease. Subagent creation/continuation and AgentTeams member spawn/ready-task claim must acquire a lease. Completed, failed, cancelled, paused, removed, and missing paths must release it exactly once.

### Subscription usage contract

The plugin consumes a public typed service and never reads another plugin's private files. Each QuotaSnapshot includes provider, account, optional model, quota class, usedPercent, resetsAt, observedAt, plan, supported, source, and confidence.

The installed subscriptions plugin already normalizes usage into supported, plan, and windows with usedPercent and resetsAt. Initial work should propose a public service upstream. A temporary adapter may call documented typed RPC, but must not import private files or access credentials.

### Public contracts and validation

All plugin/core boundaries are typed and runtime-validated. Invalid settings or RPC payloads return structured validation errors without mutation. Invalid usage snapshots are dropped individually and reported as redacted diagnostics. Route planning is pure and returns either a RouteDecision with reason codes or a typed NoEligibleRoute result. Evaluation transitions require the current model-state revision. Audit append failure must not change routing state, but marks observability degraded. Scheduler acquire is atomic and returns a lease or typed rejection; release is idempotent. Host-hook registration is capability-negotiated at startup, and any required capability mismatch makes global mode unavailable.

Trust-boundary schemas use schemaVersion=1 and the following normalized contracts. Strings are UTF-8, trimmed, and 1..200 characters unless stated otherwise; timestamps are RFC 3339 UTC; percentages are finite 0..100; normalized scores are finite 0..1; durations are integer milliseconds. Unknown object keys are rejected in settings/RPC writes and tolerated only in provider-read metadata where explicitly versioned.

| Contract | Required fields | Optional fields and limits |
|---|---|---|
| GlobalSettings | schemaVersion=1, revision:uint64, enabled:boolean, sensitive:SensitivePolicy, caps:Caps | providerBurnWeights map 0..4; defaults codex=2, grok=2, others=1; burnWeight 0..4 default 1; auditRetentionDays 1..30 default 7 |
| Caps | baseSlots:uint 1..64 default 1, globalHardCap:uint 2..64 default 8, perProviderHardCap:uint 1..64 default 4, perAccountHardCap:uint 1..64 default 4, perModelHardCap:uint 1..64 default 4, interactiveReserve:uint 1..64 default 1, backgroundReserve:uint 1..64 default 1, queueCapacity:uint 1..4096 default 256, configuredHorizonMs:uint 3600000..2678400000 default 604800000 | baseSlots and each per-scope cap <= globalHardCap; reserve sum <= globalHardCap |
| SensitivePolicy | enabled:boolean, modelAllowlist:string[] | unique IDs, max 256; enabled with empty list is valid fail-closed state |
| QuotaSnapshot | schemaVersion=1, provider, account, quotaClass, supported:boolean, observedAt, source, confidence | model, plan, usedPercent, resetsAt; confidence high/medium/low; high fresh <=5m, medium <=30m, low/stale >30m |
| WorkerCandidate | routeId, provider, account, model, taskClass, capabilityFit, healthConfidence, expectedLatencyMs, maximumContextTokens:uint | quota snapshots max 32; tools/modalities unique arrays max 128; maximumContextTokens 1..10000000 from the trusted normalized DSH model directory |
| RouteDecision | routeId, score, reasonCodes:string[], decidedAt, inputRevision | max 32 reason codes; score finite >=0 |
| ModelEvaluation | schemaVersion=1, modelId, modelVersion, taskClass, state, probeCorpusVersion, revision:uint64, evidenceAt, outcomes:EvaluationOutcome[] | identity key is modelId+modelVersion+taskClass; state quarantined/evaluating/qualified/disabled/regressed; outcomes max 100 |
| EvaluationOutcome | schemaVersion=1, modelId, modelVersion, taskClass, probeId, probeCorpusVersion, sequence:uint64, startedAt, finishedAt, result, latencyMs:uint, mandatoryTool:boolean, corpusHash | result pass/fail/safety-violation; encoded output stores no model response; latest 100 ordered by finishedAt+sequence |
| RouteRequirements | schemaVersion=1, taskClass, requiredCapabilityIds:string[], requiredToolIds:string[], requiredModalities:string[], inputContextTokens:uint, expectedOutputTokens:uint, contextSafetyReserveTokens:uint, minimumContextTokens:uint, sensitive:boolean, allowedModelIds:string[] | each token field 0..10000000; minimumContextTokens must equal their checked sum; arrays unique max 128; allowedModelIds max 256 |
| QueueRecord | schemaVersion=1, requestId, payloadHash, attemptId, kind, routeRequirements:RouteRequirements, lane, enqueueSequence:uint64, createdAt, state, settingsRevision:uint64, deficitCost:uint | state queued/cancelled/acquired; deficitCost default 1, range 1..64 |
| AuditEvent | eventId, timestamp, kind, reasonCodes, integrity | normalizedMetrics object only; encoded record max 16 KB |
| DelegationAcquire | requestId, attemptId, kind, parentAgentId, provider, model, lane, createdAt | kind subagent/agent-team-member; lane interactive/background |
| DelegationLeaseRecord | leaseId, requestId, attemptId, state, ownerPid, acquiredAt, heartbeatAt, revision | state pending/active/orphaned/released |
| DelegationOutcome | schemaVersion=1, leaseId, attemptId, sequence:uint64, phase, result, finishedAt | phase pre-dispatch/provider; result success/provider-error/rate-limited/timed-out/user-cancelled/paused/removed/missing; latencyMs:uint required for every provider-phase result; statusCode:uint 100..599 required for HTTP responses; retryAfterMs:uint required when a valid Retry-After/reset header exists; pre-dispatch outcomes never enter safe-slot statistics |
| DispatchFence | schemaVersion=1, fenceId, leaseId, attemptId, state, settingsRevision, modelRevision, createdAt, expiresAt, revision | state armed/consumed/revoked/expired; expires after 30 seconds if unconsumed |
| SchedulerState | schemaVersion=1, revision:uint64, schedulerEpoch:string UUID, bootId:string UUID, persistedAt:timestamp, enqueueSequence:uint64, outcomeSequence:uint64, triggerSequence:uint64, failureSequenceByRoute:Record<routeId,uint64>, laneDeficits:Record<lane,uint 0..64>, laneStarvation:Record<lane,{wallDeadline,remainingMs 0..30000}>, safeSlotStateByRoute:Record<routeId,SafeSlotState>, queueRecords:QueueRecord[], leases:DelegationLeaseRecord[], fences:DispatchFence[] | arrays ordered by stable IDs/sequences; records serialized with lexicographically sorted keys |
| SafeSlotState | schemaVersion=1, routeId, safeSlots:uint 0..64, ewmaLatencyMs:number, consecutiveSuccesses:uint, failureSequence:uint64, lastIncreaseAt:timestamp, cooldownWallDeadline:timestamp|null, cooldownRemainingMs:uint 0..900000, persistedBootId:string UUID, outcomes:DelegationOutcome[] | latest 20 provider-phase outcomes ordered by finishedAt+sequence |
| CompatibilityReport | dshVersion, artifactHash, checkedAt, capabilities, supported:boolean | failures max 64, retained until artifact/version changes |

Validation returns code, JSON-pointer path, and safe message. Provider/account IDs are normalized opaque identifiers and never logged raw. Settings writes use compare-and-swap revision; stale revision returns Conflict. Schema versions greater than supported fail compatibility negotiation. Route requirements, evaluation outcomes, queue records, and capability IDs are versioned before hashing. Canonical serialization is UTF-8 RFC 8785 JSON Canonicalization Scheme; payloadHash is SHA-256 over canonical AdmissionPayload={schemaVersion,requestId,attemptId,kind,parentAgentId,lane,routeRequirements,deficitCost}; it excludes only createdAt and includes every field that can change routing or authorization, and every persisted Record key is serialized lexicographically.

#### Authorization capability matrix

| Entry path | Captain policy enabled | Worker | Required proof | Unsupported behavior |
|---|---|---|---|---|
| Native DSH tools | Allow only explicit orchestration allowlist; deny filesystem/shell/research/design/review | Existing worker scope | pre-execute integration test | Global mode unavailable |
| Nested run_code calls | Re-evaluate every nested call; same allowlist | Existing worker scope | nested dispatch integration test | Global mode unavailable |
| Dynamic plugin tools | Unknown tool deny; explicit orchestration capability may be registered | Existing worker scope | dynamic registration test | Tool remains captain-denied |
| MCP tools | Unknown tool deny; no name-based trust | Existing worker scope | MCP dispatch integration test | MCP remains captain-denied |
| Future/unclassified entry | Deny | Existing DSH policy | compatibility probe | Global mode reports unsupported if it can bypass policy |

Workers receive an immutable delegationRole=worker marker created only by the trusted host runtime and bound to agent ID plus durable descriptor. Captain is delegationRole=captain. RPC/settings input cannot set either marker. Core propagates the marker to nested dispatch and rejects mutation or descriptor mismatch. Orchestration capabilities are registered by trusted host plugins as stable IDs mapped to specific tool registrations; untrusted dynamic/MCP metadata cannot self-assert them. Worker authorization remains the existing DSH worker scope plus the original parent delegation ceiling; this plugin never grants additional capabilities.

The captain allowlist is capability-based and minimally includes planning, ask-user, todo, subagent/AgentTeams creation and control, status, messaging, and result collection. A tool name alone cannot grant a capability.

## 6. Routing policy

### Eligibility

The trusted DSH request assembler calculates inputContextTokens from the exact encoded system prompt, conversation/history, tool schemas, task payload, and attachments using the selected provider model tokenizer. expectedOutputTokens is the requested max output tokens. contextSafetyReserveTokens is max(1024, ceil((inputContextTokens+expectedOutputTokens)*0.05)). minimumContextTokens is their checked integer sum; overflow or unavailable authoritative tokenizer makes the candidate unsupported rather than guessed. Recompute after route-specific prompt/tool encoding before fence creation.

A route is eligible only when global orchestration is enabled, it is authenticated/enabled, the model passed the required capability class, sensitive policy permits it, no hard exhaustion/auth failure/open circuit applies, required tools/modalities are supported, and WorkerCandidate.maximumContextTokens >= RouteRequirements.minimumContextTokens. Quota cannot rescue a route that fails capability or safety.

### Quota state

State is keyed by provider, account, optional model, and quota class. Multiple provider windows remain separate. A fresh window with remaining <=5% is a hard quota threshold and makes that route unavailable for new work. Every snapshot carries observedAt, source, and confidence. High and medium snapshots participate in headroom and pressure; low/stale snapshots contribute zero pressure and quotaHeadroom=0.5, so they are a sorting hint rather than exact allowance. Unsupported or absent usage also uses quotaHeadroom=0.5. Clock-invalid reset timestamps invalidate only that window.

### Reset pressure

For a fresh supported window:

    remaining = clamp(1 - usedPercent / 100, 0, 1)
    timeRatio = clamp((resetsAt - now) / configuredHorizon, 0, 1)
    resetUrgency = 1 - timeRatio
    burnPressure = remaining * resetUrgency

Provider weight defaults are Codex=2, Grok=2, and every other provider=1, configurable 0..4. Per-window weightedPressure is clamp(burnPressure * providerWeight / 2, 0, 1). For a route, the tightest remaining fresh window sets quotaHeadroom; route burnPressure is the maximum weightedPressure across fresh applicable windows. This intentionally favors capacity most likely to expire rather than averaging urgency away. Preference never bypasses filters.

### Route score

    score = capabilityFit
          * healthConfidence
          * quotaHeadroom
          * (1 + burnWeight * burnPressure)
          / expectedLatency

capabilityFit and healthConfidence are 0..1. quotaHeadroom is the minimum remaining fraction across fresh applicable windows, or 0.5 when unknown. expectedLatency is clamp(expectedLatencyMs / 1000, 0.1, 600). burnWeight defaults to 1 and is configurable 0..4. A zero capabilityFit or healthConfidence makes the route ineligible. Sort descending score, then descending capabilityFit, then ascending expectedLatencyMs, then lexicographic routeId for stable ties. Emit reason codes for every filter and score factor.

### Reservation and settlement

Release 1 uses abstract work permits, not fabricated token accounting. One active worker consumes one provider/account/model permit. The governor atomically acquires the permit immediately before a run becomes active and releases it on every terminal or parked transition. Provider-reported usage may update quota snapshots after completion, but missing token counts never create guessed debit values. Future token reservations require a provider contract exposing comparable estimated and actual units. Cancellation, worker loss, and expired durable attempts reclaim permits idempotently.

## 7. Adaptive concurrency

Quota totals and rate limits are different. Quota/reset creates acceleration pressure; observed 429s, latency, errors, and successes define safe concurrency.

    pressureSlots = baseSlots + floor(maxEligibleBurnPressure * (globalHardCap - baseSlots))
    desiredWorkers = min(
      readyIndependentTasks,
      globalHardCap,
      aggregateSafeCapacity,
      pressureSlots
    )

baseSlots is the configured minimum useful concurrency, bounded to at least one when ready work exists. Defaults are baseSlots=1, globalHardCap=8, perProviderHardCap=4, perAccountHardCap=4, perModelHardCap=4, interactiveReserve=1, and backgroundReserve=1. Integer caps must be 1..64 and reservations cannot sum above globalHardCap. configuredHorizon defaults to the applicable quota-window duration when known, otherwise seven days, bounded from one hour to 31 days.

aggregateSafeCapacity is computed without double counting: iterate eligible routes in stable routeId order and tentatively add one slot at a time up to each route SafeSlotState.safeSlots, accepting a slot only while the resulting allocation remains within perModelHardCap, perAccountHardCap, perProviderHardCap, and globalHardCap. Repeat round-robin passes until no slot can be added; the accepted slot count is aggregateSafeCapacity. This is capacity planning only; WDRR still decides which queued records receive those slots.

For each eligible route, compute route burn pressure as defined above; maxEligibleBurnPressure is the maximum across eligible routes, clamped to 0..1. Unknown or stale quota contributes zero burn pressure, so routing remains capability/health based at baseSlots rather than inventing urgency.

Allocation is deterministic. Effective lane reservations equal the configured interactiveReserve/backgroundReserve when that lane has queued work; an empty lane lends all reserved slots to the other lane until new work arrives. Reservations are floors, not separate capacity, and their validated sum never exceeds globalHardCap. Precedence is globalHardCap -> active lane floor -> perProviderHardCap -> perAccountHardCap -> perModelHardCap -> learned model safe slots -> pressureSlots. All are intersections, never additive.

Within available capacity use weighted deficit round robin with persistent per-lane deficit counters. At each scheduling tick, add quantum 2 to interactive and 1 to background; every QueueRecord has deficitCost default 1. Visit lanes in stable interactive/background order. Within a lane, scan queued records in enqueueSequence order and start the first record whose cost is covered and whose route caps permit acquisition. Temporarily cap-blocked or ineligible records remain in place and do not block later records; permanently invalid records are cancelled with a reason code. Subtract cost only after successful fence creation. After each start, restart the scan at interactive then background and continue within the same serialized tick until desiredWorkers is reached or a full two-lane pass starts nothing. Quantum is added once per tick, not per repeated scan. Unused deficit persists across ticks and restart, capped at 64. Empty lanes reset deficit to zero. A scheduling tick is a serialized SchedulerState compare-and-swap triggered by enqueue, cancel, release, cooldown expiry, settings/model revision, or the once-per-minute scale timer; simultaneous triggers retry against the newer revision in stable trigger sequence order. A starvation promotion occurs before quantum addition: if a queued lane has had no start for 30 seconds of monotonic elapsed time while another starts work, reserve its next available global slot and inspect its eligible head first; it still obeys provider/account/model caps. Persist elapsed starvation deadline as wall deadline plus boot-relative remaining duration and clamp to 0..30 seconds after restart.

Provider adapters use one canonical mapping before persistence: a completed provider response without provider error -> success; HTTP 429 or an explicit provider rate-limit code -> rate-limited regardless of body; an adapter timeout before any terminal response -> timed-out; any other provider/API/network failure after dispatch -> provider-error; user cancellation wins only when cancellation is observed before a provider terminal event, otherwise the provider terminal result wins. latencyMs is monotonic dispatch-to-terminal elapsed time. Retry-After accepts delta-seconds or HTTP-date, clamps 0..900000 ms, and invalid values are treated as absent.

An eligible outcome is a DelegationOutcome with phase=provider and result one of success, provider-error, rate-limited, or timed-out; pre-dispatch, user-cancelled, paused, removed, and missing outcomes are excluded. Maintain the latest 20 eligible outcomes. Success means result=success. Error denominator is all eligible outcomes in the examined window; any non-success is an error except 429, which is additionally a rate-limit signal. Five-consecutive-success count resets on every non-success.

Order outcomes by finishedAt then stable sequence. Initialize latency baseline from the first successful latency. For each later success, evaluate the current outcome against the pre-update baseline, then update EWMA as 0.2*newLatency + 0.8*previousBaseline. Compute nearest-rank p95 over available successful latencies; with fewer than five successes, safe slots cannot increase. Start at one safe slot for an unseen route. Increase by one only after five consecutive successes, no 429 in the last 20 outcomes, error rate below 5%, and p95 no more than 1.5 times baseline. Evaluate increases no more than once per minute and cap by model, account, provider, and global hard caps.

Scale in immediately by half, rounded down to at least one, on 429, error rate at or above 20% in the last ten outcomes, p95 latency above twice baseline, hard quota threshold, lane starvation, or reduced hard cap. A Retry-After cooldown sets safe slots to zero until eligible; without a header use bounded exponential backoff starting at 30 seconds and capped at 15 minutes with full jitter. Jitter uses an injected deterministic PRNG seeded by SHA-256(routeId + failureSequence + persisted schedulerEpoch); failureSequence, schedulerEpoch, sampled cooldown wall deadline/remaining duration, persisted boot ID, safe slots, EWMA, outcome ring, and last-increase timestamp are fields of SchedulerState and commit in the same outcome transaction. On the same boot, monotonic remaining duration is authoritative. After restart, compute min(max(cooldownWallDeadline-nowWall,0), persisted cooldownRemainingMs), clamp 0..900000, bind it to the new boot monotonic clock, and persist the new boot ID before scheduling; restart never resamples. After cooldown, half-open at one slot. pressureSlots can request acceleration but never exceeds learned safe slots or hard caps.

The governor enforces global, provider, account, and model maxima; at least one interactive reservation; at least one background reservation when background work exists; weighted fair queueing or deficit round robin; bounded queue length; and cancellation propagation. Concurrency values are configurable, not magic constants.

A lease represents one actively running model invocation, not a queued task, claim, or dormant member. QueueRecord contains requestId, attemptId, delegation kind, route requirements, lane, enqueue sequence, createdAt, state queued/cancelled/acquired, and settingsRevision. Queue admission occurs before acquisition in a bounded durable queue defaulting to 256 entries; requestId is unique. Duplicate admission returns the existing record only when attemptId and canonical payloadHash match; otherwise it returns Conflict and changes nothing. Overflow returns QueueFull and never starts work. The scheduler service is the sole authority for queue and lease state.

Enqueue, cancel, dequeue-plus-lease-acquire, and release are compare-and-swap transactions in one durable store. Dequeue, final settings/model/capability revision check, active-lease persistence, and creation of a single-use dispatch fence commit atomically before provider invocation. The provider adapter must consume the fence in a compare-and-swap immediately before opening the network request; cancel, disable, model removal, unload, or version-skew revokes unconsumed fences. A consumed fence defines an active captured-policy invocation that may finish. Fence consume changes armed to consumed atomically, requires current settings/model/capability revisions, and fails if expired or revoked. On restart, unconsumed armed fences are revoked and their leases released; consumed fences follow active-lease orphan recovery. Fence expiry is 30 seconds. This closes the commit-to-dispatch race without pretending a database transaction can include a network call. Restart first removes cancelled entries, marks ownerless active leases orphaned, reclaims expired orphans, then resumes queue sequence order. Spawned members acquire immediately before invocation; pause/cancel/fail/complete/remove release. Continuation and reassignment use new attempt IDs and acquire new leases.

Lease state is pending -> active -> released or orphaned -> released. Persist the active lease and owner attempt ID atomically before invoking the provider; if persistence fails, invocation does not start. Heartbeats default to every 10 seconds. On process restart, an active record without a live owner becomes orphaned; reclaim after a 30-second grace in one compare-and-swap transaction. A crash after persistence but before invocation therefore temporarily consumes capacity but is safely reclaimed. Release is an idempotent compare-and-swap keyed by lease ID plus attempt ID; stale attempts cannot release newer leases.

## 8. New model discovery

1. Detect additions from the DSH model directory.
2. Put new models in quarantine; do not route production work.
3. Read declared metadata and run low-risk deterministic probes.
4. Compare with active models in the same task class using success, tool support, context behavior, latency, and stability.
5. For each modelId+modelVersion+taskClass identity, require at least five deterministic probes from the same versioned corpus, 100% mandatory-tool checks, at least 80% overall success, and no safety-policy violation before qualification.
6. Record state and evidence date: quarantined, evaluating, qualified, disabled, or regressed. Evidence expires after 30 days or any provider model-version change.
7. Demote after two consecutive mandatory-tool failures, any safety violation, or success below 70% across the latest ten eligible outcomes. Requalification uses the full probe gate, creating hysteresis. Never promote a model to captain.
8. Let the user disable any worker model.

Evaluation uses a configurable daily probe budget defaulting to three invocations per provider and stops when the budget is exhausted. It never handles private production data or spends unbounded subscription capacity.

## 9. Failure behavior

| Failure | Required behavior |
|---|---|
| Global switch off | Bypass plugin policy for new work |
| Required hook unavailable | Fail loud with unsupported-version error |
| Usage source unavailable | Quota unknown; low-pressure capability/health routing |
| Stale snapshot | Reduce confidence; no exact allowance claim |
| HTTP 429 | Respect Retry-After, reduce safe slots, scoped cooldown |
| HTTP 401 or expired account | Disable account until reauthentication |
| Transient 5xx/network | Scoped circuit and half-open probe |
| Worker stalls | Cancel, preserve partial result, split/reassign if safe |
| Sensitive allowlist unavailable | Fail closed |
| Unknown captain tool | Deny by default while policy is active |
| Plugin unload | Stop new contributions without corrupting descriptors/leases |
| Toggle disabled during active work | Existing invocations finish under their captured policy; no new governed work starts |
| Allowlisted model removed mid-run | Active invocation may finish; subsequent acquisition fails closed |
| Audit corruption | Rotate corrupt store, report degraded status, never use it for routing state |
| Wall-clock jump | Re-read deadlines; use monotonic elapsed time for cooldown and lease grace |
| Plugin/core version skew | Capability negotiation fails before global mode can enable |
| Disable or model removal races with acquire | Toggle-off or disallowed/model-removed revision cancels the record and revokes its fence; unrelated compatible revision revalidates and requeues with the new revision |
| Toggle off with queued work | Cancel governed queued entries; active captured-policy invocations may finish |
| Plugin unload with queue/half-open/evaluation work | Stop admission, cancel queued/probe/evaluation entries, release non-running leases, then unregister hooks |

## 10. Security and privacy

### Trust boundaries and retained data

Untrusted inputs include provider usage payloads, model metadata, settings/RPC writes, dynamic/MCP tool declarations, Retry-After/reset headers, and persisted scheduler/audit records. Validate all before use. The host plugin is trusted code, while worker output is untrusted content and cannot grant capabilities.

Audit events contain timestamps, route IDs hashed with a local rotating salt, normalized metrics, decisions, and reason codes only. They never contain prompts, attachments, tokens, raw account identifiers, or repository contents. Retain events for seven days or 10,000 records, whichever is smaller; only the local DSH profile owner may read them. Use append with integrity checksum; corruption rotates the file, reports degraded audit status, and never silently feeds corrupted state into routing.

- OAuth credentials remain with the subscription plugin and DSH secret mechanisms.
- Logs redact tokens, prompt bodies, attachments, unnecessary account identifiers, and private paths.
- Route logs store reason codes and normalized metrics, not user content.
- Cross-provider routing is explicit and visible.
- Sensitive mode is fail-closed.
- Captain identity is immutable and durable.
- Authorization runs before native, nested run_code, dynamic, and MCP tool execution.
- Unknown tools are denied for the captain.
- Plugin releases are treated as arbitrary code execution and should be pinned/checksummed.

## 11. Testing and acceptance

### Deterministic tests

Cover filtering/allowlists, multi-window quota, reset pressure, stable scoring, stale/unknown usage, reservations, cancellation, fairness, both-lane starvation protection, scaling transitions, scoped 429/401/5xx, and model quarantine/promotion/regression.

### Integration tests

Cover mock usage snapshots, model-directory changes, prompt contribution and immutable role, and a capability matrix proving native, nested run_code, dynamic, and MCP authorization. Cover subagent and AgentTeams lease lifecycle, active-invocation acquisition, pause/continuation/reassignment, process-restart orphan reclamation, stale-attempt protection, all terminal/parked release paths, enable/disable/reload, and incompatible-hook behavior. Any unverified tool entry point must make global mode unavailable rather than silently degrade.

### Real GUI tests

Cover persistent toggle, unchanged captain, complete model allowlist, fail-closed unavailable models, live quota/safe slots/pressure/reasons, and restoration of ordinary behavior when disabled.

### Required quality gate

The repository must expose pnpm check as the single local and CI gate. It runs formatting/lint, typecheck, unit tests, integration tests, build, deterministic compatibility fixtures, GUI E2E against the injected DSH boot environment, and packaged-host compatibility smoke tests. CI runs the same command on Windows and the primary upstream-supported platform against every declared supported DSH version, with zero failing or skipped acceptance tests. Compatibility reports are published for each release and retained in the repository until that supported version is dropped.

### Fault injection

Inject 429, 401, stale quota, reset herd, worker death, plugin unload, hook absence, and duplicate release. Every terminal state needs an exit; every lease releases exactly once.

### End-to-end journey

1. Enable orchestration and select a captain.
2. Submit a mixed research/code/test/review task.
3. Verify the captain delegates without direct code access or self-review.
4. Provide fresh high-remaining, near-reset Codex/Grok usage.
5. Verify qualified workers receive suitable independent tasks and concurrency grows progressively.
6. Inject 429; verify scoped cooldown and contraction.
7. Enable sensitive mode; verify no disallowed route.
8. Disable orchestration; verify new work follows ordinary DSH behavior.

## 12. Delivery and release

Create public GitHub repository dsh-plugin-adaptive-orchestrator with MIT-licensed original code, English docs, architecture/security/configuration/compatibility guides, a one-command gate, and release workflow/checksums where practical. Enable required CI checks, dependency and secret scanning, generate an SBOM and provenance for releases where GitHub supports them, and document branch-protection recommendations. Do not copy code whose license is unverified.

Keep DSH core changes in separate upstream-ready commits: durable delegation role, generic scheduler, enforced subagent/AgentTeams acquisition, typed outcomes, and exact-once/bypass tests.

Pin the verified DSH range and detect capabilities at runtime. Missing required hooks must show unsupported-version state and disable global-protection claims.

Client UI changes require affected Web artifact rebuilds and refresh of the existing DSH GUI. Automatic HMR may be claimed only while pnpm run dev:web runs from the same official checkout.

## 13. Decisions

### Independent plugin plus thin generic DSH hooks
- **Why:** installable policy evolution without embedding product rules in core.
- **Rejected:** subscriptions-plugin fork, because it couples OAuth/provider maintenance and still lacks global AgentTeams enforcement.
- **Rejected:** full core implementation, because it destroys portability.

### Progressive adaptive scaling
- **Why:** quota creates urgency; observed health defines safe concurrency.
- **Rejected:** jumping directly to the cap near reset, due to avoidable rate-limit herds.

### Immutable user-selected captain
- **Why:** provider-agnostic user control.
- **Rejected:** automatic captain escalation, explicitly disallowed.

## 14. Constraints and upgrade path

- A public subscription usage host service still needs upstream agreement or a documented adapter.
- The installed app.asar is a packaged file, not a writable source checkout. Core implementation requires an official source checkout.
- AgentTeams lacks a verified shared scheduler seam in the inspected package; global guarantees require official-source implementation and tests.
- Release 1 is local-process scheduling. Multi-host scheduling is deferred until measured demand exists.
