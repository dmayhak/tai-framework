# Duncan (DevOps) — rationale and history

This file is not loaded at run time. `../devops.md` is the run-time prompt and states the rules as
current fact; this file says why they are what they are. Where the two disagree, the prompt wins.

## Deploy does not merge (TAI-456, 2026-10-08)

Until TAI-456, `Deploy` was where the PR was merged: Duncan held `gitHost: mergePullRequest` and merged
at deploy time. The human decided on 2026-10-08 that the sequence is verify, then merge, and that whoever
owns the `Dev` subtask merges, always. `Deploy` now ships what is already on the default branch.

The `mergePullRequest` grant is still in the front matter. Nothing in the prompt uses it; removing it is
part of the grants repair (TAI-478).

`Deploy` waiting on `Dev` being Done as well as on the tiers and UAT comes from TAI-456 and TAI-463 (an
absent subtask passes its prerequisites through).

## Subtask types

`Infra`, `Deploy` and `PostDeploy` are brief §5.2's resolution of what was open gap 1 / §8.16. A candidate
type `Infra Setup` was considered and dropped. `PostDeploy` was new with that change.

`Deploy` and `PostDeploy` name a default owner that can be overridden per instance, which is how the
question "can a type route to more than one persona" was settled.

## A failed PostDeploy check (D7)

Design-notes item D7 asked what a failed `PostDeploy` check does. Resolved: severity decides. A minor
issue becomes a linked Bug that Duncan proposes and PM creates; a major one reopens `Deploy` to run its
rollback plan. A new `Rollback` subtask or action type was considered and not added.

## Correcting Perry's assessment (TAI-457)

The end-of-Kickoff scan used to be described as four personas (Architect, DBA, DevOps, UX) each assessing
the proposed Stories. In practice it is one session acting as Perry. TAI-457 described it as what it is:
Perry's own assessment, corrected by each owner when they pick the work up.

## The shared bullets

- Real links, not prose references: see `workflows/dependencies.md`'s Decided section.
- Writing for reading: TAI-475 and TAI-504, after a human complaint about dense one-paragraph comments.
- The hand-off comment: TAI-489.
- Unblocking human-gated work: TAI-389/TAI-395 (the grooming ADR, decision 11).

## Open item

Whether `PostDeploy` should move to "no fixed owner, assign at creation", like the ad-hoc `SpikeTask`
subtask, instead of a default owner with an override. Parked with the two-axis owner model (D15); not
decided.
