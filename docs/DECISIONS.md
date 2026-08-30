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

## 2026-09-01 — Profile-local atomic JSON persistence
- **Why:** settings and bounded evaluation records need durable cross-process CAS without adding a database dependency. Each writer serializes read, expected-revision validation, and fsynced replacement through an atomic lock directory on the canonical filesystem path. The owner marker records PID, nonce, and start time; existing, unreachable, missing, or corrupt ownership always times out with a typed error and is never stolen automatically. Evaluation CAS also validates the parsed record identity before revision comparison.
- **Rejected:** one shared evaluation envelope, because one corrupt or oversized record would make every model evaluation unavailable.
- **Rejected:** raw identity filenames, because model/account-derived identifiers must not leak through directory listings.
- **Impact:** src/persistence stores settings as one record and evaluations in SHA-256 identity-keyed files with closed runtime parsing, 1 MiB bounds, restrictive modes, deterministic stale-temp replacement, and canonical per-record cross-process locks. A crashed owner can require manual lock recovery because ambiguous ownership fails closed.

## 2026-09-01 — AgentTeams task claims require a durable admission outbox
- **Why:** TeamJournal append and an external admission provider cannot form one atomic commit. A prepare-append-commit sequence has an unavoidable crash window after durable task ownership but before capacity commit.
- **Rejected:** describe an in-memory transfer or prepare/rollback wrapper as atomic, because commit failure or process death can leave durable ownership without an active admission.
- **Impact:** claim protocol v2 must use idempotent durable prepare/commit/reacquire/release keyed by teamId, taskId, expected revision, attemptId, and owner session. Global support remains fail-closed until DSH exposes this seam and recovery tests pass.
