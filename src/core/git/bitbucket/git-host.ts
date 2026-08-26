/**
 * TAI Framework — Bitbucket Cloud `GitHost` implementation (TAI-33 ADR)
 *
 * The one concrete `GitHost` backend actually needed first (TAI's own repo), mirroring
 * brief §9 Phase 3's "build the interface + the one backend actually needed" pragmatism.
 * A GitHub backend is explicitly out of scope until a real need appears (TAI-37 scope).
 */

import type { HumanRef } from "../../storage/interface.js";
import type {
    GitHost,
    RepoId,
    RepoRef,
    PullRequestId,
    PullRequestState,
    PullRequestRef,
    CreatePullRequestInput,
    CommitSha,
    CommitStatus,
    GitMutationResult,
} from "../interface.js";
import { RestClient, BitbucketRejection } from "./rest-client.js";
import {
    toRepoRef,
    toPullRequestRef,
    toCommitStatus,
    toComment,
    toHumanRef,
    type BitbucketRepositoryJson,
    type BitbucketPullRequestJson,
    type BitbucketCommitStatusJson,
    type BitbucketCommentJson,
    type BitbucketUserJson,
} from "./mappers.js";

/**
 * `RepoId` is opaque per `git/interface.ts`'s own doc comment — but SOMETHING has to know
 * its concrete shape to make API calls. This backend's contract with itself: `"workspace/
 * repo_slug"`, matching Bitbucket's own `full_name` field, so a `RepoRef.id` round-trips
 * straight back into a URL with no lookup table needed.
 */
function splitRepoId(repo: RepoId): { workspace: string; slug: string } {
    const [workspace, slug] = (repo as string).split("/");
    if (!workspace || !slug) {
        throw new Error(
            `Malformed RepoId "${repo}" for the Bitbucket backend — expected "workspace/repo_slug"`
        );
    }
    return { workspace, slug };
}

const BB_MERGE_STRATEGY: Record<
    NonNullable<Parameters<GitHost["mergePullRequest"]>[2]>,
    string
> = {
    mergeCommit: "merge_commit",
    squash: "squash",
    fastForward: "fast_forward",
};

const BB_PR_STATE: Record<PullRequestState, string> = {
    open: "OPEN",
    merged: "MERGED",
    declined: "DECLINED",
};

function humanReviewerBody(human: HumanRef): { account_id: string } {
    return { account_id: human.id as string };
}

