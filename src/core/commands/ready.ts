/**
 * TAI Framework — `/tai_ready [persona]` command core (TAI-61 ADR decision 4)
 *
 * Root `status.json` (`rollupStatus`) is a **display index only** (brief §7: "purely a
 * rollup/index, never authoritative") — readiness itself is computed live here, per brief
 * §3.6's refresh-point rule, never read off the cached rollup:
 *
 *   1. `search({ persona, statuses: OPEN_STATUSES })` — a coarse pre-filter (right persona,
 *      not yet closed). Story-level tickets (Kickoff/Story/Bug/Spike) have no precedence
 *      gate of their own (brief §5.3) and are trivially ready once open.
 *   2. For a subtask candidate, `isSubtaskReady()` against its parent's actual present/done
 *      subtask sets is the real gate — one `search({ parentKey })` per distinct parent
 *      (siblings share a parent, so this batches naturally rather than querying per subtask).
 *
 * `rollupStatus()`'s in-flight items are still surfaced alongside the ready list, as display
 * context (what's already being worked), not as part of the readiness computation.
 *
 * **rev 52 (TAI-159 ADR — CodeReview subtask retirement):** three live git-host-queried
 * lists extend the same "computed live, per refresh point" philosophy TAI-107/108's
 * original `readyToMerge` established, generalized now that `CodeReview` is no longer the
 * Jira-side anchor for review/test readiness — `Dev` (still `In Progress`, since it stays
 * open until its PR merges) is, correlated against the PR's own live approval/CI state:
 *   - `readyToReview` — open PRs where the current human is an eligible reviewer (the new
 *     "PR Reviewers" roster, `git/pr-reviewers.ts`) and hasn't yet cast a decision.
 *   - `readyToTest` — `Dev` subtasks with a linked, open PR — full stop, no approval-count
 *     check. Testing and review run IN PARALLEL against the PR's branch (human-confirmed
 *     2026-08-24, discussed live during TAI-160): review no longer gates testing the way
 *     `CodeReview` gated the test tiers pre-rev-52 — both are independent prerequisites
 *     `Deploy`'s own existing precedence (`workflows/story.md`, unchanged) waits on before
 *     the actual merge, which protects `master` from ever receiving untested OR unreviewed
 *     code, rather than sequencing one behind the other.
 *   - `readyToMerge` — `Dev` subtasks whose linked PR has met the configured required-
 *     approval count AND is CI-green (TAI-107/108's original check, unchanged) — a
 *     narrower, git-host-specific "is this PR mergeable" fact. Whether `Deploy` itself
 *     should actually proceed is still governed separately by the normal Jira-precedence
 *     `ready` list (Deploy's own edges still require the test tiers Done, untouched by
 *     this file).
 */

import {
    Status,
    StoryType,
    SubtaskType,
    isStoryIssueType,
    isSubtaskIssueType,
    isSubtaskReady,
    type Persona,
} from "../schema/story-schema.js";
import { DEFAULT_SEARCH_LIMIT, type HumanRef, type Issue, type IssueKey, type WorkTracker } from "../storage/interface.js";
import { rollupStatus, type RootStatusRollup } from "../workspace/status.js";
import type { GitHost, PullRequestRef, RepoId } from "../git/interface.js";
import { isGreen } from "./git-pr.js";
import { isEligibleReviewer } from "../git/pr-reviewers.js";
import { sameHuman } from "../personas/roster.js";

const OPEN_STATUSES: readonly Status[] = [Status.ToDo, Status.InProgress, Status.InReview];

/** Matches the pre-rev-52 CodeReview-Done semantics: exactly one reviewer's approval was
 *  sufficient by default. A project with a real multi-approver policy sets
 *  `requiredApprovals` explicitly (rev 52, TAI-159 ADR — TAI-side config, not a live
 *  Bitbucket branch-restrictions query; see the ADR for why). */
const DEFAULT_REQUIRED_APPROVALS = 1;

