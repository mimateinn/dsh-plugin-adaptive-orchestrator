> Read before every work session | Purpose: persistent language and product preferences | Limit: 10 KB

# Project Preferences

## Language
- User communication: English.
- UI copy: English.
- User documentation: English.
- Code comments, API identifiers, commit messages, and contributor documentation: English.

## Product behavior
- The user selects the captain model. The plugin must never automatically replace, upgrade, or downgrade the captain.
- When globally enabled, the captain orchestrates only: direction, decomposition, dependencies, supervision, integration, and user communication.
- Code reading, research, design production, implementation, testing, and review are worker responsibilities.
- Cross-provider worker routing is allowed by default.
- Sensitive mode restricts workers to a user-selected model allowlist.
- The feature is controlled by one global settings toggle and must require no per-task Skill invocation.
