# Perry (PM) — rationale and history

This file is not loaded at run time. `../pm.md` is the run-time prompt and states the rules as current
fact; this file says why they are what they are. Where the two disagree, the prompt wins.

## Decomposition follows one shape (brief §3.7 rev 70; TAI-354; TAI-457)

Perry used to decompose an Epic into Stories herself, in one turn, with no separate proposal (rev 43).
Found live on 2026-09-25 on the first target project: a human reading a proposed breakdown and
clicking "looks good" was not rigorous enough. Since TAI-354 every Epic that needs decomposing gets its
own Kickoff Story, with Ada's `Research` and a human-gated `EpicReview`. TAI-457 (2026-10-08) removed
the leftover "Perry decomposes solo" text from this doc, the front matter and brief §3.7.

## "Orchestrator" (TAI-457)

Earlier text described Perry as an Orchestrator that dispatches work to other personas. Nothing in
TAI does that: a human starts every piece of work. The term was kept and redefined (brief §3.8,
glossary) as owning the story-level tickets and running grooming.

## Elicitation, not direction; pace choice; acceptance criteria (TAI-147/TAI-148)

All from Perry's persona review.

- Elicitation: the vision being drawn out is the human's.
- Fast path / Coaching path: Fast changes how the questions are paced, never whether gaps are asked
  about.
- `NEEDS CLARIFICATION:` markers are deliberately uncapped. A Spec Kit-style "max 3, prioritized, guess
  the rest" cap was considered and rejected: rolling-wave decomposition (brief §3.7 rev 58) is the real
  escape valve, since a far-future Story stays a shallow Backlog shell. The markers blocking the
  Kickoff gate is brief §8 item 21.
- The acceptance-criteria discipline, Future Considerations (fed by Ada's and Aria's
  future-direction questions) and Explicitly Out of Scope sections.

## Open ideas become Backlog tickets (TAI-286)

This was already the practice (TAI-115, TAI-189, TAI-230) before it was written down; TAI-286
formalized it. Brief §8 stays for questions that need a decision before a ticket makes sense.

## Skipped: marker (TAI-443)

A Kickoff that deliberately skips `Requirements` or `UxDesign` kept being nagged by `/tai-ready`'s
"Subtasks ready to create" hint. The marker silences it. No confirmation gate because it is
reversible and only silences a hint.

## Project initiation

- `/tai-kickoff` (TAI-348/TAI-450) is the entry point. Before it, the only way in was asking an
  assistant in plain language to "act as Perry". It works on any project, not only an empty one.
- **Front-loading the Kickoff chain (TAI-457, human decision 2026-10-08).** Before this, Perry created
  `Research` eagerly and judged `UxDesign`; `EpicReview` was created by Ada when she reached it, and
  links were added as subtasks appeared. That let work show as ready, or get done, ahead of its turn.
  Now the known chain is created and linked at initiation. The precedence resolver passing an absent
  subtask's prerequisites through (TAI-463) is the safety net for a subtask added later, not the plan.
- Perry's `create` grant covers `Kickoff` and every live subtask type (rev 76, TAI-389/TAI-394),
  aligned with the TAI-83 rule that any persona may create a subtask once it has real, in-context
  judgment that it is needed. `ArchitectureDesign` at Kickoff is left for later because judging it
  before discovery would be the blind pre-population TAI-83 rules out.

- **The mapping Spike (TAI-471; shape agreed 2026-10-08).** A brownfield project's existing system is
  mapped before discovery, adapted from GSD's `map-codebase` and BMAD's `document-project`. The kickoff
  command detects tracked code files and an existing mapping Spike, so the rule is not left to memory.
  Perry asks first on a project that already has Epics because work has plainly gone on without a map
  there, and a Spike that blocks a new Kickoff should be the human's choice.

## The Kickoff gate comment (TAI-454, TAI-475)

TAI cannot prove who posted `Approved:`; the CLI and the human share one Jira identity. It is a
convention the user is accountable for, made visible by the CLI's stamp.

## Issue creation and the subtask assessment

- **The WBS is Perry's own assessment (TAI-457).** It was described as four personas (Architect, DBA,
  DevOps, UX) each scanning the proposed Stories. In practice one session acting as Perry did it. Each
  owner now corrects it on pick-up.
- `link-precedence` retries against Jira Cloud's eventually consistent search index (TAI-118).
- `Dev` no longer blocks a `CodeReview` subtask: retired in rev 52 (TAI-159 ADR); review readiness is
  the git host's live PR state.
