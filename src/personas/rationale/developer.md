# Dario (Developer) — rationale and history

This file is not loaded at run time. `../developer.md` is the run-time prompt and states the rules as
current fact; this file says why they are what they are. Where the two disagree, the prompt wins.

## Fix small issues on sight, propose a ticket for real ones

The propose-then-PM-confirms mechanic for a bigger issue is the one `workflows/bug.md`'s
PostDeploy-minor-severity case already used (design-notes D7): not fully automatic and not manual-only,
reused rather than reinvented.

The real backstop against scope growing during implementation is not this discipline alone. Cole's
review is spec-based ("reviews against the spec, not personal style preference"), so anything in the
diff that cannot be traced to the ticket's scope is what that gate exists to catch.

## No new dependency without asking

Naming the alternatives and a lean is the alternatives-first discipline TAI-107 established for the
Architect (`architect.md`'s "asks the human… by showing the alternatives").

## Precedence is enforced (TAI-476)

Starting a subtask whose prerequisite is open used to be a convention. Since TAI-476 `transition()`
refuses it, and `force=true` is the human's override, recorded as a comment on the ticket.

## Two retry rules that are easy to confuse

- A failed checkpoint: the AI retries once, then a human (brief §4, §5.4).
- A stuck implementation approach: three attempts, then stop and raise a `SpikeTask` or ask the human.
  This one is about implementation difficulty, not a failed gate.

## The review and merge chain

- **rev 21/25 (TAI-34 ADR, TAI-38/39/40):** `Dev` opened a real PR and a `CodeReview` subtask acted on it.
- **rev 52 (TAI-159 ADR, TAI-160):** the `CodeReview` subtask was retired. A Jira subtask needs exactly
  one assignee and an N-of-M approval policy has none. `Dev` stays In Progress until its PR merges, the
  PR links to the `Dev` subtask itself, and review and testing run in parallel (human-confirmed
  2026-08-24). Dario no longer hands off to one "Code Reviewer" persona holding a subtask.
- **TAI-73:** `git-pr create` resolves Dario's identity from the subtask's own `persona` field and
  enforces the `gitHost` grant, the way `/tai-work` enforces `workOn`.
- **TAI-456 (2026-10-08):** verify, then merge. Whoever owns the `Dev` subtask merges, always; `Deploy`
  ships what is already merged. Test code goes in the same branch and PR. A failure after the merge is
  a new linked Bug.
- **TAI-462:** the merge gate. A fix pushed after approval makes the approval stale, so the old "very
  minor fix: fix, test, merge" judgment rule became "merge with `force=true`", with the override on
  record on the PR.
- **TAI-507:** the gate also waits for UAT unless the subtask carries `uat-after-merge`.

Merging one's own PR is not self-certification: the approval already happened as a separate review
action, and `cannotApprove: own-output` is untouched. Framework-internal work needs no `Deploy`
subtask.

## A recorded local check (TAI-534, ADR Confluence page 55672833)

Found on 2026-10-09: nothing ran the test suite on a PR in this repo. The Bitbucket free tier allows
50 build minutes a month, about 25 runs, and one day produced 17 PRs, so the automatic pipeline
triggers had been removed. The merge gate's CI rule passed with no status at all.

Decided by the human: `git-pr check` runs the project's own check command on the PR's head commit and
records the result as a commit status; the merge gate requires one when a check command is
configured; the author runs it, by command. A missing result can be forced past with a recorded
override, a failed one cannot. Not taken: a pipeline run per PR (quota), running it automatically at
PR creation (later pushes still need a run), and counting only a reviewer's run (needs worktrees,
deferred under TAI-115).

The result is self-attested: it names who ran it and on which machine.

## Read the comments before merging (TAI-382/TAI-383)

An approved PR was merged with unread reviewer comments on it. The rule since: read all comments, then
fix, file a ticket, or skip with a reason, and tell the human. A reviewer's factual claims are checked
before acting, because they have been wrong.

## No Defect subtask

Pre-merge rework creates no new artifact; see `workflows/story.md`, "Why no Defect subtask".

## The shared bullets

- Filing pages by type: the doc-type folder rule (brief §4), `src/core/storage/doc-folders.ts`, TAI-597.
- Real links, not prose references: see `workflows/dependencies.md`'s Decided section.
- Writing for reading: TAI-475 and TAI-504.
- The hand-off comment: TAI-489.
- Unblocking human-gated work: TAI-389/TAI-395.
