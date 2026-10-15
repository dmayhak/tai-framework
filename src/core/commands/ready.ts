/**
 * TAI Framework — `/tai_ready [persona]` command core (TAI-61 ADR decision 4)
 *
 * Readiness is computed live here, per brief §3.6's refresh-point rule, never read off a
 * local cache (TAI-490: there is no local status file):
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
 *      This REPLACES the old, purely-local "Already in flight" section — that one couldn't
 *      show work paused on a different machine/session; this one is sourced from the same
 *      live Jira search as `ready`, so it works everywhere. Nothing local is read (TAI-490:
 *      the per-item status file was never written, so the label built on it never appeared).
 *
 * **rev 52 (TAI-159 ADR — CodeReview subtask retirement):** three live git-host-queried
 * lists extend the same "computed live, per refresh point" philosophy TAI-107/108's
 * original `readyToMerge` established, generalized now that `CodeReview` is no longer the
 * Jira-side anchor for review/test readiness — `Dev` (still `In Progress`, since it stays
 * open until its PR merges) is, correlated against the PR's own live approval/CI state:
 *   - `readyToReview` — open PRs where the current human is an eligible reviewer (the new
 *     "PR Reviewers" roster, `git/pr-reviewers.ts`) and hasn't yet cast a decision, or cast it
 *     before the PR's latest commit (a re-review, TAI-563).
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
    DependencyRelation,
    Status,
    StoryType,
    SubtaskType,
    isStoryIssueType,
    isSubtaskIssueType,
    isSubtaskReady,
    unblockedAbsentSubtaskTypes,
    type Persona,
} from "../schema/story-schema.js";
import { isFlagged, type HumanRef, type Issue, type IssueKey, type WorkTracker } from "../storage/interface.js";
import { UnreadableIssueError, reportUnreadableIssue } from "../storage/unreadable-issues.js";
import { findNotVerified } from "../storage/verification.js";
import { normalizeSubtaskTypeToken, skippedSubtaskTypeTokens } from "../storage/comment-markers.js";
import type { CommitSha, GitHost, PullRequestRef, RepoId } from "../git/interface.js";
import { isGreen } from "./git-pr.js";
import { isEligibleReviewer } from "../git/pr-reviewers.js";
import { checkMergeGate, DEFAULT_REQUIRED_APPROVALS, lastDecisionBy, sameCommit } from "../git/merge-gate.js";
import { sameHuman } from "../personas/roster.js";
import {
    EPIC_CHILD_ISSUE_TYPES,
    EPIC_SUMMARY_LIVING_DOC_TYPES,
    computeEpicSummary,
    diffLivingDocSnapshot,
    readLivingDocSnapshot,
    type EpicSummary,
    type StaleEpic,
} from "../workspace/living-doc-staleness.js";

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
    readonly gitHost?: Pick<GitHost, "listPullRequests" | "getCommitStatuses" | "listPullRequestActivity">;
    readonly repos?: readonly RepoId[];
    /** rev 52 (TAI-159 ADR): required approval count for readyToTest/readyToMerge.
     *  Defaults to 1 (the pre-rev-52 single-reviewer behavior) when omitted. */
    readonly requiredApprovals?: number;
    /** TAI-534: the project has a check command, so a PR whose commit has no status is not ready to merge. */
    readonly checkRequired?: boolean;
    /** rev 52: the current human (resolved from BITBUCKET_EMAIL), for readyToReview's
     *  eligibility check. readyToReview is empty without this. */
    readonly currentHuman?: HumanRef;
    /** rev 52: the "PR Reviewers" roster (`git/pr-reviewers.ts`) readyToReview checks
     *  eligibility against. readyToReview is empty without this. */
    readonly prReviewers?: readonly HumanRef[];
    /** TAI-419: one line ("Ann (worked on this Story (TAI-1))") naming the best assignee for a ticket that needs
     *  one, or null. Only asked for ready tickets that have a persona and no assignee; a failure skips that ticket.
     *  Omitted = /tai-ready makes no suggestions (and reads no roster). */
    readonly suggestAssignee?: (issue: Issue) => Promise<string | null>;
}

export interface ReadyToReviewCandidate {
    readonly pullRequest: PullRequestRef;
    /** TAI-563: present when the human already decided on this PR but the PR has new commits since, so it needs a
     *  fresh look. `commit` is the PR's current head and `since` the head their decision was made on (null when the
     *  history does not show it). `unreadable` is set when the PR's history could not be read at all. Absent for a
     *  first review. */
    readonly reReview?: {
        readonly decision: "approved" | "changesRequested";
        readonly commit: CommitSha;
        readonly since: CommitSha | null;
        readonly unreadable?: true;
    };
}

/** A `Dev` subtask (rev 52: stays In Progress until its PR merges — see story-schema.ts's
 *  SUBTASK_PRECEDENCE comment) with a linked, open PR. No approval-count check — testing
 *  runs in parallel with review, not gated behind it (see this file's header comment). */
export interface ReadyToTestCandidate {
    readonly devSubtaskKey: IssueKey;
    readonly pullRequest: PullRequestRef;
}

/** TAI-293/314/315/316: `issueKey` is a `Dev` subtask for ordinary Story/Bug work, a
 *  Story/Bug/Spike/Epic ticket directly for a governance-content PR with no Dev subtask
 *  at all (PM/Architect-authored — see `findStoryLinkedOpenPRs`), or a test-tier subtask
 *  (`IntegrationTest`/`SystemTest`/`E2ETest`) for Tester's own PR (see
 *  `findTestTierLinkedOpenPRs`). `git-pr merge` doesn't care which — it resolves merge
 *  permission from whichever issue's own `persona` field, EXCEPT a test-tier subtask,
 *  which resolves via its sibling `Dev`'s `persona` instead (`resolveGitHost`, `cli.ts`,
 *  since Tester herself has no `mergePullRequest` grant). */
