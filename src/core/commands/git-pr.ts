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

import type { GitHost, PullRequestId, RepoId } from "../git/interface.js";
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
