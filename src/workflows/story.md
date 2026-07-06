# Story Workflow

## Purpose
Standard implementation work. Uses Jira's native Story type directly
(`StoryType.Story` in the TAI schema — listed explicitly for clarity, not
because TAI overlays anything extra onto Jira's definition).

## Subtasks

| Subtask | Owner (default) | Notes |
|---|---|---|
| `ArchitectureDesign` | Architect | Optional — feature-level design before Dev starts, when needed |
| `Dev` | Developer | Unit tests are folded into this subtask, not tracked separately |
| `CodeReview` | Code Reviewer | |
| `IntegrationTest` | Tester | |
| `SystemTest` | Tester | |
| `E2ETest` | Tester | |
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