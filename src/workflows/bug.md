# Bug Workflow

## Purpose
Fix an issue found *after* something has already shipped. Usually skips
Kickoff — a bug rarely needs fresh research, a PRD, or new UX design; it
needs confirmation, a fix, and verification.

## Story Type
`StoryType.Bug`

## Why Bug is separate from Story
Per the Story workflow doc: pre-deployment Dev/Test failures are normal
iteration, not defects. "Bug" is reserved specifically for problems found
post-deployment. Keeping the vocabulary split this way means any later
reporting on "bug count" or "defect rate" isn't accidentally polluted by
routine dev/test rework loops that happened before anything ever shipped.

## Subtasks

| Subtask | Owner (default) | Notes |
|---|---|---|
| `Triage` | Tester | Entry point — confirms reproduction, assesses severity, identifies root cause. Replaces Research/Requirements/UxDesign as the front door into the ticket. |
| `Dev` | Developer | The fix itself. Unit tests folded in, same as Story. |
| `CodeReview` | Code Reviewer | |
| `IntegrationTest` / `SystemTest` / `E2ETest` | Tester | Regression coverage — same test tiers as Story, no separate "regression test" type needed |
| `UAT` | Tester + human stakeholder | Optional, **inherently human-gated** — for user-facing fixes where a stakeholder should confirm the fix before it ships (see Open Questions) |
| `Database` | DBA | If the bug is data-related |
| `Infra` | DevOps | If the bug is infra-related |
| `Deploy` | DevOps (default, overridable) | Fix deployment — may need to be expedited depending on severity |
| `PostDeploy` | DevOps (default, overridable) | Manual follow-up work after deployment (e.g. data backfill, flag flip) — owner often varies by what the follow-up actually is |
| `Spike` | No fixed owner | For root-cause investigation when the fix isn't obvious from Triage alone |

## Entry Point: Triage
Triage stands in for Kickoff's Research/Requirements/UxDesign trio. It
answers three questions before Dev starts:
1. Can we reproduce it?
2. How severe is it?
3. What's the likely root cause?

If root cause isn't clear from Triage alone, a `Spike` subtask can be
added for deeper investigation — same pattern as Story's ad-hoc Spike
usage.

## Dev → Test Failure Loop
Identical to the Story workflow: Dev marks Done to unblock Test; a failed
test sends Test back to Open and Dev back to In Progress (not Open). See
the Story workflow doc for the full rationale.

## Open Questions
- Should a severe/hotfix bug get an expedited path — e.g. skip full
  CodeReview, or compress test tiers down to just one — rather than
  always running the full subtask chain?
- Should a Bug ever require a Kickoff-style review gate (e.g. when the
  fix has real product or UX impact), or is Tester sign-off on Triage
  always sufficient to proceed straight to Dev? (Note: an optional `UAT`
  gate now covers the *tail* of this — stakeholder acceptance before the
  fix ships — but not a *front-end* gate before Dev starts.)
- Should a failed `PostDeploy` check on a Story be able to auto-spawn a
  linked Bug story, rather than relying on someone noticing and creating
  it manually?