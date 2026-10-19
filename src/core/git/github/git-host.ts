/**
 * TAI Framework — GitHub `GitHost` implementation (TAI-583 ADR, Confluence page 58753025)
 *
 * The second `GitHost` backend, next to `bitbucket/git-host.ts`. Each method's mapping onto
 * GitHub's REST API is recorded in the ADR; the comments here only add what the code alone
 * does not show.
 */

import type { HumanRef } from "../../storage/interface.js";
import type {
    GitHost,
    RepoId,
    RepoRef,
    PullRequestId,
    PullRequestState,
    ListPullRequestsOptions,
    PullRequestRef,
    PullRequestActivity,
    PullRequestComment,
    CreatePullRequestInput,
    CommitSha,
    CommitStatus,
    GitMutationResult,
    InlineCommentInput,
    CreateCommitStatusInput,
    MergeStrategy,
    MergeOptions,
} from "../interface.js";
import { RestClient, GitHubRejection } from "./rest-client.js";
import { StorageConnectivityError } from "../../storage/interface.js";
import {
    SELF_REVIEW_MARKER,
    SELF_REVIEW_WITHDRAWN,
    isSelfReview,
    toHumanRef,
    toRepoRef,
    toPullRequestRef,
    toPullRequestActivity,
    toCommitStatus,
    checkRunToCommitStatus,
    toGitHubStatusState,
    toComment,
    reviewCommentToPullRequestComment,
    reviewToPullRequestComment,
    type GitHubUserJson,
    type GitHubRepositoryJson,
    type GitHubPullRequestJson,
    type GitHubReviewJson,
    type GitHubIssueCommentJson,
    type GitHubReviewCommentJson,
    type GitHubStatusJson,
    type GitHubCheckRunJson,
} from "./mappers.js";

export interface GitHubGitHostOptions {
    /**
     * `TAI_PR_SELF_REVIEW` (TAI-583 ADR decision 1): the PR's author may record a self-review,
     * which counts as one approval. Off by default.
     */
    readonly allowSelfReview?: boolean;
}

/** `RepoId` on this backend is `"owner/repo"`, GitHub's own `full_name`. */
function splitRepoId(repo: RepoId): { owner: string; name: string } {
    const [owner, name] = (repo as string).split("/");
    if (!owner || !name) {
        throw new Error(`Malformed RepoId "${repo}" for the GitHub backend — expected "owner/repo"`);
    }
    return { owner, name };
}

/** Repository names are case-insensitive on GitHub, and a `RepoId` is often hand-typed (PR 215 review). */
function sameRepo(fullName: string | undefined, repo: RepoId): boolean {
    return fullName !== undefined && fullName.toLowerCase() === (repo as string).toLowerCase();
}

const GH_MERGE_METHOD: Record<MergeStrategy, string> = {
    mergeCommit: "merge",
    squash: "squash",
    // GitHub has no true fast-forward; a rebase merge gives the same linear history with new commit ids.
    fastForward: "rebase",
};

/** The body GitHub requires on a change request when the reviewer gave none. */
const DEFAULT_CHANGES_BODY = "Changes requested.";