export interface ReadyToMergeCandidate {
    readonly issueKey: IssueKey;
    readonly pullRequest: PullRequestRef;
}

/** TAI-564: an open PR with at least one approval that the merge gate still holds. `blockers` are the gate's own
 *  sentences (`evaluateMergeGate`), so this list and `git-pr merge`'s refusal cannot disagree. Show-only. */
export interface WaitingToMergeCandidate extends ReadyToMergeCandidate {
    readonly blockers: readonly string[];
}

/** TAI-293: issue types a governance-content PR (no `Dev` subtask involved) can be
 *  directly remote-linked to — the same three story-level types plus Epic that
 *  `validatePrTitle`'s direct-invocation form (`git-pr.ts`) already allows a PM/Architect
 *  PR title to reference. `Kickoff` excluded — it has its own PM+UX Approved: comment
 *  gate (`workflows/kickoff.md`), never a PR. */
const GOVERNANCE_ISSUE_TYPES: readonly (StoryType | "epic")[] = [StoryType.Story, StoryType.Bug, StoryType.Spike, "epic"];

/** An issue that's already started (live Jira status `In Progress`/`In Review`), not
 *  genuinely-not-started work (TAI-196/200). Membership comes entirely from live Jira status;
 *  full detail only surfaces once it's actually picked, via `/tai-work`'s own briefing. */
export interface InProgressCandidate {
    readonly issue: Issue;
}

/** TAI-373: an In Progress Kickoff Story whose precedence graph now allows subtask types nobody has created
 *  yet. Informational and never auto-created -- making them is the PM's judgment call (Perry's `/tai-work`). */
export interface UnblockedSubtaskHint {
    readonly story: Issue;
    readonly types: readonly SubtaskType[];
}

/** Kickoff's optional subtask types: a Kickoff may deliberately never have one, so its absence is not a "next step"
 *  and a hint for it would nag forever (TAI-373 -- same noise concern as a normal Story's optional types). */
const OPTIONAL_KICKOFF_SUBTASK_TYPES: ReadonlySet<SubtaskType> = new Set([SubtaskType.ArchitectureDesign]);

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
    /** TAI-390 (TAI-389 ADR decision 8): FLAGGED To Do items (Jira's Flag / impediment: waiting on
     *  something external). They would otherwise be in `ready`, but a flag means "not now", so they
     *  are listed here instead; unflagging puts them back. A flagged In Progress item is NOT held --
     *  it stays in `inProgress` (the work already started; its `issue.flagged` drives a marker). */
    readonly onHold: readonly Issue[];
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
    /** TAI-564: approved PRs the merge gate still holds, with its reasons; show-only. Empty without a git host. */
    readonly waitingToMerge: readonly WaitingToMergeCandidate[];
    /** TAI-266 (TAI-243 ADR): open real-Jira `DependsOn` blockers, keyed by issue key —
     *  covers both `ready` and `inProgress` entries (ADR decision #3), a separate map
     *  rather than a new field on `Issue`/`InProgressCandidate` themselves so this stays
     *  purely additive to the existing shape (no ripple through every other consumer of
     *  `ready: Issue[]`). A key with no entry here has no open blockers — purely
     *  informational (ADR decision #4): never excludes anything from `ready`/`inProgress`,
     *  never blocks `/tai-work`. */
    readonly blockedBy: ReadonlyMap<IssueKey, readonly IssueKey[]>;
    /** TAI-302/319: Epics whose computed summary (status, child done/total tally) has moved
     *  since the `project-home` living doc last snapshotted it — see
     *  `workspace/living-doc-staleness.ts`. Empty whenever no snapshot has ever been taken
     *  (not itself a staleness signal) or nothing has moved since. */
    readonly staleLivingDocs: readonly StaleEpic[];
    /** TAI-373: In Progress Kickoff Stories with unblocked-but-uncreated subtasks (e.g. EpicReview Done, so
     *  Requirements and UxDesign are allowed but absent). Readiness is computed only from tickets that exist, so
     *  without this the next step is invisible. Kickoff only (it creates subtasks lazily; on a normal Story an
     *  absent type is usually a deliberate omission). Respects the persona filter via the Story's own persona. */
    readonly unblockedSubtaskHints: readonly UnblockedSubtaskHint[];
    /** TAI-419 (ADR decision 13c): the best assignee suggestion for each unassigned ready ticket, keyed by issue key.
     *  Empty when `suggestAssignee` was not supplied. Informational only -- never excludes anything. */
    readonly assigneeSuggestions: ReadonlyMap<IssueKey, string>;
    /** TAI-468/546: In Progress Stories and Bugs whose Dev subtasks are all Done but that carry no `Verified:` /
     *  `Not verified:` comment (`verify <KEY>` posts one). Show-only: it never excludes or blocks anything. */
    readonly notVerified: ReadonlySet<IssueKey>;
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

/**
 * TAI-405: `getIssue` fails hard on a ticket whose Jira type TAI does not map (reading one issue by
 * key is deliberately strict), but readiness walks parents and blockers that may be such a ticket.
 * Treat it as unreadable -- null, reported once -- instead of crashing the whole briefing.
 */
async function getIssueOrUnreadable(workTracker: WorkTracker, key: IssueKey): Promise<Issue | null | "unreadable"> {
    try {
        return await workTracker.getIssue(key);
    } catch (e) {
        if (e instanceof UnreadableIssueError) {
            reportUnreadableIssue({ key: e.key, typeName: e.typeName });
            return "unreadable";
        }
        throw e;
    }
}