export interface FindReadyWorkDeps {
    readonly workTracker: WorkTracker;
    readonly taiRoot: string;
    readonly projectKey: string;
    // Both optional — git hosting is an independent configuration axis (brief §6/TAI-33
    // ADR), and /tai-ready must keep working with zero GitHost awareness when no repo is
    // configured (filesystem-only setups, or Bitbucket credentials simply not present —
    // same "only demanded where actually needed" posture as cli.ts's resolveGitHost).
    // Omit either (or pass an empty repos array) to skip the PR-awareness path entirely.
    // Narrowed to exactly what's used (same `Pick<GitHost, ...>` pattern as `git-pr.ts`'s
    // `resolvePullRequestId`) rather than the full `GitHost`, so a caller/test double
    // doesn't need to implement PR-CRUD/review/merge just to supply this dependency.
    readonly gitHost?: Pick<GitHost, "listPullRequests" | "getCommitStatuses">;
    readonly repos?: readonly RepoId[];
    /** rev 52 (TAI-159 ADR): required approval count for readyToTest/readyToMerge.
     *  Defaults to 1 (the pre-rev-52 single-reviewer behavior) when omitted. */
    readonly requiredApprovals?: number;
    /** rev 52: the current human (resolved from BITBUCKET_EMAIL), for readyToReview's
     *  eligibility check. readyToReview is empty without this. */
    readonly currentHuman?: HumanRef;
    /** rev 52: the "PR Reviewers" roster (`git/pr-reviewers.ts`) readyToReview checks
     *  eligibility against. readyToReview is empty without this. */
    readonly prReviewers?: readonly HumanRef[];
}

export interface ReadyToReviewCandidate {
    readonly pullRequest: PullRequestRef;
}

/** A `Dev` subtask (rev 52: stays In Progress until its PR merges — see story-schema.ts's
 *  SUBTASK_PRECEDENCE comment) with a linked, open PR. No approval-count check — testing
 *  runs in parallel with review, not gated behind it (see this file's header comment). */
export interface ReadyToTestCandidate {
    readonly devSubtaskKey: IssueKey;
    readonly pullRequest: PullRequestRef;
}

export interface ReadyToMergeCandidate {
    readonly devSubtaskKey: IssueKey;
    readonly pullRequest: PullRequestRef;
}

export interface ReadyWorkResult {
    readonly ready: readonly Issue[];
    /** rev 52: open PRs the current human should review. Empty whenever `gitHost`/`repos`/
     *  `currentHuman`/`prReviewers` aren't all supplied, or the current human isn't on the
     *  PR Reviewers roster — never a partial/best-effort guess. */
    readonly readyToReview: readonly ReadyToReviewCandidate[];
    /** rev 52: `Dev` subtasks with a linked, open PR — the live signal that replaced the
     *  `CodeReview`-anchored precedence edges (see story-schema.ts). No approval-count
     *  check; testing runs in parallel with review. Empty whenever `gitHost`/`repos`
     *  aren't supplied. */
    readonly readyToTest: readonly ReadyToTestCandidate[];
    /** Same candidates as `readyToTest`, additionally CI-green (TAI-106/107/108's
     *  original check, unchanged). Empty whenever `gitHost`/`repos` aren't supplied. */
    readonly readyToMerge: readonly ReadyToMergeCandidate[];
    /** Display context only — what's already in flight, per the root status rollup. */
    readonly inFlight: RootStatusRollup;
}

interface ParentPrecedenceContext {
    readonly storyType: StoryType;
    readonly presentSubtaskTypes: SubtaskType[];
    readonly doneSubtaskTypes: Set<SubtaskType>;
}

async function loadParentPrecedenceContext(
    workTracker: WorkTracker,
    projectKey: string,
    parentKey: IssueKey
): Promise<ParentPrecedenceContext | null> {
    const parent = await workTracker.getIssue(parentKey);
    if (!parent || !isStoryIssueType(parent.issueType)) {
        // No parent, or a parent that isn't a Story-level ticket (e.g. an Epic) — no
        // SUBTASK_PRECEDENCE graph applies. Conservatively not "ready" via this path rather
        // than guessing; a data-integrity gap here is worth surfacing, not silently papering
        // over.
        return null;
    }
    const siblings = await workTracker.search({ projectKey, parentKey, limit: DEFAULT_SEARCH_LIMIT });
    const presentSubtaskTypes = siblings.filter((s) => isSubtaskIssueType(s.issueType)).map((s) => s.issueType as SubtaskType);
    const doneSubtaskTypes = new Set(
        siblings
            .filter((s) => isSubtaskIssueType(s.issueType) && (s.status === Status.Done || s.status === Status.Canceled))
            .map((s) => s.issueType as SubtaskType)
    );
    return { storyType: parent.issueType, presentSubtaskTypes, doneSubtaskTypes };
}

