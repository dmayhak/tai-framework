# Team AI (TAI) — Gemini CLI

**Read `PROJECT_BRIEF.md` (repo root) first.** It is the single source of truth for
this project's vision, design decisions, current phase, ground rules, and open
questions. Do not write code that contradicts it; if something needs to change, update
the brief deliberately rather than working around it. The brief states what is true now:
write a change as current fact there and add the history (what changed, why, which ticket)
as an entry in `CHANGELOG.md`.
The entry's rev is the number after the newest one on `origin/main`, taken when the PR is opened, and the brief's `Last updated` line names the same rev;
if a parallel PR merged first, renumber yours to follow it in both files (`npm test` fails on a duplicate or skipped rev).

## Gemini-specific
- **No Atlassian MCP server required (TAI-126).** TAI talks to Jira and Confluence over their REST APIs
  directly, through the CLI (`src/hosts/cli.ts`); the global `tai-*` skills in `~/.gemini/skills/` call it.
  Don't configure or reach for an MCP server for ticket or page work.
