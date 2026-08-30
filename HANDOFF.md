> Read before every work session | Purpose: current state, next steps, and hazards | Limit: 50 KB

# Handoff

## In progress
- Approved design is documented. Implementation has not started because the user must review the written specification first.

## Current state
- Project skeleton and memory foundation created on 2026-08-30.
- Approved design: docs/superpowers/specs/2026-08-30-adaptive-orchestrator-design.md.
- DSH packaged runtime seams were inspected read-only; official source checkout is still required before core-hook implementation.
- No tests/build baseline exists yet because no package scaffold has been implemented.

## Checklist
- [ ] User reviews and approves the written design specification.
- [ ] Create implementation plan.
- [ ] Scaffold one-command quality gate and characterization tests.
- [ ] Implement plugin core and UI.
- [ ] Implement/test thin DSH core hooks in an official source checkout.
- [ ] Run independent review and real GUI verification.
- [ ] Publish public GitHub repository.

## Known hazards
- The installed DSH app.asar path is a packaged file, not a source checkout.
- AgentTeams shared scheduling has no verified public hook in the inspected package.
- dsh-plugin-subscriptions source license was not verified; do not copy its code.
- Client changes do not update the existing GUI without affected Web rebuilds and refresh, unless dev:web is running from the same official checkout.

## Document map
| Document | Read timing | Purpose |
|---|---|---|
| AGENTS.md | Every session | Working rules and protocol routes |
| docs/PREFERENCES.md | Every session | Persistent product and language choices |
| HANDOFF.md | Every session | Live progress and hazards |
| docs/PROJECT_GOALS.md | Before selecting work | Outcomes and priority |
| docs/FEATURE_MAP.md | Before architecture changes | Module/contract relationships |
| docs/DECISIONS.md | Before architecture changes | Decisions and rejected alternatives |
| docs/superpowers/specs/2026-08-30-adaptive-orchestrator-design.md | Before implementation | Approved acceptance contract |