function approvalCount(pr: PullRequestRef): number {
    return pr.reviewers.filter((r) => r.status === "approved").length;
}

/** Has `human` NOT yet cast a review decision on `pr`? True both when they're not on the
 *  PR's reviewer/participant list at all, and when they are but still `"pending"`. */
function hasUndecidedReview(pr: PullRequestRef, human: HumanRef): boolean {
    const existing = pr.reviewers.find((r) => sameHuman(r.human, human));
    return !existing || existing.status === "pending";
}

/**
 * Finds `Dev` subtasks that are `In Progress` (rev 52: `Dev` stays open until its PR
 * merges, not until the PR opens — see story-schema.ts) with a linked open PR (`git-pr
 * create` now links directly to the `Dev` subtask, not a `CodeReview` sibling — TAI-159
 * ADR §4), correlated via `WorkTracker.getRemoteLinks` the same way TAI-107/108's original
 * `findReadyToMergePRs` correlated `CodeReview` subtasks. Live-queried every call, same
 * "readiness is computed live, per brief §3.6's refresh-point rule" philosophy as the rest
 * of this file — no persisted "awaiting review/merge" flag (TAI-107 ADR decision 5).
 *
 * KNOWN SCALING CAVEAT (documented, not silently accepted, same as the pre-rev-52
 * version): this does one `getRemoteLinks` call per In-Progress `Dev` subtask found
 * (bounded by `DEFAULT_SEARCH_LIMIT`) — fine at this project's current scale, revisit if a
 * large volume of concurrently-in-progress `Dev` work ever makes this real.
 */
async function findDevLinkedOpenPRs(
    workTracker: WorkTracker,
    gitHost: Pick<GitHost, "listPullRequests">,
    projectKey: string,
    repos: readonly RepoId[]
): Promise<readonly { readonly devSubtaskKey: IssueKey; readonly pullRequest: PullRequestRef }[]> {
    const inProgressDevs = await workTracker.search({
        projectKey,
        issueTypes: [SubtaskType.Dev],
        statuses: [Status.InProgress],
        limit: DEFAULT_SEARCH_LIMIT,
    });
    if (inProgressDevs.length === 0) return [];

    const openPRsByRepo = new Map<RepoId, readonly PullRequestRef[]>();
    for (const repo of repos) {
        openPRsByRepo.set(repo, await gitHost.listPullRequests(repo, "open"));
    }

    const candidates: { devSubtaskKey: IssueKey; pullRequest: PullRequestRef }[] = [];
    for (const dev of inProgressDevs) {
        const links = await workTracker.getRemoteLinks(dev.key);
        if (links.length === 0) continue;

        for (const openPRs of openPRsByRepo.values()) {
            const match = openPRs.find((pr) => links.some((l) => l.url === pr.url));
            if (!match) continue;
            candidates.push({ devSubtaskKey: dev.key, pullRequest: match });
            break;
        }
    }
    return candidates;
}

/**
 * Detects an In-Progress `Dev` subtask whose linked PR has already merged out-of-band —
 * a human merging directly on Bitbucket, or any process outside TAI's own `git-pr merge`
 * (which already self-closes the `Dev` subtask it can correlate, `git-pr.ts`'s
 * `findLinkedDevSubtask`) — and syncs it to `Done` here instead. Same principle TAI-34 §2
 * already established for out-of-band reviews (a human acting directly on the git host is
 * authoritative, detected and reflected at the next refresh point, never fought), just
 * extended from reviews to merges of a different subtask type (rev 52, TAI-159 ADR).
 *
 * Runs at the start of `findReadyWork` so a subtask synced to `Done` here doesn't then
 * spuriously appear in `readyToTest`/`readyToMerge` below, computed from the same refresh.
 */
