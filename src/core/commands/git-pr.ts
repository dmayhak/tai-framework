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

import { CHECK_STATUS_KEY } from "../git/local-check.js";
import type { CommitStatus, MergeStrategy, PullRequestId, RepoId } from "../git/interface.js";
import type { GitHost } from "../git/interface.js";
import { toPullRequestId } from "../git/interface.js";
import { isSubtaskIssueType, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import type { Issue, IssueKey, WorkTracker } from "../storage/interface.js";

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

// ---------- CI-status gating (TAI-107/TAI-108, revised TAI-230/250, TAI-714) ----------
//
// Brief §5.4: "Merge/Deploy -> GitHost.mergePullRequest, gated on GitHost.getCommitStatuses
// being green first."
//
// History: TAI-230/250 made an empty status list green because Pipelines had become manual-only.
// TAI-714 reverses the default: an empty list is also what a fresh push looks like before the host
// has registered its CI run, so a merge right after a push could pass before CI reported. The gate
// now needs a CI result unless the project's `require-ci` setting is off (CI cannot run on the
// account). A status that exists and is not successful blocks either way.

export type CiVerdict =
    | { readonly ok: true }
    | {
          readonly ok: false;
          /** `no-ci`: nothing reported yet. `waiting`: reported but not finished. `failed`: a status ended unsuccessfully. `check-unfinished`: TAI's own check is recorded but not finished (a local command sets it, so waiting does not help). */
          readonly kind: "no-ci" | "waiting" | "failed" | "check-unfinished";
          readonly reason: string;
      };

/**
 * The CI part of the merge gate, from the commit's statuses.
 *
 * A CI status is any status that is not TAI's own `tai-check`. With `requireCi` on, at least one must
 * exist and every one must be finished and successful. With it off, none need exist; one that is present
 * and failed (or still running) still blocks. `tai-check`, when present, must be successful either way; one that
 * is recorded but unfinished is its own kind, since only a local command can change it and waiting would not help.
 * Failure is reported before waiting, and waiting before absence, so the most final cause is named.
 */
export function ciVerdict(statuses: readonly CommitStatus[], requireCi: boolean, commit: string): CiVerdict {
    const list = (xs: readonly CommitStatus[]) => xs.map((s) => `${s.key}: ${s.state}`).join(", ");
    const bad = statuses.filter((s) => s.state === "failed" || s.state === "stopped");
    if (bad.length > 0) return { ok: false, kind: "failed", reason: `CI status not green for ${commit} — ${list(bad)}.` };
    const ownUnfinished = statuses.filter((s) => s.key === CHECK_STATUS_KEY && s.state !== "successful");
    if (ownUnfinished.length > 0) return { ok: false, kind: "check-unfinished", reason: `The TAI check is not finished for ${commit} — ${list(ownUnfinished)}. Run \`git-pr check\` again.` };
    const unfinished = statuses.filter((s) => s.state !== "successful");
    if (unfinished.length > 0) return { ok: false, kind: "waiting", reason: `Waiting for CI on ${commit} — ${list(unfinished)}.` };
    if (requireCi && !statuses.some((s) => s.key !== CHECK_STATUS_KEY)) {
        return { ok: false, kind: "no-ci", reason: `No CI run on this commit yet (${commit}). Wait for CI to start, or turn \`require-ci\` off if CI cannot run on this account.` };
    }
    return { ok: true };
}

/**
 * True if a `mergePullRequest` denial reason (`GitMutationResult`'s `reason`, Bitbucket's own
 * raw rejection text — `rest-client.ts`'s `extractReason`) means a merge conflict specifically,
 * as opposed to any other denial (branch restriction, insufficient approvals, ...). Bitbucket's
 * own conflict message is "You can't merge until you resolve all merge conflicts." (TAI-217/219,
 * confirmed live) — a simple case-insensitive substring check, same pragmatism as `ciVerdict`'s
 * own state check, rather than parsing a structured error code Bitbucket doesn't expose here.
 */
export function isMergeConflict(reason: string): boolean {
    // GitHub refuses a conflicting PR with "Pull Request is not mergeable" (TAI-583); its
    // protection and review refusals are worded differently.
    const r = reason.toLowerCase();
    return r.includes("conflict") || r.includes("not mergeable");
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

// ---------- Issue self-closing on merge (rev 52, TAI-159 ADR §4; generalized TAI-293) ----------

/**
 * Finds the `In Progress` issue linked to a just-merged PR — a `Dev` subtask for ordinary
 * Story/Bug work, (TAI-293) a governance-content Story/Bug/Spike/Epic ticket with no
 * `Dev` subtask at all (PM/Architect-authored, e.g. `PROJECT_BRIEF.md`/persona-doc
 * content), or (TAI-314/315/316) a test-tier subtask (`IntegrationTest`/`SystemTest`/
 * `E2ETest`) or (TAI-614) `Database` subtask that opened its own PR — so `git-pr merge` can transition it to `Done` as a
 * second write in the same call. Same "one command, two writes" shape `git-pr create`
 * already has (PR create + remote link).
 *
 * Doesn't assume the `<ISSUE-KEY>` the merge was invoked with IS the linked issue — before
 * TAI-293 granted PM/Architect their own `mergePullRequest`, that key was sometimes
 * borrowed purely to resolve a different persona's `gitHost` permission grant, so it was
 * never reliable as the correlation key; still isn't assumed now, for the same reason a
 * human might invoke `git-pr merge` with any issue key that happens to have the right
 * permission. Instead searches the project's `In Progress` Dev/Story/Bug/Spike/Epic issues
 * for whichever one's own remote link points at this PR's URL — same correlation idiom
 * `ready.ts`'s `findDevLinkedOpenPRs`/`findStoryLinkedOpenPRs` and (pre-rev-52)
 * `findCodeReviewSiblingForLink` all used.
 *
 * Returns `null` rather than throwing when no match exists — same "best-effort, don't fail
 * the action itself over this" posture as the pre-rev-52 sibling-correlation function. A
 * merge that can't be correlated to any tracked issue still succeeds; only the self-closing
 * side effect is skipped.
 */
export async function findLinkedIssueForPR(
    workTracker: Pick<WorkTracker, "search" | "getRemoteLinks">,
    projectKey: string,
    prUrl: string
): Promise<IssueKey | null> {
    const inProgressCandidates = await workTracker.search({
        projectKey,
        issueTypes: [
            SubtaskType.Dev,
            SubtaskType.IntegrationTest,
            SubtaskType.SystemTest,
            SubtaskType.E2ETest,
            SubtaskType.Database,
            StoryType.Story,
            StoryType.Bug,
            StoryType.Spike,
            "epic",
        ],
        statuses: [Status.InProgress],
    });
    for (const issue of inProgressCandidates) {
        const links = await workTracker.getRemoteLinks(issue.key);
        if (links.some((l) => l.url === prUrl)) return issue.key;
    }
    return null;
}

// ---------- Branch naming (TAI-107/TAI-108) ----------

/**
 * TAI-297: resolves which key `git-pr create`'s branch/title validation should require —
 * the issue's OWN key, unless it's actually a subtask, in which case its parent's.
 *
 * Deliberately checks `isSubtaskIssueType(issue.issueType)`, NOT `issue.parentKey`
 * presence — a standalone governance-content Story/Bug can carry a `parentKey` purely for
 * topical categorization under an Epic (not as a branch-naming parent), and checking
 * presence alone misclassified it as a subtask, wrongly demanding the branch/title
 * reference that Epic instead of the ticket's own key. Found live (TAI-292's PR):
 * `git-pr create TAI-292 ...` rejected a `TAI-292-...` branch name, insisting on
 * `TAI-9-...` (TAI-292's Epic parent), forcing a direct-Bitbucket-MCP workaround instead
 * of TAI's own tooling.
 *
 * `subtaskKey` is `null` for a story-level ticket (matches `validatePrTitle`'s own
 * "Story/Bug/Epic key with no subtask" direct-invocation form), or the issue's own key
 * when it IS a subtask (a subtask's parent, if it has none, falls back to the subtask's
 * own key — same defensive fallback the pre-TAI-297 form had).
 */
export function resolveStoryKeyForPr(issue: Pick<Issue, "key" | "issueType" | "parentKey">): {
    readonly storyKey: IssueKey;
    readonly subtaskKey: IssueKey | null;
} {
    if (isSubtaskIssueType(issue.issueType)) {
        return { storyKey: issue.parentKey ?? issue.key, subtaskKey: issue.key };
    }
    return { storyKey: issue.key, subtaskKey: null };
}

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

export interface ParsedFindingsCommentArgs {
    readonly prIdArg: string | undefined;
    readonly findingsArg: string;
}

/** Parses `git-pr comment-findings`'s trailing args: `[PR-ID] <FINDINGS-JSON-OR-@FILE>` —
 *  same last-argument-is-required, count-disambiguates convention as `parseCommentArgs`
 *  (TAI-209 ADR Decision §2). */
export function parseFindingsCommentArgs(gitArgs: readonly string[]): ParsedFindingsCommentArgs {
    const [first, second] = gitArgs;
    if (second !== undefined) return { prIdArg: first, findingsArg: second };
    if (first !== undefined) return { prIdArg: undefined, findingsArg: first };
    throw new Error("Usage: git-pr comment-findings <REPO> [PR-ID] <FINDINGS-JSON-OR-@FILE>");
}
