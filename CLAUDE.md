# Team AI (TAI) — Claude Code

**Read `PROJECT_BRIEF.md` (repo root) first.** It is the single source of truth for
this project's vision, design decisions, current phase, ground rules, and open
questions. Do not write code that contradicts it; if something needs to change, update
the brief deliberately rather than working around it.

## Claude-specific
- **No Atlassian MCP server required (TAI-126).** `src/hosts/cli.ts`'s `issue`/`page`
  subcommands (`create`/`transition`/`comment`/`link`) wrap `WorkTracker`/`DocStore`
  directly against real Jira/Confluence REST — the same direct-REST path `work`/`ready`/
  `git-pr`/`link-precedence` already use (brief §3.2). Earlier sessions used the
  Atlassian MCP server for ticket/page CRUD only because these subcommands didn't exist
  yet, not because TAI's architecture needs it — don't reach for the MCP server for this
  going forward.