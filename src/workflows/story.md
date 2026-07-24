# Story Workflow

> Must comply with `PROJECT_BRIEF.md`; re-check before finalizing output (brief §8.25).

## Purpose
Standard implementation work. Uses Jira's native Story type directly
(`StoryType.Story` in the TAI schema — listed explicitly for clarity, not
because TAI overlays anything extra onto Jira's definition).

## Who owns it (story-level)

**PM is the default owner/driver of the Story ticket itself**, same as Kickoff (§2e) —
consistent Orchestrator role throughout the Story's lifecycle, even as individual
subtasks route to their own owners (Developer for `Dev`, Code Reviewer for `CodeReview`,
etc.). The Story's `persona` field stays PM regardless of which subtask is currently
active (brief §5.6, the two-axis owner model) — the native Jira **Assignee** is a
separate field, a real human holding the PM Project Role.

## Subtasks

| Subtask | Owner (default) | Notes |
|---|---|---|
| `Investigate` | Analyst | Optional refinement — adds detail before implementation subtasks are (separately) created; no automatic unblock effect, no formal review gate (brief §3.7, §8.13/§8.17). A reactively-spawned `Investigate` can block its originating subtask via the ad-hoc-dependency escape hatch (`workflows/dependencies.md`) |
| `UxDesign` | UX Designer | Optional — Story-level detailing/tweaking beyond Kickoff's higher-level flows; lets a smaller design doc attach at Story level when Epic-level isn't the right granularity. Gates `Dev`, same as `ArchitectureDesign`/`Database`/`Infra` |
| `ArchitectureDesign` | Architect | Optional — feature-level design before Dev starts, when needed |
| `DesignReview` | Architect (2nd pass or peer) | Optional gate on `ArchitectureDesign` — mirrors `CodeReview`; blocks `Dev` when present |
| `Dev` | Developer | Unit tests are folded into this subtask, not tracked separately |
| `CodeReview` | Code Reviewer | |
| `IntegrationTest` | Tester | |
| `SystemTest` | Tester | |
| `E2ETest` | Tester | |
| `UAT` | Tester + human stakeholder | Optional, **inherently human-gated** (never autocompletes) — gates `Deploy` |
| `Database` | DBA | Schema, migrations, query tuning, performance — not just schema work |
| `Infra` | DevOps | |
| `Deploy` | DevOps (default, overridable) | Manual or gated deployment |
| `PostDeploy` | DevOps (default, overridable) | Manual follow-up work after deployment (e.g. data backfill, flag flip) — owner often varies by what the follow-up actually is |
| `SpikeTask` | No fixed owner — assigned explicitly at creation | Ad-hoc investigation without spinning up a full Spike story |

## Output

Unlike Kickoff, a Story has no single artifact of its own — its output is the aggregate
of whichever subtasks are actually present:

- **The shipped code change** (from `Dev`, including unit tests).
- Any **ADR** (`ArchitectureDesign`), **schema notes/migration plan** (`Database`),
  **infra notes** (`Infra`), or **Story-level UX doc** (`UxDesign`) that were needed.
- **Review notes** (`CodeReview`, and `DesignReview` if present).
- **Test plans and results** for whichever tiers were present, plus a **UAT plan** and
  human sign-off if present.
- A **deploy runbook** (`Deploy`) and any **PostDeploy** follow-up notes.

A Story's "done" state is the union of its present subtasks reaching Done (plus the
human-gated ones — `UAT` if present — being signed off), not a distinct story-level
artifact the way Kickoff's PRD/UX-flows/WBS batch is.

## Dev → Test Dependency & Failure Loop

Dev marking its subtask **Done** is what unblocks the dependent Test
subtask (Integration/System/E2E) to start.

| Trigger | Test Subtask | Dev Subtask |
|---|---|---|
| Dev marks Done | — | Done → Test subtask unblocked, moves to In Progress |
| Test fails | In Progress → **Open** | Done → **In Progress** |

Dev goes back to **In Progress**, not Open — the work already exists and
needs revision, so "Open" would misleadingly suggest nothing's been done.

This loop can repeat any number of times before Test passes.

**Planned (not yet built):** a configurable status-transition mapping, so
a failed test can drive the Dev subtask to a user-specified status instead
of a hardcoded default. Out of scope for v1 — documented here so the
current hardcoded behavior is understood as a placeholder, not a
permanent decision.

