/**
 * TAI Framework — `git-pr review`/`git-pr merge` PR-ID resolution (TAI-87)
 *
 * `<PR-ID>` is the one argument in `git-pr review|merge <ISSUE-KEY> <REPO> [PR-ID] ...`
 * that's genuinely awkward to type from memory — unlike `<ISSUE-KEY>` (what the persona is
 * already working) or `<REPO>` (a stable, memorable value that doesn't change per-PR), a PR
 * number has to be looked up from a prior `create` call or the Bitbucket UI. Found live
 * (2026-08-17) during TAI-87's own Gemini CLI smoke test: a bare `/tai-pr merge` only
 * "worked" because Gemini inferred the PR-ID from its own recent conversation history —
 * fragile, since a fresh session or a different persona turn has nothing to infer from.
 *
 * This resolves it from `GitHost.listPullRequests` instead, scoped to `repo`'s currently
 * open PRs — no new `GitHost` primitive needed, and no local git shell-out (`cli.ts`
 * deliberately has none, brief §9/TAI-90 discussion: cwd is the target repo, but nothing
 * here needs to know its branch). Same "don't guess, ask" posture as `NoOwningPersonaError`/
 * `PersonaPermissionError` elsewhere: zero matches or more than one both fail loudly with
 * enough detail to act on, rather than picking one.
 */

import type { CommitStatus, MergeStrategy, PullRequestId, RepoId } from "../git/interface.js";
import type { GitHost } from "../git/interface.js";
import { toPullRequestId } from "../git/interface.js";
import { Status, SubtaskType } from "../schema/story-schema.js";
import type { IssueKey, WorkTracker } from "../storage/interface.js";

export async function resolvePullRequestId(
    gitHost: Pick<GitHost, "listPullRequests">,
    repo: RepoId,
    explicit?: string
): Promise<PullRequestId> {
    if (explicit) return toPullRequestId(explicit);

    const open = await gitHost.listPullRequests(repo, "open");
    if (open.length === 0) {
        throw new Error(`No open pull requests found for ${repo} — pass a PR-ID explicitly.`);
    }
    if (open.length > 1) {
        const list = open
            .map((pr) => `  - ${pr.id}: ${pr.title} (${pr.sourceBranch} → ${pr.destinationBranch})`)
            .join("\n");
        throw new Error(`Multiple open pull requests found for ${repo} — pass a PR-ID explicitly:\n${list}`);
    }
    return open[0]!.id;
}

// ---------- CI-status gating (TAI-107/TAI-108) ----------
//
// Brief §5.4: "Merge/Deploy -> GitHost.mergePullRequest, gated on GitHost.getCommitStatuses
// being green first." Confirmed live (2026-08-20) that nothing in the codebase actually did
// this — both this session's real merges (PR #16, #17) went through with zero CI check.

/**
 * "Green" per brief §5.4's merge gate: at least one status exists — a commit with zero
 * statuses means the pipeline never ran (or this is the wrong commit), which must NOT read
 * as "nothing to block on," same reasoning as `bitbucket-git-host.integration.test.ts`'s own
 * live assertion that master's HEAD always has statuses once the pipeline exists — AND every
 * one of them succeeded.
 */
export function isGreen(statuses: readonly CommitStatus[]): boolean {
    return statuses.length > 0 && statuses.every((s) => s.state === "successful");
}

// ---------- PR <-> Dev subtask correlation (rev 52, TAI-159 ADR §4) ----------
//
// Pre-rev-52 this file had `findCodeReviewSiblingForLink` — a sibling-search-plus-
// DependsOn-disambiguation function needed because the PR conceptually belonged to a
// SEPARATE CodeReview subtask, not the Dev subtask that opened it. `CodeReview` is retired
// going forward (never created for new work — see story-schema.ts), so that indirection is
// gone: `git-pr create <DEV-SUBTASK-KEY> ...` already has the Dev subtask's own key as its
// first argument, and the PR links directly to it, no search/disambiguation needed at all.
// A net simplification, not a replacement function.

// ---------- Dev subtask self-closing on merge (rev 52, TAI-159 ADR §4) ----------

