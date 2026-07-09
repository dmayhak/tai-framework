# Story Workflow

## Purpose
Standard implementation work. Uses Jira's native Story type directly
(`StoryType.Story` in the TAI schema — listed explicitly for clarity, not
because TAI overlays anything extra onto Jira's definition).

## Subtasks

| Subtask | Owner (default) | Notes |
|---|---|---|
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
| `Spike` | No fixed owner — assigned explicitly at creation | Ad-hoc investigation without spinning up a full Spike story |

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
- **Failure handling is different from the automated tiers.** A rejected `UAT`
  is **human-adjudicated**, not the automatic single-retry loop: a rejection can
  mean an *implementation* miss (route the `Dev` subtask back to **In Progress**)
  **or** an *acceptance-criteria* gap (route back to **PM/Requirements**). A
  human decides which. A rejected `UAT` **can** reopen a `Requirements` task, not
  only `Dev` — the exact mechanism (who can trigger it, what transition it drives)
  falls out of the persona-capability design (what each persona may do or cause),
  and is settled there rather than here.

## Why no "Defect" subtask
A failed Dev/Test loop before deployment is normal iteration, not a
defect — "Bug"/"Defect" terminology is reserved for issues found *after*
something ships (see `StoryType.Bug`). Reopening the existing Dev subtask
preserves Jira's built-in transition history and worklogs automatically,
so no separate defect-tracking artifact is needed for pre-deployment
rework.

## Open Questions
- Should reopen/retest count be derived from Jira's transition history at
  report time, or does it need an explicit counter field on the subtask?
- Should the Test subtask's "sent back" status be a plain `Open`, or a
  distinct `Ready for Retest` status so the board reflects that this
  isn't untouched work?
- A rejected `UAT` **can** reopen a `Requirements` task (acceptance-criteria
  gap) as well as send `Dev` back — the trigger/authority details are deferred
  to the persona-capability design (what each persona may do or cause), not
  decided here.
- Should `DesignReview` ever be a **required** default (not just optional)
  above some architecture-risk threshold, rather than always present-when-added?