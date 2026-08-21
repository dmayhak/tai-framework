/**
 * TAI Framework — `/tai_ready [persona]` command core (TAI-61 ADR)
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
import { DEFAULT_SEARCH_LIMIT, type Issue, type IssueKey, type WorkTracker } from "../storage/interface.js";
import { rollupStatus, type RootStatusRollup } from "../workspace/status.js";
import type { GitHost, PullRequestRef, RepoId } from "../git/interface.js";
import { isGreen } from "./git-pr.js";

const OPEN_STATUSES: readonly Status[] = [Status.ToDo, Status.InProgress, Status.InReview];

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
}

export interface ReadyToMergeCandidate {
    /** The Done CodeReview subtask this PR belongs to — a different action type (run
     *  `git-pr merge`) than a Jira-side ready subtask (start work on it), so kept as its
     *  own list rather than collapsed into `ready`. */
    readonly codeReviewKey: IssueKey;
    readonly pullRequest: PullRequestRef;
}

export interface ReadyWorkResult {
    readonly ready: readonly Issue[];
    /** Approved (CodeReview Done) PRs with green CI, still open — TAI-106/107/108. Empty
     *  whenever `gitHost`/`repos` aren't supplied, never a partial/best-effort guess. */
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

/**
 * Finds Done CodeReview subtasks whose linked PR (`WorkTracker.getRemoteLinks` —
 * TAI-107/108, the link `git-pr create` now makes in code) is still open on the git host
 * and has green CI (`isGreen`, `git-pr.ts`). Live-queried every call, same "readiness is
 * computed live, per brief §3.6's refresh-point rule" philosophy as the rest of this file
 * — no persisted "awaiting merge" flag (TAI-107 ADR decision 5).
 *
 * KNOWN SCALING CAVEAT (documented, not silently accepted): this does one
 * `getRemoteLinks` call per Done CodeReview subtask found (bounded by
 * `DEFAULT_SEARCH_LIMIT`, same as every other unbounded search in this file) — fine at
 * this project's current scale, but a project with a large volume of historical Done
 * CodeReview subtasks would pay for that scan every `/tai-ready` call. Revisit if that
 * ever becomes real (brief's own repeated "don't build ahead of an observed need" stance).
 */
async function findReadyToMergePRs(
    workTracker: WorkTracker,
    gitHost: Pick<GitHost, "listPullRequests" | "getCommitStatuses">,
    projectKey: string,
    repos: readonly RepoId[]
): Promise<readonly ReadyToMergeCandidate[]> {
    const doneCodeReviews = await workTracker.search({
        projectKey,
        issueTypes: [SubtaskType.CodeReview],
        statuses: [Status.Done],
    });
    if (doneCodeReviews.length === 0) return [];

    const openPRsByRepo = new Map<RepoId, readonly PullRequestRef[]>();
    for (const repo of repos) {
        openPRsByRepo.set(repo, await gitHost.listPullRequests(repo, "open"));
    }

    const candidates: ReadyToMergeCandidate[] = [];
    for (const cr of doneCodeReviews) {
        const links = await workTracker.getRemoteLinks(cr.key);
        if (links.length === 0) continue;

        for (const openPRs of openPRsByRepo.values()) {
            const match = openPRs.find((pr) => links.some((l) => l.url === pr.url));
            if (!match) continue;
            const statuses = await gitHost.getCommitStatuses(match.repo, match.sourceCommit);
            if (isGreen(statuses)) candidates.push({ codeReviewKey: cr.key, pullRequest: match });
            break;
        }
    }
    return candidates;
}

/**
 * Finds work that's actually ready to start, optionally scoped to one persona. `persona`
 * omitted means "ready for anyone."
 */
export async function findReadyWork(deps: FindReadyWorkDeps, persona?: Persona): Promise<ReadyWorkResult> {
    const candidates = await deps.workTracker.search({
        projectKey: deps.projectKey,
        ...(persona ? { persona } : {}),
        statuses: OPEN_STATUSES,
        limit: DEFAULT_SEARCH_LIMIT,
    });

    const ready: Issue[] = [];
    const parentContexts = new Map<IssueKey, ParentPrecedenceContext | null>();

    for (const issue of candidates) {
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

    const readyToMerge =
        deps.gitHost && deps.repos && deps.repos.length > 0
            ? await findReadyToMergePRs(deps.workTracker, deps.gitHost, deps.projectKey, deps.repos)
            : [];

    const inFlight = await rollupStatus(deps.taiRoot);
    return { ready, readyToMerge, inFlight };
}
