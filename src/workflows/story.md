# Story Workflow

> Must comply with `PROJECT_BRIEF.md`; re-check before finalizing output (brief §8.25).

## Purpose
Standard implementation work. Uses Jira's native Story type directly
(`StoryType.Story` in the TAI schema — listed explicitly for clarity, not
because TAI overlays anything extra onto Jira's definition).

## Who owns it (story-level)

**PM is the default owner/driver of the Story ticket itself**, same as Kickoff (§2e) —
consistent Orchestrator role throughout the Story's lifecycle, even as individual
subtasks route to their own owners (Developer for `Dev`, Tester for the test tiers,
etc.). The Story's `persona` field stays PM regardless of which subtask is currently
active (brief §5.6, the two-axis owner model) — the native Jira **Assignee** is a
separate field, a real human holding the PM Project Role.

## Subtasks

| Subtask | Owner (default) | Notes |
|---|---|---|
| `Investigate` | Analyst | Optional refinement — adds detail before implementation subtasks are (separately) created; no automatic unblock effect, no formal review gate (brief §3.7, §8.13/§8.17). A reactively-spawned `Investigate` can block its originating subtask via the ad-hoc-dependency escape hatch (`workflows/dependencies.md`) |
| `UxDesign` | UX Designer | Optional — Story-level detailing/tweaking beyond Kickoff's higher-level flows; lets a smaller design doc attach at Story level when Epic-level isn't the right granularity. Gates `Dev`, same as `ArchitectureDesign`/`Database`/`Infra` |
| `ArchitectureDesign` | Architect | Optional — feature-level design before Dev starts, when needed |
| `DesignReview` | Architect (2nd pass or peer) | Optional gate on `ArchitectureDesign`; blocks `Dev` when present — the one Jira-subtask-tracked review gate left after rev 52 (reviews a design doc, not a git PR; no git-host-native equivalent) |
| `Dev` | Developer | Unit tests are folded into this subtask, not tracked separately. Stays **In Progress** until its PR merges (rev 52) — a unit of work isn't done until then |
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
- **Review notes** — rev 52: real PR comments/approval on the git host, not a Jira
  subtask (`DesignReview`'s output, if present, stays a Confluence/Jira artifact — it
  reviews a design doc, not code).
- **Test plans and results** for whichever tiers were present, plus a **UAT plan** and
  human sign-off if present.
- A **deploy runbook** (`Deploy`) and any **PostDeploy** follow-up notes.

A Story's "done" state is the union of its present subtasks reaching Done (plus the
human-gated ones — `UAT` if present — being signed off), not a distinct story-level
artifact the way Kickoff's PRD/UX-flows/WBS batch is.

## Dev → Test Dependency & Failure Loop

**rev 52 (TAI-159 ADR):** an open PR on the `Dev` subtask — not `Dev` reaching Done — is
what unblocks the dependent Test subtask (Integration/System/E2E) to start. `Dev` stays
**In Progress** through the whole review/test span (it doesn't reach Done until its PR
actually merges, see the PR-backed section below), so there's no Dev-Done trigger to wait
on: Tester picks the tier up directly from `/tai-ready`'s `readyToTest` list the moment a
qualifying open PR exists, in parallel with review, not gated behind it.

| Trigger | Test Subtask | Dev Subtask |
|---|---|---|
| `Dev` has an open PR | — | Stays In Progress → Test subtask becomes ready (`readyToTest`), moves to In Progress |
| Test fails | In Progress → **To Do** (the "sent back" status, see Decided below) | Stays **In Progress** — it never left |

There's no "Dev goes back to In Progress" step the way there was under the old
`CodeReview`-gated model — `Dev` never left. A test failure is Developer continuing work
on the same still-open PR, not a fresh investigation; the fix lands as more commits on
that PR, and Tester re-runs the tier once it's ready again.

This loop can repeat any number of times before Test passes.

**When a test tier's own code needs to land, it belongs in the same branch/PR as the
`Dev` work it's testing, landed before that PR is asked for review/merge — not opened as
a follow-on PR after Dev has already merged.** Dev and its test-tier siblings accumulate
onto the same Story branch (brief §6), so this is the natural default, not an extra step:
if a tier's real scope surfaces while Dev's PR is still open, add the test commits to
that same branch before it merges. Discovering the need only after merge is the
exception, not the plan — a small test-only addition can still go straight to `master`
at that point (same risk class as a docs-only commit, no production behavior change)
rather than opening a second full review cycle, but catching it before the PR is even
asked for review is the target.

**Planned (not yet built):** a configurable status-transition mapping, so
a failed test can drive the Dev subtask to a user-specified status instead
of a hardcoded default. Out of scope for v1 — documented here so the
current hardcoded behavior is understood as a placeholder, not a
permanent decision.

## PR-backed checkpoint chain (rev 52, TAI-159 ADR — supersedes the TAI-34 ADR's original
`CodeReview`-subtask design, brief §5.4)

