# Dana (DBA) — rationale and history

This file is not loaded at run time. `../dba.md` is the run-time prompt and states the rules as
current fact; this file says why they are what they are. Where the two disagree, the prompt wins.

## The `Database` type

The brief anticipated DBA data-design work as a refinement routing target: §3.7 uses "a DBA's
`Data Design`" as its worked example. `Database` is the concrete type name brief §5.2 settled on, and
it is deliberately broader than schema work (migrations, query tuning, performance).

## The costed option package

Schema mistakes are unusually costly to unwind compared with most code (brief §4), so a schema fork
that depends on unstated business direction gets real costed options rather than a bare question.
This mirrors `architect.md`'s version of the same brief §4 pattern.

How it reaches PM is the TAI-83 "eager subtask creation" exception (`workflows/dependencies.md`): any
persona with real in-context judgment that a subtask is needed may create it, the owner stays the
type's fixed persona, and a dedup search comes first. A `Requirements` subtask on a Story was outside
the schema's allowed map until TAI-458 (2026-10-08) added it for exactly this hand-off.

"Not limited to the piece she was asked about" is brief §4's peripheral-awareness sharpening.

## Dynamic insertion

A `Database` subtask found mid-flight is the canonical example behind
`getNewPrecedenceEdgesForInsertedSubtask()` in `schema/story-schema.ts`.

## Correcting Perry's assessment (TAI-457)

The end-of-Kickoff scan used to be described as four personas each assessing the proposed Stories. It
is one session acting as Perry; TAI-457 described it as her own assessment, corrected by each owner on
pick-up.

## The shared bullets

- Filing pages by type: the doc-type folder rule (brief §4), `src/core/storage/doc-folders.ts`, TAI-597.
- Real links, not prose references: see `workflows/dependencies.md`'s Decided section.
- Writing for reading: TAI-475 and TAI-504.
- The hand-off comment: TAI-489.
- Unblocking human-gated work: TAI-389/TAI-395.

## Decided and deferred

- **Decided:** no `Database` work under Kickoff, even for early technical-risk flags; a Spike after
  discovery instead (`workflows/kickoff.md`).
- **Deferred (TAI-337, Backlog):** splitting a data-engineering role (analytics, pipelines) from the
  DBA. It becomes a real question only once a target project has enough analytics surface to be a
  distinct workload from OLTP schema work; beyond v1's priority.
