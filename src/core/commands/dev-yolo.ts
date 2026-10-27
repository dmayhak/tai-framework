/**
 * TAI Framework — the unattended Dev run, part 2: build, review, decide, fix (TAI-634, ADR page 64782337 decisions 1, 3, 4).
 *
 * `runYolo` takes one Dev ticket from a build to a PR that an automated reviewer has approved. Every step that touches Claude,
 * the git host or the shell is injected, so the order of the steps, the round limit and every stop are tested without them.
 * It never throws and it never merges: a ticket that needs a person gets a `Handoff:` comment and a `waiting` outcome, so the
 * batch goes on. The gated merge, the verification and the close are part 3 (`afterApproved`).
 */

import type { PullRequestActivity } from "../git/interface.js";
import type { HumanRef } from "../storage/interface.js";
import type { ReviewFinding, ReviewFindings } from "../git/review-findings.js";
import { noPrDetail, type DevTask, type DevTaskOutcome } from "./do-dev-tasks.js";

export type ReviewDecision = "approve" | "requestChanges" | "none";

/** What one review round produced: the reviewer's structured findings and the decision it cast on the PR's head. */
export interface ReviewRound {
    readonly findings: ReviewFindings;
    readonly decision: ReviewDecision;
    /** The PR head commit the review was of. */
    readonly head: string;
}

export interface YoloDeps {
    /** The most review-and-fix rounds before the run stops for a person (the `review-rounds` setting). */
    readonly rounds: number;
    readonly build: (task: DevTask) => Promise<{ readonly ok: boolean; readonly summary: string }>;
    /** The open PR the build left, or null. */
    readonly findPullRequest: (task: DevTask) => Promise<{ readonly prUrl: string | null; readonly checkRecorded: boolean | null }>;
    /** A fresh Claude run as the automated reviewer. Fails (ok: false) when it produced no readable findings. */
    readonly review: (task: DevTask, prUrl: string, round: number) => Promise<{ readonly ok: true; readonly review: ReviewRound } | { readonly ok: false; readonly reason: string }>;
    /** The building run decides each finding (do it now, new ticket, comment why not) and posts one line per finding. */
    readonly fix: (task: DevTask, prUrl: string, findings: readonly ReviewFinding[], round: number) => Promise<{ readonly ok: boolean; readonly summary: string }>;
    /** The PR's head commit now. */
    readonly head: (task: DevTask, prUrl: string) => Promise<string>;
    readonly handoff: (key: string, body: string) => Promise<void>;
    /** Part 3: the gated merge, verification and close of an approved PR. Without it the run ends at the approval. */
    readonly afterApproved?: (task: DevTask, prUrl: string) => Promise<DevTaskOutcome>;
}

