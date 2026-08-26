/**
 * TAI Framework — `/tai_ready [persona]` command core (TAI-61 ADR decision 4)
 *
 * Root `status.json` (`rollupStatus`, `workspace/status.ts`) is a **display index only**
 * (brief §7: "purely a rollup/index, never authoritative") — readiness itself is computed
 * live here, per brief §3.6's refresh-point rule, never read off the cached rollup:
 *
 *   1. `search({ persona, statuses: OPEN_STATUSES })` — a coarse pre-filter (right persona,
 *      not yet closed). Story-level tickets (Kickoff/Story/Bug/Spike) have no precedence
 *      gate of their own (brief §5.3) and are trivially ready once open.
 *   2. For a subtask candidate at `Status.ToDo`, `isSubtaskReady()` against its parent's
 *      actual present/done subtask sets is the real gate — one `search({ parentKey })` per
 *      distinct parent (siblings share a parent, so this batches naturally rather than
 *      querying per subtask).
 *   3. TAI-196/200 (2026-08-26): a candidate already at `Status.InProgress`/`InReview` skips
 *      that precedence check entirely (already started once — precedence gates OFFERING new
 *      work, not resuming already-started work) and lands in `inProgress` instead of `ready`.
 *      This REPLACES the old, purely-local `rollupStatus()` "Already in flight" section —
 *      that one couldn't show work paused on a different machine/session; this one is
 *      sourced from the same live Jira search as `ready`, so it works everywhere. Local
 *      `.tai/work/` history, when present on THIS machine, only ever ANNOTATES an entry
 *      already justified by that live check (a single `readWorkStatus` read per candidate —
 *      local filesystem I/O, not a network round-trip, so unlike this file's other N+1
 *      git-host calls this one isn't worth bounding/documenting as a scaling caveat).
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
import { readWorkStatus } from "../workspace/status.js";
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

/** An issue that's already started (live Jira status `In Progress`/`In Review`), not
 *  genuinely-not-started work (TAI-196/200). `hasLocalHistory` FLAGS (never details) whether
 *  THIS machine has session history for it (`.tai/work/<project>/<key>/status.json`) — full
 *  detail (currentStep etc.) only surfaces once it's actually picked, via `/tai-work`'s own
 *  briefing, not inline here. Membership comes entirely from live Jira status, never local
 *  file presence, so a stale/drifted local cache can never produce a wrong or phantom entry
 *  (brief §7: local status is index-only, it only ever ANNOTATES an entry already justified
 *  by the live check). */
export interface InProgressCandidate {
    readonly issue: Issue;
    readonly hasLocalHistory: boolean;
}

export interface ReadyWorkResult {
    /** Genuinely not-yet-started (`Status.ToDo` for a subtask that's also precedence-ready,
     *  or any open story-level ticket at ToDo — see `isSubtaskReady`). `InProgress`/
     *  `InReview` issues live in `inProgress` instead (TAI-196/200) — this list never mixes
     *  the two, unlike the pre-TAI-196 combined "Ready work" list. */
    readonly ready: readonly Issue[];
    /** TAI-196/200: already-started work (`Status.InProgress`/`Status.InReview`), sourced
     *  from the same live-Jira search as `ready` — works across machines/sessions, unlike
     *  the old, purely-local `rollupStatus` "Already in flight" section this replaces. No
     *  precedence re-check (already started once, so precedence — a gate on OFFERING new
     *  work — doesn't apply to resuming it). */
    readonly inProgress: readonly InProgressCandidate[];
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
}

interface ParentPrecedenceContext {
    readonly storyType: StoryType;
    readonly presentSubtaskTypes: SubtaskType[];
    readonly doneSubtaskTypes: Set<SubtaskType>;
    /** TAI-195: a subtask rarely carries its own `Priority` (set at Triage on the Bug/Story
     *  itself, brief's Expedited Path) — the parent's value is what a subtask inherits for
     *  Ready Work sort/display purposes (human-confirmed 2026-08-25). */
    readonly priority: string | undefined;
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
    return { storyType: parent.issueType, presentSubtaskTypes, doneSubtaskTypes, priority: parent.priority };
}

/**
 * TAI-195: total order for Ready Work sorting — the standard Jira default 5-level scheme
 * (brief's own Bug Expedited Path already keys off "Highest" by name). A priority string
 * outside this set (a project running a custom scheme) sorts alongside "unset" rather than
 * guessing where it belongs — same safe-narrows-not-guesses direction as `fromJiraLinkType`
 * elsewhere in this codebase.
 */
