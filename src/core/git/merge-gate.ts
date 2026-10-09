/**
 * TAI Framework — the merge gate (TAI-462; human decisions TAI-455 and TAI-456)
 *
 * What must hold before a PR is merged, in one place, so `git-pr merge` and `/tai-ready`'s
 * "ready to merge" list cannot disagree:
 *
 *  1. The required number of FRESH approvals. An approval counts only if it was cast while the
 *     PR's head was the commit it has now. A host that keeps an approval across later commits
 *     (Bitbucket's free tier) still reports the reviewer as approved; TAI does not unapprove
 *     anything on anyone's behalf, it just does not count the older approval and says so.
 *     Compared on the commit, not on dates alone: an update entry can repeat the same commit
 *     (a title edit), and that must not turn a good approval stale.
 *  2. No request-changes left standing. Only its author can withdraw one.
 *  3. Every test tier present on the ticket is Done (or Canceled). A tier that was never
 *     created does not block; the PR's own ticket is never its own blocker.
 *  4. A UAT subtask present on the ticket is Done (or Canceled), unless it carries the
 *     `uat-after-merge` label (TAI-507; UAT is before the merge by default, TAI-456).
 *
 * CI is checked next to this, as before (`isGreen`), and is not part of the override.
 *
 * Crisp rules, so they are checked rather than left to prose (TAI-455) — and the way past
 * them is an explicit, stamped override in `git-pr merge`, not a judgment call nobody sees.
 */

import { Status, SubtaskType, isSubtaskIssueType } from "../schema/story-schema.js";
import type { HumanRef, Issue, IssueKey, WorkTracker } from "../storage/interface.js";
import { sameHuman } from "../personas/roster.js";
import type { CommitSha, GitHost, PullRequestActivity, PullRequestRef } from "./interface.js";

/** One reviewer's approval is sufficient by default. A project with a real multi-approver
 *  policy sets `TAI_PR_REQUIRED_APPROVALS` (rev 52, TAI-159 ADR — TAI-side config, not a live
 *  Bitbucket branch-restrictions query; see the ADR for why). */
export const DEFAULT_REQUIRED_APPROVALS = 1;
export const TEST_TIER_TYPES: readonly SubtaskType[] = [SubtaskType.IntegrationTest, SubtaskType.SystemTest, SubtaskType.E2ETest];
/** On a UAT subtask: acceptance happens after the merge, so the merge does not wait for it (TAI-456). */
export const UAT_AFTER_MERGE_LABEL = "uat-after-merge";
const SATISFIED: readonly Status[] = [Status.Done, Status.Canceled];

export interface MergeGateInput {
    readonly pullRequest: Pick<PullRequestRef, "reviewers" | "sourceCommit">;
    /** Oldest first (`GitHost.listPullRequestActivity`). */
    readonly activity: readonly PullRequestActivity[];
    readonly requiredApprovals: number;
    /** The test-tier subtasks present on the PR's ticket, other than the PR's own ticket. */
    readonly testTiers: readonly Pick<Issue, "key" | "issueType" | "status">[];
    /** The UAT subtasks present on the PR's ticket, other than the PR's own ticket. */
    readonly uat: readonly Pick<Issue, "key" | "status" | "labels">[];
}

export interface MergeGateVerdict {
    readonly ok: boolean;
    /** One human-readable sentence per unmet rule; empty when `ok`. */
    readonly blockers: readonly string[];
    readonly freshApprovals: readonly HumanRef[];
    /** Reviewers whose approval predates the PR's current commit: shown, not counted. */
    readonly staleApprovals: readonly HumanRef[];
}

/** Hosts hand out commit hashes at different lengths (Bitbucket's PR payloads use 12
 *  characters); one is the other's prefix when they name the same commit. */
function sameCommit(a: CommitSha, b: CommitSha): boolean {
    return a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a));
}

const names = (humans: readonly HumanRef[]): string => humans.map((h) => h.displayName).join(", ");

