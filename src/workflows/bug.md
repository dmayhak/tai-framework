# Bug Workflow

> Must comply with `PROJECT_BRIEF.md`; re-check before finalizing output (brief §8.25).

## Purpose
Fix an issue found *after* the work has been merged or shipped (TAI-456: a failure found after a Story's merge is
a new linked Bug; nothing reopens that Story's `Dev`). Usually skips
Kickoff — a bug rarely needs fresh research, a PRD, or new UX design; it
needs confirmation, a fix, and verification.

## Story Type
`StoryType.Bug`

## Who creates it
**Both paths are valid, not exclusive:** a human can file a Bug directly, without going
through any persona (brief §3.8) — this is the common case, since bugs are typically
reported by whoever finds them. **PM can also create one, if asked** to do so on a human's
behalf — unlike Epic/Story/Spike, a Bug isn't decomposition-sourced from Ada's proposals,
so PM creating it isn't the primary path the way it is for those (see `personas/pm.md`).

## Who owns it (story-level)

**PM is the default owner/driver of the Bug ticket itself**, same as Kickoff/Story (kept
uniform even though Perry usually isn't the one who filed it — most Bugs are filed
directly by a human, not through PM, brief §3.8) — consistent Orchestrator role
regardless of which subtask (`Triage`, `Dev`, etc.) is currently active. Concretely, the
Bug's `persona` field defaults to PM (brief §5.6, the two-axis owner model); the native
Jira **Assignee** is a separate field, a real human holding the PM Project Role.

## Why Bug is separate from Story
Per the Story workflow doc: Dev/Test failures before the merge are normal
iteration, not defects. "Bug" is reserved specifically for problems found
after the merge. Keeping the vocabulary split this way means any later
reporting on "bug count" or "defect rate" isn't accidentally polluted by
routine dev/test rework loops that happened before anything ever shipped.

## Subtasks

| Subtask | Owner (default) | Notes |
|---|---|---|
| `Triage` | Tester | Entry point — confirms reproduction, assesses severity, identifies root cause. Replaces Research/Requirements/UxDesign as the front door into the ticket. |
| `Investigate` | Analyst | Optional refinement — rarer on a Bug (Triage usually covers it), but available if more detail is needed before Dev |
| `Dev` | Developer | The fix itself. Unit tests folded in, same as Story. Stays **In Progress** until its PR merges (rev 52) — a unit of work isn't done until then |
| `IntegrationTest` / `SystemTest` / `E2ETest` | Tester | Regression coverage — same test tiers as Story, no separate "regression test" type needed |
| `UAT` | Tester + human stakeholder | Optional, **inherently human-gated** — for user-facing fixes where a stakeholder should confirm the fix; before the merge by default, `uat-after-merge` label places it after (see Open Questions) |
| `Database` | DBA | If the bug is data-related |
| `Infra` | DevOps | If the bug is infra-related |
| `Deploy` | DevOps (default, overridable) | Deploys the already-merged fix — may need to be expedited depending on severity |
| `PostDeploy` | DevOps (default, overridable) | Manual follow-up work after deployment (e.g. data backfill, flag flip) — owner often varies by what the follow-up actually is |
| `SpikeTask` | No fixed owner | For root-cause investigation when the fix isn't obvious from Triage alone |

## Output

Same shape as Story (§2b) — the aggregate of whichever subtasks are present, not a
single artifact:

- **Triage notes:** reproduction steps, severity, likely root cause — the Bug's
  front-door artifact, replacing Kickoff's Research/PRD/UX trio.
- **The fix itself** (from `Dev`, including unit tests).
- Any **schema notes/migration plan** (`Database`) or **infra notes** (`Infra`) the fix
  needed.
- **Review notes** — rev 52: real PR comments/approval on the git host, not a Jira
  subtask (see `workflows/story.md`'s PR-backed section).
- **Test/regression results** for whichever tiers were present, plus a **UAT plan** and
  human sign-off if present.
- A **deploy runbook** (`Deploy`) and any **PostDeploy** follow-up notes.

## Entry Point: Triage
Triage stands in for Kickoff's Research/Requirements/UxDesign trio. It
answers three questions before Dev starts:
1. Can we reproduce it?
2. How severe is it?
3. What's the likely root cause?

**Severity vs. Priority — two different axes, both set during Triage:**
`Bug.severity` (custom field) is *impact* — how bad the issue is (e.g. data loss vs.
cosmetic). Jira's native `Priority` is *urgency* — how fast it should be worked/deployed,
and specifically **Priority=1 (Urgent/Emergency) is what triggers the expedited path**
below. They often correlate but aren't the same field — a low-priority bug can still be
high-severity if nobody's demanding an immediate fix yet.

If root cause isn't clear from Triage alone, a `SpikeTask` subtask can be
added for deeper investigation — same pattern as Story's ad-hoc SpikeTask
usage.

## Status Transitions (story-level)

Same 3-state flow as Story: `To Do → In Progress → Done`, plus `Canceled` as an
alternate terminal state (brief §5.3 rev 16) — e.g. a reported Bug that turns out to be
"working as intended," a duplicate, or otherwise not worth fixing.

- **To Do:** reported, `Triage` hasn't started.
- **In Progress:** `Triage` or any later subtask is underway — covers the whole chain
  including failure loops and the D5 expedited path.
- **Done:** every present subtask is Done, including `UAT` sign-off if present.
- **Canceled:** the Bug was decided against — not a fix, a duplicate, or otherwise
  won't-fix — typically straight from Triage.

## Dev → Test Failure Loop
Identical to the Story workflow (rev 52): an open PR on `Dev` — not `Dev` reaching
Done — is what unblocks Test; `Dev` stays In Progress through the whole review/test span,
so a failed test just sends the test-tier subtask back to **To Do** while `Dev` keeps
working the same still-open PR (it never left In Progress to begin with). The rest of the
sequence is the Story's too (brief §5.4, TAI-456): test code in the `Dev` PR, a tier Done on a pass, the
`Dev` owner merges through the merge gate, `Deploy` ships what is merged, and a failure after the merge is
another linked Bug. See the Story workflow doc's "The sequence" and "Dev → Test Dependency & Failure Loop"
sections.

## Expedited Path (Urgent/Emergency Bugs)

**Decided:** a Bug with Jira **Priority = 1 (Urgent/Emergency, native Jira value
`"Highest"`)** gets an expedited subtask chain — this is the existing native Jira field
being used as the severity signal, not a new custom field.

- **Review always stays mandatory**, regardless of priority — code still gets reviewed
  under time pressure. This isn't a subtask to skip, it's structural — the merge gate behind `git-pr
  merge`/`readyToMerge` requires the configured number of fresh approvals whatever the priority; the only way
  past it is the stamped `force=true` override (brief §5.4, TAI-462).
- **Test tiers compress to just one** — `IntegrationTest` — instead of running all
  present tiers (`SystemTest`/`E2ETest` are skipped). **Implemented (TAI-119):**
  `defaultTestTiersForBug(priority)` (`src/core/schema/story-schema.ts`) is the concrete
  recommendation Triage consults when deciding which test-tier subtasks to create —
  guidance at creation time, not a hard resolver-level gate (the precedence graph
  already handles a skipped tier correctly once it's simply never created). Whoever
  triages can override the recommendation and create `SystemTest`/`E2ETest` anyway if
  `IntegrationTest` genuinely isn't the right check for this specific fix.
- `Deploy`/`PostDeploy` are unaffected — still run as normal.

## Open Questions
- **Decided:** a Bug never requires a Kickoff-style review gate, regardless of
  product/UX impact. Tester sign-off on `Triage` is always sufficient to
  proceed straight to Dev. (An optional `UAT` gate still covers the *tail* —
  stakeholder acceptance before the fix ships — but there is no front-end
  gate before Dev starts.)
- **Resolved (D7):** a `PostDeploy` failure's severity decides the response — minor
  spawns a linked Bug (DevOps proposes/drafts it, PM confirms/creates it — not fully
  automatic, not manual-only) while major/showstopper reopens `Deploy` to run its
  existing rollback plan. No new `Rollback` type. See `workflows/story.md` — same
  handling applies to a Bug's own `Deploy`/`PostDeploy` subtasks.