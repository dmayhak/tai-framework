# Aria (Architect) — rationale and history

This file is not loaded at run time. `../architect.md` is the run-time prompt and states the rules as
current fact; this file says why they are what they are. Where the two disagree, the prompt wins.

## Two subtask types

`Feasibility` and `ArchitectureDesign` are both refinement work in the brief's terms (§3.7). They
correspond to the brief's single `Design` routing candidate (§5.2), split into two named types.

## The load-bearing bar (TAI-149/TAI-328)

Adapted from BMAD-METHOD's architecture-spine practice during Aria's persona review. It is also the
bar Perry applies when assessing which proposed Stories need `ArchitectureDesign`.

## Investigate before deciding

TAI itself is brownfield from day one for anyone dogfooding it (see `CLAUDE.md`), so reading the real
code before proposing a convention is not a greenfield-only concern.

## Ask the human, showing alternatives (TAI-107, 2026-08-20; sharpened TAI-149/328)

Decided after an ADR resolved an open design point solo and presented it as settled. The sharpening
added that surfacing means showing the alternatives weighed and a lean, so the human does not have to
reconstruct the trade-off. It is in addition to escalating a true dead-end.

## Amending a reviewed ADR (TAI-481; human decision TAI-455, row 7)

The doc used to say that amending an ADR whose `DesignReview` had passed reopens that gate, citing a
brief rule that editing an already-gated doc reopens the gate. Nothing in the code ever reopened
anything. The decision was to show edits, not block on them: for Kickoff gates `/tai-ready` and
`/tai-groom` list pages edited after approval, and for a reviewed ADR Aria tells the human.

## Altitude inheritance

Aria's answer to brief §3.7's rolling-wave principle for system-level design. Follow-up subtasks use
the TAI-83 "eager subtask creation" exception (`workflows/dependencies.md`), not new machinery. What
happens when a reviewed ADR is amended is in the section above.

## Future-direction forks

The trigger is the same cost-of-change test `analyst.md` uses (brief §4), inferred from context rather
than a checklist. The hand-off to PM uses the TAI-83 exception with a dedup search first. A
`Requirements` subtask on a Story was outside the schema's allowed map until TAI-458 added it for this
hand-off (and `dba.md`'s). The point of a subtask is that a comment on an already-gated Story is easy
to miss.

## Parent-Story links

Human feedback: an ADR linked only to its authoring subtask is found by the briefing's traversal but
not by a human browsing Jira.

## DesignReview is a human gate (TAI-458, 2026-10-08)

Until TAI-458 `DesignReview` was an AI second pass: "a second pass or a peer, not the same Architect
instance that authored the design", a soft self-review separation, overridable for a solo architect.
Aria held the `complete` grant, and a failed review sent `ArchitectureDesign` back with one AI retry
before escalating to a human.

The human decided it is a human gate. It joined `ALWAYS_HUMAN_GATED_SUBTASKS`, Aria's `complete` grant
was removed, and the retry loop went. Aria prepares review notes; preferring a fresh context is the
part of self-review separation that is true (making it the default is TAI-469). Scaling the gate's
depth to stakes is deferred (TAI-327, brief §8 item 38).

`DesignReview` survived rev 52's retirement of the `CodeReview` subtask because it reviews a design
document, not a git PR, so there is no git-host-native equivalent to defer to.

The sign-off convention and its stamped comment are TAI-454 and TAI-475.

## Kickoff involvement (decided)

Contributing an early `ArchitectureDesign` to a Kickoff never pulls Aria into the Kickoff review gate.

## Correcting Perry's assessment (TAI-457)

The end-of-Kickoff scan is Perry's own assessment, not four personas run in turn; each owner corrects
it on pick-up.

## Architecture Overview (TAI-281, TAI-307; Confluence page 34963485)

- A general capability, not a TAI-specific one: brief §4's "generalize to unknown future target
  projects" principle (rev 57). Hence a menu assessed per project instead of a template.
- "Name the gap, don't skip it" is the same discipline as `workflows/spike.md`'s outcome taxonomy.
- Mermaid: this project's own Confluence space uses "Mermaid Macros for Confluence" by 9ByNight,
  confirmed working end to end.
- Cadence: periodic or on demand, the same answer TAI-280/TAI-300 reached for the project home page.
  TAI-302/TAI-319 built a staleness signal for the home page's Epic-status table, and deliberately did
  not extend it here. This doc goes stale when the codebase changes materially, which is a
  code-activity signal that diffing Epic summaries cannot answer. Still undecided for this doc.

## Mapping an existing system (TAI-471; shape agreed 2026-10-08)

Adapted from GSD's `map-codebase` and BMAD's `document-project`: a project that arrives with code
needs a map before discovery, or the Analyst's breakdown is built on guesses about what exists.

It uses existing ticket types on purpose, with no schema change. A Spike's subtasks are
`Feasibility`, `Database` and `Infra`; `Feasibility` is the one the Architect owns, although mapping
is not a go/no-go question. The Spike story itself is Perry's, as every Spike is.

The `project-context.md` draft goes through a PR because the file lives in the project's repo and is
meant to be reviewed like code (TAI-470). `init` offering a blank template for projects with no code,
or already onboarded, is TAI-516.

## Governance PRs

- TAI-112: Aria and Perry got `createPullRequest`. Framework-governance content is real repo content
  they own, and borrowing an unrelated Dev subtask's key for permission made `git-pr create` link the
  PR to the wrong ticket (PRs #18 and #21).
- TAI-293: `mergePullRequest` added, superseding TAI-112's "no self-merge".
- TAI-382/TAI-383: read all comments before merging. TAI-462: the merge gate.

## The shared bullets

- Filing pages by type: the doc-type folder rule (brief §4), `src/core/storage/doc-folders.ts`, TAI-597.
- Real links, not prose references: see `workflows/dependencies.md`'s Decided section.
- Confluence content as unwrapped lines: TAI-397.
- Writing for reading: TAI-475 and TAI-504.
- The hand-off comment: TAI-489.
- Unblocking human-gated work: TAI-389/TAI-395.
- **Decided (TAI-601):** Aria creates the follow-on `Dev` when `ArchitectureDesign` ends with nothing implementing it; see `workflows/dependencies.md`.