const PRIORITY_RANK: Readonly<Record<string, number>> = {
    Highest: 0,
    High: 1,
    Medium: 2,
    Low: 3,
    Lowest: 4,
};
const UNRANKED_PRIORITY = 5;

function priorityRank(priority: string | undefined): number {
    return priority !== undefined ? (PRIORITY_RANK[priority] ?? UNRANKED_PRIORITY) : UNRANKED_PRIORITY;
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
    const inProgressIssues: Issue[] = [];
    const parentContexts = new Map<IssueKey, ParentPrecedenceContext | null>();

    for (const issue of candidates) {
        if (issue.issueType === "epic") {
            // TAI-192: an Epic only reaches Done once everything under it finishes, so it
            // would otherwise sit "open" and get swept in here for its entire multi-month
            // lifetime — pure noise once it's actually been decomposed. PM's real action on
            // an Epic (workOn: Epic, pm.md) is decomposing it into its first Stories/Kickoff;
            // once that's happened at all, the Epic itself stops being the actionable unit.
            // Only surface it while genuinely undecomposed (zero children yet). No
            // TAI-196/200 in-progress split here — an Epic isn't "worked" directly the way a
            // Story/subtask is, so its own status doesn't carry the same meaning.
            const children = await deps.workTracker.search({
                projectKey: deps.projectKey,
                parentKey: issue.key,
                limit: 1,
            });
            if (children.length === 0) ready.push(issue);
            continue;
        }

        // TAI-196/200: already-started work (any issue type) skips precedence entirely and
        // goes to `inProgress` instead of `ready` — precedence gates OFFERING new work, not
        // resuming already-started work, so re-checking it here would be meaningless (and
        // for a subtask, could even wrongly exclude something that started validly under an
        // older precedence state).
        if (issue.status === Status.InProgress || issue.status === Status.InReview) {
            inProgressIssues.push(issue);
            continue;
        }

        if (!isSubtaskIssueType(issue.issueType)) {
            // Story-level ticket — no precedence gate of its own (brief §5.3), trivially
            // ready once it's open (ToDo, per the branch above) and matches the persona filter.
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
            // TAI-195: a subtask inherits its parent's Priority for sort/display purposes
            // when it has none of its own — a synthesized view (a copy; the original fetched
            // Issue elsewhere is untouched), not a claim about what Jira's raw field says.
            ready.push(issue.priority !== undefined ? issue : { ...issue, priority: ctx.priority });
        }
    }

    // TAI-195: P1s (and other priorities) sort to the top — no auto-interrupt of in-flight
    // work (human-decided 2026-08-25), purely a display/ordering change. Stable sort: equal
    // priority (including "both unset") preserves the search's own key-ascending order.
    ready.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));

    // TAI-195/199 (extended 2026-08-26, human-confirmed after a live PR merge conflict
    // surfaced the gap): In Progress gets the same priority sort/inheritance treatment as
    // Ready Work — a P1 already in flight is exactly the kind of thing that should surface
    // first when resuming work, same rationale as the original decision. Reuses the SAME
    // `parentContexts` cache the Ready Work loop above already populated, so a parent shared
    // between a ready and an in-progress sibling costs nothing extra to look up twice.
    const inProgress: InProgressCandidate[] = [];
    for (const issue of inProgressIssues) {
        const local = await readWorkStatus(deps.taiRoot, deps.projectKey, issue.key);

        let withPriority = issue;
        if (issue.priority === undefined && isSubtaskIssueType(issue.issueType) && issue.parentKey) {
            let ctx = parentContexts.get(issue.parentKey);
            if (ctx === undefined) {
                ctx = await loadParentPrecedenceContext(deps.workTracker, deps.projectKey, issue.parentKey);
                parentContexts.set(issue.parentKey, ctx);
            }
            if (ctx) withPriority = { ...issue, priority: ctx.priority };
        }

        inProgress.push({ issue: withPriority, hasLocalHistory: local !== null });
    }
    inProgress.sort((a, b) => priorityRank(a.issue.priority) - priorityRank(b.issue.priority));

    const { readyToReview, readyToTest, readyToMerge } = await computePRSections(deps);

    return { ready, inProgress, readyToReview, readyToTest, readyToMerge };
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
