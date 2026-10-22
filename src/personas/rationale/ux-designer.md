# Uma (UX Designer) — rationale and history

This file is not loaded at run time. `../ux-designer.md` is the run-time prompt and states the rules
as current fact; this file says why they are what they are. Where the two disagree, the prompt wins.

## Elicits, doesn't impose

Same shape as `pm.md`'s "Elicitation, not direction", and it shares that principle's escalation
posture (brief §3.7). It came out of the persona review (TAI-6): a designer persona that picks colours
and flows unprompted replaces the human's vision instead of drawing it out.

## Concern scan and surface closure

Both were adapted from BMAD-METHOD during the persona review.

- The concern scan (accessibility, responsive behaviour, i18n, dark mode, offline, input modalities,
  notifications, regulated language) is BMAD's own concern-scan list. It is inferred from what the
  flow touches rather than applied to every screen, the same right-sized instinct as Ada's
  `Investigate` ambiguity-coverage checklist.
- Surface closure is BMAD's IA-closure test. It plays the role for Uma that Aria's load-bearing bar
  and Ada's ambiguity checklist play for them: a checkable answer to "is this done", not a vibe check.

## The UxDesign subtask usually already exists (rev 66, found live 2026-09-24)

Perry creates it at Project Initiation under the general TAI-83 "eager subtask creation" exception
(`pm.md` item 1), and since TAI-457 she front-loads it at Kickoff. Uma once created a duplicate
because her doc told her to create it; hence the dedup search first.

## The Kickoff gate comment (TAI-454, TAI-475)

The CLI and the human share one Jira identity, so TAI cannot prove who posted `Approved:`. It is a
convention the user is accountable for: Uma posts it only when the human says so in their own
message, and the CLI stamps the comment as posted through it.

## Correcting Perry's assessment (TAI-457)

The end-of-Kickoff scan is Perry's own assessment, not four personas each run in turn; each owner
corrects it on pick-up.

## Design System (TAI-6 persona review)

Assessed against the target project's real shape the same way Aria's Architecture Overview is. That
comes from brief §4's "generalize to unknown future target projects" principle (rev 57): a section is
included, reframed, or marked N/A with a reason.

The drift rule (an undeclared divergence from a parent design-system doc is a conflict) uses the same
dedup-search-then-comment-or-subtask mechanic as Aria's altitude-inheritance principle.

## Artifact storage (decided)

UX artifacts are Confluence pages like every other persona's output; a dedicated `design` artifact
type in the storage layer was considered and not added.

## The shared bullets

- Filing pages by type: the doc-type folder rule (brief §4), `src/core/storage/doc-folders.ts`, TAI-597.
- Real links, not prose references: see `workflows/dependencies.md`'s Decided section.
- Confluence content as unwrapped lines: TAI-397.
- Writing for reading: TAI-475 and TAI-504.
- The hand-off comment: TAI-489.
- Unblocking human-gated work: TAI-389/TAI-395.
- `NEEDS CLARIFICATION:` markers blocking the Kickoff gate: brief §8.21.
- **Decided (TAI-601):** the UX Designer creates the follow-on `Dev` when `UxDesign` ends with nothing implementing it; see `workflows/dependencies.md`.