async function loadParentPrecedenceContext(
    workTracker: WorkTracker,
    projectKey: string,
    parentKey: IssueKey
): Promise<ParentPrecedenceContext | null> {
    const found = await getIssueOrUnreadable(workTracker, parentKey);
    const parent = found === "unreadable" ? null : found;
    if (!parent || !isStoryIssueType(parent.issueType)) {
        // No parent, or a parent that isn't a Story-level ticket (e.g. an Epic) — no
        // SUBTASK_PRECEDENCE graph applies. Conservatively not "ready" via this path rather
        // than guessing; a data-integrity gap here is worth surfacing, not silently papering
        // over.
        return null;
    }
    const siblings = await workTracker.search({ projectKey, parentKey, exhaustive: true });
    const presentSubtaskTypes = siblings.filter((s) => isSubtaskIssueType(s.issueType)).map((s) => s.issueType as SubtaskType);
    const doneSubtaskTypes = new Set(
        siblings
            .filter((s) => isSubtaskIssueType(s.issueType) && (s.status === Status.Done || s.status === Status.Canceled))
            .map((s) => s.issueType as SubtaskType)
    );
    return { storyType: parent.issueType, presentSubtaskTypes, doneSubtaskTypes, priority: parent.priority };
}

/**
 * TAI-266 (TAI-243 ADR): the keys of tickets `issue` genuinely depends on that are still
 * open — a real cross-ticket Jira `Blocks` link (`DependencyRelation.DependsOn`,
 * `"outgoing"`: the tickets `issue` depends on, not the ones depending on it — see
 * `jira/work-tracker.ts`'s `getLinkedIssues` doc comment for the inward/outward mapping),
 * distinct from the internal `SUBTASK_PRECEDENCE` graph `loadParentPrecedenceContext`
 * already checks. A resolved/canceled blocker link is stale data, not a real block (ADR
 * decision #2) — filtered out here, not left for a caller to re-check.
 *
 * One `getLinkedIssues` + one `getIssue` per returned link, per candidate — the same
 * per-candidate extra-Jira-call cost shape `loadParentPrecedenceContext` already accepts
 * for sibling precedence (ADR decision #2: no batching/caching layer for this project's
 * current backlog size).
 */