## PR-backed checkpoint chain (TAI-34 ADR, brief §5.4 rev 21)

For a repo-touching Story, the `Dev → CodeReview → Merge/Deploy` chain above operates on a
real git PR (`src/core/git/interface.ts`'s `GitHost`), not Jira transitions alone:

```
[Dev subtask] --opens PR--> [CodeReview subtask] --approves PR--> [Merge/Deploy subtask] --merges PR-->
```

- **Dev completes** → Developer calls `GitHost.createPullRequest` (source = the Story's
  branch, brief §6; destination = the repo's default branch), then links the PR to the
  CodeReview subtask via a Jira remote issue link — same mechanism already used to link an
  issue to its Confluence ADR, no new linking primitive. CodeReview becomes actionable, same
  as today.
- **CodeReview actionable** → Code Reviewer reviews the real PR diff (`GitHost`'s PR
  operations), not just Jira ticket content. A decision makes **two calls**: `GitHost.
  reviewPullRequest` (writes the real PR) and `WorkTracker.transition` (writes the Jira
  subtask) — separate backends, one reviewer decision.
- **Review fails** (persona- or human-authored directly on the git host) → unchanged from
  the Dev ⇄ Test loop above: reopen Dev, Jira comment with reviewer notes, retry-once-then-
  escalate.
- **Review passes** → CodeReview done, unblocking Merge/Deploy.
- **Merge/Deploy** → `GitHost.mergePullRequest`, gated on `GitHost.getCommitStatuses` being
  green first — CI is a load-bearing merge gate, not advisory.
- **PR state syncs one-way into the Jira subtask**, at existing refresh points (brief §3.6),
  never the reverse — the Jira subtask stays what TAI's own precedence engine reads. A human
  acting directly on the git host (approve/request-changes/merge) is detected on next
  refresh and reflected, never fought — same stance as brief §4's Confluence-gate-reopening
  rule.

See the TAI-33/TAI-34 ADRs (Confluence, TA space) for the full design. **Bootstrapping
note:** TAI-37/TAI-38 — the Story that builds this mechanism — cannot use it for its own
CodeReview, since it doesn't exist yet until that Story ships; that review goes through the
old Jira-only process.

## Design Review gate (optional)

When present, `DesignReview` sits between `ArchitectureDesign` and `Dev` — the
architecture equivalent of `CodeReview` sitting between `Dev` and the test
tiers. It is **optional and present-when-added**: when no `DesignReview`
subtask exists, `ArchitectureDesign` unblocks `Dev` directly (see
`workflows/dependencies.md` — both edges are kept; the resolver drops whichever
end is absent).

- **Owner:** the Architect persona, but on a **second pass or a peer** — by
  default not the same instance that authored the `ArchitectureDesign`, per the
  soft self-authored-review separation (see `personas/code-reviewer.md`, brief
  §4 / §8.3). This is a default, not a hard lock — a solo architect may review
  their own design.
- **Failure loop:** a failed `DesignReview` sends `ArchitectureDesign` back to
  **In Progress** (not Open — the design already exists and needs revision),
  exactly like the Dev ⇄ Test loop. AI may retry once; a second failure
  escalates to a human (brief §4 / §5.4).

## UAT gate (optional, human-gated)

When present, `UAT` sits after `CodeReview` and whichever automated test tiers
exist on the story, and **gates `Deploy`**. It is **optional and
present-when-added**; when absent, the automated tiers gate `Deploy` directly.

- **Owner:** the Tester persona drives the run, but a **human stakeholder must
  sign off** — `UAT` is **inherently human-gated** (brief §3.3) and **never
  autocompletes**, even where autocompletion is otherwise enabled. A human-gated
  checkpoint takes priority over all autocompletion settings.
- **How sign-off/rejection is recorded:** **approval** is the human transitioning the
  `UAT` subtask to Done themselves — the transition itself is the signal, no comment
  required (a human, not Tessa or any AI persona, must be the one performing it).
  **Rejection** is the human transitioning it back to Open. The routing decision
  (Dev vs. Requirements — see below) is best-effort, not strict: the human is
  *encouraged* to post a comment prefixed `Rejected: Dev` or `Rejected: Requirements`,
  but **can't be relied on to type it reliably every time** — if that marker isn't
  present, TAI falls back to reading whatever comment text exists and infers the
  intended routing from it, escalating to a human for clarification only if the
  comment doesn't give enough signal either way.
- **Failure handling is different from the automated tiers.** A rejected `UAT`
  is **human-adjudicated**, not the automatic single-retry loop: a rejection can
  mean an *implementation* miss (route the `Dev` subtask back to **In Progress**)
  **or** an *acceptance-criteria* gap (route back to **PM/Requirements**). A
  human decides which, recorded per the marker/inference rule above. A rejected
  `UAT` **can** reopen a `Requirements` task, not only `Dev` — the exact trigger/
  authority mechanism (who can cause it, what transition it drives under the hood)
  falls out of the persona-capability design (what each persona may do or cause),
  and is settled there rather than here; this section only fixes how the *human's
  intent* gets captured.

## PostDeploy Failure Handling (D7)

When a `PostDeploy` check surfaces a problem, severity decides the response — **not** a
new `Rollback` subtask/action type:

- **Minor:** `PostDeploy` itself is unaffected (can still complete Done) — DevOps
  **proposes/drafts a linked Bug** capturing the issue, and **PM confirms/creates it**,
  mirroring the propose/create split already used for Spike outcomes and Ada's
  decomposition (see `workflows/spike.md`, `personas/pm.md`).
- **Major/showstopper:** the existing `Deploy` subtask is **reopened to In Progress** —
  same "reopen, don't invent a new artifact" pattern as the Dev ⇄ Test and
  ArchitectureDesign ⇄ DesignReview loops — and DevOps executes the **rollback plan
  that's already part of `Deploy`'s own `deploy-runbook` output** (see
  `personas/devops.md` — the runbook always includes a rollback plan, not just the forward
  deploy steps). `PostDeploy` itself also reopens, since its follow-up work needs
  re-evaluating once the rolled-back `Deploy` completes.

## Status Transitions (story-level)

`To Do → In Progress → Done` — Story's own flow never transitions through `In Review`,
even though that status exists on the issue type (rev 15: Jira's shared default workflow
includes it on every type; TAI's own logic simply never drives a Story into it, per §3.3's
"TAI's plugin layer decides what's meaningful" pattern), since Story has no single
whole-story gate (`CodeReview`/`DesignReview`/`UAT` are all subtask-level sign-offs, not a
story-level one). `Canceled` is also available, as an alternate terminal state from
`To Do` or `In Progress` (brief §5.3 rev 16) — for a Story decided against before
completion (deprioritized, superseded, or otherwise not worth finishing).

- **To Do:** created, no present subtask has started.
- **In Progress:** at least one present subtask has started — covers the entire
  `Dev → CodeReview → Test tiers → UAT → Deploy → PostDeploy` chain, including any
  Dev ⇄ Test or ArchitectureDesign ⇄ DesignReview failure loops. The Story stays
  In Progress through all of that; loops don't regress the story-level status.
- **Done:** every present subtask is Done (or Canceled, brief §5.3 rev 16 — a cancelled
  subtask doesn't block the Story from completing), including `UAT` being signed off if
  present.
- **Canceled:** the Story itself was decided against, independent of any present
  subtasks' own statuses.

## Why no "Defect" subtask
A failed Dev/Test loop before deployment is normal iteration, not a
defect — "Bug"/"Defect" terminology is reserved for issues found *after*
something ships (see `StoryType.Bug`). Reopening the existing Dev subtask
preserves Jira's built-in transition history and worklogs automatically,
so no separate defect-tracking artifact is needed for pre-deployment
rework.

## Decided
- **Reopen/retest count** is derived from Jira's transition history as
  needed (at report time), not tracked via an explicit counter field.
- The Test subtask's "sent back" status is plain **`To Do`** — no distinct
  `Ready for Retest` status.

## Open Questions
- A rejected `UAT` **can** reopen a `Requirements` task (acceptance-criteria
  gap) as well as send `Dev` back — the trigger/authority details are deferred
  to the persona-capability design (what each persona may do or cause), not
  decided here.
- Should `DesignReview` ever be a **required** default (not just optional)
  above some architecture-risk threshold, rather than always present-when-added?