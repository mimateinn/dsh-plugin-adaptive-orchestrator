> Read before selecting work | Purpose: product direction and priorities | Limit: 20 KB

# Project Goals

**Updated:** 2026-08-30  
**Baseline:** design only; implementation/test/build not started.

## Vision
Build a DSH plugin that lets a user choose one immutable captain while automatically delegating all execution to the best qualified subscription-backed workers, using otherwise-expiring quota to finish work faster without per-task Skills.

## Target user and value
A DSH user with multiple model subscriptions who currently routes work manually or leaves paid capacity unused. The product replaces manual provider choice and repetitive agent spawning with visible, safe, adaptive orchestration.

## Non-goals
Automatic captain replacement; OAuth credential ownership; distributed multi-host scheduling; silent sensitive-data fallback; a general external AI gateway.

## Success criteria
- One global toggle enables or disables orchestration.
- Captain never changes automatically and cannot directly execute protected worker work while enabled.
- Qualified workers are routed by capability, safety, quota/reset pressure, and health.
- Concurrency grows progressively near reset and contracts on rate-limit/health signals.
- Ordinary subagents and AgentTeams share one governor.
- Sensitive allowlist fails closed.
- New models are quarantined and evidence-tested before use.
- The mixed-work end-to-end journey in the design specification passes in the real GUI.
- Public GitHub repository and compatibility documentation are available.

## Completed
- [x] Product discovery and architecture design approved.
- [x] Approved design specification written.

## Short-term goals
- [ ] **S1 Harness:** create package scaffold, one-command gate, and first failing characterization tests.
- [ ] **S2 Pure routing core:** implement validated quota, eligibility, scoring, health, reservation, and scaling logic.
- [ ] **S3 Host policy:** implement global setting, captain prompt contribution, and fail-closed pre-execute guard.
- [ ] **S4 Worker integration:** implement routing provider, shared governor adapter, and typed usage source.
- [ ] **S5 Settings UI:** implement toggle, sensitive model allowlist, live usage, safe slots, and route reasons.
- [ ] **S6 Core seams:** implement upstream-ready durable role and shared delegation scheduler hooks.
- [ ] **S7 Verification:** deterministic, integration, fault-injection, real-GUI, and independent review gates.
- [ ] **S8 Release:** publish GitHub repository with MIT license and compatibility/security docs.

## Long-term goals
- [ ] **L1 Upstream contracts:** merge generic DSH hooks and subscription usage service upstream.
- [ ] **L2 Evidence learning:** improve safe-slot and model qualification using anonymized local outcomes.
- [ ] **L3 Distributed scheduling:** evaluate only after measured multi-host demand.

## Priority
S1 → S2 → S3 first: reliable tests and a pure core reduce the highest implementation risk before UI or upstream integration.
