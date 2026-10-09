# Kickoff Workflow

> Must comply with `PROJECT_BRIEF.md`; re-check before finalizing output (brief §8.25).

## Purpose
Discovery, requirements, and UX design for a new initiative, before any
implementation work is scheduled.

## Story Type
`StoryType.Kickoff`

## Who creates it
**PM** creates the initial Jira shell for a new initiative — an Epic plus this
Kickoff Story (reached through `/tai-kickoff [initiative]`, TAI-348/450, which needs no ticket and
works on a fresh project or one that already has Epics).

**She then front-loads the known subtask chain, in `Backlog`, and links it (TAI-457, human decision
2026-10-08).** Subtasks and their dependencies are created as soon as she is pretty sure they are needed, not
when they are picked up, so nothing can show as ready or get done ahead of its turn — the same rule
`workflows/dependencies.md` applies to a Story's subtasks.

- `Research` — near-always.
- `EpicReview` — always; it is mandatory, so there is nothing to judge. Ada finds it there and no longer
  creates it herself.
- `Requirements` and `UxDesign` — when Perry is pretty sure they are needed.
- A type she is pretty sure is not needed gets a first-line `Skipped:` comment on the Kickoff instead.
- `ArchitectureDesign` stays a later, situational call (see `personas/pm.md` item 7) — judging it before any
  discovery has happened would be speculation.

Right after creating them she runs `link-precedence <KICKOFF-KEY>`, so the blocking links exist from the
start. Creation authority and execution ownership stay separate: `Research` and `EpicReview` still route to
Analyst and `UxDesign` to UX Designer whoever created the ticket. Each type's owning persona can still create
its own if it turns out to be missing, same dedup-search-first mechanics as any other case (see
`personas/pm.md`, `personas/analyst.md`, `personas/ux-designer.md`).

## When the repo already has code: map it first

A project that is onboarded with an existing system gets that system mapped before discovery starts.

- `/tai-kickoff`'s briefing has an "Existing code" section: whether the repo tracks code files, whether a
  mapping Spike already exists, and whether the project has a `project-context.md`.
- On a project's first Kickoff with code and no map, Perry creates a Spike, "Map the existing system", under
  the Epic, with a `Feasibility` subtask owned by the Architect, and links the Kickoff Story as depending on
  it. When the project already has Epics, she asks the human first.
- The Architect's output is the Architecture Overview page and a first draft of `project-context.md`,
  delivered as a PR (`personas/architect.md` item 7).
- The Spike blocks the Kickoff, so `Research` starts from a map of what exists. It uses existing ticket types;
  nothing in the schema is specific to it.

## Who owns it (story-level)
**PM is the default owner/driver of the Kickoff Story itself**, distinct from each
subtask's own persona owner — consistent with PM owning the story-level tickets (brief §3.8):
Perry created the shell and its known subtasks, and drives the story to the
PM+UX review gate. She does not dispatch the subtasks: a human starts each one. **The Kickoff Story's `persona` field defaults to PM** (brief §5.6,
the two-axis owner model) while `Research`/`Requirements`/`UxDesign`/`ArchitectureDesign`
each route to their own persona at the subtask level. The native Jira **Assignee** is a
real human holding the PM Project Role, picked via the assignment-helper (brief §5.6) —
`persona` and `Assignee` are two distinct fields, not the same thing.

## Subtasks

| Subtask | Owner (default) | Notes |
|---|---|---|
| `Research` | Analyst | Market/competitive research, requirements elicitation |
| `EpicReview` | Analyst + human stakeholder | Mandatory, **inherently human-gated** (TAI-354) — a real, per-Epic probing discussion of Research's proposed breakdown, not a rubber-stamp read of the doc; gates `Requirements`/`UxDesign` |
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
TAI. For a Kickoff specifically, `/tai-ready` also has a fallback for a subtask that was not front-loaded:
once a type's prerequisites are all Done it lists the types that are unblocked but not created yet (TAI-373).
A type left out on purpose is silenced with a first-line `Skipped: ux-design — backend-only epic` comment on the Kickoff
(TAI-443, brief §3.9).

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
Done; the transition itself is the signal, no `Approved:` comment marker needed. That is a convention the user is accountable for, not something TAI can prove (brief §4, TAI-454): a persona performs it only when the human says so in their own message, and the CLI then leaves a stamped `Sign-off:` comment (TAI-475). This is
`ALWAYS_HUMAN_GATED_SUBTASKS` (`story-schema.ts`), the same class as `UAT`.

**Out-of-band actions are detected and reflected, never fought** — same TAI-34 principle
already applied to PR reviews/merges (`workflows/story.md`) and `UAT`. However the Done
transition actually happens — the CLI command below, a human clicking the transition
directly in Jira, or another AI session with its own Jira access acting on the human's
behalf — TAI reads the resulting Jira state, not the mechanism that produced it. Nothing
here requires the transition to come from TAI's own `issue transition` command
specifically; that's one concrete way to do it, not the only valid one.