export function createBitbucketGitHost(client: RestClient): GitHost {
    return {
        // TAI-213/214 (found live, 2026-08-26): the authenticated user's REAL Bitbucket
        // identity (account_id/display_name) — not a synthetic HumanRef built from the
        // configured email, which can never match a PullRequestRef's own reviewer entries
        // (see this method's doc comment on the GitHost interface).
        async getCurrentUser(): Promise<HumanRef> {
            const user = await client.request<BitbucketUserJson>("GET", "/user");
            return toHumanRef(user);
        },

        async getRepository(id: RepoId): Promise<RepoRef | null> {
            const { workspace, slug } = splitRepoId(id);
            const repo = await client.getOrNull<BitbucketRepositoryJson>(
                `/repositories/${workspace}/${slug}`
            );
            return repo ? toRepoRef(repo) : null;
        },

        async listRepositories(workspace: string): Promise<readonly RepoRef[]> {
            const repos = await client.paginate<BitbucketRepositoryJson>(`/repositories/${workspace}`);
            return repos.map(toRepoRef);
        },

        async listBranches(repo: RepoId, limit?: number): Promise<readonly string[]> {
            const { workspace, slug } = splitRepoId(repo);
            const branches = await client.paginate<{ name: string }>(
                `/repositories/${workspace}/${slug}/refs/branches`,
                limit
            );
            return branches.map((b) => b.name);
        },

        async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
            const { workspace, slug } = splitRepoId(input.repo);
            const pr = await client.request<BitbucketPullRequestJson>(
                "POST",
                `/repositories/${workspace}/${slug}/pullrequests`,
                {
                    title: input.title,
                    ...(input.description !== undefined ? { description: input.description } : {}),
                    source: { branch: { name: input.sourceBranch } },
                    destination: { branch: { name: input.destinationBranch } },
                    ...(input.reviewers ? { reviewers: input.reviewers.map(humanReviewerBody) } : {}),
                }
            );
            return toPullRequestRef(pr, input.repo);
        },

        async getPullRequest(repo: RepoId, id: PullRequestId): Promise<PullRequestRef | null> {
            const { workspace, slug } = splitRepoId(repo);
            const pr = await client.getOrNull<BitbucketPullRequestJson>(
                `/repositories/${workspace}/${slug}/pullrequests/${id}`
            );
            return pr ? toPullRequestRef(pr, repo) : null;
        },

        async listPullRequests(
            repo: RepoId,
            state?: PullRequestState
        ): Promise<readonly PullRequestRef[]> {
            const { workspace, slug } = splitRepoId(repo);
            // TAI-213/214 (found live, 2026-08-26): Bitbucket's list-PRs endpoint omits
            // `participants` by default (see mappers.ts's `BitbucketPullRequestJson` doc comment)
            // -- every `PullRequestRef` built from this endpoint used to report empty
            // `reviewers` regardless of real approval state, silently breaking `readyToReview`
            // (showed every open PR, approved or not) and `readyToMerge` (never populated) in
            // `ready.ts`. `fields=+values.participants` is Bitbucket's partial-response syntax
            // for asking a list endpoint to include a field it omits by default on each item;
            // `URLSearchParams` percent-encodes the literal `+` to `%2B` (required -- a bare `+`
            // in a query string means space, not the character Bitbucket's syntax needs).
            const params = new URLSearchParams({ fields: "+values.participants" });
            if (state) params.set("state", BB_PR_STATE[state]);
            const prs = await client.paginate<BitbucketPullRequestJson>(
                `/repositories/${workspace}/${slug}/pullrequests?${params}`
            );
            return prs.map((pr) => toPullRequestRef(pr, repo));
        },

        async reviewPullRequest(
            repo: RepoId,
            id: PullRequestId,
            decision: "approve" | "requestChanges",
            comment?: string
        ): Promise<void> {
            const { workspace, slug } = splitRepoId(repo);
            const action = decision === "approve" ? "approve" : "request-changes";
            await client.request("POST", `/repositories/${workspace}/${slug}/pullrequests/${id}/${action}`);
            // Bitbucket's approve/request-changes endpoints take no comment body — a comment
            // is a separate write, same two-call shape TAI-34's ADR already expects at the
            // Jira layer (GitHost.reviewPullRequest + WorkTracker.transition are already two
            // calls; this is the git-host side occasionally being two calls itself).
            if (comment) {
                await client.request(
                    "POST",
                    `/repositories/${workspace}/${slug}/pullrequests/${id}/comments`,
                    { content: { raw: comment } }
                );
            }
        },

        async addPullRequestComment(repo: RepoId, id: PullRequestId, body: string) {
            const { workspace, slug } = splitRepoId(repo);
            const c = await client.request<BitbucketCommentJson>(
                "POST",
                `/repositories/${workspace}/${slug}/pullrequests/${id}/comments`,
                { content: { raw: body } }
            );
            return toComment(c);
        },

        async mergePullRequest(
            repo: RepoId,
            id: PullRequestId,
            strategy?: "mergeCommit" | "squash" | "fastForward"
        ): Promise<GitMutationResult> {
            const { workspace, slug } = splitRepoId(repo);
            try {
                const pr = await client.request<BitbucketPullRequestJson>(
                    "POST",
                    `/repositories/${workspace}/${slug}/pullrequests/${id}/merge`,
                    {
                        ...(strategy ? { merge_strategy: BB_MERGE_STRATEGY[strategy] } : {}),
                        // TAI's own branching model (brief §6): a branch is scoped to one
                        // work unit and never reused after its PR merges — nothing left to
                        // keep it around for. Always ask Bitbucket to clean it up on merge,
                        // matching the manual branch-deletion done by hand elsewhere in this
                        // project (TAI-38's own demo branches).
                        close_source_branch: true,
                    }
                );
                return { ok: true, pullRequest: toPullRequestRef(pr, repo) };
            } catch (err) {
                // A merge conflict / branch restriction / not-approved-yet gate is a
                // BitbucketRejection — brief §3.3's "unplanned checkpoint" shape, not a
                // connectivity fault. StorageConnectivityError (5xx, network) propagates
                // uncaught, per the interface's own contract (git/interface.ts).
                if (err instanceof BitbucketRejection) {
                    return { ok: false, reason: err.reason };
                }
                throw err;
            }
        },

        async getCommitStatuses(repo: RepoId, commit: CommitSha): Promise<readonly CommitStatus[]> {
            const { workspace, slug } = splitRepoId(repo);
            const statuses = await client.paginate<BitbucketCommitStatusJson>(
                `/repositories/${workspace}/${slug}/commit/${commit}/statuses`
            );
            return statuses.map(toCommitStatus);
        },
    };
}
