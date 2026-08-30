> Read before architecture changes | Purpose: architecture decisions and rejected options | Limit: 30 KB

# Architecture Decisions

## 2026-08-30 — Independent plugin plus thin generic DSH hooks
- **Why:** keeps routing policy installable and independently evolvable while core exposes only generic capabilities.
- **Rejected:** fork dsh-plugin-subscriptions, because OAuth/provider maintenance would become coupled and global AgentTeams control would still be missing.
- **Rejected:** put the full policy in DSH core, because it would destroy portability and embed product policy in generic runtime.
- **Impact:** plugin repository plus separate upstream-ready core commits.

## 2026-08-30 — Immutable user-selected captain
- **Why:** preserves explicit user control and provider/model neutrality.
- **Rejected:** automatic upgrade/escalation, explicitly disallowed by the user.
- **Impact:** captain policy may constrain tools but never changes model selection.

## 2026-08-30 — Progressive adaptive concurrency
- **Why:** quota/reset expresses urgency, while observed 429, latency, and errors determine safe concurrency.
- **Rejected:** jump directly to maximum concurrency near reset, due to herd and rate-limit risk.
- **Impact:** scale out one slot at a time; scale in immediately on negative feedback.

## 2026-08-30 — Default cross-provider routing with optional fail-closed sensitive mode
- **Why:** maximizes ordinary throughput while preserving an explicit privacy boundary when requested.
- **Rejected:** always fixed provider per project, because the user requested cross-company routing by default.
- **Impact:** complete-model allowlist and visible route records are required.

## 2026-08-31 — Pure policy core before host adapters
- **Why:** routing, scheduling, evaluation, and audit behavior can be deterministic and independently verified while generic DSH admission hooks mature.
- **Rejected:** implement policy directly in DSH lifecycle callbacks, because it would couple algorithms to host APIs and make fault tests nondeterministic.
- **Impact:** src/contracts, src/core, src/scheduler, src/evaluation, and src/audit have no DSH runtime imports; host adapters will depend on them, never the reverse.