**Not the same gate as the PM+UX Kickoff Review Gate below.** That gate converges the PRD
and UX-flow *artifacts* once they exist; `EpicReview` is upstream of both — it settles the
epic/Story *shape* itself, before PRD/UX-flow work is built against it.

**Reused at the Epic level, not just this initial project-level Kickoff (TAI-354):** when
a specific Epic is to be broken into Stories (`personas/pm.md` item 5), Perry
creates its own Kickoff-type Story under that Epic rather than deciding the breakdown
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
Story/Spike tickets spawned from it through the subtask assessment; Epic shells and per-Epic Kickoff
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
anyway.

**How it is checked.** When the Kickoff Story is moved to Done, `transition()` reads every
Confluence page linked to the Story and refuses the move while any of them contains the
marker, naming each page and question (`storage/review-gate.ts`, the same on both backends).
It scans all linked pages, not only the PRD and UX flows, so Ada's work-breakdown page and
Perry's subtask-assessment page are held to it too. The marker is the two words in capitals;
bold or italics on it, or a line break between the words, does not hide it. A marker inside code formatting (an inline code span or a fenced block)
does not count, so a page can describe the convention. `force=true` does not get past it.

This gives a concrete, gate-checkable stopping point for how deep the
requirements-gathering conversation (`Research`, `Requirements`, `UxDesign`) needs to go:
deep enough that no marker remains, no deeper.

**An edit to a linked page after the gate has passed is shown, and reopens nothing** (brief
§4). When a page linked to a Done Kickoff Story has been updated since that Kickoff's latest
`Approved:` comment, `/tai-ready` and `/tai-groom` list it under "Pages edited after their
Kickoff was approved", for as long as the Kickoff's Epic is open. No step is blocked and no
fresh `Approved:` is required. The human decides whether the change matters; if it does, the
remedy is ordinary work (a comment, a new ticket), not a reopened gate.

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

## Subtask assessment — the WBS (after the review gate, before ticket creation)

Once the PM + UX Designer review gate passes, and before PM creates the actual Story/Spike
tickets, there's one more step: figuring out what subtasks each proposed Story will
actually need.

- **Perry's own assessment (TAI-457).** For each proposed Story she judges whether it needs
  `ArchitectureDesign`, `Database`, `Infra` or a Story-level `UxDesign`, using the bar each owning persona
  publishes in its own doc. It is one pass by one persona — not four independent scans by Architect, DBA,
  DevOps and UX Designer, which is how this step used to be described and never actually ran.
- **Each owner corrects it on pick-up.** When Architect, DBA, DevOps or UX Designer picks up a Story (or one
  of its subtasks) and sees that a subtask of their own type is missing, or present and not needed, they fix
  it there, under the existing create-when-you-know rule (`workflows/dependencies.md`).
- **Informal:** no dedicated subtask or ticket-level artifact for the assessment itself.
- **Batch, not per-Story:** this happens once, across the whole proposed list, because
  individual Story tickets don't exist yet — they're the *output* of this step.
- **Attaches to this Kickoff Story** — same ticket as Ada's work-breakdown doc, either as
  an extension of that page or a sibling page (exact granularity is a later, separate
  question).
- **Clarifying questions** use the framework-wide comment convention: a
  `Q:`-prefixed comment, native Jira reply-threading to keep the discussion together, and
  a closing resolution comment once settled (see design-notes doc for the full mechanism —
  this isn't a dedicated Q&A sibling doc, just comments).
- PM then creates each Story/Spike ticket with its assessed initial subtask set already
  attached (see `personas/pm.md`).
- Independent passes by the owning personas, run as subagents, are a possible later addition (alongside
  TAI-469); they are not part of this step today.

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
(e.g. a `Database` subtask, bypassing the "spawn a Spike instead" rule below). TAI does
**not** block it or remove it — humans can override AI process judgment; TAI's job is
visibility, not enforcement here.

**What is visible:** when a subtask is created through the CLI (`issue create`) and its type
is not listed for its parent's type, the CLI prints a note naming the types that are listed,
and creates the ticket anyway. This holds for Kickoff, Story, Bug and Spike alike. A subtask
created directly under an Epic, or under another subtask, gets a note too: no subtask type
belongs there. A subtask added directly in Jira gets no note; nothing scans for one afterwards.

## Decided: no Feasibility/Database/Infra under Kickoff

`Feasibility`, `Database`, and `Infra` subtasks are **not** allowed under
Kickoff, even for early technical-risk flags. If Kickoff discovery surfaces a
specific technical question that needs an answer before PRD/UX can converge,
the resolution is: **spawn a Spike story, after discovery, assigned to the
appropriate persona, scoped to that one question** — not a subtask bolted
onto the Kickoff story itself. This keeps Kickoff's subtask set to its
discovery/requirements/UX trio and keeps technical investigation in the
workflow built for it.