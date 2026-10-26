/**
 * TAI Framework — the unattended Dev run, part 3: merge through the gate, verify, close (TAI-634, ADR page 64782337
 * decisions 4 and 5).
 *
 * `finishApproved` takes a PR the automated reviewer approved. It merges only through the same gate as `git-pr merge`, never
 * with force, says on the PR that the approval was automated, then has Tessa verify the Story or Bug against its acceptance
 * criteria and closes it only on a `Verified:` comment. Every stop is a `Handoff:` and a `waiting` outcome, so the batch goes on.
 */

import type { CommitStatus, GitHost, PullRequestRef } from "../git/interface.js";
import { isGreen, findLinkedIssueForPR } from "./git-pr.js";
import { checkMergeGate } from "../git/merge-gate.js";
import { mergeBlockersWithCheck } from "../git/local-check.js";
import { Status } from "../schema/story-schema.js";
import type { HumanRef, IssueKey, WorkTracker } from "../storage/interface.js";
import type { DevTask, DevTaskOutcome } from "./do-dev-tasks.js";
import { yoloHandoff } from "./dev-yolo.js";

export interface FinishDeps {
    readonly gitHost: Pick<GitHost, "getPullRequest" | "getCommitStatuses" | "listPullRequestActivity" | "mergePullRequest" | "addPullRequestComment">;
    readonly workTracker: Pick<WorkTracker, "search" | "getRemoteLinks" | "getIssue" | "transition">;
    readonly projectKey: string;
    /** The PR for this ticket, as found for the review. */
    readonly pullRequest: (task: DevTask) => Promise<PullRequestRef>;
    /** The project's check command (`TAI_CHECK_COMMAND`), or null: with one, a commit with no check result blocks the merge. */
    readonly checkCommand: string | null;
    readonly requiredApprovals?: number;
    /** The automated reviewer's account, named in the merge comment. */
    readonly reviewer: () => Promise<Pick<HumanRef, "id" | "displayName">>;
    /** Signs a comment as the Developer persona. */
    readonly stamp: (body: string) => string;
    /** Brings the working tree to the updated default branch, so the verification runs on what was merged. Throws when it cannot. */
    readonly prepare: () => Promise<void>;
    /** The Tessa run: it posts one `Verified:` or `Not verified:` comment on the Story or Bug. */
    readonly verify: (task: DevTask) => Promise<{ readonly ok: boolean; readonly summary: string }>;
    readonly handoff: (key: string, body: string) => Promise<void>;
}

/** The merge comment: it says the approval was automated, by whom, and on which commit. */
export function automatedMergeComment(reviewer: Pick<HumanRef, "id" | "displayName">, commit: string): string {
    return `Merged by an unattended DEV-YOLO run. The approval was automated: it was cast by ${reviewer.displayName} (${String(reviewer.id)}), the automated reviewer, on commit ${commit}. The merge went through the merge gate; nothing was forced.`;
}

