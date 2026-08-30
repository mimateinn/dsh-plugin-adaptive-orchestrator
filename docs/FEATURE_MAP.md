> Read before architecture changes | Purpose: intended module and contract relationships | Limit: 30 KB

# Feature Map

| Feature/module | Planned location/layer | Contract | Used by / depends on |
|---|---|---|---|
| Approved architecture | docs/superpowers/specs/2026-08-30-adaptive-orchestrator-design.md | Acceptance contract | All implementation work |
| Persistent preferences | docs/PREFERENCES.md | Human-readable policy | All contributors |
| Routing core | src/core/ (planned) | QuotaSnapshot, Candidate, RouteDecision | Host and scheduler adapters |
| Captain policy | src/host/ (planned) | DSH prompt and tool-policy hooks | Top-level captain sessions |
| Usage adapter | src/integrations/ (planned) | SubscriptionUsageService | Routing core |
| Delegation governor | src/scheduler/ (planned) | DelegationScheduler/Lease | Subagents and AgentTeams |
| Settings client | src/client/ (planned) | Typed settings/status RPC | DSH Settings UI |
| New-model evaluator | src/evaluation/ (planned) | ModelEvaluation state | Model registry |

Planned paths are not evidence of implementation. Update rows when files and contracts exist.