async function findOpenDependsOnBlockers(workTracker: WorkTracker, issue: Issue): Promise<readonly IssueKey[]> {
    const links = await workTracker.getLinkedIssues(issue.key, DependencyRelation.DependsOn, "outgoing");
    if (links.length === 0) return [];

    const blockers: IssueKey[] = [];
    for (const link of links) {
        const found = await getIssueOrUnreadable(workTracker, link.key);
        // An unreadable blocker's status is unknown, so it stays an open blocker (flagged, never excluded).
        if (found === "unreadable") {
            blockers.push(link.key);
            continue;
        }
        const blocker = found;
        if (blocker && blocker.status !== Status.Done && blocker.status !== Status.Canceled) {
            blockers.push(link.key);
        }
    }
    return blockers;
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

/**
 * Does `pr` need `human`'s review? (TAI-563) Yes when they have not decided on it (not on the reviewer list, or still
 * `"pending"`), and also when they approved or requested changes on an EARLIER commit: the host keeps the decision
 * across later commits, so its status alone would drop a PR that has changed since. Freshness is read from the PR's
 * history, as the merge gate reads it; with no decision of theirs in it, freshness cannot be shown and the PR is listed.
 * Returns `null` when no review is needed, `{}` for a first review, or the re-review mark.
 */
async function reviewNeeded(
    gitHost: Pick<GitHost, "listPullRequestActivity">,
    pr: PullRequestRef,
    human: HumanRef
): Promise<{ readonly reReview?: NonNullable<ReadyToReviewCandidate["reReview"]> } | null> {
    const existing = pr.reviewers.find((r) => sameHuman(r.human, human));
    if (!existing || existing.status === "pending") return {};
    let last: ReturnType<typeof lastDecisionBy>;
    try {
        last = lastDecisionBy(await gitHost.listPullRequestActivity(pr.repo, pr.id), human);
    } catch {
        // One unreadable history (a rate limit, one bad PR) must not take the whole list down: list the PR, say why.
        return { reReview: { decision: existing.status, commit: pr.sourceCommit, since: null, unreadable: true } };
    }
    if (last?.head != null && sameCommit(last.head, pr.sourceCommit)) return null;
    return { reReview: { decision: existing.status, commit: pr.sourceCommit, since: last?.head ?? null } };
}

/** Fetches every configured repo's open PRs ONCE — shared by `findDevLinkedOpenPRs` and
 *  `findStoryLinkedOpenPRs` (TAI-293's review, PR #82) so `computePRSections` doesn't pay
 *  for the same `gitHost.listPullRequests` calls twice per invocation. */
async function fetchOpenPRsByRepo(
    gitHost: Pick<GitHost, "listPullRequests">,
    repos: readonly RepoId[]
): Promise<ReadonlyMap<RepoId, readonly PullRequestRef[]>> {
    const openPRsByRepo = new Map<RepoId, readonly PullRequestRef[]>();
    for (const repo of repos) {
        openPRsByRepo.set(repo, await gitHost.listPullRequests(repo, "open"));
    }
    return openPRsByRepo;
}

/**
 * Shared correlation logic underneath `findDevLinkedOpenPRs`/`findTestTierLinkedOpenPRs`
 * below: searches `In Progress` issues of the given `issueTypes`, then correlates each
 * one's `WorkTracker.getRemoteLinks` against every configured repo's open PRs — the same
 * mechanism TAI-107/108's original `findReadyToMergePRs` used for `CodeReview` subtasks,
 * generalized. Live-queried every call, same "readiness is computed live, per brief
 * §3.6's refresh-point rule" philosophy as the rest of this file — no persisted
 * "awaiting review/merge" flag (TAI-107 ADR decision 5).
 *
 * KNOWN SCALING CAVEAT (documented, not silently accepted, same as the pre-rev-52
 * version): this does one `getRemoteLinks` call per matching `In Progress` issue found
 * (searched exhaustively, TAI-402) — fine at this project's current scale, revisit if a
 * large volume of concurrently-in-progress work ever makes this real.
 */
async function findSubtaskLinkedOpenPRs(
    workTracker: WorkTracker,
    projectKey: string,
    issueTypes: readonly SubtaskType[],
    openPRsByRepo: ReadonlyMap<RepoId, readonly PullRequestRef[]>
): Promise<readonly { readonly issueKey: IssueKey; readonly pullRequest: PullRequestRef }[]> {
    const inProgress = await workTracker.search({
        projectKey,
        issueTypes,
        statuses: [Status.InProgress],
        exhaustive: true,
    });
    if (inProgress.length === 0) return [];

    const candidates: { issueKey: IssueKey; pullRequest: PullRequestRef }[] = [];
    for (const issue of inProgress) {
        const links = await workTracker.getRemoteLinks(issue.key);
        if (links.length === 0) continue;

        for (const openPRs of openPRsByRepo.values()) {
            const match = openPRs.find((pr) => links.some((l) => l.url === pr.url));
            if (!match) continue;
            candidates.push({ issueKey: issue.key, pullRequest: match });
            break;
        }
    }
    return candidates;
}

/**
 * Finds `Dev` subtasks that are `In Progress` (rev 52: `Dev` stays open until its PR
 * merges, not until the PR opens — see story-schema.ts) with a linked open PR (`git-pr
 * create` now links directly to the `Dev` subtask, not a `CodeReview` sibling — TAI-159
 * ADR §4). Feeds BOTH `readyToTest` and `readyToMerge` (see `computePRSections`) — unlike
 * `findTestTierLinkedOpenPRs` below, which feeds `readyToMerge` only.
 */
async function findDevLinkedOpenPRs(
    workTracker: WorkTracker,
    projectKey: string,
    openPRsByRepo: ReadonlyMap<RepoId, readonly PullRequestRef[]>
): Promise<readonly { readonly devSubtaskKey: IssueKey; readonly pullRequest: PullRequestRef }[]> {
    const found = await findSubtaskLinkedOpenPRs(workTracker, projectKey, [SubtaskType.Dev], openPRsByRepo);
    return found.map((c) => ({ devSubtaskKey: c.issueKey, pullRequest: c.pullRequest }));
}

/**
 * TAI-314/315/316 (Confluence page 40304641): the test-tier counterpart to
 * `findDevLinkedOpenPRs` above — an `IntegrationTest`/`SystemTest`/`E2ETest` subtask that
 * opened its own PR to land test code (Tester's `TAI-100` `createPullRequest` grant), now
 * staying `In Progress` after a pass instead of going straight to `Done` (`tester.md`
 * revision, this same ADR) so it can be found here the same way `Dev` already is. Feeds
 * `readyToMerge` ONLY, never `readyToTest` — testing your own test-tier PR is meaningless
 * (same posture `findStoryLinkedOpenPRs` already established for governance-content PRs).
 */
async function findTestTierLinkedOpenPRs(
    workTracker: WorkTracker,
    projectKey: string,
    openPRsByRepo: ReadonlyMap<RepoId, readonly PullRequestRef[]>
): Promise<readonly { readonly issueKey: IssueKey; readonly pullRequest: PullRequestRef }[]> {
    return findSubtaskLinkedOpenPRs(
        workTracker,
        projectKey,
        [SubtaskType.IntegrationTest, SubtaskType.SystemTest, SubtaskType.E2ETest],
        openPRsByRepo
    );
}

/**
 * TAI-293: the governance-content counterpart to `findDevLinkedOpenPRs` above — a PM/
 * Architect-authored PR attached directly to a Story/Bug/Spike/Epic ticket (no `Dev`
 * subtask involved at all, e.g. `PROJECT_BRIEF.md`/persona-doc content — see TAI-286,
 * TAI-292). Same correlation mechanism (`WorkTracker.getRemoteLinks` against each repo's
 * open PRs), scoped to `GOVERNANCE_ISSUE_TYPES` instead of `SubtaskType.Dev`. Feeds ONLY
 * `readyToMerge`, never `readyToTest` — there's no meaningful "test tier" for a docs-only
 * change, and testing an ordinary Story/Bug's `Dev` work already has its own path.
 */
async function findStoryLinkedOpenPRs(
    workTracker: WorkTracker,
    projectKey: string,
    openPRsByRepo: ReadonlyMap<RepoId, readonly PullRequestRef[]>
): Promise<readonly { readonly issueKey: IssueKey; readonly pullRequest: PullRequestRef }[]> {
    const inProgressGovernance = await workTracker.search({
        projectKey,
        issueTypes: GOVERNANCE_ISSUE_TYPES,
        statuses: [Status.InProgress],
        exhaustive: true,
    });
    if (inProgressGovernance.length === 0) return [];

    const candidates: { issueKey: IssueKey; pullRequest: PullRequestRef }[] = [];
    for (const issue of inProgressGovernance) {
        const links = await workTracker.getRemoteLinks(issue.key);
        if (links.length === 0) continue;

        for (const openPRs of openPRsByRepo.values()) {
            const match = openPRs.find((pr) => links.some((l) => l.url === pr.url));
            if (!match) continue;
            candidates.push({ issueKey: issue.key, pullRequest: match });
            break;
        }
    }
    return candidates;
}

/**
 * Detects an In-Progress `Dev` subtask, OR (TAI-293) an In-Progress governance-content
 * Story/Bug/Spike/Epic ticket, OR (TAI-314/315/316) an In-Progress test-tier subtask,
 * whose linked PR has already merged out-of-band — a human merging directly on Bitbucket,
 * or any process outside TAI's own `git-pr merge` (which already self-closes whichever
 * issue it can correlate, `git-pr.ts`'s `findLinkedIssueForPR`) — and syncs it to `Done`
 * here instead. Same principle TAI-34 §2 already established for out-of-band reviews (a
 * human acting directly on the git host is authoritative, detected and reflected at the
 * next refresh point, never fought), just extended from reviews to merges (rev 52,
 * TAI-159 ADR), to governance-content tickets (TAI-293), and now to test-tier subtasks
 * too — this is the realistic path a PR actually merges through: this session's own
 * precedent merged PRs #78/#79/#81 directly via Bitbucket, never through `git-pr merge`
 * at all.
 *
 * Runs at the start of `findReadyWork` so an issue synced to `Done` here doesn't then
 * spuriously appear in `readyToTest`/`readyToMerge` below, computed from the same refresh.
 */
async function syncMergedIssues(
    workTracker: WorkTracker,
    gitHost: Pick<GitHost, "listPullRequests">,
    projectKey: string,
    repos: readonly RepoId[]
): Promise<readonly IssueKey[]> {
    const inProgressCandidates = await workTracker.search({
        projectKey,
        issueTypes: [
            SubtaskType.Dev,
            SubtaskType.IntegrationTest,
            SubtaskType.SystemTest,
            SubtaskType.E2ETest,
            ...GOVERNANCE_ISSUE_TYPES,
        ],
        statuses: [Status.InProgress],
        exhaustive: true,
    });
    if (inProgressCandidates.length === 0) return [];

    const mergedPRsByRepo = new Map<RepoId, readonly PullRequestRef[]>();
    for (const repo of repos) {
        mergedPRsByRepo.set(repo, await gitHost.listPullRequests(repo, "merged"));
    }

    const synced: IssueKey[] = [];
    for (const issue of inProgressCandidates) {
        const links = await workTracker.getRemoteLinks(issue.key);
        if (links.length === 0) continue;

        const isMerged = [...mergedPRsByRepo.values()].some((prs) => prs.some((pr) => links.some((l) => l.url === pr.url)));
        if (!isMerged) continue;

        await workTracker.transition(issue.key, Status.Done);
        synced.push(issue.key);
    }
    return synced;
}

const TEST_TIER_TYPES: ReadonlySet<SubtaskType> = new Set([
    SubtaskType.IntegrationTest,
    SubtaskType.SystemTest,
    SubtaskType.E2ETest,
]);

/**
 * TAI-194: gives the Jira board itself a visible "ready to pick up" signal for Test-tier
 * subtasks, the moment their `Dev` sibling has a qualifying open PR — today that's a
 * purely live-computed fact (`readyToTest` below), invisible to anyone just glancing at
 * the board without running `/tai-ready`. Mirrors `syncMergedIssues`'s own
 * "opportunistic sync as a side effect of ready" pattern exactly: `readyToTest`'s live
 * computation stays the real readiness source (brief §3.6/TAI-171 — this never becomes a
 * second source of truth), this only makes that live state ALSO visible on the board.
 * Only transitions a sibling still sitting in `Backlog` — never disturbs one already
 * further along (`To Do` already, In Progress, or done with).
 */
async function syncTestTiersToToDo(
    workTracker: WorkTracker,
    gitHost: Pick<GitHost, "listPullRequests">,
    projectKey: string,
    repos: readonly RepoId[]
): Promise<readonly IssueKey[]> {
    const openPRsByRepo = await fetchOpenPRsByRepo(gitHost, repos);
    const devLinked = await findDevLinkedOpenPRs(workTracker, projectKey, openPRsByRepo);
    if (devLinked.length === 0) return [];

    const synced: IssueKey[] = [];
    const checkedParents = new Set<IssueKey>();
    for (const { devSubtaskKey } of devLinked) {
        const found = await getIssueOrUnreadable(workTracker, devSubtaskKey);
        const dev = found === "unreadable" ? null : found;
        if (!dev?.parentKey || checkedParents.has(dev.parentKey)) continue;
        checkedParents.add(dev.parentKey);

        const siblings = await workTracker.search({ projectKey, parentKey: dev.parentKey, exhaustive: true });
        for (const sibling of siblings) {
            if (!TEST_TIER_TYPES.has(sibling.issueType as SubtaskType) || sibling.status !== Status.Backlog) continue;
            const result = await workTracker.transition(sibling.key, Status.ToDo);
            if (result.ok) synced.push(sibling.key);
        }
    }
    return synced;
}

/** Just the git-host-derived deps `computePRSections` needs — a subset of
 *  `FindReadyWorkDeps` shared by both `findReadyWork` and the lighter `findReadyPRWork`
 *  (TAI-211/212), neither of which needs `taiRoot` for this part. */
type PRSectionDeps = Pick<
    FindReadyWorkDeps,
    "workTracker" | "projectKey" | "gitHost" | "repos" | "requiredApprovals" | "checkRequired" | "currentHuman" | "prReviewers"
>;

interface PRSections {
    readonly readyToReview: readonly ReadyToReviewCandidate[];
    readonly readyToTest: readonly ReadyToTestCandidate[];
    readonly readyToMerge: readonly ReadyToMergeCandidate[];
    readonly waitingToMerge: readonly WaitingToMergeCandidate[];
}

/** The `readyToReview`/`readyToTest`/`readyToMerge` computation, factored out so
 *  `findReadyPRWork` (TAI-211/212) can reuse it without also paying for `findReadyWork`'s
 *  general Jira-wide `ready` query. `readyToTest` falls out of the same `findDevLinkedOpenPRs`
 *  call `readyToMerge` already needs — computing it costs nothing extra, so it stays part of
 *  this shared helper even though `findReadyPRWork` doesn't expose it in its own result. */
async function computePRSections(deps: PRSectionDeps): Promise<PRSections> {
    let readyToTest: readonly ReadyToTestCandidate[] = [];
    let readyToMerge: readonly ReadyToMergeCandidate[] = [];
    let waitingToMerge: readonly WaitingToMergeCandidate[] = [];
    if (deps.gitHost && deps.repos && deps.repos.length > 0) {
        const requiredApprovals = deps.requiredApprovals ?? DEFAULT_REQUIRED_APPROVALS;
        // Fetched ONCE (PR #82 review) — findDevLinkedOpenPRs/findStoryLinkedOpenPRs both
        // need it, and each configured repo's open-PR list only changes between refresh
        // points anyway (brief §3.6), so there's no reason to ask the git host for it twice.
        const openPRsByRepo = await fetchOpenPRsByRepo(deps.gitHost, deps.repos);

        const devLinked = await findDevLinkedOpenPRs(deps.workTracker, deps.projectKey, openPRsByRepo);
        // Testing runs in parallel with review, not gated behind it — every Dev-linked
        // open PR is a test candidate regardless of approval count. Governance-content
        // PRs (TAI-293) never feed readyToTest — no meaningful test tier for docs-only
        // content.
        readyToTest = devLinked;

        // TAI-293/314/315/316: readyToMerge draws from THREE sources — an ordinary Dev
        // subtask's PR, a governance-content PR linked directly to a Story/Bug/Spike/Epic
        // ticket, or a test-tier subtask's own PR. Same approval-count + CI-green gating
        // either way; `git-pr merge` resolves permission from whichever issue's `persona`
        // field (or, for a test-tier subtask, its sibling `Dev`'s — see `resolveGitHost`,
        // `cli.ts`), not from which source found it.
        const storyLinked = await findStoryLinkedOpenPRs(deps.workTracker, deps.projectKey, openPRsByRepo);
        const testTierLinked = await findTestTierLinkedOpenPRs(deps.workTracker, deps.projectKey, openPRsByRepo);
        const mergeCandidates: readonly ReadyToMergeCandidate[] = [
            ...devLinked.map((c) => ({ issueKey: c.devSubtaskKey, pullRequest: c.pullRequest })),
            ...storyLinked,
            ...testTierLinked,
        ];

        // TAI-462: the same merge gate `git-pr merge` applies (fresh approvals, no standing
        // request-changes, test tiers Done, UAT Done unless labeled uat-after-merge), then CI. A PR with no approval at all is skipped
        // before the gate's own reads -- it cannot pass, and most open PRs are in that state.
        // TAI-564: a PR with an approval on ANY commit that the gate still holds is listed as waiting, with the gate's own
        // sentences. One with no approval at all stays out of both lists (most open PRs are in that state).
        const gateDeps = { gitHost: deps.gitHost, workTracker: deps.workTracker, requiredApprovals };
        const merge: ReadyToMergeCandidate[] = [];
        const waiting: WaitingToMergeCandidate[] = [];
        for (const c of mergeCandidates) {
            if (approvalCount(c.pullRequest) === 0) continue;
            const verdict = await checkMergeGate(gateDeps, c.pullRequest, c.issueKey);
            if (!verdict.ok) {
                waiting.push({ ...c, blockers: verdict.blockers });
                continue;
            }
            const statuses = await deps.gitHost.getCommitStatuses(c.pullRequest.repo, c.pullRequest.sourceCommit);
            // TAI-534: with a check command configured, "no result at all" is not ready either.
            if (deps.checkRequired && statuses.length === 0) continue;
            if (isGreen(statuses)) merge.push(c);
        }
        readyToMerge = merge;
        waitingToMerge = waiting;
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
                const needed = await reviewNeeded(deps.gitHost, pr, deps.currentHuman);
                if (needed) candidates.push({ pullRequest: pr, ...needed });
            }
        }
        readyToReview = candidates;
    }

    return { readyToReview, readyToTest, readyToMerge, waitingToMerge };
}

