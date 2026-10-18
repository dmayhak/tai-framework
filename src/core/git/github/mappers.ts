/**
 * TAI Framework — GitHub REST JSON -> GitHost shape mappers (TAI-583 ADR)
 *
 * GitHub's own JSON objects, narrowed to the fields this backend reads, kept apart from
 * `git-host.ts` as `bitbucket/mappers.ts` is.
 */

import { toHumanId, type HumanRef, type Comment } from "../../storage/interface.js";
import {
    toRepoId,
    toPullRequestId,
    toCommitSha,
    type RepoId,
    type RepoRef,
    type PullRequestState,
    type PullRequestReviewer,
    type PullRequestRef,
    type PullRequestActivity,
    type PullRequestComment,
    type CommitStatus,
    type CommitStatusState,
} from "../interface.js";

// ---------- GitHub's raw JSON shapes (subset actually consumed) ----------

export interface GitHubUserJson {
    readonly login: string;
    readonly name?: string | null;
}

export interface GitHubRepositoryJson {
    readonly full_name: string; // "owner/repo"
    readonly name: string;
    readonly default_branch?: string;
    readonly html_url: string;
}

export interface GitHubPullRequestJson {
    readonly number: number;
    readonly title: string;
    readonly body?: string | null;
    readonly state: "open" | "closed";
    readonly merged_at?: string | null;
    readonly head: { readonly ref: string; readonly sha: string; readonly repo?: { readonly full_name: string } | null };
    readonly base: { readonly ref: string };
    readonly user: GitHubUserJson;
    readonly requested_reviewers?: readonly GitHubUserJson[];
    readonly created_at: string;
    readonly updated_at: string;
    readonly html_url: string;
}

export interface GitHubReviewJson {
    readonly id: number;
    readonly user: GitHubUserJson | null;
    readonly state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
    readonly body?: string | null;
    readonly commit_id?: string | null;
    readonly submitted_at?: string | null;
}

export interface GitHubIssueCommentJson {
    readonly id: number;
    readonly user: GitHubUserJson | null;
    readonly body?: string | null;
    readonly created_at: string;
    readonly updated_at: string;
}

export interface GitHubReviewCommentJson extends GitHubIssueCommentJson {
    readonly path: string;
    readonly line?: number | null;
}

/** One entry of a commit's combined status (`GET /commits/{ref}/status`): the latest per context. */
export interface GitHubStatusJson {
    readonly context: string;
    readonly state: "success" | "failure" | "error" | "pending";
    readonly description?: string | null;
    readonly target_url?: string | null;
}

export interface GitHubCheckRunJson {
    readonly name: string;
    readonly status: "queued" | "in_progress" | "completed" | "waiting" | "requested" | "pending";
    readonly conclusion?: string | null;
    readonly html_url?: string | null;
}

// ---------- Self-review (TAI-583 ADR decision 1) ----------

/** The first line of the COMMENT review a PR's author posts as a recorded self-review. */
export const SELF_REVIEW_MARKER = "Self-review: approved";
/** What an author's withdrawn self-review is edited to start with. */
export const SELF_REVIEW_WITHDRAWN = "Self-review: withdrawn";

/** A COMMENT review by the PR's own author whose first line is the self-review stamp. */
export function isSelfReview(review: GitHubReviewJson, author: GitHubUserJson): boolean {
    return (
        review.state === "COMMENTED" &&
        review.user?.login === author.login &&
        (review.body ?? "").split("\n", 1)[0]!.trim() === SELF_REVIEW_MARKER
    );
}

// ---------- Mappers ----------

const GHOST: GitHubUserJson = { login: "ghost" };

/** `id` is the login: stable, and what the PR Reviewers page names (TAI-583 ADR decision 3). */
export function toHumanRef(user: GitHubUserJson | null): HumanRef {
    const u = user ?? GHOST;
    return { id: toHumanId(u.login), displayName: u.name || u.login };
}

export function toRepoRef(repo: GitHubRepositoryJson): RepoRef {
    return {
        id: toRepoId(repo.full_name),
        name: repo.name,
        defaultBranch: repo.default_branch ?? "main",
        url: repo.html_url,
    };
}

export function toPullRequestState(pr: Pick<GitHubPullRequestJson, "state" | "merged_at">): PullRequestState {
    if (pr.state === "open") return "open";
    return pr.merged_at ? "merged" : "declined";
}

/**
 * The reviews that stand as decisions, oldest first: APPROVED and CHANGES_REQUESTED, plus the
 * author's stamped self-review when the project allows it. A dismissed review has state
 * DISMISSED and drops out; a plain COMMENT review is not a decision.
 */
export function standingDecisions(
    reviews: readonly GitHubReviewJson[],
    author: GitHubUserJson,
    allowSelfReview: boolean
): readonly { readonly review: GitHubReviewJson; readonly decision: "approved" | "changesRequested" }[] {
    const out: { review: GitHubReviewJson; decision: "approved" | "changesRequested" }[] = [];
    for (const review of reviews) {
        if (!review.user) continue;
        if (review.state === "APPROVED") out.push({ review, decision: "approved" });
        else if (review.state === "CHANGES_REQUESTED") out.push({ review, decision: "changesRequested" });
        else if (allowSelfReview && isSelfReview(review, author)) out.push({ review, decision: "approved" });
    }
    return out;
}

