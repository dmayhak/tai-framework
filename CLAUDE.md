# Team AI (TAI) — Claude Code

**Read `PROJECT_BRIEF.md` (repo root) first.** It is the single source of truth for
this project's vision, design decisions, current phase, ground rules, and open
questions. Do not write code that contradicts it; if something needs to change, update
the brief deliberately rather than working around it. The brief states what is true now:
write a change as current fact there and add the history (what changed, why, which ticket)
as an entry in `CHANGELOG.md`.

## Claude-specific
- **No Atlassian MCP server required (TAI-126).** `src/hosts/cli.ts`'s `issue`/`page`
  subcommands (`create`/`transition`/`comment`/`link`) wrap `WorkTracker`/`DocStore`
  directly against real Jira/Confluence REST — the same direct-REST path `work`/`ready`/
  `git-pr`/`link-precedence` already use (brief §3.2). Earlier sessions used the
  Atlassian MCP server for ticket/page CRUD only because these subcommands didn't exist
  yet, not because TAI's architecture needs it — don't reach for the MCP server for this
  going forward.

## Dogfooding this repo (as opposed to a target project TAI manages)
- **Live tests and throwaway tickets go in the TAIT scratch project, not TAI.** Anything created
  only to try something live (a probe issue, a flag/cascade experiment, the live conformance run)
  uses `TAIT`; real work lives in `TAI`. Clean up probe issues afterward (Cancel + the
  `tai-conformance-fixture` label — Free-plan Jira can't delete).
- **What `IntegrationTest` scope concretely means here:** extending `conformance.ts`
  (the suite that verifies the Jira and filesystem `StorageBackend`s behave identically)
  — but only when the Dev deliverable is actually wired into `WorkTracker`/`DocStore`. A
  deliverable with no backend touchpoint (a standalone pure-function module, a CLI-only
  concern, etc.) has nothing for `conformance.ts` to catch beyond its own unit tests —
  close it **N/A with an explanation, confirmed with the human first** (see
  `personas/tester.md`'s general version of this principle). Don't assume every Dev
  subtask implies a real `conformance.ts` addition.