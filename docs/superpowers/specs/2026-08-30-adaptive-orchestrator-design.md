> Read before implementation | Purpose: approved architecture and acceptance contract | Limit: 50 KB

# Adaptive Orchestrator for DSH — Design Specification

**Status:** Approved design; implementation pending  
**Date:** 2026-08-30  
**Audience:** DSH maintainers, plugin contributors, and operators

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

To guarantee shared concurrency across subagents and AgentTeams, core needs a generic DelegationScheduler service with an acquire request containing delegation kind, parent agent ID, provider/model, interactive or background priority, and AbortSignal. It returns an idempotent lease. Subagent creation/continuation and AgentTeams member spawn/ready-task claim must acquire a lease. Completed, failed, cancelled, paused, removed, and missing paths must release it exactly once.

### Subscription usage contract

The plugin consumes a public typed service and never reads another plugin's private files. Each QuotaSnapshot includes provider, account, optional model, quota class, usedPercent, resetsAt, observedAt, plan, supported, source, and confidence.

The installed subscriptions plugin already normalizes usage into supported, plan, and windows with usedPercent and resetsAt. Initial work should propose a public service upstream. A temporary adapter may call documented typed RPC, but must not import private files or access credentials.

## 6. Routing policy

### Eligibility

A route is eligible only when global orchestration is enabled, it is authenticated/enabled, the model passed the required capability class, sensitive policy permits it, no hard exhaustion/auth failure/open circuit applies, and required tools/context/modalities are supported. Quota cannot rescue a route that fails capability or safety.

### Quota state

State is keyed by provider, account, optional model, and quota class. Multiple provider windows remain separate. The tightest applicable window is the hard constraint; other windows still contribute pressure. Every snapshot carries observedAt, source, and confidence. Stale or low-confidence data may influence ordering but is never exact allowance.

### Reset pressure

For a fresh supported window:

    remaining = clamp(1 - usedPercent / 100, 0, 1)
    timeRatio = clamp((resetsAt - now) / configuredHorizon, 0, 1)
    resetUrgency = 1 - timeRatio
    burnPressure = remaining * resetUrgency

Provider preference may multiply burn pressure, with higher defaults for Codex and Grok. Preference never bypasses filters.

### Route score

    score = capabilityFit
          * healthConfidence
          * quotaHeadroom
          * (1 + burnWeight * burnPressure)
          / expectedLatency

The formula must normalize factors, remain deterministic for equal inputs, expose reason codes, and use stable tie-breaking.

### Reservation and settlement

Release 1 uses abstract work permits, not fabricated token accounting. One active worker consumes one provider/account/model permit. The governor atomically acquires the permit immediately before a run becomes active and releases it on every terminal or parked transition. Provider-reported usage may update quota snapshots after completion, but missing token counts never create guessed debit values. Future token reservations require a provider contract exposing comparable estimated and actual units. Cancellation, worker loss, and expired durable attempts reclaim permits idempotently.

## 7. Adaptive concurrency

Quota totals and rate limits are different. Quota/reset creates acceleration pressure; observed 429s, latency, errors, and successes define safe concurrency.

    pressureSlots = baseSlots + floor(maxEligibleBurnPressure * (globalHardCap - baseSlots))
    desiredWorkers = min(
      readyIndependentTasks,
      globalHardCap,
      sum(providerSafeSlots),
      pressureSlots
    )

baseSlots is the configured minimum useful concurrency, bounded to at least one when ready work exists. maxEligibleBurnPressure is normalized to 0..1. Unknown or stale quota contributes zero burn pressure, so routing remains capability/health based at baseSlots rather than inventing urgency.

Scale out one slot at a time only when independent tasks exist, remaining capacity is approaching reset, the route is healthy, no recent rate-limit or material latency degradation exists, and both lanes remain protected.

Scale in immediately on 429, rising latency/error rate, hard quota threshold, lane starvation, or a reduced hard cap. Respect Retry-After/reset headers; otherwise use bounded exponential backoff with full jitter. Scope cooldown to the affected account/model bucket.

The governor enforces global, provider, and account maxima; at least one interactive reservation; at least one background reservation when background work exists; weighted fair queueing or deficit round robin; bounded queue length; and cancellation propagation. Concurrency values are configurable, not magic constants.

A lease represents one actively running model invocation, not a queued task, claim, or dormant member. Queueing and planning do not consume leases. Spawned members acquire immediately before invocation; pause/cancel/fail/complete/remove release. Continuation and reassignment acquire a new lease for the new invocation. Lease records persist with owner attempt ID and heartbeat; process restart marks orphaned leases reclaimable after a configured grace period. Release is idempotent and stale attempt IDs cannot release a newer lease.

## 8. New model discovery

1. Detect additions from the DSH model directory.
2. Put new models in quarantine; do not route production work.
3. Read declared metadata and run low-risk deterministic probes.
4. Compare with active models in the same task class using success, tool support, context behavior, latency, and stability.
5. Require at least five deterministic probes per claimed task class, 100% mandatory-tool checks, at least 80% overall success, and no safety-policy violation before qualification.
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

## 10. Security and privacy

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
