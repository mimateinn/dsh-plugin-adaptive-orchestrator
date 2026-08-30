> Read before architecture changes | Purpose: intended module and contract relationships | Limit: 30 KB

# Feature Map

| Feature/module | Planned location/layer | Contract | Used by / depends on |
|---|---|---|---|
| Approved architecture | docs/superpowers/specs/2026-08-30-adaptive-orchestrator-design.md | Acceptance contract | All implementation work |
| Persistent preferences | docs/PREFERENCES.md | Human-readable policy | All contributors |
| Runtime contracts | src/contracts/ | Versioned settings, quota, routing, compatibility, CAS, canonical JSON | All trust boundaries and pure services |
| Routing core | src/core/ | QuotaSnapshot, Candidate, RouteDecision, HealthState | Host and scheduler adapters |
| Captain policy | src/host/ (planned) | DSH prompt and tool-policy hooks | Top-level captain sessions |
| Usage adapter | src/integrations/ (planned) | SubscriptionUsageService | Routing core |
| Delegation governor | src/scheduler/ | SchedulerState, QueueRecord, Lease, DispatchFence | Future DSH subagent and AgentTeams admission adapters |
| Settings client | src/client/ (planned) | Typed settings/status RPC | DSH Settings UI |
| New-model evaluator | src/evaluation/ | ModelEvaluation and EvaluationOutcome | Model registry and future probe adapter |
| Privacy-safe audit | src/audit/ | AuditEvent, integrity envelope, salted route hash | Host status/RPC and persistent storage adapter |

Planned paths are not evidence of implementation. Update rows when files and contracts exist.
