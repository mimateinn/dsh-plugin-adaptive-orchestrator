> Read before implementation | Purpose: executable implementation sequence | Limit: 50 KB

# Adaptive Orchestrator Implementation Plan

**Approved design:** docs/superpowers/specs/2026-08-30-adaptive-orchestrator-design.md  
**Plugin repository:** this repository  
**Verified DSH source:** ../05 Notes/deepseek-harness-upstream at 0a53fb55bea101816fa226bb964ae2bed71c343b

## Critical path

1. Pure contracts, routing, health, queue, lease, evaluation, and audit logic can ship in this repository independently.
2. Authoritative global orchestration requires generic DSH capability seams before the plugin can claim compatibility.
3. Host integration, real GUI acceptance, and release follow only after compatibility probes pass.

## Phase 1 — Harness and contracts

1. Complete package/build/test configuration and make pnpm check the single local/CI gate.
2. Add RED tests under tests/unit/contracts for every schema in the approved specification, canonical RFC 8785 hashing, bounds, version negotiation, and CAS conflicts.
3. Implement src/contracts/{schemas,canonical-json,errors,index}.ts with runtime validation and byte-stable round trips.
4. Add trust-boundary fixtures for malformed provider usage, settings RPC, persisted state, dynamic tool declarations, and compatibility reports.
5. Update docs/FEATURE_MAP.md and docs/DECISIONS.md when modules land.

## Phase 2 — Pure routing and quota pressure

1. Add RED tests under tests/unit/core for eligibility, sensitive fail-closed behavior, context accounting, multi-window quota, stale/unknown usage, pressure, normalized scoring, stable ties, and reason codes.
2. Implement src/core/{types,model-registry,route-planner,quota-pressure,health-controller,index}.ts with injected clock/tokenizer.
3. Add 401, 429, transient failure, Retry-After, circuit, and half-open tests.
4. Implement public SubscriptionUsageService consumption in src/integrations without reading credentials or private files.

## Phase 3 — Durable adaptive scheduler

1. Add RED tests under tests/unit/scheduler for WDRR, lane reservations, starvation, cap aggregation, progressive scale-out, immediate scale-in, deterministic jitter, queue admission, duplicate requests, leases, fences, restart recovery, and stale attempts.
2. Implement src/scheduler/{state-store,scheduler,wddr,dispatch-fence,recovery,index}.ts. SchedulerState is the sole queue/lease authority.
3. Add fault injection for every terminal/parked state, cancel-vs-fence consume, unload, wall-clock jump, corrupted state, and exact-once release.

## Phase 4 — Evaluation and audit

1. Add RED tests for per-model-version/task-class quarantine, five-probe promotion, mandatory-tool and safety gates, evidence expiry, hysteresis, and daily probe budget.
2. Implement src/evaluation/{model-evaluator,evidence-store}.ts.
3. Add RED tests for bounded audit retention, redaction, rotating local salt, integrity checksum, and corruption recovery.
4. Implement src/audit/audit-store.ts.

## Phase 5 — Generic DSH source changes in separate upstream commits

Work only in the verified official checkout and keep adaptive policy out of core.

1. Add a generic DelegationAdmission service/lease contract.
2. Integrate admission immediately before SubagentRuntime provider ownership for one-shot and continuable starts. Verified source: packages/subagent/subagent/src/index.ts around start()/prepareContinuable().
3. Integrate AgentTeams spawn admission before Roster.spawnAdmitted commits provisioning. Verified source: packages/experimental/agent-team/src/roster.ts around spawnAdmitted().
4. Integrate claim admission inside TaskBoard.update claim transaction so capacity and ownership revisions remain atomic. Verified source: packages/experimental/agent-team/src/task-board.ts claim branch.
5. Add immutable universal delegation role only if required outside Team membership; otherwise preserve existing Team-derived roles and add no Agent role field.
6. Add RED characterization, exact-once lifecycle, direct-service/remote path, restart, and cancellation tests. Run the official repository gate.
7. Produce separate upstream-ready commits and compatibility evidence; do not modify internal ToolRuntimeScheduler or agent-loop.

## Phase 6 — Host plugin

1. Add RED integration tests for the global toggle, captain prompt contribution, per-agent ToolRuntime.guard/pre-execute denial, nested run_code, dynamic/MCP unknown-tool denial, disabled bypass, and compatibility failure.
2. Implement src/host/{plugin,settings,capability-probe,prompt-contribution,tool-policy,rpc,lifecycle}.ts using verified public APIs.
3. Implement adapters to generic DSH DelegationAdmission and the public subscription-usage service only after source hooks pass.
4. Preserve the user-selected captain provider/model; never implement escalation.

## Phase 7 — Settings client and package

1. Add client tests and GUI E2E for the durable global toggle, immutable captain display, sensitive allowlist, live quota/safe slots/pressure/reasons, unsupported host state, accessibility, and disabled restoration.
2. Implement src/client settings.section contribution using official 0.1.2-alpha.2 slots/settings contracts.
3. Use connection.rpc.handle(channel, handler) on host and rpc.call(channel, endpoint, payload, signal?) on client; do not add the obsolete authority argument.
4. Wire approved assets/icon SVG and PNGs to the verified manifest/UI convention.
5. Build, install, unload, reload, and validate the bundle metadata.

## Phase 8 — Compatibility, review, GUI, and release

1. Add versioned compatibility fixtures containing DSH source revision, packaged artifact hash, source symbols, and capability results.
2. Run pnpm check with zero failed or skipped acceptance tests on Windows and the supported upstream platform.
3. Build affected Web artifacts and verify the existing http://127.0.0.1:43120 after refresh; do not start a replacement server.
4. Capture production light/dark screenshots and user journeys for enablement, mixed delegation, near-reset scale-out, 429 contraction, sensitive isolation, and disabled bypass.
5. Freeze SHAs and obtain independent security/contracts, scheduler/concurrency, upstream architecture, GUI/accessibility, and release reviews. Repair and re-review failures.
6. Complete README, architecture, configuration, security, compatibility, changelog, checksums, SBOM/provenance, and install instructions.
7. Push clean commits to the public GitHub repository, tag a prerelease, attach artifacts/checksums/reports, and verify a fresh install.

## Current next action

Make Phase 1 RED: install the verified published dependencies, run the scaffold gate, then add contract tests before production logic.
