# Target-project setup checklist (TAI-116 piece 3, TAI-130)

The steps for pointing TAI at a real Jira/Confluence/Bitbucket project, reverse-engineered
from `tai-framework`'s own live `TAI`/`TAIT` projects (TAI-90 ADR decision 4) rather than
written from generic Jira docs. Full automation of Jira/Confluence admin provisioning is an
explicit v1 non-goal (same ADR) — a human does the Jira/Confluence UI steps in sections 1–2
below; **`init run`** (next section) does everything else: it collects credentials, discovers
the project's coordinates, and verifies each step against the real API.

## Quick path: `init run`

One command serves both a **brand-new project** and an **already-onboarded project cloned into
a new folder or onto a new PC** (a fresh clone has no `.env` and no `.tai/`, because both are
gitignored). The journey:

1. **Install TAI** once per machine: clone it to `~/.tai-framework`, `npm install`, then run
   `install-global` (see the README's *Install* section). This writes the `/tai-init` skill
   (and the rest) for both Claude Code and Gemini CLI. **A running Gemini CLI session does not
   pick up refreshed skill files — quit and restart the process** (`/clear` is not enough). After
   any `install-global` re-run, restart Gemini before trusting its behavior; an apparent failure
   right after an update is often a stale skill, not a real gap.
2. **Clone your project's repo** (or `cd` into the one you have).
3. **Run `/tai-init`** in your assistant from inside that repo. It checks `init status`, and if
   the project isn't fully initialized it tells you to open a **separate terminal** and gives
   you the exact command, which is always:

```bash
cd <your project>
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init run
```

Run it directly in the terminal — piping or redirecting its output disables the prompts. (An
assistant's own shell has no usable terminal: it can't answer prompts or open your editor, and
a token pasted into chat goes to the model provider, so secrets are only ever typed into your
own editor.) What `init run` does, in order:

- Asks for your **Atlassian site URL** (defaulting to the one in an existing `.env`).
- Writes a `.env` skeleton (mode 0600) with each secret line empty under a comment saying
  what belongs there, then opens `$VISUAL` / `$EDITOR` so you fill in the Jira email, the
  Atlassian API token and, if you use `git-pr`, the Bitbucket email and token. It re-checks
  that the required ones are filled before going on. With no editor configured it prints the
  path and waits for you to fill the file yourself and press Enter.
- **Discovers** the Jira project, Confluence space and Bitbucket repo live: you pick from the
  lists (or type a key that isn't listed — the path for a brand-new project). A value already
  in `.env` that the live list confirms is kept as-is; only an absent or stale one is asked
  about. The Bitbucket repo is read from your `git remote` when it is on bitbucket.org. A
  space you pick is written under its common name (the alias, e.g. `TAI`) rather than its real
  key (`TA`).
- **Verifies** `jira`, `confluence` and `bitbucket` live, in that order, and stops at the first
  failure with that step's own to-do list. If no Bitbucket repo or credentials are
  configured, `bitbucket` is recorded as done with an `N/A` detail so the project can still
  reach "Fully initialized" (re-run `init run` later to add it).
- Writes the `CLAUDE.md` pointer and the matching `GEMINI.md` pointer (Claude Code reads the
  first, Gemini CLI the second), then — if either, or `.gitignore`, changed — reminds you to
  commit and push them so teammates and future clones get them. It never commits or pushes for
  you. `GEMINI.md` is not one of the five tracked steps, so a project onboarded before it
  existed stays "Fully initialized".

It is idempotent. Nothing is trusted from a previous run: `.tai/init-state.json` is only a
cache that `init run` rebuilds from real API results, so on a re-run (or a clone that never had
one) you never copy it from another folder. If `init run` stops at a failing step, fix what
its to-do list says — for a new project that is usually sections 1–2 below — and run the same
command again.

Exit codes: `0` everything verified, `1` a step failed or you quit, `2` it needs a human at a
terminal (printed when it was started somewhere it can't prompt).

**Joining an already-onboarded project** needs nothing beyond the above: you supply the site URL
and your own email and tokens, and every other value is discovered. The Jira/Confluence
provisioning in sections 1–2 is already done for that project, so the verification simply
passes.

The sections below are the manual admin steps `init run` can't do for you (1–2), and the
individual `init <step>` actions it is built from, which still exist for scripting and for
re-running a single step.

### Using the individual `init` actions directly

Only needed if you skip `init run`. Each reads its credentials from the current shell or from
`.env`; these are the same names `.env.example` documents:

```bash
export TAI_PROJECT_KEY=<jira project key>
export TAI_SPACE_KEY=<confluence space key>          # NOT assumed to equal TAI_PROJECT_KEY
export TAI_JIRA_SITE_URL=https://<your-site>.atlassian.net
export TAI_JIRA_EMAIL=<you@example.com>
export TAI_JIRA_API_TOKEN=<token>
# Only if this project also needs git-pr support:
# BITBUCKET_EMAIL/BITBUCKET_API_TOKEN are deliberately unprefixed, unlike everything else
# here (TAI-346) -- matches a Bitbucket MCP server's own naming convention, if you use one.
export BITBUCKET_EMAIL=<you@example.com>
export BITBUCKET_API_TOKEN=<token>
export TAI_GIT_REPOS=<workspace/repo>
```

`cli.ts init status` shows progress at any time, and a step already recorded done is safe to
skip on a re-run.

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

Once done, re-run `init run` (or, using the individual actions, `init jira`):

```bash
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init jira
```

On a brand-new project this will report every issue type as missing and the `Persona`
field as not found — that report **is** the concrete to-do list; keep provisioning and
re-run until it says "All N required issue types are provisioned... Persona field was
found."

On a project that already has tickets, the same run also **reports tickets whose Jira issue
type TAI does not map** (a default `Task`, say), with a count and example keys per type
(TAI-413). It is report only and never fails the step: alias the type on the Type Aliases page
if it means the same as a TAI type (then set the persona with `issue update <KEY>
persona=<PERSONA>`), otherwise leave it unmanaged and work it outside TAI. Until then TAI skips
those tickets, with a warning, whenever it searches.

## 2. Confluence

Create a Confluence space for this project (any key — brief §4 rev 18 is explicit that
`TAI_SPACE_KEY` is never assumed to equal `TAI_PROJECT_KEY`). No further manual page setup
is needed: TAI creates its own `Config` folder page and `Persona Roster` page underneath
it eagerly (brief §4 rev 13; the ~21 `confluenceOutputs` doc-type folders stay lazy,
created the first time a persona actually writes that doc type).

```bash
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init confluence
```

**Space keys (TAI's own space is the worked example).** A Confluence space's *real* key can differ
from the key you see: TAI's own space is keyed `TA` with `TAI` kept as an alias, and on a free plan
the real key may not even be visible. Use whichever key `init confluence` discovered and recorded
in `.env` (`TAI_SPACE_KEY`) — both resolve — and for raw page-create / space-key arguments use the
alias that works on your site (`TAI` for TAI's own space), never one derived from the Jira key.

Then open the new **Persona Roster** page and fill in the "Authorized humans" column —
review-gate `Approved:`/`Rejected:` comment validation (brief §3.5) depends on it.

## 3. Bitbucket

Only needed if this project will use `git-pr`/`tai-pr`. Identify (or create) the repo, and
generate an API token with repo read/write + pull-request scopes.

```bash
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init bitbucket <workspace/repo>
```

## 4. Generate `.env`

`init run` already does this — it writes `.env` first, since it needs your credentials before
it can discover or verify anything. This section is for the individual `init env` action.
Requires the `jira`/`confluence` steps above (and `bitbucket`, if `BITBUCKET_EMAIL`/
`BITBUCKET_API_TOKEN` are exported) to already be recorded done — `init env` refuses to
run ahead of them, so the generated file is never built from an unverified setup.

```bash
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init env
```

**`.gitignore` (automatic, TAI-358, TAI-366):** every `init` action above (except `status`)
also idempotently ensures `.gitignore` covers `.tai/` (or `$TAI_ROOT`, if overridden), `.env`,
`.env.local`, `.env.*` (every variant, including editor swap files like `.env.swp` that can
hold tokens you just typed) with a `!.env.example` exception so the template stays
committable, `*~` (editor backup files), and `.handoff/` (the global `sess-handoff` skill's
convention). Order matters in a `.gitignore` — the last matching rule wins — so TAI keeps
`!.env.example` after `.env.*`, re-appending it if an existing file has it above. Nothing to
do here, but if you're wondering why these are already excluded, that's why.

## 5. Generate a `CLAUDE.md` pointer

`init run` does this as its last step; this section is the individual action. Requires the `env` step above. Idempotent — re-running replaces TAI's own section (found
by an HTML-comment marker) without touching the rest of an existing `CLAUDE.md`.

```bash
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init claude-md [TAI-HOME]
```

`CLAUDE.md` is committed and shared, so the pointer renders a path under your home directory
as `~/...` (e.g. `~/.tai-framework`) rather than `/home/<you>/...` (TAI-359). A project
onboarded before that fix has the old absolute path committed — re-run this step and commit
the diff.

### `GEMINI.md` pointer (TAI-376)

Gemini CLI reads `GEMINI.md`, not `CLAUDE.md`, so a project used from Gemini needs its own
pointer. `init run` writes it, so on a fresh clone (no `.tai/`) or a project that was never
set up on this machine, just run `init run`. To add it to a project already initialized here
without re-running everything, or to refresh it:

```bash
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init gemini-md [TAI-HOME]
```

Same marker-based idempotent merge as `CLAUDE.md` (only TAI's own section is replaced) and
the same prerequisite: an `env` step already recorded in `.tai/init-state.json`, which a fresh
clone doesn't have (the command refuses and points you at `init run`). It records no step of
its own, so `init status` is unaffected.

## Suggested team rituals (not a verified `init` step)

TAI doesn't build or tickle the *schedule* for any of this (human-decided 2026-08-25) —
recurring reminders are a job calendar apps already do well (real notifications,
timezones, snoozing), and reinventing that inside TAI would be worse than just using one.
Worth setting up now, while you're already thinking about how this project runs:

- **A recurring prioritization/planning meeting** — the vehicle for moving tickets
  `Backlog → To Do` (and back, if priorities shift) and for setting/adjusting `Priority`.
  Set yourself a recurring calendar reminder for it; no suggested cadence — whatever fits
  this team. **`/tai-groom` is what Perry brings to that meeting (TAI-389/395, human-decided
  2026-10-02 — this reverses the 2026-08-25 "no planning command" decision).** Run
  `/tai-groom` (the whole board) or `/tai-groom <EPIC-KEY>` (one epic): she shows what
  needs grooming — epics with nothing under them, Kickoff Stories to sequence, Backlog
  tickets whose blockers are done, flagged and stale tickets, tickets that need an
  assignee — and proposes the changes. She creates Backlog tickets, links and phase
  labels on her own; every `Backlog → To Do` move, epic approval, flag, cancel and
  assignment is proposed as a batch and applied only after you confirm. The meeting
  itself, and its cadence, stay yours. A Backlog ticket untouched for 60 days shows up
  as stale; set `TAI_STALE_BACKLOG_DAYS` in `.env` to change that.
- **A recurring standup**, if this team wants one — same reasoning, same "your calendar,
  not TAI's job" answer.

## Checking progress / resuming

```bash
npx --prefix <taiHome> tsx <taiHome>/src/hosts/cli.ts init status
```

Shows which of the five steps (`jira`, `confluence`, `bitbucket`, `env`, `claude-md`) are
already recorded done. Safe to run `/tai-init` (and `init run`) again after any interruption —
`init run` re-verifies every step live rather than trusting this list.

## What's next once "Fully initialized" (TAI-349)

`init status`/`init claude-md` print a next-step hint once every step is done. For a
genuinely fresh project (nothing in Jira yet): run `/tai-kickoff` (TAI-348/450) to have
Perry (PM) start the project, per `personas/pm.md`'s "Project initiation" behavior. She creates the
initial Epic + Kickoff Story and decides which subtasks to start with. For a re-run against
an already-active project, ignore the hint — it's worded to apply either way since this
step has no live check for whether an Epic already exists.

## Out of scope (TAI-90 ADR, TAI-116)

- Full automation of Jira/Confluence admin-level provisioning (issue-type/workflow/screen
  schemes, space creation) — the steps above stay manual in v1.
- Filesystem-only onboarding (brief §3.2's solo-dev fallback) — this checklist is for the
  Jira-backed real-project path only.
- Type-alias mapping (a target project's own native issue-type names → TAI's
  `SubtaskType`/`StoryType`) — TAI-116 piece 4, a separate future ticket once this piece
  lands.
- Retroactively migrating an already-onboarded project's existing setup.
- Windows. `init run`'s editor hand-off avoids hard-coding POSIX, but supported platforms are
  an open decision (TAI-371).