- Near-term Stories in `To Do`, the rest in `Backlog`: TAI-292.
- The `Q:` convention is brief §3.9 (it used to be cited from the design-notes doc).

## Never leave an Epic empty (TAI-374/TAI-387, ADR Confluence page 47349832 rev 4)

Ada creates an Epic shell when it is agreed; an Epic with no children used to sit invisible. The Flag
mechanic for an external wait and the "On hold" section are TAI-390. "Scheduling the first wave is
approval to build" is human-approved, not necessarily human-only, and is a convention with no code
gate. The fuller grooming process was designed in TAI-389.

## Rolling-wave depth (brief §3.7 rev 58, TAI-147/TAI-148)

No fixed lookahead count, because TAI cannot know a team's capacity in advance. Pulling a Story to
full depth early, and creating a known refinement subtask for a shallow Story, are the TAI-83
eager-creation posture applied one level up.

## Spike ownership (brief §3.1 rev 45)

Perry owns Spike stories and confirms the outcome. Naming the optional subtask types considered for a
Story created from a Spike comes from the TAI-83 ADR: named, not silently skipped.

## Creating Investigate / ArchitectureDesign (brief §8 item 13; rev 57, TAI-317)

The earlier convention was that Perry only flagged the need and the Analyst or Architect created the
subtask. Two live incidents (TAI-280/TAI-300 and TAI-281) had the human direct Perry to create them
directly. It is now the general TAI-83 exception. What formally marks a Story ready for
implementation was the other half of item 13, resolved as "no formal marker".

## Grooming (TAI-389/TAI-395, ADR Confluence page 48463873)

- It reverses the 2026-08-25 decision that TAI builds no planning command: the planning meeting stays
  the human's cadence, and this is what Perry brings to it.
- "Show the briefing first", verbatim, with no question in the same turn: TAI-423. A tool call's
  output is not reliably visible to the human, and a session had summarized the briefing and asked for
  confirmation in one turn.
- The authority split is ADR decision 3; reconciling the work-breakdown document by reading, not by a
  parser, is decision 12.
- The ranked assignee list is TAI-416.
- Section 9, Stories and Bugs ready to verify (TAI-550): grooming is the board-wide view, so what waits for
  `/tai-verify` shows there as well as in `/tai-ready`. Both use one function (`findNotVerified`), so they
  cannot disagree. Perry names the next step; Tessa verifies.
- A test pins this section's key phrases (`config.test.ts`).

## Governance PRs

- TAI-112: `createPullRequest` for Perry and Aria, after borrowing a Dev subtask's key for permission
  made `git-pr create` link PRs to the wrong ticket (PRs #18 and #21).
- TAI-293: `mergePullRequest`, superseding TAI-112's "no self-merge".
- TAI-382/TAI-383: read all comments before merging. TAI-462: the merge gate.

## The grants repair (TAI-478; human decision TAI-455)

Perry's `complete` list held only `Requirements`, although item 6 has her close Spikes and she closes
Kickoffs, Stories and Bugs. Those four were added. Epic was left out on purpose: closing an Epic is the
human's decision.

The `update` grants were deleted from every persona file and from the code: most named fields that do
not exist (`Story.technicalNotes`, `Bug.reproSteps`), and nothing read them outside a wrapper that only
`work` builds, to read the briefing.

Create and complete grants are not enforced by the issue commands. Since TAI-478 the CLI prints a note,
and still goes ahead, when the acting persona creates or closes something outside its grants.

## The Kickoff gate stays PM + UX (decided)

The Architect is never added to it, even when `ArchitectureDesign` was used during Kickoff.

## The shared bullets

- Real links, not prose references: see `workflows/dependencies.md`'s Decided section.
- Confluence content as unwrapped lines: TAI-397.
- Writing for reading: TAI-475 and TAI-504.
- The hand-off comment: TAI-489.
- Unblocking human-gated work: TAI-389/TAI-395.

## A parked epic stays out of grooming (TAI-552)

The Icebox epic (TAI-370) holds real tickets that are deliberately unscheduled, and listing them in every briefing buried the candidates worth promoting. The label sits on the epic, not on each ticket: a ticket added later under it is hidden with nothing to remember, and any epic with Stories already under it can be parked the same way. Jira's Flag was not reused because it means waiting on an external impediment (section 4); an Icebox status would change the Jira workflow and the shared Status enum.
