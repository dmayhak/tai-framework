# Kickoff Workflow

## Purpose
Discovery, requirements, and UX design for a new initiative, before any
implementation work is scheduled.

## Story Type
`StoryType.Kickoff`

## Who creates it
**PM** creates the initial Jira shell for a new initiative — an Epic plus this
Kickoff Story — then identifies which of the subtasks below are appropriate to
start (typically at least `Research`). Each subtask is created by its owning
persona once invoked, same as everywhere else — PM creates the container, not
the subtasks (see `personas/pm.md`, `personas/analyst.md`).

## Who owns it (story-level)
**PM is the default owner/driver of the Kickoff Story itself**, distinct from each
subtask's own persona owner — consistent with PM's Orchestrator role (brief §3.8):
Perry created the shell, sequences which subtasks start, and drives the story to the
PM+UX review gate. **The Kickoff Story's `persona` field defaults to PM** (brief §5.6,
the two-axis owner model) while `Research`/`Requirements`/`UxDesign`/`ArchitectureDesign`
each route to their own persona at the subtask level. The native Jira **Assignee** is a
real human holding the PM Project Role, picked via the assignment-helper (brief §5.6) —
`persona` and `Assignee` are two distinct fields, not the same thing.

## Subtasks

| Subtask | Owner (default) | Notes |
|---|---|---|
| `Research` | Analyst | Market/competitive research, requirements elicitation |
| `Requirements` | PM | PRD drafting |
| `UxDesign` | UX Designer | Flows, wireframes, mockups |
| `ArchitectureDesign` | Architect | Optional — only when the initiative has enough technical risk to warrant early design input |

## Subtask Precedence

`Research` unblocks `Requirements` and `UxDesign` in parallel. When `ArchitectureDesign`
is used, it waits on **both** `Requirements` and `UxDesign` being Done, not just
`Requirements` — flows and requirements are expected to converge before the Architect
finalizes any design (see `personas/ux-designer.md`).

## Review Gate
**Required reviewers:** PM + UX Designer

The Kickoff story cannot spawn Story/Spike tickets until PM and UX Designer
sign off that the PRD and UX artifacts are ready to build against.

**Decided:** the gate stays fixed at **PM + UX Designer**, always — even when
`ArchitectureDesign` was used during Kickoff. The Architect is never added as
a required reviewer for this gate.

**How sign-off is recorded:** no custom Jira field. Each required reviewer posts a
comment prefixed `Approved:` (optionally with notes) on the Kickoff Story. TAI's plugin
layer scans for one `Approved:` comment from each persona in `REVIEW_GATES[Kickoff]
.requiredReviewers` (PM and UX Designer) before allowing Story/Spike tickets to be
created — symmetric with the framework-wide `Q:` open-question convention (see
design-notes doc). **The commenting human must also hold that persona's Jira Project
Role** (brief §5.6) — this is how TAI verifies a comment actually counts as "the PM" or
"the UX Designer" signing off, not just anyone typing the marker.

**An edit to the PRD or UX-flow Confluence pages after the gate has already passed
reopens it** (brief §6, rev 11) — detected the same way any staleness is detected
(cached `lastUpdated` vs. source, brief §3.6/§7). TAI flags it and requires fresh
`Approved:` sign-off from both PM and UX Designer before any further downstream step
that depends on this gate (e.g. creating additional Story/Spike tickets from the WBS)
proceeds. Already-created Story/Spike tickets aren't retroactively undone — this only
blocks *further* gate-dependent steps, not work already spawned.

## Output
- **Work-breakdown doc** (owned by Analyst) — a Confluence page attached to the Kickoff
  Story from the `Research` subtask, proposing the initial Epic/Story decomposition; feeds
  the PRD and UX work below.
- PRD (owned by PM)
- UX flows/mockups (owned by UX Designer)
- Optional early architecture notes (if `ArchitectureDesign` was used)
- **Subtask WBS** — see below
- One or more Story/Spike tickets, created after the review gate passes, each with its
  assessed initial subtask set already attached

## WBS assembly (after the review gate, before ticket creation)

Once the PM + UX Designer review gate passes, and before PM creates the actual Story/Spike
tickets, there's one more step: figuring out what subtasks each proposed Story will
actually need.

- **Independent scan, not a joint pass:** Architect, DBA, DevOps, and UX Designer each
  review Ada's whole proposed Story list on their own, checking only for their own subtask
  type — does this Story need `ArchitectureDesign`? `Database`? `Infra`? Story-level
  `UxDesign`? Each persona already owns this judgment call reactively elsewhere (see their
  respective persona files); this is the same judgment made proactively and upfront.
- **Informal:** no dedicated subtask or ticket-level artifact for the scan itself.
- **Batch, not per-Story:** this happens once, across the whole proposed list, because
  individual Story tickets don't exist yet — they're the *output* of this step.
- **Attaches to this Kickoff Story** — same ticket as Ada's work-breakdown doc, either as
  an extension of that page or a sibling page (exact granularity is a later, separate
  question).
- **Clarifying questions** during the scan use the framework-wide comment convention: a
  `Q:`-prefixed comment, native Jira reply-threading to keep the discussion together, and
  a closing resolution comment once settled (see design-notes doc for the full mechanism —
  this isn't a dedicated Q&A sibling doc, just comments).
- PM then creates each Story/Spike ticket with its assessed initial subtask set already
  attached (see `personas/pm.md`).

## Naming Convention

No enforced title prefix (e.g. no "[Kickoff]" tag). Jira's native issue-type field
already carries the `StoryType.Kickoff` signal; the title is just a descriptive
initiative name (e.g. "Mobile checkout redesign"). **This is a general rule, not
Kickoff-specific** — expected to apply to Story/Bug/Spike titles too; confirm when
reviewing those story types rather than assuming a different convention there.

## Status Transitions (story-level)

`Open → In Progress → In Review → Done`

- **Open:** PM has created the shell; no subtask work has started.
- **In Progress:** at least one of `Research`/`Requirements`/`UxDesign`/`ArchitectureDesign`
  is underway.
- **In Review:** all present subtasks are Done; waiting on the PM+UX `Approved:` gate
  (see Review Gate above).
- **Done:** gate passed, Story/Spike tickets created from the WBS.

## Human Overrides (unforeseen subtask types)

A human can add a subtask type outside `STORY_SUBTASK_MAP[Kickoff]` directly in Jira
(e.g. a `Database` subtask, bypassing the "spawn a Spike instead" rule below). TAI
**flags it on the next refresh** (comment/journal note to whoever's driving the Kickoff)
but does **not** block progress or auto-remove it — humans can override AI process
judgment; TAI's job is visibility, not enforcement here. Same pattern as D13's
"create/adjust and flag" for late-arriving precedence edges (`workflows/dependencies.md`).
This is expected to generalize to Story/Bug/Spike, not just Kickoff.

## Decided: no Feasibility/Database/Infra under Kickoff

`Feasibility`, `Database`, and `Infra` subtasks are **not** allowed under
Kickoff, even for early technical-risk flags. If Kickoff discovery surfaces a
specific technical question that needs an answer before PRD/UX can converge,
the resolution is: **spawn a Spike story, after discovery, assigned to the
appropriate persona, scoped to that one question** — not a subtask bolted
onto the Kickoff story itself. This keeps Kickoff's subtask set to its
discovery/requirements/UX trio and keeps technical investigation in the
workflow built for it.