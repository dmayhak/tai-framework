# Kickoff Workflow

> Must comply with `PROJECT_BRIEF.md`; re-check before finalizing output (brief §8.25).

## Purpose
Discovery, requirements, and UX design for a new initiative, before any
implementation work is scheduled.

## Story Type
`StoryType.Kickoff`

## Who creates it
**PM** creates the initial Jira shell for a new initiative — an Epic plus this
Kickoff Story — then, per the general TAI-83 "Eager Subtask Creation" exception
(`workflows/dependencies.md`), creates whichever of the subtasks below she's already
judged appropriate to start (rev 66, found live 2026-09-24 — supersedes the prior
"PM creates the container, not the subtasks" framing, which contradicted TAI-83's own
rule the same way TAI-317/rev-57 already fixed once for `Investigate`/
`ArchitectureDesign`). `Research` is typically startable immediately and `UxDesign` follows `EpicReview` (TAI-354), so Perry usually creates both directly once she judges them needed — creation
authority and execution ownership stay separate axes, so `Research` still routes to
Analyst and `UxDesign` to UX Designer regardless of who created the ticket. `Requirements`
is Perry's own type but precedence-blocked behind `Research` and `EpicReview`, so it's
created naturally when she starts PRD drafting, not at this initial moment.
`ArchitectureDesign` stays a later, situational call (see `personas/pm.md` item 7) —
judging whether it's warranted this early, before any real discovery has happened, would
be speculation, not the real judgment TAI-83 requires. **`EpicReview` is different from
all of these: Perry doesn't create it at this initial moment.** Ada creates it herself the
moment her Research proposal exists (`personas/analyst.md` item 3, TAI-354) — it isn't a
judgment call Perry is positioned to make this early, and it only ever makes sense once
there's a proposal to review. (Perry's grant does allow her to create one later, once she
actually knows an `EpicReview` is needed — TAI-389/394, human, 2026-10-05; this sentence is
about the Kickoff moment, not a prohibition.) Each other subtask type's owning persona can still create its own if Perry hasn't
already, same dedup-search-first mechanics as any other TAI-83 case (see `personas/pm.md`,
`personas/analyst.md`, `personas/ux-designer.md`).

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
| `EpicReview` | Analyst + human stakeholder | Mandatory, **inherently human-gated** (never autocompletes, TAI-354) — a real, per-Epic probing discussion of Research's proposed breakdown, not a rubber-stamp read of the doc; gates `Requirements`/`UxDesign` |
| `Requirements` | PM | PRD drafting |
| `UxDesign` | UX Designer | Flows, wireframes, mockups |
| `ArchitectureDesign` | Architect | Optional — only when the initiative has enough technical risk to warrant early design input |

## Subtask Precedence

`Research` unblocks `EpicReview`. `EpicReview` — not `Research` directly — unblocks
`Requirements` and `UxDesign` in parallel (TAI-354): PRD/UX-flow work shouldn't start
against an epic shape that's still being probed and potentially revised. When
`ArchitectureDesign` is used, it waits on **both** `Requirements` and `UxDesign` being
Done, not just `Requirements` — flows and requirements are expected to converge before the
Architect finalizes any design (see `personas/ux-designer.md`).

**Satisfying an edge above doesn't trigger anything on its own** — see
`workflows/dependencies.md`'s Layer 2 note (TAI-355): the next `/tai-work`/`/tai-ready`
invocation is what actually re-engages a persona to continue, same as everywhere else in
TAI. For a Kickoff specifically, `/tai-ready` now says what to run next: once a prerequisite
is Done it lists the subtask types that are unblocked but not created yet (TAI-373).

## EpicReview gate (mandatory, human-gated, TAI-354)

Found live (2026-09-25, EXA): Ada's proposed Epic/Story breakdown was written to
Confluence and immediately treated as settled — the very next thing surfaced as ready to
work was a Kickoff-subtask-level `ArchitectureDesign` deep-dive, with no step in between
where a human had actually discussed the breakdown itself. A human reading the doc and
clicking "looks good, approve" isn't rigorous enough on its own; real issues surface later
that genuine probing, epic by epic, would have caught up front.