/**
 * Finds the `In Progress` `Dev` subtask linked to a just-merged PR, so `git-pr merge` can
 * transition it to `Done` as a second write in the same call — the same "one command, two
 * writes" shape `git-pr create` already has (PR create + remote link).
 *
 * Doesn't assume the `<ISSUE-KEY>` the merge was invoked with IS the linked Dev subtask —
 * that key is sometimes borrowed purely to resolve a different persona's `gitHost`
 * permission grant (an established pattern: merging a PM/Architect governance-content PR
 * via a Dev subtask's `mergePullRequest` grant), so it isn't reliable as the correlation
 * key. Instead searches the project's `In Progress` `Dev` subtasks for whichever one's own
 * remote link points at this PR's URL — same correlation idiom `ready.ts`'s
 * `findDevLinkedOpenPRs` and (pre-rev-52) `findCodeReviewSiblingForLink` both used.
 *
 * Returns `null` rather than throwing when no match exists — same "best-effort, don't fail
 * the action itself over this" posture as the pre-rev-52 sibling-correlation function. A
 * merge that can't be correlated to a Dev subtask (e.g. a governance-content PR with no
 * Dev subtask at all) still succeeds; only the self-closing side effect is skipped.
 */
export async function findLinkedDevSubtask(
    workTracker: Pick<WorkTracker, "search" | "getRemoteLinks">,
    projectKey: string,
    prUrl: string
): Promise<IssueKey | null> {
    const inProgressDevs = await workTracker.search({
        projectKey,
        issueTypes: [SubtaskType.Dev],
        statuses: [Status.InProgress],
    });
    for (const dev of inProgressDevs) {
        const links = await workTracker.getRemoteLinks(dev.key);
        if (links.some((l) => l.url === prUrl)) return dev.key;
    }
    return null;
}

// ---------- Branch naming (TAI-107/TAI-108) ----------

/**
 * Validates brief §6's branching convention: a branch is named after the *parent* Story/Bug
 * key, not a subtask's own key — "Subtasks accumulate onto their parent Story's branch."
 * Found live (TAI-107): this session's own branches (`TAI-98-materialize-...`,
 * `TAI-100-integration-test-...`) deviated from this, named after the subtask instead. The
 * docs (`personas/developer.md`, `workflows/story.md`) already correctly reference §6 — this
 * was an execution deviation, not a doc bug — so this check exists to catch a repeat, same
 * "fail loudly, don't silently guess" posture as this file's argument parsing above.
 */
export function validateBranchName(sourceBranch: string, storyKey: IssueKey): void {
    if (sourceBranch !== storyKey && !sourceBranch.startsWith(`${storyKey}-`)) {
        throw new Error(
            `Source branch "${sourceBranch}" should start with the parent Story/Bug's key "${storyKey}-" ` +
                `per brief §6, not a subtask's own key — subtasks accumulate onto their parent Story's branch.`
        );
    }
}

/**
 * Validates that a PR title is tied to its parent Story/Bug first, subtask second (TAI-112) —
 * required prefix `"<storyKey> - <subtaskKey> - "` when `git-pr create` was invoked against a
 * subtask (`subtaskKey` non-null), or just `"<storyKey> - "` when invoked directly against a
 * Story/Bug/Epic key with no subtask (e.g. PM/Architect's own governance-content PRs). Found
 * live: the 10 merged PRs preceding this ticket used neither convention consistently — some
 * titled by subtask key alone, some by Story key alone. Same validate-only, fail-loudly
 * posture as `validateBranchName` above — the persona still writes the title, this only
 * rejects a malformed one rather than silently constructing/correcting it.
 */
export function validatePrTitle(title: string, storyKey: IssueKey, subtaskKey: IssueKey | null): void {
    const requiredPrefix = subtaskKey ? `${storyKey} - ${subtaskKey} - ` : `${storyKey} - `;
    if (!title.startsWith(requiredPrefix)) {
        throw new Error(
            `PR title "${title}" should start with "${requiredPrefix}" — PRs are tied to their parent ` +
                `Story/Bug first, subtask second, per brief §6.`
        );
    }
}