For a repo-touching Story, the review/test/merge chain operates on a real git PR
(`src/core/git/interface.ts`'s `GitHost`), not a Jira `CodeReview` subtask — that subtask
type is retired going forward (still legal in the schema for parsing historical tickets,
never created for new work):

```
[Dev subtask, opens PR] --stays In Progress--> [review (readyToReview) + test tiers (readyToTest), IN PARALLEL] --approved + CI green (readyToMerge)--> [Dev merges own PR, self-closes to Done]
```

- **Dev has code ready (including unit tests)** → Developer calls
  `GitHost.createPullRequest` (source = the Story's branch, brief §6; destination = the
  repo's default branch) — concretely `git-pr create <DEV-SUBTASK-KEY> ...`. The PR links
  **directly to the `Dev` subtask itself** (no `CodeReview` sibling to link to anymore).
  `Dev` **stays In Progress** — it does not go Done here. A unit of work isn't finished
  until it's merged; `Dev`'s own transition to Done is what records that, further down
  this chain.
- **Review and testing now proceed in parallel against this PR, both required before
  merge — testing does not wait on review passing first** (human-confirmed 2026-08-24,
  TAI-160). Two independent live-computed lists, no Jira subtask for either:
  - **`readyToReview`** — any human on the "PR Reviewers" Confluence roster (rev 52,
    separate from the Persona Roster) sees this PR via `/tai-ready` and decides via
    `git-pr review <REPO> [PR-ID] approve|requestChanges [COMMENT]` — roster-gated, not
    persona-gated (no `CodeReview` subtask left to resolve permission through). A
    decision makes one call: `GitHost.reviewPullRequest`, writing the real PR directly —
    there's no parallel Jira subtask write to make alongside it.
  - **`readyToTest`** — Tester picks up the tier via `/tai-ready` the moment `Dev` has a
    qualifying open PR, no approval-count check at all (see the Dev → Test section
    above).
- **Review request-changes** (persona- or human-authored directly on the git host) →
  Developer keeps working the same still-open PR; there's no separate reopen step the way
  there was under the old `CodeReview` model, since `Dev` never left In Progress.
- **Once approved (per the project's configured required-approval count) and CI is
  green** — surfaced as **`readyToMerge`**, a strict subset of `readyToTest`'s candidates
  — **Dev merges his own already-approved work**: `git-pr merge <DEV-SUBTASK-KEY> <REPO>
  ...`, gated on `GitHost.getCommitStatuses` being green first (CI is load-bearing, not
  advisory). Real practice, not self-certification (`cannotApprove: own-output` is
  untouched) — the approval already happened as a separate, independent review action.
  **This same command also transitions the `Dev` subtask itself to Done**, as a second
  write in the same call — the actual completion signal for the unit of work.
- **Out-of-band actions are detected and reflected, never fought** — same stance as brief
  §4's Confluence-gate-reopening rule, now covering the git host too. A human approving/
  requesting-changes directly on Bitbucket is picked up at the next `readyToReview`
  refresh. A human merging the PR directly on Bitbucket (bypassing `git-pr merge`) is
  detected on the next `/tai-ready` refresh and syncs `Dev` to Done the same way —
  extending TAI-34's original "out-of-band review is authoritative" principle from
  reviews to merges of a different subtask type.

See the TAI-159 ADR (Confluence, TA space, ADRs folder) for the full design and the
Context section's account of what prompted the change (a Jira subtask needs exactly one
assignee; a real N-of-M reviewer-approval policy had no honest single assignee for "the"
`CodeReview` subtask). The original TAI-33/TAI-34 ADRs are marked superseded, not
deleted — TAI-34's own out-of-band-human-action principle is kept and extended above, not
replaced. **Historical note:** TAI-37/TAI-38 (this mechanism's own first Story) and every
Story between then and rev 52 shipped through the original `Dev → CodeReview → Merge`
model this section used to describe — real history, not reconstructed, just no longer how
new work goes through this chain.

## Design Review gate (optional)

When present, `DesignReview` sits between `ArchitectureDesign` and `Dev` — the one
Jira-subtask-tracked review gate left after rev 52's `CodeReview` retirement (it reviews
a design document, not a git PR, so there's no git-host-native equivalent to defer to the
way code review now has). It is **optional and present-when-added**: when no `DesignReview`
subtask exists, `ArchitectureDesign` unblocks `Dev` directly (see
`workflows/dependencies.md` — an absent subtask passes its prerequisites through).

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

When present, `UAT` sits after whichever automated test tiers exist on the story (rev 52:
not after `CodeReview`, which no test tier is gated behind anymore — see the Dev → Test
section above), and **gates `Deploy`**. It is **optional and present-when-added**; when
absent, the automated tiers gate `Deploy` directly.

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
whole-story gate (review, `DesignReview`, `UAT` are all subtask/PR-level sign-offs, not a
story-level one). `Canceled` is also available, as an alternate terminal state from
`To Do` or `In Progress` (brief §5.3 rev 16) — for a Story decided against before
completion (deprioritized, superseded, or otherwise not worth finishing).

- **To Do:** created, no present subtask has started.
- **In Progress:** at least one present subtask has started — covers the entire
  `Dev (opens PR, stays In Progress through parallel review+test) → UAT → Deploy →
  PostDeploy` chain, including any Dev ⇄ Test or ArchitectureDesign ⇄ DesignReview
  failure loops. The Story stays In Progress through all of that; loops don't regress the
  story-level status.
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