**Mechanism (mirrors `workflows/story.md`'s `UAT` gate exactly):** Ada drives the
conversation — goes through the proposed breakdown one entry at a time, probes for
missing/incorrectly-scoped/incorrectly-sequenced epics, and revises the *same*
work-breakdown Confluence doc in place as questions resolve — but **cannot complete or
sign off `EpicReview` herself**. Only the human stakeholder can transition the subtask to
Done; the transition itself is the signal, no `Approved:` comment marker needed. This is
`ALWAYS_HUMAN_GATED_SUBTASKS` (`story-schema.ts`), same enforcement class as `UAT` —
never autocompletes, regardless of any autocompletion setting.

**Out-of-band actions are detected and reflected, never fought** — same TAI-34 principle
already applied to PR reviews/merges (`workflows/story.md`) and `UAT`. However the Done
transition actually happens — the CLI command below, a human clicking the transition
directly in Jira, or another AI session with its own Jira access acting on the human's
behalf — TAI reads the resulting Jira state, not the mechanism that produced it. Nothing
here requires the transition to come from `npx tsx src/hosts/cli.ts issue transition`
specifically; that's one concrete way to do it, not the only valid one.

**Not the same gate as the PM+UX Kickoff Review Gate below.** That gate converges the PRD
and UX-flow *artifacts* once they exist; `EpicReview` is upstream of both — it settles the
epic/Story *shape* itself, before PRD/UX-flow work is built against it.

**Reused at the Epic level, not just this initial project-level Kickoff (TAI-354):** when
Perry later decomposes a specific Epic into Stories (`personas/pm.md` item 5), that pass
now creates its own Kickoff-type Story under that Epic rather than deciding the breakdown
solo — the same `Research` → `EpicReview` sequence applies there too, scoped to one Epic
instead of the whole project.

## Epic shells, per-Epic Kickoffs, and this gate (TAI-374/387)

Epics are created **as they are agreed**, not after this whole Kickoff finishes (ADR Confluence
page 47349832 rev 4). During `EpicReview` Ada creates each agreed Epic as a **Backlog shell** and
records its Jira key in the work-breakdown doc's Epic table at once (the doc stays canonical;
the ticket carries a short summary and a link to its section). Perry then gives every Epic its
own Kickoff Story (`personas/pm.md` item 5) and the Stories/tasks already known, all in
`Backlog` — an Epic is not left empty. **Epic status describes readiness:** `Backlog` =
proposed and being fleshed out, `To Do` = fleshed out and approved to build, `In Progress` =
building. A Kickoff Story starting work or being scheduled **never moves its Epic**; every
other child still does (`cascade-gate.ts`, `upwardCascadeTarget`). **None of this is gated by
the review gate below:** that gate governs THIS Kickoff Story's own `Done` transition and the
Story/Spike tickets spawned from it through WBS assembly; Epic shells and per-Epic Kickoff
Stories sit outside it, and each per-Epic Kickoff has its own gate when it needs one.

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
design-notes doc). **The commenting human must also appear in the Persona Roster**
(brief §5.6, rev 12 — TAI's own roster, not a native Jira Project Role; free-tier Jira
can't create those) **under that persona** — this is how TAI verifies a comment actually
counts as "the PM" or "the UX Designer" signing off, not just anyone typing the marker.

**Gate also requires zero unresolved `NEEDS CLARIFICATION` markers (rev 23, brief §8.21).**
While drafting, PM (PRD) and UX Designer (UX flows) mark any genuine gap inline with
`NEEDS CLARIFICATION: <question>` rather than guessing or silently glossing over it — the
same "don't guess, mark it" discipline the brief adopted from GitHub Spec Kit. The gate is
mechanically blocked while either doc still contains an unresolved marker, in addition to
needing both required `Approved:` comments — a marker is resolved by editing it out once
the question is actually answered, not by a reviewer simply noticing it and approving
anyway. This gives a concrete, gate-checkable stopping point for how deep the
requirements-gathering conversation (`Research`, `Requirements`, `UxDesign`) needs to go:
deep enough that no marker remains, no deeper.

**An edit to the PRD or UX-flow Confluence pages after the gate has already passed
reopens it** (brief §6, rev 11) — detected the same way any staleness is detected
(cached `lastUpdated` vs. source, brief §3.6/§7). TAI flags it and requires fresh
`Approved:` sign-off from both PM and UX Designer before any further downstream step
that depends on this gate (e.g. creating additional Story/Spike tickets from the WBS)
proceeds. Already-created Story/Spike tickets aren't retroactively undone — this only
blocks *further* gate-dependent steps, not work already spawned.

## Output
- **Work-breakdown doc** (owned by Analyst) — a Confluence page attached to the Kickoff
  Story from the `Research` subtask, proposing the initial Epic/Story decomposition;
  revised in place during `EpicReview`; feeds the PRD and UX work below only once
  `EpicReview` is Done.
- **EpicReview sign-off** — no doc of its own; the human stakeholder's own transition of
  the subtask to Done (TAI-354).
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

`To Do → In Progress → In Review → Done`, plus `Canceled` as an alternate terminal state
reachable from `To Do`, `In Progress`, or `In Review` (brief §5.3 rev 16) — e.g. the
initiative itself gets deprioritized before discovery concludes.

- **To Do:** PM has created the shell; no subtask work has started.
- **In Progress:** at least one of
  `Research`/`EpicReview`/`Requirements`/`UxDesign`/`ArchitectureDesign` is underway.
- **In Review:** all present subtasks are Done; waiting on the PM+UX `Approved:` gate
  (see Review Gate above).
- **Done:** gate passed, Story/Spike tickets created from the WBS.
- **Canceled:** the Kickoff itself was called off before reaching the review gate.

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