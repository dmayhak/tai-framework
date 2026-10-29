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
import { DirtyTreeError } from "./dev-tasks-git.js";
import { yoloHandoff, type ConflictStop } from "./dev-yolo.js";
import { stampedAs } from "../storage/stamp.js";

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
    /** Throws when the working tree is not clean. Asked before the merge, so a dirty tree stops the ticket while the PR is still open. */
    readonly assertClean: () => Promise<void>;
    /** Brings the working tree to the updated default branch, so the verification runs on what was merged. Throws when it cannot. */
    readonly prepare: () => Promise<void>;
    /** The Tessa run: it posts one `Verified:` or `Not verified:` comment on the Story or Bug. */
    readonly verify: (task: DevTask) => Promise<{ readonly ok: boolean; readonly summary: string }>;
    readonly handoff: (key: string, body: string) => Promise<void>;
    /** TAI-733: when set, a merge refused for a conflict is answered `conflict` (no hand-off) so the run can resolve it and ask for a fresh review. */
    readonly resolveConflicts?: boolean;
}

/** Whether a host's reason for refusing a merge is a conflict with the default branch. */
export function isConflictRefusal(reason: string): boolean {
    return /conflict/i.test(reason);
}

/** The merge comment: it says the approval was automated, by whom, and on which commit. */
export function automatedMergeComment(reviewer: Pick<HumanRef, "id" | "displayName">, commit: string): string {
    return `Merged by an unattended DEV-YOLO run. The approval was automated: it was cast by ${reviewer.displayName} (${String(reviewer.id)}), the automated reviewer, on commit ${commit}. The merge went through the merge gate; nothing was forced.`;
}

/** The verdict in a comment: `Verified:` or `Not verified:` as the comment's first line (blank lines or markup may precede it); a later line never counts. */
export function verificationVerdict(body: string): "verified" | "not-verified" | null {
    const m = /^\s*[ \t>*_]*(Not verified|Verified):/i.exec(body);
    if (!m) return null;
    return m[1]!.toLowerCase().startsWith("not") ? "not-verified" : "verified";
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function finishApproved(deps: FinishDeps): (task: DevTask, prUrl: string) => Promise<DevTaskOutcome | ConflictStop> {
    return async (task, prUrl) => {
        const key = task.issue.key;
        let merged = false;
        let devDone = false;
        let devKey: string = key;
        const notes: string[] = [];
        // Before the merge the Dev ticket carries the hand-off. After it the Dev ticket is Done and drops out of the open work, so
        // the hand-off goes on the Story or Bug that stays open, and says what the Dev ticket did.
        const say = async (stoppedAt: string, next: string): Promise<DevTaskOutcome> => {
            const done = devDone
                ? `Dev ticket ${devKey} is Done: its PR was reviewed and approved by the automated reviewer and merged: ${prUrl}.`
                : merged
                  ? `The PR was reviewed and approved by the automated reviewer and merged by this run: ${prUrl}. Dev ticket ${devKey} is not Done.`
                  : `The PR was reviewed and approved by the automated reviewer and was not merged by this run: ${prUrl}.`;
            try {
                await deps.handoff(devDone ? task.parent.key : devKey, yoloHandoff(notes.length ? `${done} Note: ${notes.join("; ")}.` : done, stoppedAt, next));
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
            devKey = linked;
            const verdict = await checkMergeGate({ gitHost: deps.gitHost, workTracker: deps.workTracker, ...(deps.requiredApprovals !== undefined ? { requiredApprovals: deps.requiredApprovals } : {}) }, live, linked as IssueKey);
            // The approval that carries the merge must be the automated reviewer's own, on this commit.
            const reviewer = await deps.reviewer();
            const gateBlockers = verdict.freshApprovals.some((h) => String(h.id).toLowerCase() === String(reviewer.id).toLowerCase())
                ? verdict.blockers
                : [...verdict.blockers, `The automated reviewer (${String(reviewer.id)}) has no approval on the current commit (${live.sourceCommit}).`];
            const { blockers, proceed } = mergeBlockersWithCheck({ gateBlockers, checkCommand: deps.checkCommand, statuses, commit: live.sourceCommit, force: false });
            if (!proceed) return await say(`the merge gate refused: ${blockers.map((b) => b.replace(/\.$/, "")).join("; ")}.`, "meet what the gate names, then merge it.");
            // A tree the earlier runs left dirty is found now, while the PR is still open, and not after the merge.
            try {
                await deps.assertClean();
            } catch (err) {
                return await say(`the working tree is not clean, so the verification could not run after a merge: ${err instanceof DirtyTreeError ? err.porcelain.trim() : errorText(err)}.`, "commit or discard the changes, then run the ticket again.");
            }
            // Only on the commit the gate was checked against, and never forced.
            let result: Awaited<ReturnType<FinishDeps["gitHost"]["mergePullRequest"]>>;
            try {
                result = await deps.gitHost.mergePullRequest(live.repo, live.id, undefined, { expectedHead: live.sourceCommit });
            } catch (err) {
                // A timeout or a dropped answer can come after the host did merge, so look at the host before treating the merge as failed.
                const after = await deps.gitHost.getPullRequest(live.repo, live.id).catch(() => null);
                if (after?.state !== "merged") throw err;
                notes.push(`the merge call failed (${errorText(err)}) but the host shows the PR merged`);
                result = { ok: true, pullRequest: after };
            }
            if (!result.ok && deps.resolveConflicts && isConflictRefusal(result.reason)) return { state: "conflict", reason: result.reason };
            if (!result.ok) return await say(`the merge was refused: ${result.reason}.`, "read the reason and merge it by hand.");
            merged = true;
            try {
                await deps.gitHost.addPullRequestComment(live.repo, live.id, deps.stamp(automatedMergeComment(reviewer, live.sourceCommit)));
            } catch (err) {
                notes.push(`the merge comment could not be posted: ${errorText(err)}`);
            }
            try {
                await deps.workTracker.transition(linked as IssueKey, Status.Done);
                devDone = true;
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
            // Only the Tester's own new comments count (a stamped "(tester)"), and any Not verified: among them keeps the Story open.
            const verdicts = (story?.comments ?? [])
                .filter((c) => !before.has(c.id) && /\(tester\)/.test(stampedAs(c.body) ?? ""))
                .map((c) => verificationVerdict(c.body))
                .filter((v) => v !== null);
            const last = verdicts.includes("not-verified") ? "not-verified" : verdicts[verdicts.length - 1];
            if (last === undefined) return await say("the verification run left no Verified: or Not verified: comment from the Tester.", `run /tai-verify ${task.parent.key} by hand.`);
            if (last === "not-verified") return await say(`${task.parent.key} was not verified against its criteria, so it stays open.`, `read the Not verified: comment on ${task.parent.key}.`);
            // Verified from this PR alone is not enough while other work on the Story is still open.
            const openSiblings = (await deps.workTracker.search({ projectKey: deps.projectKey, parentKey: task.parent.key, exhaustive: true, readYourWrites: true })).filter((i) => i.status !== Status.Done && i.status !== Status.Canceled);
            if (openSiblings.length > 0) {
                return await say(`${task.parent.key} was verified, but other work on it is still open (${openSiblings.map((i) => i.key).join(", ")}), so it stays open.`, "finish that work, then close the Story.");
            }
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