/**
 * TAI-267 (TAI-247 ADR decision #2): the key of the nearest terminal (Done/Canceled)
 * ancestor, or `null` if none — walks up at most two hops (subtask -> Story/Bug -> Epic),
 * matching TAI's own hierarchy depth, no deeper. A candidate under a terminal ancestor is
 * stale and gets EXCLUDED outright (not just flagged, unlike TAI-266's DependsOn check) —
 * this listing shouldn't be acted on at all, not "proceed with caution."
 *
 * Independent of (and a STRONGER guarantee than) TAI-266's downward cascade
 * (`WorkTracker.transition()`/`cascade-gate.ts`): this also catches a parent closed via a
 * path that bypassed the cascade entirely (e.g. directly in the Jira UI — the exact class of
 * bypass risk the cascade's own doc comment already acknowledges), and any ticket that was
 * ALREADY stale before the cascade ever shipped (TAI-133, this ADR's own motivating case,
 * predates it).
 *
 * `ancestorCache` is a plain `getIssue`-result cache local to one `findReadyWork` call —
 * siblings under the same parent (or cousins under the same grandparent) share fetches
 * rather than each re-fetching the same ancestor.
 */
async function findTerminalAncestor(
    workTracker: WorkTracker,
    issue: Issue,
    ancestorCache: Map<IssueKey, Issue | null>
): Promise<IssueKey | null> {
    let current = issue;
    for (let hop = 0; hop < 2; hop++) {
        if (!current.parentKey) return null;
        let parent = ancestorCache.get(current.parentKey);
        if (parent === undefined) {
            const found = await getIssueOrUnreadable(workTracker, current.parentKey);
            parent = found === "unreadable" ? null : found; // unreadable ancestor: not terminal, as far as TAI can tell
            ancestorCache.set(current.parentKey, parent);
        }
        if (!parent) return null; // malformed/missing data -- not this function's job to flag
        if (parent.status === Status.Done || parent.status === Status.Canceled) return parent.key;
        current = parent;
    }
    return null;
}

