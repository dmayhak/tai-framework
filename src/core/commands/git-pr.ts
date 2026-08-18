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

import type { GitHost, MergeStrategy, PullRequestId, RepoId } from "../git/interface.js";
import { toPullRequestId } from "../git/interface.js";

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
        throw new Error("Usage: git-pr review <ISSUE-KEY> <REPO> [PR-ID] <approve|requestChanges> [COMMENT]");
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