/**
 * The PR's reviewers: each human's latest standing decision, then every requested reviewer
 * who has none. `reviews` is null when they were not read (a closed PR in a list, see
 * `git-host.ts`), and then only the requested reviewers are known.
 */
export function toReviewers(
    pr: GitHubPullRequestJson,
    reviews: readonly GitHubReviewJson[] | null,
    allowSelfReview: boolean
): PullRequestReviewer[] {
    const latest = new Map<string, PullRequestReviewer>();
    for (const { review, decision } of standingDecisions(reviews ?? [], pr.user, allowSelfReview)) {
        latest.set(review.user!.login, { human: toHumanRef(review.user), status: decision });
    }
    const reviewers = [...latest.values()];
    for (const requested of pr.requested_reviewers ?? []) {
        if (!latest.has(requested.login)) reviewers.push({ human: toHumanRef(requested), status: "pending" });
    }
    return reviewers;
}

export function toPullRequestRef(
    pr: GitHubPullRequestJson,
    repo: RepoId,
    reviews: readonly GitHubReviewJson[] | null,
    allowSelfReview: boolean
): PullRequestRef {
    return {
        id: toPullRequestId(String(pr.number)),
        repo,
        title: pr.title,
        ...(pr.body ? { description: pr.body } : {}),
        state: toPullRequestState(pr),
        sourceBranch: pr.head.ref,
        destinationBranch: pr.base.ref,
        author: toHumanRef(pr.user),
        reviewers: toReviewers(pr, reviews, allowSelfReview),
        sourceCommit: toCommitSha(pr.head.sha),
        url: pr.html_url,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
    };
}

/**
 * The merge gate's history, built from the reviews (TAI-583 ADR): every GitHub review names the
 * commit it was cast on, so each decision is preceded by an `update` entry for that commit.
 * The gate then reads which head each decision was made on exactly as it does on Bitbucket.
 */
export function toPullRequestActivity(
    reviews: readonly GitHubReviewJson[],
    author: GitHubUserJson,
    allowSelfReview: boolean
): PullRequestActivity[] {
    const out: PullRequestActivity[] = [];
    for (const { review, decision } of standingDecisions(reviews, author, allowSelfReview)) {
        const at = review.submitted_at ?? "";
        if (review.commit_id) out.push({ kind: "update", at, sourceCommit: toCommitSha(review.commit_id) });
        out.push({ kind: decision === "approved" ? "approval" : "changesRequested", at, human: toHumanRef(review.user) });
    }
    return out;
}

const STATUS_STATE: Record<GitHubStatusJson["state"], CommitStatusState> = {
    success: "successful",
    failure: "failed",
    error: "failed",
    pending: "inProgress",
};

/** Our state as GitHub's status API spells it; GitHub has no "stopped", so it is an error. */
export function toGitHubStatusState(state: CommitStatusState): GitHubStatusJson["state"] {
    if (state === "successful") return "success";
    if (state === "failed") return "failure";
    if (state === "inProgress") return "pending";
    return "error";
}

export function toCommitStatus(status: GitHubStatusJson): CommitStatus {
    return {
        key: status.context,
        name: status.description || status.context,
        state: STATUS_STATE[status.state],
        ...(status.target_url ? { url: status.target_url } : {}),
    };
}

/** A check run (how GitHub Actions reports) as a commit status (TAI-583 ADR). */
export function checkRunToCommitStatus(run: GitHubCheckRunJson): CommitStatus {
    let state: CommitStatusState;
    if (run.status !== "completed") state = "inProgress";
    else if (run.conclusion === "success" || run.conclusion === "neutral" || run.conclusion === "skipped") state = "successful";
    else if (run.conclusion === "cancelled") state = "stopped";
    else state = "failed";
    return { key: run.name, name: run.name, state, ...(run.html_url ? { url: run.html_url } : {}) };
}

export function toComment(c: GitHubIssueCommentJson): Comment {
    return {
        id: String(c.id),
        author: toHumanRef(c.user),
        body: c.body ?? "",
        createdAt: c.created_at,
        updatedAt: c.updated_at,
    };
}

export function reviewCommentToPullRequestComment(c: GitHubReviewCommentJson): PullRequestComment {
    return { ...toComment(c), inline: { path: c.path, ...(typeof c.line === "number" ? { line: c.line } : {}) } };
}

/** A review's own body, as a general comment; null when it has none. */
export function reviewToPullRequestComment(r: GitHubReviewJson): PullRequestComment | null {
    if (!r.body || !r.submitted_at) return null;
    return { id: `review-${r.id}`, author: toHumanRef(r.user), body: r.body, createdAt: r.submitted_at, updatedAt: r.submitted_at };
}