async function syncMergedDevSubtasks(
    workTracker: WorkTracker,
    gitHost: Pick<GitHost, "listPullRequests">,
    projectKey: string,
    repos: readonly RepoId[]
): Promise<readonly IssueKey[]> {
    const inProgressDevs = await workTracker.search({
        projectKey,
        issueTypes: [SubtaskType.Dev],
        statuses: [Status.InProgress],
        limit: DEFAULT_SEARCH_LIMIT,
    });
    if (inProgressDevs.length === 0) return [];

    const mergedPRsByRepo = new Map<RepoId, readonly PullRequestRef[]>();
    for (const repo of repos) {
        mergedPRsByRepo.set(repo, await gitHost.listPullRequests(repo, "merged"));
    }

    const synced: IssueKey[] = [];
    for (const dev of inProgressDevs) {
        const links = await workTracker.getRemoteLinks(dev.key);
        if (links.length === 0) continue;

        const isMerged = [...mergedPRsByRepo.values()].some((prs) => prs.some((pr) => links.some((l) => l.url === pr.url)));
        if (!isMerged) continue;

        await workTracker.transition(dev.key, Status.Done);
        synced.push(dev.key);
    }
    return synced;
}

/** Just the git-host-derived deps `computePRSections` needs — a subset of
 *  `FindReadyWorkDeps` shared by both `findReadyWork` and the lighter `findReadyPRWork`
 *  (TAI-211/212), neither of which needs `taiRoot` for this part. */
type PRSectionDeps = Pick<
    FindReadyWorkDeps,
    "workTracker" | "projectKey" | "gitHost" | "repos" | "requiredApprovals" | "currentHuman" | "prReviewers"
>;

interface PRSections {
    readonly readyToReview: readonly ReadyToReviewCandidate[];
    readonly readyToTest: readonly ReadyToTestCandidate[];
    readonly readyToMerge: readonly ReadyToMergeCandidate[];
}

/** The `readyToReview`/`readyToTest`/`readyToMerge` computation, factored out so
 *  `findReadyPRWork` (TAI-211/212) can reuse it without also paying for `findReadyWork`'s
 *  general Jira-wide `ready` query. `readyToTest` falls out of the same `findDevLinkedOpenPRs`
 *  call `readyToMerge` already needs — computing it costs nothing extra, so it stays part of
 *  this shared helper even though `findReadyPRWork` doesn't expose it in its own result. */
async function computePRSections(deps: PRSectionDeps): Promise<PRSections> {
    let readyToTest: readonly ReadyToTestCandidate[] = [];
    let readyToMerge: readonly ReadyToMergeCandidate[] = [];
    if (deps.gitHost && deps.repos && deps.repos.length > 0) {
        const requiredApprovals = deps.requiredApprovals ?? DEFAULT_REQUIRED_APPROVALS;
        const devLinked = await findDevLinkedOpenPRs(deps.workTracker, deps.gitHost, deps.projectKey, deps.repos);
        // Testing runs in parallel with review, not gated behind it — every Dev-linked
        // open PR is a test candidate regardless of approval count.
        readyToTest = devLinked;

        const approved = devLinked.filter((c) => approvalCount(c.pullRequest) >= requiredApprovals);
        const merge: ReadyToMergeCandidate[] = [];
        for (const c of approved) {
            const statuses = await deps.gitHost.getCommitStatuses(c.pullRequest.repo, c.pullRequest.sourceCommit);
            if (isGreen(statuses)) merge.push(c);
        }
        readyToMerge = merge;
    }

    let readyToReview: readonly ReadyToReviewCandidate[] = [];
    if (
        deps.gitHost &&
        deps.repos &&
        deps.repos.length > 0 &&
        deps.currentHuman &&
        deps.prReviewers &&
        isEligibleReviewer(deps.prReviewers, deps.currentHuman)
    ) {
        const candidates: ReadyToReviewCandidate[] = [];
        for (const repo of deps.repos) {
            const openPRs = await deps.gitHost.listPullRequests(repo, "open");
            for (const pr of openPRs) {
                if (hasUndecidedReview(pr, deps.currentHuman)) candidates.push({ pullRequest: pr });
            }
        }
        readyToReview = candidates;
    }

    return { readyToReview, readyToTest, readyToMerge };
}

/**
 * Finds work that's actually ready to start, optionally scoped to one persona. `persona`
 * omitted means "ready for anyone."
 */
