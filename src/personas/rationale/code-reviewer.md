# Cole (Code Reviewer) — rationale and history

This file is not loaded at run time. `../code-reviewer.md` is the run-time prompt and states the rules
as current fact; this file says why they are what they are. Where the two disagree, the prompt wins.

## Why Cole has no ticket (rev 52, TAI-159 ADR, TAI-160)

Before rev 52, review was a `CodeReview` Jira subtask: Cole was invoked with `/tai-work <KEY>`, held
create/workOn/complete grants on `Subtask:CodeReview`, and the test tiers waited on it in sequence. A
decision was two writes, one to the PR and one Jira transition.

A real requirement for N-of-M PR approvals broke that: a Jira subtask needs exactly one assignee, and
"the" review has no honest single assignee under a multi-approver policy. Rev 52 retired the subtask
(it stays in the schema to parse historical tickets). Review status is the git host's own approval
state, queried live.

Consequences that the prompt states as plain fact:

- Authorization is the "PR Reviewers" Confluence roster (`git/pr-reviewers.ts`), a human-level list.
  `git-pr review` checks it directly and takes no issue key, because no ticket's `persona` field says
  `code-reviewer`. The `gitHost: reviewPullRequest` grant in the front matter is vestigial for
  permission resolution and kept as documentation of the role.
- A decision is one write. The Jira-side transition and comment were removed, not relocated.
- Review and testing run in parallel (human-confirmed 2026-08-24). This superseded the framing in
  design-notes D12 of `CodeReview` as the tiers' gate; the order among the tiers themselves
  (Integration, System, E2E) did not change.
- `confluenceOutputs` is empty. It was `review-notes`, a Confluence page; review notes now go to a PR
  comment. The front-matter block was missed in the rev 52 rewrite and found in TAI-153's persona
  review (TAI-341).

## The required-approval count

It is a TAI-side config value (`TAI_PR_REQUIRED_APPROVALS`), not a live query of Bitbucket branch
restrictions. Since TAI-462 the merge gate counts only approvals cast on the PR's current commit. The
doc used to say Bitbucket enforces the count at merge time; the merge gate does.

## Adversarial default (TAI-153)

Human-confirmed during Cole's persona review, after comparing against BMAD-METHOD's
`bmad-code-review` and GSD's `gsd-code-reviewer`, which independently converge on the same posture.

## Never edits code (2026-08-24)

Human-confirmed live during the review of TAI-160/TAI-161, where Cole fixed what he found and
committed it directly. That makes the reviewer review his own contribution, which is the
self-certification problem `cannotApprove: own-output` exists to prevent.

## Self-review separation (TAI-458, 2026-10-08)

The doc used to say Cole "by default does not review work authored by the same persona instance, a
soft default, overridable". That was not true to how TAI runs: the reviewer is a human on the roster
and the AI prepares findings. The wording now says so. Making a fresh context the default is TAI-469.
The scope question (same human, not persona role) was settled in rev 31 (brief §8 item 3).

## The review flow lives in the CLI (TAI-425)

`git-pr review-prep` prints the persona, the PR and the steps, so there is one copy of the steps and
it sits in the output the session just read. Before that they were in the skill body and were skipped
(TAI-423).

## Reading context from the PR's branch (TAI-522, ADR Confluence page 55246849)

On 2026-10-09 a PR was reviewed from a second clone whose default branch was 28 commits behind. The
diff was right, because review-prep fetches both branches, but any file opened from disk was old, and
the review said "verified by a new regression test" about a test that did not exist in that tree.

Fast-forwarding the default branch does not fix that on its own: an up-to-date default branch is still
not the PR's code. So the reviewer is told to read from the fetched PR branch, and review-prep says
whether the working tree is at the PR's head. Review-prep also runs the safe fast-forward that
`/tai-work` does, as hygiene. In the review flow the project's rules file is read from the destination
branch on origin, so a PR cannot rewrite the rules it is reviewed under.

## A review must show what it read and ran (TAI-527, ADR Confluence page 55640065)

On 2026-10-09 about ten PRs in a row came back with no issues found. The reviews restated the author's
PR description; one claimed a verification that could not have happened in its checkout. Two
side-by-side comparisons (PRs 183 and 186) had a second reviewer find real issues from the same
output. The causes found:

- "No issues" and "did not look" were indistinguishable: the findings format said nothing about what
  was read or run. Hence the required `coverage` block, the cross-check against the changed files, and
  the line added when a large diff draws no issue.
- The author's description came before the code, and reviewers anchored on it. Hence code first and
  the description last, labelled as claims.
- The diff was mostly not in the output: the host cuts tool output at about 30,000 characters and the
  persona prompt plus the steps used most of the budget, so a 73-line PR came back "DIFF NOT SHOWN IN
  FULL". Hence the diff as a file.
- One reviewer ran the suite in an improvised worktree and read nothing critically; another read
  critically and ran nothing. The decision was to show the CI result for the commit under review, so
  that where CI has run and passed the reviewer's effort goes into reading. Where no CI result exists
  the output says nothing has run the suite. That is this repo's own case: its pipeline has no
  automatic trigger, which the first review of this change pointed out. A built-in worktree check
  command was considered and not taken (worktree machinery is deferred, TAI-115).

The coverage block is self-declared. It cannot prove a file was read; it puts the claim on the record
next to the review, where the human deciding can see it.

## Structured findings (TAI-209 ADR, TAI-207)

Findings are JSON rendered by code so the write-up is deterministic. Inline comments for `critical`
findings with a line are TAI-207; the threshold is hard-coded for v1 (ADR decision 4) with no config
surface yet.

## The shared bullets

- Real links, not prose references: see `workflows/dependencies.md`'s Decided section.
- Writing for reading: TAI-475 and TAI-504.
- The hand-off comment: TAI-489.
- Unblocking human-gated work: TAI-389/TAI-395. It rarely applies to Cole; the line is identical in
  every persona doc on purpose, and a test checks for it.
