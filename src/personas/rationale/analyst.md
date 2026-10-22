# Ada (Analyst) — rationale and history

This file is not loaded at run time. `../analyst.md` is the run-time prompt and states the rules as
current fact; this file says why they are what they are. Where the two disagree, the prompt wins.

## Who creates the container

For a new initiative Perry creates the Epic and the Kickoff Story; Ada's `Research` is the first
analytical work inside it. The Phase 1 bootstrap (brief §9) is the exception and is history: TAI's own
requirements spec was written from the brief as local markdown before Jira and Confluence were wired
in. A `requirements-spec` output type dated from that and was removed from the front matter: a
Kickoff's requirements are the PM's PRD under the Requirements subtask, and Ada's output on a managed
project is always a Confluence doc.

`epic-breakdown` was removed because it is the same doc as `work-breakdown`: one doc per Kickoff Story,
revised in place through EpicReview. The standalone Epic→Story pass gets its own Kickoff Story, and
its own copy of that doc.

## Elicitation principles

- **Pre-existing docs are a discussion aid (rev 68, human-confirmed 2026-09-24).** Found live on the
  first target project: Ada synthesized a work breakdown silently from a rough design doc that
  reflected an earlier version's thinking. Docs ground the questions; they do not replace asking.
- **Asks the human directly on open questions (TAI-107, 2026-08-20).** Decided together with the
  Architect's version, after a design point was resolved solo and written down as settled.
- **Escalates when not converging (rev 59, brief §3.7).** Mirrors the PM's PRD-drafting posture
  (brief §3.7, rev 58). Calibrated to stakes, the same instinct as right-sized output.
- **Future-direction questions (rev 59, brief §4).** The cost-of-change trigger; the Architect and
  DBA use the same one for design forks.
- **Research is opt-in (rev 59).** Light sourcing, not a formal citation format.
- **Right-sized output** is the same instinct as BMAD's scale-adaptive planning depth.

## Kickoff discovery

- The real conversation first, the home page written at the same time, and (below) the
  `ArchitectureDesign` rule were all found live on 2026-09-24 (rev 68, rev 69).
- The `Research` subtask already exists because Perry front-loads the Kickoff chain (TAI-457). Before
  that Ada created it herself under the TAI-83 "eager subtask creation" exception. Creation authority
  and execution ownership are separate axes: `persona=analyst` is set whoever creates the ticket.

## EpicReview (TAI-354, found live 2026-09-25)

A human clicking "looks good, approve" on a written proposal was not rigorous enough. EpicReview
replaced read-and-approve with the same probing standard Ada applies in ordinary elicitation, and made
it a human-gated subtask (`ALWAYS_HUMAN_GATED_SUBTASKS`), the same mechanic as `tester.md`'s UAT. It is
intentionally not in Ada's `complete` grant.

## Epic shells (TAI-374/TAI-387, ADR Confluence page 47349832)

Ada holds `create` for Epic only, and only as Backlog shells during EpicReview. A shell is the
proposal; the human's approval is the move to `To Do`. The one-exception framing in the front matter
comes from this ADR.

Dedup reads the work-breakdown doc's Epic table instead of searching because Jira's search index lags
a few seconds behind a create, which produced duplicates. Writing the key back at once closes the
window in which another person or process sees a row with no ticket.

## Decomposition

- Rolling-wave depth: brief §3.7 (rev 58), TAI-147/TAI-148, the same pattern as `pm.md` item 5.
- Near-term Stories land in `To Do` and the rest as shallow `Backlog` shells: TAI-292.
- Epic → Story decomposition is invoked as the `Research` subtask of a per-Epic Kickoff Story
  (TAI-354).
- The candidate Story types once listed here (Spike, Research, Bug, Implementation) predate the final
  taxonomy; brief §5.1 is current.

## Refinement

- The ambiguity-coverage checklist (rev 59) is adapted from Spec Kit's `clarify` taxonomy.
- `Investigate` has no "unblocks Dev" edge and no review gate: brief §8 items 13 and 17, both
  resolved.
- Who creates `Investigate` (brief §8 item 13; rev 57, TAI-317): it used to be a standing rule that
  only the Analyst creates it. That became the general TAI-83 exception.
- `ArchitectureDesign` created by Ada (rev 69, found live 2026-09-24): she had named a design
  trade-off as an open question with no ticket to attach it to. Naming it is itself the judgment
  TAI-83 requires.

## Project Home Page (TAI-280, TAI-300)

- A general capability, not a TAI-specific one (brief §4, rev 57), like the Architect's Architecture
  Overview.
- The native space Overview page was chosen over a bespoke page or a new doc type. Found live on
  TAI's own space: the default page sat on Confluence's "Welcome to your new space" scaffold until
  someone wrote on it. Hence first writing it at Kickoff discovery (rev 68).
- Staleness signal (TAI-302/TAI-319): `workspace/living-doc-staleness.ts` diffs the page's last
  snapshotted Epic summary against a fresh computation. There is no timestamp or time-window
  heuristic, so unrelated churn that would not change what a reader sees does not fire it.

## Hand-off after refinement

What formally marks a Story ready for implementation was brief §8 item 13's open half. Resolved: no
formal marker; the persona creating the next subtask judges readiness.

## The shared bullets

- Filing pages by type: the doc-type folder rule (brief §4), `src/core/storage/doc-folders.ts`, TAI-597.
- Real links, not prose references, and the parent-Story link: `workflows/dependencies.md`'s Decided
  section, plus human feedback that a human browsing Jira does not get the briefing's traversal.
- Confluence content as unwrapped lines: TAI-397.
- Writing for reading: TAI-475 and TAI-504.
- The hand-off comment: TAI-489.
- Unblocking human-gated work: TAI-389/TAI-395.
- **Decided (TAI-601):** Ada creates a `Requirements` subtask for follow-on work no ticket holds (a Story she proposes for a Kickoff is already on the board); see `workflows/dependencies.md`.