export function createGitHubGitHost(client: RestClient, options: GitHubGitHostOptions = {}): GitHost {
    const allowSelfReview = options.allowSelfReview === true;
    let me: GitHubUserJson | undefined;

    async function currentUser(): Promise<GitHubUserJson> {
        me ??= await client.request<GitHubUserJson>("GET", "/user");
        return me;
    }

    const base = (repo: RepoId): string => {
        const { owner, name } = splitRepoId(repo);
        return `/repos/${owner}/${name}`;
    };

    async function rawPullRequest(repo: RepoId, id: PullRequestId): Promise<GitHubPullRequestJson | null> {
        return client.getOrNull<GitHubPullRequestJson>(`${base(repo)}/pulls/${id}`);
    }

    async function requirePullRequest(repo: RepoId, id: PullRequestId): Promise<GitHubPullRequestJson> {
        const pr = await rawPullRequest(repo, id);
        if (!pr) throw new GitHubRejection(`Pull request ${id} not found in ${repo}`, 404);
        return pr;
    }

    async function reviews(repo: RepoId, id: PullRequestId | number): Promise<GitHubReviewJson[]> {
        return client.paginate<GitHubReviewJson>(`${base(repo)}/pulls/${id}/reviews`);
    }

    return {
        async getCurrentUser(): Promise<HumanRef> {
            return toHumanRef(await currentUser());
        },

        async getRepository(id: RepoId): Promise<RepoRef | null> {
            const repo = await client.getOrNull<GitHubRepositoryJson>(base(id));
            return repo ? toRepoRef(repo) : null;
        },

        // `TAI_GIT_WORKSPACE` names the owner: an organization, or a user. A user's own private
        // repositories are only listed through `/user/repos`, so that is used for the token's owner.
        async listRepositories(owner: string): Promise<readonly RepoRef[]> {
            try {
                return (await client.paginate<GitHubRepositoryJson>(`/orgs/${owner}/repos`)).map(toRepoRef);
            } catch (err) {
                if (!(err instanceof GitHubRejection) || err.status !== 404) throw err;
            }
            const self = await currentUser();
            const path = self.login.toLowerCase() === owner.toLowerCase() ? "/user/repos?affiliation=owner" : `/users/${owner}/repos`;
            return (await client.paginate<GitHubRepositoryJson>(path)).map(toRepoRef);
        },

        async listBranches(repo: RepoId, limit?: number): Promise<readonly string[]> {
            const branches = await client.paginate<{ name: string }>(`${base(repo)}/branches`, limit !== undefined ? { limit } : {});
            return branches.map((b) => b.name);
        },

        // GitHub's create call takes no reviewers: they are requested with a second call. A failed
        // request leaves the PR created, as a failed reviewer lookup does on Bitbucket.
        async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
            let pr = await client.request<GitHubPullRequestJson>("POST", `${base(input.repo)}/pulls`, {
                title: input.title,
                head: input.sourceBranch,
                base: input.destinationBranch,
                ...(input.description !== undefined ? { body: input.description } : {}),
            });
            // Logins are case-insensitive and the PR Reviewers page is hand-typed; requesting the author
            // makes GitHub refuse the whole request (PR 215 review).
            const logins = (input.reviewers ?? []).map((h) => h.id as string).filter((l) => l.toLowerCase() !== pr.user.login.toLowerCase());
            if (logins.length > 0) {
                try {
                    pr = await client.request<GitHubPullRequestJson>("POST", `${base(input.repo)}/pulls/${pr.number}/requested_reviewers`, {
                        reviewers: logins,
                    });
                } catch (err) {
                    // The PR exists either way; a reviewer not requested shows in the PR's reviewers, and
                    // `git-pr create` names who is missing (PR 215 review: a rate limit lands here too).
                    if (!(err instanceof GitHubRejection) && !(err instanceof StorageConnectivityError)) throw err;
                }
            }
            return toPullRequestRef(pr, input.repo, [], allowSelfReview);
        },

        async getPullRequest(repo: RepoId, id: PullRequestId): Promise<PullRequestRef | null> {
            const pr = await rawPullRequest(repo, id);
            return pr ? toPullRequestRef(pr, repo, await reviews(repo, id), allowSelfReview) : null;
        },

        // Reviews are read for open PRs only: a closed PR's reviewers are only its requested ones.
        // Nothing reads decisions on a closed PR, and reading them would cost one call per PR in a
        // repository's whole history.
        async listPullRequests(repo: RepoId, state?: PullRequestState, options?: ListPullRequestsOptions): Promise<readonly PullRequestRef[]> {
            const params = new URLSearchParams({ state: state === undefined ? "all" : state === "open" ? "open" : "closed" });
            const since = options?.updatedSince ? new Date(options.updatedSince).getTime() : null;
            if (since !== null) {
                params.set("sort", "updated");
                params.set("direction", "desc");
            }
            const isOlder = (pr: GitHubPullRequestJson): boolean => since !== null && new Date(pr.updated_at).getTime() < since;
            const raw = await client.paginate<GitHubPullRequestJson>(
                `${base(repo)}/pulls?${params}`,
                since !== null ? { stopAfterPage: (page) => page.some(isOlder) } : {}
            );
            const wanted = raw.filter((pr) => !isOlder(pr) && (state === undefined || state === "open" || (state === "merged") === Boolean(pr.merged_at)));
            return Promise.all(
                wanted.map(async (pr) => toPullRequestRef(pr, repo, pr.state === "open" ? await reviews(repo, pr.number) : null, allowSelfReview))
            );
        },

        // GitHub refuses an approval or a change request from the PR's author. With
        // `allowSelfReview`, the author's approval is recorded as a stamped COMMENT review instead.
        async reviewPullRequest(repo: RepoId, id: PullRequestId, decision: "approve" | "requestChanges", comment?: string): Promise<void> {
            const pr = await requirePullRequest(repo, id);
            const self = await currentUser();
            if (pr.user.login === self.login) {
                if (decision === "requestChanges") {
                    throw new GitHubRejection("GitHub does not allow a pull request's author to request changes on it. Post a comment instead.", 422);
                }
                if (!allowSelfReview) {
                    throw new GitHubRejection(
                        "GitHub does not allow a pull request's author to approve it. Have another reviewer approve it, or set TAI_PR_SELF_REVIEW=true for a solo project to record a self-review.",
                        422
                    );
                }
                await client.request("POST", `${base(repo)}/pulls/${id}/reviews`, {
                    event: "COMMENT",
                    commit_id: pr.head.sha,
                    body: comment ? `${SELF_REVIEW_MARKER}\n\n${comment}` : SELF_REVIEW_MARKER,
                });
                return;
            }
            await client.request("POST", `${base(repo)}/pulls/${id}/reviews`, {
                event: decision === "approve" ? "APPROVE" : "REQUEST_CHANGES",
                ...(comment ? { body: comment } : decision === "requestChanges" ? { body: DEFAULT_CHANGES_BODY } : {}),
            });
        },

        // Dismisses the current human's latest approval; a self-review is edited to say it was
        // withdrawn, since a COMMENT review cannot be dismissed. Throws with nothing to withdraw,
        // as Bitbucket does.
        async unapprovePullRequest(repo: RepoId, id: PullRequestId): Promise<void> {
            const pr = await requirePullRequest(repo, id);
            const self = await currentUser();
            const mine = (await reviews(repo, id)).filter(
                (r) => r.user?.login === self.login && (r.state === "APPROVED" || isSelfReview(r, pr.user))
            );
            const last = mine.at(-1);
            if (!last) throw new GitHubRejection("You haven't approved this pull request.", 404);
            if (last.state === "APPROVED") {
                await client.request("PUT", `${base(repo)}/pulls/${id}/reviews/${last.id}/dismissals`, {
                    message: "Approval withdrawn.",
                    event: "DISMISS",
                });
            } else {
                await client.request("PUT", `${base(repo)}/pulls/${id}/reviews/${last.id}`, { body: SELF_REVIEW_WITHDRAWN });
            }
        },

        async addPullRequestComment(repo: RepoId, id: PullRequestId, body: string) {
            const c = await client.request<GitHubIssueCommentJson>("POST", `${base(repo)}/issues/${id}/comments`, { body });
            return toComment(c);
        },

        async addInlineComment(repo: RepoId, id: PullRequestId, input: InlineCommentInput) {
            const pr = await requirePullRequest(repo, id);
            const c = await client.request<GitHubReviewCommentJson>("POST", `${base(repo)}/pulls/${id}/comments`, {
                body: input.body,
                commit_id: pr.head.sha,
                path: input.path,
                line: input.line,
                side: "RIGHT",
            });
            return toComment(c);
        },

        // Issue comments, inline review comments and review bodies, oldest first.
        async listPullRequestComments(repo: RepoId, id: PullRequestId): Promise<readonly PullRequestComment[]> {
            const [issueComments, reviewComments, reviewList] = await Promise.all([
                client.paginate<GitHubIssueCommentJson>(`${base(repo)}/issues/${id}/comments`),
                client.paginate<GitHubReviewCommentJson>(`${base(repo)}/pulls/${id}/comments`),
                reviews(repo, id),
            ]);
            const all: PullRequestComment[] = [
                ...issueComments.map(toComment),
                ...reviewComments.map(reviewCommentToPullRequestComment),
                ...reviewList.map(reviewToPullRequestComment).filter((c): c is PullRequestComment => c !== null),
            ];
            return all.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        },

        async listPullRequestActivity(repo: RepoId, id: PullRequestId): Promise<readonly PullRequestActivity[]> {
            const pr = await requirePullRequest(repo, id);
            return toPullRequestActivity(await reviews(repo, id), pr.user, allowSelfReview);
        },

        async mergePullRequest(repo: RepoId, id: PullRequestId, strategy?: MergeStrategy, options?: MergeOptions): Promise<GitMutationResult> {
            const expected = options?.expectedHead;
            const before = await requirePullRequest(repo, id);
            if (expected) {
                // Found live (TAI-585): GitHub reports a PR's new head a few seconds after a push, so the
                // PR read the gate was checked on can be behind the branch. The branch itself is current.
                const pr = before;
                if (sameRepo(pr.head.repo?.full_name, repo)) {
                    const ref = await client.getOrNull<{ object: { sha: string } }>(`${base(repo)}/git/ref/heads/${encodeURIComponent(pr.head.ref).replace(/%2F/g, "/")}`);
                    if (ref && !ref.object.sha.startsWith(expected as string) && !(expected as string).startsWith(ref.object.sha)) {
                        return { ok: false, reason: `The branch has moved to ${ref.object.sha.slice(0, 12)} since ${(expected as string).slice(0, 12)} was checked. Check the PR again before merging.` };
                    }
                }
            }
            try {
                // `sha`: GitHub itself refuses the merge when the head is no longer the commit that was checked.
                await client.request("PUT", `${base(repo)}/pulls/${id}/merge`, {
                    merge_method: GH_MERGE_METHOD[strategy ?? "mergeCommit"],
                    ...(expected ? { sha: expected } : {}),
                });
            } catch (err) {
                // Not mergeable, a conflict, the head moved, branch protection: a rejection with
                // GitHub's reason. A connectivity fault propagates, per the interface's contract.
                if (err instanceof GitHubRejection) return { ok: false, reason: err.reason };
                throw err;
            }
            // The merge went through: nothing after it may report a failure (PR 215 review). A re-read that
            // fails falls back to the PR as read before, marked merged.
            let pr: GitHubPullRequestJson;
            try {
                pr = await requirePullRequest(repo, id);
            } catch (err) {
                if (!(err instanceof GitHubRejection) && !(err instanceof StorageConnectivityError)) throw err;
                pr = { ...before, state: "closed", merged_at: before.merged_at ?? new Date().toISOString() };
            }
            // Matches Bitbucket's close_source_branch: a branch is used for one unit of work (brief §6).
            // Only a branch in this same repository, and a failure to delete it does not undo the merge.
            let note: string | undefined;
            if (sameRepo(pr.head.repo?.full_name, repo)) {
                try {
                    await client.request("DELETE", `${base(repo)}/git/refs/heads/${encodeURIComponent(pr.head.ref).replace(/%2F/g, "/")}`);
                } catch (err) {
                    if (!(err instanceof GitHubRejection) && !(err instanceof StorageConnectivityError)) throw err;
                    note = `The branch ${pr.head.ref} was not deleted (${(err as Error).message}); delete it by hand.`;
                }
            }
            return { ok: true, pullRequest: toPullRequestRef(pr, repo, null, allowSelfReview), ...(note ? { note } : {}) };
        },

        // Commit statuses (what `git-pr check` posts) and check runs (what GitHub Actions reports). A
        // fine-grained token cannot read check runs at all (found live, TAI-585), so then the commit's
        // GitHub Actions workflow runs are read instead (human decision, 2026-10-19). Never skipped:
        // unread CI results could hide a failure from the merge gate.
        async getCommitStatuses(repo: RepoId, commit: CommitSha): Promise<readonly CommitStatus[]> {
            const [combined, runs] = await Promise.all([
                // The combined status is paged too (PR 215 review): a failing context on a later page must still count.
                client.paginate<GitHubStatusJson>(`${base(repo)}/commits/${commit}/status`, { itemsKey: "statuses" }),
                client.paginate<GitHubCheckRunJson>(`${base(repo)}/commits/${commit}/check-runs`, { itemsKey: "check_runs" }).catch(async (err: unknown) => {
                    if (!(err instanceof GitHubRejection) || err.status !== 403) throw err;
                    try {
                        return await client.paginate<GitHubCheckRunJson>(`${base(repo)}/actions/runs?head_sha=${commit}`, { itemsKey: "workflow_runs" });
                    } catch (fallback) {
                        if (fallback instanceof GitHubRejection && fallback.status === 403) {
                            throw new GitHubRejection(
                                `${fallback.reason}. The GitHub token cannot read CI results: a fine-grained token needs the Actions: read permission.`,
                                403
                            );
                        }
                        throw fallback;
                    }
                }),
            ]);
            return [...combined.map(toCommitStatus), ...runs.map(checkRunToCommitStatus)];
        },

        async createCommitStatus(repo: RepoId, commit: CommitSha, input: CreateCommitStatusInput): Promise<CommitStatus> {
            const created = await client.request<GitHubStatusJson>("POST", `${base(repo)}/statuses/${commit}`, {
                state: toGitHubStatusState(input.state),
                context: input.key,
                target_url: input.url,
                description: input.description ?? input.name,
            });
            return { ...toCommitStatus(created), name: input.name };
        },
    };
}
