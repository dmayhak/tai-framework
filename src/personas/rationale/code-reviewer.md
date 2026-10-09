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