export function evaluateMergeGate(input: MergeGateInput): MergeGateVerdict {
    const { pullRequest, activity, requiredApprovals, testTiers, uat } = input;

    // Which commit was the head when each human last approved.
    let head: CommitSha | null = null;
    const approvedOn: { human: HumanRef; head: CommitSha | null }[] = [];
    for (const entry of activity) {
        if (entry.kind === "update") head = entry.sourceCommit;
        else if (entry.kind === "approval") approvedOn.push({ human: entry.human, head });
    }

    const freshApprovals: HumanRef[] = [];
    const staleApprovals: HumanRef[] = [];
    for (const reviewer of pullRequest.reviewers) {
        if (reviewer.status !== "approved") continue;
        // The latest approval entry for this human; with none, freshness cannot be shown.
        const last = [...approvedOn].reverse().find((a) => sameHuman(a.human, reviewer.human));
        const fresh = last?.head != null && sameCommit(last.head, pullRequest.sourceCommit);
        (fresh ? freshApprovals : staleApprovals).push(reviewer.human);
    }

    const blockers: string[] = [];
    if (freshApprovals.length < requiredApprovals) {
        const need = `Needs ${requiredApprovals} approval${requiredApprovals === 1 ? "" : "s"} on the current commit (${pullRequest.sourceCommit}); has ${freshApprovals.length}.`;
        const stale = staleApprovals.length > 0 ? ` ${names(staleApprovals)} approved before the latest changes, which does not count.` : "";
        blockers.push(need + stale);
    }

    const requesting = pullRequest.reviewers.filter((r) => r.status === "changesRequested").map((r) => r.human);
    if (requesting.length > 0) blockers.push(`Changes requested by ${names(requesting)} and not withdrawn.`);

    for (const tier of testTiers) {
        if (!SATISFIED.includes(tier.status)) blockers.push(`Test tier ${tier.key} (${tier.issueType}) is ${tier.status}, not Done.`);
    }

    for (const acceptance of uat) {
        if (SATISFIED.includes(acceptance.status) || acceptance.labels.includes(UAT_AFTER_MERGE_LABEL)) continue;
        blockers.push(`UAT ${acceptance.key} is ${acceptance.status}, not Done, and does not carry the ${UAT_AFTER_MERGE_LABEL} label.`);
    }

    return { ok: blockers.length === 0, blockers, freshApprovals, staleApprovals };
}

export interface MergeGateDeps {
    readonly gitHost: Pick<GitHost, "listPullRequestActivity">;
    readonly workTracker: Pick<WorkTracker, "getIssue" | "search">;
    readonly requiredApprovals?: number;
}

/**
 * Gathers what `evaluateMergeGate` needs for `pullRequest` and the ticket it belongs to, and
 * evaluates it. `issueKey` is the ticket the PR is linked to (a Dev or test-tier subtask, or a
 * Story/Bug/Spike/Epic for a governance PR); `null` when the PR could not be tied to a ticket,
 * in which case there are no tiers to check.
 */
export async function checkMergeGate(deps: MergeGateDeps, pullRequest: PullRequestRef, issueKey: IssueKey | null): Promise<MergeGateVerdict> {
    const activity = await deps.gitHost.listPullRequestActivity(pullRequest.repo, pullRequest.id);
    const verification = issueKey ? await verificationSubtasksFor(deps.workTracker, issueKey) : [];
    return evaluateMergeGate({
        pullRequest,
        activity,
        requiredApprovals: deps.requiredApprovals ?? DEFAULT_REQUIRED_APPROVALS,
        testTiers: verification.filter((s) => s.issueType !== SubtaskType.Uat),
        uat: verification.filter((s) => s.issueType === SubtaskType.Uat),
    });
}

/** The test-tier and UAT subtasks under the same Story/Bug as `issueKey` (or under `issueKey`
 *  itself when it is the Story/Bug), leaving out `issueKey`: a tier's own PR does not wait on itself. */
async function verificationSubtasksFor(workTracker: MergeGateDeps["workTracker"], issueKey: IssueKey): Promise<readonly Issue[]> {
    const issue = await workTracker.getIssue(issueKey);
    if (!issue) return [];
    const storyKey = isSubtaskIssueType(issue.issueType) ? issue.parentKey : issue.key;
    if (!storyKey) return [];
    const found = await workTracker.search({ projectKey: issue.projectKey, parentKey: storyKey, issueTypes: [...TEST_TIER_TYPES, SubtaskType.Uat] });
    return found.filter((subtask) => subtask.key !== issueKey);
}

/** The PR comment left when a merge went ahead past the gate (`git-pr merge … force=true`). */
export function mergeOverrideComment(blockers: readonly string[]): string {
    return ["Merge-gate override: merged with force=true although", "", ...blockers.map((b) => `* ${b}`)].join("\n");
}
