# Tessa (Tester) — rationale and history

This file is not loaded at run time. `../tester.md` is the run-time prompt and states the rules as
current fact; this file says why they are what they are. Where the two disagree, the prompt wins.

## The test types

The brief originally had a single `Test` routing candidate (§5.2). The three tiers
(`IntegrationTest`, `SystemTest`, `E2ETest`) elaborate it, and `Triage` was added as the Bug entry
point; neither was in the brief's first list. `UAT` is brief §5.2's rev 10 addition.

Tiers run sequentially, cheapest first: design-notes item D12.

## IntegrationTest may be N/A

A deliverable with no real integration boundary gets closed N/A with an explanation, confirmed with
the human first, instead of a test forced into existence. This came from dogfooding: a standalone
pure-function module has nothing an integration tier can catch beyond its own unit tests.

## Testing runs alongside review (rev 52, TAI-159 ADR, TAI-160)

Before rev 52 the tiers waited on a `CodeReview` subtask. That subtask was retired; review happens
on the real PR, and `readyToTest` lists an In-Progress `Dev` with an open PR with no approval
requirement.

## Verify, then merge (TAI-456, 2026-10-08)

Human decision: test code goes in the `Dev` branch and PR, a tier is Done on a pass and does not wait
for the merge, and the merge waits for the tiers (the merge gate, TAI-462).

Before this, Test-tier subtasks sat outside the PR chain and had no way to land their own code. Tessa
was given `gitHost: createPullRequest` (rev 48) but never `mergePullRequest`. After TAI-456 that grant
is for one case only: test code discovered after the `Dev` PR has merged.

A failure after the merge is a new linked Bug; nothing reopens `Dev`.

## UAT

- The session mechanic (one scenario at a time, severity inferred from the stakeholder's wording,
  never asked) is TAI-154, adapted from GSD's `verify-work` workflow. It only made concrete how Tessa
  runs a session she already owned; the stakeholder's sign-off authority did not change.
- Placement before the merge by default, with the `uat-after-merge` label for the other case, is
  TAI-456. The merge gate enforces it since TAI-507.
- UAT is intentionally not in Tessa's `complete` grant.

## Bug test tiers

`defaultTestTiersForBug(priority)` is TAI-119: for a Priority=Highest Bug it recommends
`IntegrationTest` only, per the Expedited Path in `workflows/bug.md`.

## The shared bullets

- Filing pages by type: the doc-type folder rule (brief §4), `src/core/storage/doc-folders.ts`, TAI-597.
- Real links, not prose references: see `workflows/dependencies.md`'s Decided section.
- Confluence content as unwrapped lines: TAI-397, after hard-wrapped page content broke hyphenated
  words and merged labelled sentences when rendered.
- Writing for reading: TAI-475 and TAI-504.
- The hand-off comment: TAI-489.
- Unblocking human-gated work: TAI-389/TAI-395.

## Decided and open

- **Decided:** a tier's "sent back" status is plain `To Do`, not a distinct `Ready for Retest` status
  (`workflows/story.md`).
- **Open:** whether a test-automation/SDET split from general Tester duties is needed later. Not yet.