/**
 * Finds work that's actually ready to start, optionally scoped to one persona. `persona`
 * omitted means "ready for anyone."
 */
export async function findReadyWork(deps: FindReadyWorkDeps, persona?: Persona): Promise<ReadyWorkResult> {
    if (deps.gitHost && deps.repos && deps.repos.length > 0) {
        await syncMergedIssues(deps.workTracker, deps.gitHost, deps.projectKey, deps.repos);
        await syncTestTiersToToDo(deps.workTracker, deps.gitHost, deps.projectKey, deps.repos);
    }

    const candidates = await deps.workTracker.search({
        projectKey: deps.projectKey,
        ...(persona ? { persona } : {}),
        statuses: OPEN_STATUSES,
        exhaustive: true,
    });

    const ready: Issue[] = [];
    const onHold: Issue[] = [];
    const inProgressIssues: Issue[] = [];
    const parentContexts = new Map<IssueKey, ParentPrecedenceContext | null>();
    const ancestorCache = new Map<IssueKey, Issue | null>();

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
            if (children.length === 0) (isFlagged(issue) ? onHold : ready).push(issue);
            continue;
        }

        // TAI-267 (TAI-247 ADR decision #2): a candidate under an already-terminal ancestor
        // is stale -- excluded outright, before it can reach EITHER `ready` or `inProgress`
        // below. See `findTerminalAncestor`'s own doc comment for why this exists
        // independently of TAI-266's downward cascade, not just as a fallback for it.
        if (await findTerminalAncestor(deps.workTracker, issue, ancestorCache)) continue;

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
            (isFlagged(issue) ? onHold : ready).push(issue);
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
            const offered = issue.priority !== undefined ? issue : { ...issue, priority: ctx.priority };
            (isFlagged(issue) ? onHold : ready).push(offered);
        }
    }

    // TAI-195: P1s (and other priorities) sort to the top — no auto-interrupt of in-flight
    // work (human-decided 2026-08-25), purely a display/ordering change. Stable sort: equal
    // priority (including "both unset") preserves the search's own key-ascending order.
    ready.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
    onHold.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));

    // TAI-195/199 (extended 2026-08-26, human-confirmed after a live PR merge conflict
    // surfaced the gap): In Progress gets the same priority sort/inheritance treatment as
    // Ready Work — a P1 already in flight is exactly the kind of thing that should surface
    // first when resuming work, same rationale as the original decision. Reuses the SAME
    // `parentContexts` cache the Ready Work loop above already populated, so a parent shared
    // between a ready and an in-progress sibling costs nothing extra to look up twice.
    const inProgress: InProgressCandidate[] = [];
    for (const issue of inProgressIssues) {
        let withPriority = issue;
        if (issue.priority === undefined && isSubtaskIssueType(issue.issueType) && issue.parentKey) {
            let ctx = parentContexts.get(issue.parentKey);
            if (ctx === undefined) {
                ctx = await loadParentPrecedenceContext(deps.workTracker, deps.projectKey, issue.parentKey);
                parentContexts.set(issue.parentKey, ctx);
            }
            if (ctx) withPriority = { ...issue, priority: ctx.priority };
        }

        inProgress.push({ issue: withPriority });
    }
    inProgress.sort((a, b) => priorityRank(a.issue.priority) - priorityRank(b.issue.priority));

    // TAI-373: only Kickoff Stories that are actively In Progress (an In Review Kickoff is waiting on its review
    // gate, not on new subtasks). Candidates come from `inProgressIssues`, so the persona filter and the
    // terminal-ancestor exclusion above already applied.
    const unblockedSubtaskHints: UnblockedSubtaskHint[] = [];
    for (const issue of inProgressIssues) {
        if (issue.issueType !== StoryType.Kickoff || issue.status !== Status.InProgress) continue;
        let ctx = parentContexts.get(issue.key);
        if (ctx === undefined) {
            ctx = await loadParentPrecedenceContext(deps.workTracker, deps.projectKey, issue.key);
            parentContexts.set(issue.key, ctx);
        }
        if (!ctx) continue;
        // TAI-443: a `Skipped:` comment on the Kickoff records a deliberate omission; re-read each call, never cached.
        const skipped = skippedSubtaskTypeTokens(issue.comments);
        const types = unblockedAbsentSubtaskTypes(ctx.storyType, ctx.presentSubtaskTypes, ctx.doneSubtaskTypes).filter(
            (t) => !OPTIONAL_KICKOFF_SUBTASK_TYPES.has(t) && !skipped.has(normalizeSubtaskTypeToken(t))
        );
        if (types.length > 0) unblockedSubtaskHints.push({ story: issue, types });
    }
    unblockedSubtaskHints.sort((a, b) => priorityRank(a.story.priority) - priorityRank(b.story.priority));

    // TAI-266 (TAI-243 ADR decision #3): the same open-DependsOn-blocker check applies to
    // BOTH `ready` and `inProgress` — an In Progress item can newly become blocked if a
    // DependsOn link is added or its blocker reopens after work already started.
    const blockedBy = new Map<IssueKey, readonly IssueKey[]>();
    for (const issue of [...ready, ...inProgress.map((c) => c.issue)]) {
        const blockers = await findOpenDependsOnBlockers(deps.workTracker, issue);
        if (blockers.length > 0) blockedBy.set(issue.key, blockers);
    }

    const notVerified = await findNotVerified(deps.workTracker, deps.projectKey, inProgress.map((c) => c.issue));

    const { readyToReview, readyToTest, readyToMerge, waitingToMerge } = await computePRSections(deps);
    const staleLivingDocs = await computeStaleLivingDocs(deps.workTracker, deps.taiRoot, deps.projectKey);

    const assigneeSuggestions = new Map<IssueKey, string>();
    if (deps.suggestAssignee) {
        for (const issue of ready) {
            if (issue.assignee || !issue.persona) continue;
            try {
                const suggestion = await deps.suggestAssignee(issue);
                if (suggestion) assigneeSuggestions.set(issue.key, suggestion);
            } catch {
                // A suggestion is a convenience; one that cannot be computed must never fail /tai-ready.
            }
        }
    }

    return {
        ready,
        onHold,
        inProgress,
        unblockedSubtaskHints,
        readyToReview,
        readyToTest,
        readyToMerge,
        waitingToMerge,
        blockedBy,
        staleLivingDocs,
        assigneeSuggestions,
        notVerified,
    };
}