/** The verdict in a comment: `Verified:` or `Not verified:` as its first line (a stamp or markup may precede it). */
export function verificationVerdict(body: string): "verified" | "not-verified" | null {
    const m = /^[ \t>*_]*(Not verified|Verified):/im.exec(body);
    if (!m) return null;
    return m[1]!.toLowerCase().startsWith("not") ? "not-verified" : "verified";
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function finishApproved(deps: FinishDeps): (task: DevTask, prUrl: string) => Promise<DevTaskOutcome> {
    return async (task, prUrl) => {
        const key = task.issue.key;
        let merged = false;
        const say = async (stoppedAt: string, next: string): Promise<DevTaskOutcome> => {
            const done = merged ? `The PR was reviewed and approved by the automated reviewer and merged: ${prUrl}.` : `The PR is open, reviewed and approved by the automated reviewer: ${prUrl}.`;
            try {
                await deps.handoff(key, yoloHandoff(done, stoppedAt, next));
            } catch (err) {
                return { state: "waiting", reason: `${stoppedAt} (and the hand-off comment could not be posted: ${errorText(err)})` };
            }
            return { state: "waiting", reason: stoppedAt };
        };
        try {
            const pr = await deps.pullRequest(task);
            const live = await deps.gitHost.getPullRequest(pr.repo, pr.id);
            if (!live || live.state !== "open") return await say("the PR is no longer open.", "check what happened to it.");
            const statuses: readonly CommitStatus[] = await deps.gitHost.getCommitStatuses(live.repo, live.sourceCommit);
            if (!isGreen(statuses)) {
                return await say(`the check is not green on ${live.sourceCommit} (${statuses.map((s) => `${s.key}: ${s.state}`).join(", ")}).`, "fix the check and merge through the gate.");
            }
            const linked = (await findLinkedIssueForPR(deps.workTracker, deps.projectKey, live.url).catch(() => null)) ?? key;
            const verdict = await checkMergeGate({ gitHost: deps.gitHost, workTracker: deps.workTracker, ...(deps.requiredApprovals !== undefined ? { requiredApprovals: deps.requiredApprovals } : {}) }, live, linked as IssueKey);
            // The approval that carries the merge must be the automated reviewer's own, on this commit.
            const reviewer = await deps.reviewer();
            const gateBlockers = verdict.freshApprovals.some((h) => String(h.id).toLowerCase() === String(reviewer.id).toLowerCase())
                ? verdict.blockers
                : [...verdict.blockers, `The automated reviewer (${String(reviewer.id)}) has no approval on the current commit (${live.sourceCommit}).`];
            const { blockers, proceed } = mergeBlockersWithCheck({ gateBlockers, checkCommand: deps.checkCommand, statuses, commit: live.sourceCommit, force: false });
            if (!proceed) return await say(`the merge gate refused: ${blockers.map((b) => b.replace(/\.$/, "")).join("; ")}.`, "meet what the gate names, then merge it.");
            // Only on the commit the gate was checked against, and never forced.
            const result = await deps.gitHost.mergePullRequest(live.repo, live.id, undefined, { expectedHead: live.sourceCommit });
            if (!result.ok) return await say(`the merge was refused: ${result.reason}.`, "read the reason and merge it by hand.");
            merged = true;
            const notes: string[] = [];
            try {
                await deps.gitHost.addPullRequestComment(live.repo, live.id, deps.stamp(automatedMergeComment(reviewer, live.sourceCommit)));
            } catch (err) {
                notes.push(`the merge comment could not be posted: ${errorText(err)}`);
            }
            try {
                await deps.workTracker.transition(linked as IssueKey, Status.Done);
            } catch (err) {
                return await say(`the PR merged, but ${linked} could not be moved to Done: ${errorText(err)}.`, "move it to Done and run /tai-verify on the Story.");
            }
            try {
                await deps.prepare();
            } catch (err) {
                return await say(`the PR merged, but the checkout could not be updated for the verification: ${errorText(err)}.`, "update the default branch and run /tai-verify on the Story.");
            }
            // Only a comment that appeared during the verification run counts, never an older verdict.
            const before = new Set(((await deps.workTracker.getIssue(task.parent.key))?.comments ?? []).map((c) => c.id));
            const ran = await deps.verify(task);
            if (!ran.ok) return await say(`the verification run did not finish: ${ran.summary}`, `run /tai-verify ${task.parent.key} by hand.`);
            const story = await deps.workTracker.getIssue(task.parent.key);
            const verdicts = (story?.comments ?? [])
                .filter((c) => !before.has(c.id))
                .map((c) => verificationVerdict(c.body))
                .filter((v) => v !== null);
            const last = verdicts[verdicts.length - 1];
            if (last === undefined) return await say("the verification run left no Verified: or Not verified: comment.", `run /tai-verify ${task.parent.key} by hand.`);
            if (last === "not-verified") return await say(`${task.parent.key} was not verified against its criteria, so it stays open.`, `read the Not verified: comment on ${task.parent.key}.`);
            try {
                await deps.workTracker.transition(task.parent.key, Status.Done);
            } catch (err) {
                return await say(`${task.parent.key} was verified but could not be closed: ${errorText(err)}.`, `close ${task.parent.key} by hand.`);
            }
            return { state: "handed-on", note: `merged ${prUrl}, verified and closed ${task.parent.key}${notes.length ? ` (${notes.join("; ")})` : ""}` };
        } catch (err) {
            return await say(`an error: ${errorText(err)}.`, merged ? "check the PR and the ticket, then run /tai-verify on the Story." : "merge it by hand if it is ready.");
        }
    };
}