/** What a person reads on the ticket when the run stops. */
export function yoloHandoff(done: string, stoppedAt: string, next: string): string {
    return `Handoff: DEV-YOLO run. ${done}\n\nStopped: ${stoppedAt}\n\nNext: ${next}`;
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/**
 * The decision the automated reviewer cast on the PR's current head, from the git host's activity (oldest first). Only its own
 * entries count as its decision, so an approval from the developer's account, a person or another bot is ignored. A request for
 * changes from anyone after the last push is still a stop. "none" when the reviewer cast nothing after the last push.
 */
export function reviewDecisionOnHead(activity: readonly PullRequestActivity[], reviewer: Pick<HumanRef, "id">): ReviewDecision {
    const same = (h: Pick<HumanRef, "id">): boolean => String(h.id).toLowerCase() === String(reviewer.id).toLowerCase();
    let own: ReviewDecision = "none";
    let othersAskedForChanges = false;
    for (const entry of activity) {
        if (entry.kind === "update") {
            own = "none";
            othersAskedForChanges = false;
        } else if (same(entry.human)) {
            own = entry.kind === "approval" ? "approve" : "requestChanges";
        } else if (entry.kind === "changesRequested") {
            othersAskedForChanges = true;
        }
    }
    return othersAskedForChanges ? "requestChanges" : own;
}

/** How many decisions the reviewer's own account has cast since the PR's last push. A decision from this run is one more than before it. */
export function ownDecisionCount(activity: readonly PullRequestActivity[], reviewer: Pick<HumanRef, "id">): number {
    let n = 0;
    for (const entry of activity) {
        if (entry.kind === "update") n = 0;
        else if (String(entry.human.id).toLowerCase() === String(reviewer.id).toLowerCase()) n++;
    }
    return n;
}

export async function runYolo(task: DevTask, deps: YoloDeps): Promise<DevTaskOutcome> {
    const key = task.issue.key;
    const say = async (done: string, stoppedAt: string, next: string): Promise<DevTaskOutcome> => {
        try {
            await deps.handoff(key, yoloHandoff(done, stoppedAt, next));
        } catch (err) {
            return { state: "waiting", reason: `${stoppedAt} (and the hand-off comment could not be posted: ${errorText(err)})` };
        }
        return { state: "waiting", reason: stoppedAt };
    };
    try {
        const built = await deps.build(task);
        if (!built.ok) return await say("The build run did not finish.", built.summary, "read the reason, fix what it names, and run the ticket again with /tai-work.");
        const found = await deps.findPullRequest(task);
        if (!found.prUrl) return await say("The build run finished.", noPrDetail(built.summary), "check the branch and open the PR with /tai-work.");
        const prUrl = found.prUrl;
        if (found.checkRecorded === false) {
            return await say(`The PR is open: ${prUrl}.`, "the PR has no check result.", "run git-pr check on the PR, then run the ticket again.");
        }
        for (let round = 1; round <= deps.rounds; round++) {
            const reviewed = await deps.review(task, prUrl, round);
            if (!reviewed.ok) return await say(`The PR is open: ${prUrl}. Review round ${round} did not produce a review.`, reviewed.reason, "review the PR by hand.");
            const { findings, decision } = reviewed.review;
            const critical = findings.findings.filter((f) => f.severity === "critical");
            if (critical.length > 0 || decision === "requestChanges") {
                const what = critical.length > 0 ? `${critical.length} finding${critical.length === 1 ? "" : "s"} above Suggestion (${critical.map((f) => f.title).join("; ")})` : "the reviewer asked for changes";
                return await say(`The PR is open: ${prUrl}. Review round ${round} of ${deps.rounds}.`, what, "read the review on the PR and decide.");
            }
            if (decision !== "approve") {
                return await say(`The PR is open: ${prUrl}. Review round ${round} of ${deps.rounds}.`, "the reviewer cast no approval on the PR's current commit.", "review the PR by hand.");
            }
            // The bar is the whole rule here: no critical finding means approve. A leaning of "neither" offers a hold this flow does not have.
            if (findings.leaning !== "approve") {
                return await say(`The PR is open: ${prUrl}. Review round ${round} of ${deps.rounds}.`, `the reviewer approved, but its findings lean "${findings.leaning}", and with no finding above Suggestion an unattended review leans "approve".`, "read the review on the PR and decide.");
            }
            const open = findings.findings.filter((f) => f.severity === "suggestion" || f.severity === "nitpick");
            if (open.length > 0) {
                const before = reviewed.review.head;
                const fixed = await deps.fix(task, prUrl, open, round);
                if (!fixed.ok) return await say(`The PR is open: ${prUrl}. Review round ${round} of ${deps.rounds} left ${open.length} Suggestion or Nitpick finding${open.length === 1 ? "" : "s"}.`, fixed.summary, "read the PR comments and finish the decisions by hand.");
                // A push makes the approval stale, so only a fix that moved the head needs a fresh review.
                if ((await deps.head(task, prUrl)) !== before) {
                    if (round === deps.rounds) {
                        return await say(`The PR is open: ${prUrl}.`, `${deps.rounds} review round${deps.rounds === 1 ? "" : "s"} used, and the last fix has no fresh review.`, "review the newest commit by hand.");
                    }
                    continue;
                }
            }
            return deps.afterApproved
                ? await deps.afterApproved(task, prUrl)
                : await say(`The PR is open: ${prUrl}, reviewed and approved by the automated reviewer in ${round} round${round === 1 ? "" : "s"}.`, "the merge, verification and close are not in this version.", "merge the PR through the gate and run /tai-verify.");
        }
        return await say(`The PR is open: ${prUrl}.`, `${deps.rounds} review round${deps.rounds === 1 ? "" : "s"} used.`, "review the newest commit by hand.");
    } catch (err) {
        return await say("The DEV-YOLO run hit an error.", errorText(err), "read the reason, fix what it names, and run the ticket again.");
    }
}