export async function findReadyWork(deps: FindReadyWorkDeps, persona?: Persona): Promise<ReadyWorkResult> {
    if (deps.gitHost && deps.repos && deps.repos.length > 0) {
        await syncMergedDevSubtasks(deps.workTracker, deps.gitHost, deps.projectKey, deps.repos);
    }

    const candidates = await deps.workTracker.search({
        projectKey: deps.projectKey,
        ...(persona ? { persona } : {}),
        statuses: OPEN_STATUSES,
        limit: DEFAULT_SEARCH_LIMIT,
    });

    const ready: Issue[] = [];
    const parentContexts = new Map<IssueKey, ParentPrecedenceContext | null>();

    for (const issue of candidates) {
        if (issue.issueType === "epic") {
            // TAI-192: an Epic only reaches Done once everything under it finishes, so it
            // would otherwise sit "open" and get swept in here for its entire multi-month
            // lifetime — pure noise once it's actually been decomposed. PM's real action on
            // an Epic (workOn: Epic, pm.md) is decomposing it into its first Stories/Kickoff;
            // once that's happened at all, the Epic itself stops being the actionable unit.
            // Only surface it while genuinely undecomposed (zero children yet).
            const children = await deps.workTracker.search({
                projectKey: deps.projectKey,
                parentKey: issue.key,
                limit: 1,
            });
            if (children.length === 0) ready.push(issue);
            continue;
        }
        if (!isSubtaskIssueType(issue.issueType)) {
            // Story-level ticket — no precedence gate of its own (brief §5.3), trivially
            // ready once it's open and matches the persona filter.
            ready.push(issue);
            continue;
        }
        if (!issue.parentKey) continue; // malformed data — skip rather than crash

        let ctx = parentContexts.get(issue.parentKey);
        if (ctx === undefined) {
            ctx = await loadParentPrecedenceContext(deps.workTracker, deps.projectKey, issue.parentKey);
            parentContexts.set(issue.parentKey, ctx);
        }
        if (!ctx) continue;

        if (isSubtaskReady(issue.issueType, ctx.storyType, ctx.presentSubtaskTypes, ctx.doneSubtaskTypes)) {
            ready.push(issue);
        }
    }

    const { readyToReview, readyToTest, readyToMerge } = await computePRSections(deps);

    const inFlight = await rollupStatus(deps.taiRoot);
    return { ready, readyToReview, readyToTest, readyToMerge, inFlight };
}

export interface FindReadyPRWorkDeps {
    readonly workTracker: WorkTracker;
    readonly projectKey: string;
    readonly gitHost?: Pick<GitHost, "listPullRequests" | "getCommitStatuses">;
    readonly repos?: readonly RepoId[];
    readonly requiredApprovals?: number;
    readonly currentHuman?: HumanRef;
    readonly prReviewers?: readonly HumanRef[];
}

export interface ReadyPRWorkResult {
    readonly readyToReview: readonly ReadyToReviewCandidate[];
    readonly readyToMerge: readonly ReadyToMergeCandidate[];
}

/**
 * Lighter-weight sibling to `findReadyWork` (TAI-211/212) — for PR-review-mode, where the
 * general Jira-wide `ready` query (and its per-parent precedence resolution) and the
 * `inFlight` status rollup are pure overhead: just `readyToReview` + `readyToMerge`, the two
 * sections actually relevant to a human deciding what PR to act on next. `readyToTest` is
 * deliberately not exposed here — it's Tester-persona scope, out of place in a review/merge
 * view (human-confirmed, TAI-211).
 *
 * Still runs `syncMergedDevSubtasks` first, same as `findReadyWork` — a `Dev` subtask merged
 * out-of-band shouldn't spuriously appear as still awaiting review/merge from this same call.
 */
export async function findReadyPRWork(deps: FindReadyPRWorkDeps): Promise<ReadyPRWorkResult> {
    if (deps.gitHost && deps.repos && deps.repos.length > 0) {
        await syncMergedDevSubtasks(deps.workTracker, deps.gitHost, deps.projectKey, deps.repos);
    }
    const { readyToReview, readyToMerge } = await computePRSections(deps);
    return { readyToReview, readyToMerge };
}
