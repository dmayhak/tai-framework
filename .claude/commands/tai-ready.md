---
description: Show what's ready to work on, optionally scoped to one persona (brief §3.8)
---

Run this and read its full output:

```bash
npx tsx src/hosts/cli.ts ready $ARGUMENTS
```

The output lists issues that are actually ready to start (open, and — for a subtask — with
every precedence prerequisite already Done or Canceled, per `SUBTASK_PRECEDENCE`), plus an
"Already in flight" section for context (the root status rollup — display only, never the
readiness source itself, brief §7).

When `BITBUCKET_EMAIL`/`BITBUCKET_API_TOKEN`/`TAI_GIT_REPOS` are all configured, an
"Approved PRs ready to merge" section may also appear (TAI-106/107/108) — a CodeReview
subtask that's Done, whose linked PR is still open, with green CI. This is a DIFFERENT
action type than the ready-to-start list above: run `git-pr merge <ISSUE-KEY> <REPO>` to
land it, not `/tai-work`.

Present this list to the human. If they pick a ready-to-start issue, follow up with
`/tai-work <KEY>` for that issue — same underlying flow, `/tai-ready` is only for when
there's no specific key in mind yet (brief §3.8).
