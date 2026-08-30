> Read before every work session | Purpose: repository working rules | Limit: 20 KB

# Repository Instructions

## Protocol routing
1. Read docs/PREFERENCES.md and HANDOFF.md before work.
2. Read docs/PROJECT_GOALS.md before choosing work.
3. Read docs/FEATURE_MAP.md and docs/DECISIONS.md before architecture changes.
4. Read the approved design spec before implementation.

## Engineering rules
- Contracts first; runtime-validate trust-boundary inputs.
- Keep the routing core pure and dependency-injected.
- Captain selection is immutable and user-controlled; never add automatic escalation.
- Never read or store subscription OAuth credentials.
- Treat quota totals and rate limits as different signals.
- Protect both interactive and background lanes.
- Unknown captain tools fail closed while policy is enabled.
- Add every new module to docs/FEATURE_MAP.md and every architecture choice to docs/DECISIONS.md in the same commit.
- One command must run the project quality gate.
- User-facing strings and all repository content are English.