/** TAI-302/319: short-circuits before fetching a single Epic/child when no snapshot has ever
 *  been taken (the common case until a project actually starts using `doc
 *  snapshot-living-doc`) — same "only pay for what's configured" posture as the
 *  gitHost/repos-optional PR sections above. */
async function computeStaleLivingDocs(
    workTracker: WorkTracker,
    taiRoot: string,
    projectKey: string
): Promise<readonly StaleEpic[]> {
    // TAI-302/319 ADR: only the Home Page's Epic-summary case is wired up -- see
    // EPIC_SUMMARY_LIVING_DOC_TYPES's own doc comment for why "project-home" specifically,
    // and why Architecture Overview isn't checked here too.
    const snapshot = await readLivingDocSnapshot(taiRoot, projectKey, EPIC_SUMMARY_LIVING_DOC_TYPES[0]!);
    if (!snapshot) return [];

    const epics = await workTracker.search({ projectKey, issueTypes: ["epic"], exhaustive: true });
    const summaries: EpicSummary[] = [];
    for (const epic of epics) {
        const children = await workTracker.search({
            projectKey,
            parentKey: epic.key,
            issueTypes: EPIC_CHILD_ISSUE_TYPES,
            exhaustive: true,
        });
        summaries.push(computeEpicSummary(epic, children));
    }
    return diffLivingDocSnapshot(summaries, snapshot);
}