// ---------- Argument parsing: `[PR-ID]` optional, but never guessed silently ----------
//
// Gemini CLI review of this Story's own first pass (PR #15) found a real safety hazard:
// discriminating "PR-ID given" vs "PR-ID omitted" purely by *shape* (all-digits) means a
// typo'd PR-ID (e.g. "12s") silently reads as "omitted" — auto-resolving to whatever's
// open (possibly the wrong PR) with the merge strategy *also* silently defaulting, since
// "12s" doesn't match any known strategy literal either. Two silent wrong guesses stacked
// on one typo, no error at any point.
//
// Fixed by anchoring on the argument that both actions already validate against a CLOSED
// set of literal values — `decision` (`approve`/`requestChanges`) for review, `strategy`
// (`mergeCommit`/`squash`/`fastForward`) for merge — rather than sniffing the PR-ID's
// shape. Anything that matches neither "looks like the anchor" nor "is a plausible PR-ID"
// throws, it never falls through to a default.

const VALID_STRATEGIES: readonly MergeStrategy[] = ["mergeCommit", "squash", "fastForward"];

function isValidStrategy(s: string | undefined): s is MergeStrategy {
    return s !== undefined && (VALID_STRATEGIES as readonly string[]).includes(s);
}

export interface ParsedReviewArgs {
    readonly prIdArg: string | undefined;
    readonly decision: "approve" | "requestChanges";
    readonly comment: string | undefined;
}

/** Parses `git-pr review`'s trailing args: `[PR-ID] <approve|requestChanges> [COMMENT]`.
 *  `decision` is required and closed-set, so it's the reliable anchor — whichever
 *  position holds a literal `approve`/`requestChanges` IS the decision; there's no
 *  silent-default path here at all (unlike merge's optional strategy). */
export function parseReviewArgs(gitArgs: readonly string[]): ParsedReviewArgs {
    const [first, second, third] = gitArgs;
    const [prIdArg, decision, comment] =
        first === "approve" || first === "requestChanges" ? [undefined, first, second] : [first, second, third];
    if (decision !== "approve" && decision !== "requestChanges") {
        throw new Error("Usage: git-pr review <REPO> [PR-ID] <approve|requestChanges> [COMMENT]");
    }
    return { prIdArg, decision, comment };
}

export interface ParsedMergeArgs {
    readonly prIdArg: string | undefined;
    readonly strategy: MergeStrategy;
}

/** Parses `git-pr merge`'s trailing args: `[PR-ID] [mergeCommit|squash|fastForward]`. Both
 *  are optional, so — unlike review's required `decision` — there's no single reliable
 *  anchor; a token that's neither a valid strategy literal nor plausibly a PR-ID (all
 *  digits) throws rather than silently becoming "PR-ID omitted, strategy defaulted", which
 *  is exactly the two-silent-guesses hazard this was written to close. */
export function parseMergeArgs(gitArgs: readonly string[]): ParsedMergeArgs {
    const [first, second] = gitArgs;

    if (first === undefined) return { prIdArg: undefined, strategy: "mergeCommit" };

    if (isValidStrategy(first)) return { prIdArg: undefined, strategy: first };

    if (!/^\d+$/.test(first)) {
        throw new Error(
            `Invalid merge strategy or PR-ID "${first}" — expected a numeric PR-ID or one of ${VALID_STRATEGIES.join("|")}.`
        );
    }
    if (second !== undefined && !isValidStrategy(second)) {
        throw new Error(`Invalid merge strategy "${second}" — expected one of ${VALID_STRATEGIES.join("|")}.`);
    }
    return { prIdArg: first, strategy: second ?? "mergeCommit" };
}

export interface ParsedCommentArgs {
    readonly prIdArg: string | undefined;
    readonly body: string;
}

/** Parses `git-pr comment`'s trailing args: `[PR-ID] <BODY>` (TAI-187). Unlike merge's two
 *  optional args, this has no heuristic-detection ambiguity: `BODY` is required and always
 *  the LAST argument (callers pass it as one already-quoted string, same convention as
 *  every other free-text arg in this CLI — `issue comment`'s own `<BODY>`, `page create`'s
 *  `<CONTENT>`) — so argument COUNT alone disambiguates. */
export function parseCommentArgs(gitArgs: readonly string[]): ParsedCommentArgs {
    const [first, second] = gitArgs;
    if (second !== undefined) return { prIdArg: first, body: second };
    if (first !== undefined) return { prIdArg: undefined, body: first };
    throw new Error("Usage: git-pr comment <REPO> [PR-ID] <BODY>");
}
