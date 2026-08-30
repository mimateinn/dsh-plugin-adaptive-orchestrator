> Read before architecture changes | Purpose: intended module and contract relationships | Limit: 30 KB

# Feature Map

| Feature/module | Planned location/layer | Contract | Used by / depends on |
|---|---|---|---|
| Approved architecture | docs/superpowers/specs/2026-08-30-adaptive-orchestrator-design.md | Acceptance contract | All implementation work |
| Persistent preferences | docs/PREFERENCES.md | Human-readable policy | All contributors |
| Runtime contracts | src/contracts/ | Versioned settings, quota, routing, compatibility, CAS, canonical JSON | All trust boundaries and pure services |
| Routing core | src/core/ | QuotaSnapshot, Candidate, RouteDecision, HealthState | Host and scheduler adapters |
| Host composition | src/host/ | CompatibilityReport, SettingsService, captain tool guard and guidance, scheduler admission bridges | src/index.ts apply(); DSH system-prompt and tools/pre-execute seams |
| Usage adapter | src/integrations/ | UsageSource with redacted drop of invalid QuotaSnapshot; NeutralUsageSource when the usage RPC is absent | Routing core and host wiring |
| Delegation governor | src/scheduler/ | SchedulerState, QueueRecord, Lease, DispatchFence | Future DSH subagent and AgentTeams admission adapters |
| Settings client | src/client/ | settings.section slot page (global toggle + sensitive allowlist) bound to the adaptive-orchestrator namespace | DSH Settings shell via ctx.settingsScope and ctx.slots |
| Host settings namespace | src/index.ts | Registers the adaptive-orchestrator settings namespace (schemastery) and watches it to drive runtime enablement | DSH Settings service (ctx.settings), Settings page |
| New-model evaluator | src/evaluation/ | ModelEvaluation and EvaluationOutcome | Model registry and future probe adapter |
| Privacy-safe audit | src/audit/ | AuditEvent, integrity envelope, salted route hash | Host status/RPC and persistent storage adapter |
| Profile-local persistence | src/persistence/ | Durable cross-process atomic SettingsRepository and identity-keyed EvaluationStore; canonical mkdir locks never steal ambiguous ownership | Host settings and evaluation services; validates through contracts/evaluation parsers |
| Headless integration smoke | tests/integration/ | apply() against a real Cordis context with stubbed seams; real scheduler gateway acquire/release round-trip; settings CAS activation | Host policy, admission bridges, SettingsService |

Planned paths are not evidence of implementation. Update rows when files and contracts exist.