export interface FindReadyPRWorkDeps {
    readonly workTracker: WorkTracker;
    readonly projectKey: string;
    readonly gitHost?: Pick<GitHost, "listPullRequests" | "getCommitStatuses" | "listPullRequestActivity">;
    readonly repos?: readonly RepoId[];
    readonly requiredApprovals?: number;
    /** TAI-534: the project has a check command, so a PR whose commit has no status is not ready to merge. */
    readonly checkRequired?: boolean;
    readonly currentHuman?: HumanRef;
    readonly prReviewers?: readonly HumanRef[];
}

export interface ReadyPRWorkResult {
    readonly readyToReview: readonly ReadyToReviewCandidate[];
    readonly readyToMerge: readonly ReadyToMergeCandidate[];
    readonly waitingToMerge: readonly WaitingToMergeCandidate[];
}

/**
 * Lighter-weight sibling to `findReadyWork` (TAI-211/212) — for PR-review-mode, where the
 * general Jira-wide `ready` query (and its per-parent precedence resolution) and the
 * `inFlight` status rollup are pure overhead: just `readyToReview` + `readyToMerge`, the two
 * sections actually relevant to a human deciding what PR to act on next. `readyToTest` is
 * deliberately not exposed here — it's Tester-persona scope, out of place in a review/merge
 * view (human-confirmed, TAI-211).
 *
 * Still runs `syncMergedIssues` first, same as `findReadyWork` — a `Dev` subtask merged
 * out-of-band shouldn't spuriously appear as still awaiting review/merge from this same call.
 */
export async function findReadyPRWork(deps: FindReadyPRWorkDeps): Promise<ReadyPRWorkResult> {
    if (deps.gitHost && deps.repos && deps.repos.length > 0) {
        await syncMergedIssues(deps.workTracker, deps.gitHost, deps.projectKey, deps.repos);
        // TAI-194/198: keeps the Jira board's Test-tier subtasks in sync too, even from this
        // lighter command — a side effect independent of what pr-ready itself displays (it
        // doesn't expose readyToTest at all, TAI-211's decided scope), same as
        // syncMergedIssues running here regardless of display scope.
        await syncTestTiersToToDo(deps.workTracker, deps.gitHost, deps.projectKey, deps.repos);
    }
    const { readyToReview, readyToMerge, waitingToMerge } = await computePRSections(deps);
    return { readyToReview, readyToMerge, waitingToMerge };
}
