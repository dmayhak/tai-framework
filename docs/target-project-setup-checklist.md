# Target-project setup checklist (TAI-116 piece 3, TAI-130)

The manual admin steps for pointing TAI at a real Jira/Confluence/Bitbucket project,
reverse-engineered from `tai-framework`'s own live `TAI`/`TAIT` projects (TAI-90 ADR
decision 4) rather than written from generic Jira docs. Full automation of Jira/Confluence
admin provisioning is an explicit v1 non-goal (same ADR) — a human does the steps below in
the Jira/Confluence UI; `cli.ts init <step>` verifies each one against the real API before
moving on, and each verification doubles as the step's own resumability checkpoint (state
recorded in `<taiRoot>/init-state.json` — `cli.ts init status` shows progress any time, and
a step already recorded done is safe to skip on a re-run).

Before running any `init` subcommand below, export the target project's real credentials
into the current shell — these are the exact same env var names `.env` will end up holding
once `init env` runs, so nothing here is TAI-specific setup on top of what `.env.example`
already documents:

```bash
export TAI_PROJECT_KEY=<jira project key>
export TAI_SPACE_KEY=<confluence space key>          # NOT assumed to equal TAI_PROJECT_KEY
export TAI_JIRA_SITE_URL=https://<your-site>.atlassian.net
export TAI_JIRA_EMAIL=<you@example.com>
export TAI_JIRA_API_TOKEN=<token>
# Only if this project also needs git-pr support:
export BITBUCKET_EMAIL=<you@example.com>
export BITBUCKET_API_TOKEN=<token>
export TAI_GIT_REPOS=<workspace/repo>
```

## 1. Jira

TAI needs every `StoryType`/`SubtaskType` provisioned as its own **native Jira issue
type** with an **exact name match** (brief §5.2 rev 11 — one custom sub-task issue type
per `SubtaskType`; Kickoff/Spike aren't native types either).

**Team-managed project:** Project settings → Issue types → add each missing type
directly; no separate scheme to manage.

**Company-managed project:** Site admin → Issue types → create each missing type
site-wide, then Issue type scheme → associate them with this project. Heavier, but the
same end state.

**Escape hatch for a pre-existing project (TAI-116 piece 4, TAI-178 ADR):** if this
project already has its own native issue types (a generic `Sub-task`, a locally-named
`Defect`, …) that you'd rather reuse than re-provision to match exactly, add a `Type
Aliases` page (Confluence, `Config` folder, sibling to `Persona Roster`) mapping each
native name to TAI's internal type value:

````
```yaml
Sub-task: dev
Defect: bug
```
````

`issue create`'s `<ISSUE-TYPE>` argument (`dev`, `code-review`, `bug`, …) is the exact
vocabulary the right-hand side accepts — see `SubtaskType`/`StoryType` in
`story-schema.ts` for the full list. `init jira` (below) honors this page once
`TAI_SPACE_KEY` is set — on a fresh project it may not exist yet on the very first run;
re-run `init jira` after creating/editing it to re-verify. This reduces, not eliminates,
provisioning: still add any type that's neither a native match nor aliased.

Either way, also provision:

- A **`Persona`** single-select custom field, with options matching each of: Analyst, PM,
  Architect, UX Designer, Developer, DBA, Code Reviewer, Tester, DevOps (brief §5.6 — TAI
  discovers this field **by name**, not a hardcoded id, so the exact field name matters,
  the id doesn't).
- A workflow whose status set includes: `Backlog`, `To Do`, `In Progress`, `In Review`,
  `Done`, `Canceled` (brief §5.3). This isn't verified by `init jira` below (no reliable
  API surface short of creating real test issues) — a wrong/missing status shows up the
  first time a persona actually attempts a transition into it, which already fails loudly
  by design (`fromJiraStatus`/`transition()`).

Once done:

```bash
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init jira
```

On a brand-new project this will report every issue type as missing and the `Persona`
field as not found — that report **is** the concrete to-do list; keep provisioning and
re-run until it says "All N required issue types are provisioned... Persona field was
found."

## 2. Confluence

Create a Confluence space for this project (any key — brief §4 rev 18 is explicit that
`TAI_SPACE_KEY` is never assumed to equal `TAI_PROJECT_KEY`). No further manual page setup
is needed: TAI creates its own `Config` folder page and `Persona Roster` page underneath
it eagerly (brief §4 rev 13; the ~21 `confluenceOutputs` doc-type folders stay lazy,
created the first time a persona actually writes that doc type).

```bash
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init confluence
```

Then open the new **Persona Roster** page and fill in the "Authorized humans" column —
review-gate `Approved:`/`Rejected:` comment validation (brief §3.5) depends on it.

## 3. Bitbucket

Only needed if this project will use `git-pr`/`tai-pr`. Identify (or create) the repo, and
generate an API token with repo read/write + pull-request scopes.

```bash
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init bitbucket <workspace/repo>
```

## 4. Generate `.env`

Requires the `jira`/`confluence` steps above (and `bitbucket`, if `BITBUCKET_EMAIL`/
`BITBUCKET_API_TOKEN` are exported) to already be recorded done — `init env` refuses to
run ahead of them, so the generated file is never built from an unverified setup.

```bash
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init env
```

## 5. Generate a `CLAUDE.md` pointer

Requires the `env` step above. Idempotent — re-running replaces TAI's own section (found
by an HTML-comment marker) without touching the rest of an existing `CLAUDE.md`.

```bash
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init claude-md [TAI-HOME]
```

## Checking progress / resuming

```bash
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init status
```

Shows which of the five steps (`jira`, `confluence`, `bitbucket`, `env`, `claude-md`) are
already recorded done. Safe to run `/tai-init` again after any interruption — it picks up
wherever this list leaves off rather than restarting.

## Out of scope (TAI-90 ADR, TAI-116)

- Full automation of Jira/Confluence admin-level provisioning (issue-type/workflow/screen
  schemes, space creation) — the steps above stay manual in v1.
- Filesystem-only onboarding (brief §3.2's solo-dev fallback) — this checklist is for the
  Jira-backed real-project path only.
- Type-alias mapping (a target project's own native issue-type names → TAI's
  `SubtaskType`/`StoryType`) — TAI-116 piece 4, a separate future ticket once this piece
  lands.
- Retroactively migrating an already-onboarded project's existing setup.
