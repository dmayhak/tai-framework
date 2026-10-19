/**
 * TAI Framework — Git Host Plugin Interface (TAI-33 ADR, Confluence TA space, page 13926401)
 *
 * A sibling abstraction to the Storage Plugin (`storage/interface.ts`, brief §3.2), not a
 * third field bolted onto `StorageBackend`. Git hosting is an independent configuration
 * axis from Jira/Confluence (a team can mix Jira+Bitbucket, Jira+GitHub, filesystem+GitHub)
 * — the ADR's decision 1. It reuses the Storage Plugin's *pattern* (branded opaque IDs, an
 * open `kind` discriminator, the rejection-vs-connectivity split) without reusing its
 * interface, and reuses `HumanRef`/`Comment`/`StorageConnectivityError` directly from
 * `storage/interface.ts` rather than duplicating them (ADR decision 3).
 *
 * One `GitHost` interface, not split like `WorkTracker`/`DocStore` — repos, branches, PRs,
 * and commit statuses are one coherent domain on both Bitbucket and GitHub, with no internal
 * product seam the way Jira/Confluence has (ADR decision 2).
 *
 * Scoped to PR CRUD, approve/request-changes, merge, and commit status — exactly what the
 * checkpoint chain (brief §5.4, TAI-34 ADR) needs. Deliberately excluded for v1: webhooks,
 * branch restrictions, deployments, tags, repo admin/permissions — extend when a real need
 * appears, don't build ahead of it (ADR decision 2, mirroring brief §7's cache-eviction
 * stance).
 *
 * Verified live end-to-end (2026-07-15, TAI-38): this Bitbucket backend created, reviewed
 * (approved), and merged a real PR against `tai-framework` — this very commit — through
 * `createPullRequest`/`reviewPullRequest`/`getCommitStatuses`/`mergePullRequest`, satisfying
 * TAI-37's acceptance criteria.
 */

import type { HumanRef, Comment } from "../storage/interface.js";

// ---------- Branded IDs ----------

type Brand<T, B extends string> = T & { readonly __brand: B };

/**
 * Opaque, backend-scoped, like `HumanId` (`storage/interface.ts`). On the Bitbucket backend
 * this is `"<workspace>/<repo_slug>"`; a future GitHub backend would use `"<owner>/<repo>"`.
 * Callers must not parse it — construction/parsing is a backend-internal concern.
 */
export type RepoId = Brand<string, "RepoId">;
export type PullRequestId = Brand<string, "PullRequestId">;
export type CommitSha = Brand<string, "CommitSha">;

export const toRepoId = (s: string): RepoId => s as RepoId;
export const toPullRequestId = (s: string): PullRequestId => s as PullRequestId;
export const toCommitSha = (s: string): CommitSha => s as CommitSha;

// ---------- Core shapes ----------

export interface RepoRef {
    readonly id: RepoId;
    readonly name: string;
    readonly defaultBranch: string;
    readonly url: string;
}

/**
 * Bitbucket's own vocabulary (`OPEN`/`MERGED`/`DECLINED`, lowercased) — the concrete backend
 * this interface is scoped against (ADR context). A future GitHub backend maps its
 * open/closed+merged-flag shape onto this same three-state union; that mapping is backend
 *-internal, not this interface's concern.
 */
export type PullRequestState = "open" | "merged" | "declined";

/** Named so callers (`git-pr.ts`'s CLI arg parsing, TAI-87) can validate against it without
 *  duplicating the literal union `mergePullRequest` accepts inline below. */
export type MergeStrategy = "mergeCommit" | "squash" | "fastForward";

export interface PullRequestReviewer {
    readonly human: HumanRef;
    readonly status: "pending" | "approved" | "changesRequested";
}

export interface PullRequestRef {
    readonly id: PullRequestId;
    readonly repo: RepoId;
    readonly title: string;
    readonly description?: string;
    readonly state: PullRequestState;
    readonly sourceBranch: string;
    readonly destinationBranch: string;
    readonly author: HumanRef;
    /** What the CodeReview checkpoint (TAI-34 ADR) actually inspects — decision 3. */
    readonly reviewers: readonly PullRequestReviewer[];
    /** Head commit of the source branch — what `getCommitStatuses` gates the merge on. */
    readonly sourceCommit: CommitSha;
    readonly url: string;
    readonly createdAt: string;
    readonly updatedAt: string;
}

/** TAI-562: bounds `GitHost.listPullRequests` to what a caller's window needs. */
export interface ListPullRequestsOptions {
    /** ISO 8601 instant: only PRs updated at or after it are returned. */
    readonly updatedSince?: string;
}

/** TAI-585: what a merge must still find true when it happens. */
export interface MergeOptions {
    /**
     * The head commit the merge gate was checked against. A host that can refuses the merge when
     * the PR's head is no longer this commit, so a push in between cannot slip past the gate.
     * GitHub honours it; Bitbucket's merge call has no such guard and ignores it.
     */
    readonly expectedHead?: CommitSha;
}

export interface CreatePullRequestInput {
    readonly repo: RepoId;
    readonly title: string;
    readonly description?: string;
    readonly sourceBranch: string;
    /**
     * Per TAI-34 ADR §3: "destination = the repo's default branch" — the caller (the
     * Developer persona / whatever wires the checkpoint chain) resolves that via
     * `getRepository(repo).defaultBranch` first. Required here, not defaulted internally,
     * so a caller never accidentally opens a PR against the wrong branch by omission.
     */
    readonly destinationBranch: string;
    readonly reviewers?: readonly HumanRef[];
}

/**
 * TAI-207: what `GitHost.addInlineComment` needs to anchor a comment to one line of one
 * file in a PR's diff. `line` is the DESTINATION-side (new-file) line number only — the
 * common case for a review comment pointing at current code, and the only shape TAI-209's
 * `ReviewFinding` schema itself carries (a single `line`, no old/new distinction). Anchoring
 * to the source (old-file) side isn't exposed here; add it if a real caller ever needs it.
 */
export interface InlineCommentInput {
    readonly path: string;
    readonly line: number;
    readonly body: string;
}

/**
 * TAI-383: a PR comment as read back, for the "review ALL comments before merging, even an
 * approved PR" step (TAI-382). A general comment has no `inline`; an inline one carries the file
 * and the destination-side (new-file) line it was anchored to, mirroring `InlineCommentInput`.
 */
export interface PullRequestComment extends Comment {
    readonly inline?: { readonly path: string; readonly line?: number };
}

/**
 * TAI-462: one entry of a PR's history, as far as the merge gate needs it -- when the source
 * branch's head was a given commit, and who approved or requested changes when. What makes an
 * approval FRESH (cast on the PR's current head) can only be told from this, since a host
 * that does not reset approvals on a new commit (Bitbucket's free tier) still reports the
 * reviewer as approved.
 *
 * Only decisions that still stand are expected here: Bitbucket drops a withdrawn approval or
 * request-changes from its feed (checked live on dmayhak/tait PR 12, 2026-10-08).
 */
export type PullRequestActivity =
    | { readonly kind: "update"; readonly at: string; readonly sourceCommit: CommitSha }
    | { readonly kind: "approval"; readonly at: string; readonly human: HumanRef }
    | { readonly kind: "changesRequested"; readonly at: string; readonly human: HumanRef };

export type CommitStatusState = "successful" | "failed" | "inProgress" | "stopped";

export interface CommitStatus {
    readonly key: string;
    readonly name: string;
    readonly state: CommitStatusState;
    readonly url?: string;
}

export interface CreateCommitStatusInput {
    /** Stable per kind of check: a second post with the same key replaces the first. */
    readonly key: string;
    readonly name: string;
    readonly state: CommitStatusState;
    /** Where a reader goes for more; git hosts require one. */
    readonly url: string;
    readonly description?: string;
}

/**
 * Same rejection-vs-connectivity SHAPE as `storage/interface.ts`'s `MutationResult` (brief
 * §3.3 / TAI-33 ADR decision 3) — a git-host mutation gets an identical ok/reason rejection
 * contract (e.g. a merge blocked by a branch restriction), with a genuine connectivity fault
 * still thrown as `StorageConnectivityError`, never returned here.
 *
 * Deliberately NOT a literal reuse of `MutationResult` itself: that type's success branch is
 * hardcoded to `{ ok: true, issue: Issue }` (Jira-specific), which cannot hold a
 * `PullRequestRef` — TAI-33's ADR pseudocode wrote `Promise<MutationResult>` for
 * `mergePullRequest`, but that doesn't actually type-check as proposed. This mirrors the
 * same ok/reason pattern with a payload that fits what a PR merge actually returns.
 */
export type GitMutationResult =
    | { readonly ok: true; readonly pullRequest: PullRequestRef }
    | { readonly ok: false; readonly reason: string };

// ---------- GitHost ----------

export interface GitHost {
    /**
     * The authenticated identity behind the credentials this `GitHost` was constructed with
     * (TAI-213/214, found live 2026-08-26) — NOT the same thing as a synthetic `HumanRef`
     * built from a known email address. A PR's `reviewers`/participant entries (see
     * `PullRequestRef`) carry the git host's own real identity fields (Bitbucket:
     * `account_id`/`display_name`, no email at all), which a `{ id: email, displayName:
     * email }` construction can never match via `sameHuman` — that mismatch is exactly what
     * silently broke `ready.ts`'s `readyToReview` (every open PR looked undecided, even
     * ones the current human had already approved). Callers that need to compare "is this
     * me" against a PR's own reviewer data must resolve identity through here, not
     * synthesize it from configuration.
     */
    getCurrentUser(): Promise<HumanRef>;
    getRepository(id: RepoId): Promise<RepoRef | null>;
    /** TAI-162/TAI-163 ADR: enumerates every repo in a workspace (Bitbucket's
     *  `GET /2.0/repositories/{workspace}`) — what lets `/tai-ready` discover PRs across a
     *  whole workspace instead of relying solely on an explicit `RepoId` allowlist. */
    listRepositories(workspace: string): Promise<readonly RepoRef[]>;
    listBranches(repo: RepoId, limit?: number): Promise<readonly string[]>;

    createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef>;
    getPullRequest(repo: RepoId, id: PullRequestId): Promise<PullRequestRef | null>;
    /**
     * TAI-562: with `updatedSince` (an ISO 8601 instant), only PRs updated at or after it, read newest-updated first and
     * stopping as soon as the history is older than that, so the cost does not grow with the repo's age. Without it,
     * every PR in `state`, exactly as before.
     */
    listPullRequests(repo: RepoId, state?: PullRequestState, options?: ListPullRequestsOptions): Promise<readonly PullRequestRef[]>;

    reviewPullRequest(
        repo: RepoId,
        id: PullRequestId,
        decision: "approve" | "requestChanges",
        comment?: string
    ): Promise<void>;
    /**
     * Withdraws a previously-cast approval (TAI-217/219) — the mutation counterpart to
     * `reviewPullRequest(..., "approve")`. No equivalent for withdrawing a `requestChanges`
     * decision — Bitbucket's own approve/unapprove pair has no "un-request-changes" sibling,
     * and nothing in this flow needs one. NOT idempotent (verified live, 2026-08-26, contrary
     * to an earlier assumption here): calling this when the current human never approved in
     * the first place throws — Bitbucket returns 404 "You haven't approved this pull
     * request." (a `BitbucketRejection`), not a silent success. Left as a real error rather
     * than caught-and-swallowed here, matching this codebase's "fail loudly, report the
     * error, never guess or proceed anyway" discipline (`tai-pr`'s own SKILL.md).
     */
    unapprovePullRequest(repo: RepoId, id: PullRequestId): Promise<void>;
    addPullRequestComment(repo: RepoId, id: PullRequestId, body: string): Promise<Comment>;
    /**
     * TAI-207: posts a comment anchored to one line of one file in the PR's diff — the
     * per-finding counterpart to `addPullRequestComment`'s single general comment. Used by
     * `git-pr comment-findings` (`cli.ts`) for `critical`-severity findings (TAI-209 ADR
     * Decision §4), the rest still go through `addPullRequestComment`'s summary comment.
     * Same failure contract as `addPullRequestComment`: throws (a `BitbucketRejection` on a
     * real rejection — e.g. `line` isn't part of the diff — or a connectivity fault), no
     * ok/reason result type, since there's nothing structurally different about this
     * mutation that would need one.
     */
    addInlineComment(repo: RepoId, id: PullRequestId, input: InlineCommentInput): Promise<Comment>;
    mergePullRequest(repo: RepoId, id: PullRequestId, strategy?: MergeStrategy, options?: MergeOptions): Promise<GitMutationResult>;
    /**
     * TAI-383: every (non-deleted) comment on a PR, oldest first as the host returns them --
     * what `git-pr comments` shows so whoever merges reads ALL of them first, including a second
     * reviewer's. Read-only, so no persona gate (same as `getPullRequest`).
     */
    listPullRequestComments(repo: RepoId, id: PullRequestId): Promise<readonly PullRequestComment[]>;
    /**
     * TAI-462: the PR's updates, approvals and change requests, OLDEST first. Read-only, so no
     * persona gate. Entries of any other kind (comments, tasks) are left out.
     */
    listPullRequestActivity(repo: RepoId, id: PullRequestId): Promise<readonly PullRequestActivity[]>;

    /**
     * Reports status; it does not trigger a CI run — TAI-32 (this project's own Bitbucket Pipelines
     * work) found no reliable way to force one on a PR-only pipeline retroactively (ADR decision 2).
     */
    getCommitStatuses(repo: RepoId, commit: CommitSha): Promise<readonly CommitStatus[]>;

    /**
     * TAI-534: records a check result on a commit — what `git-pr check` posts after running the
     * project's check command locally. Posting the same `key` again for the commit replaces it.
     */
    createCommitStatus(repo: RepoId, commit: CommitSha, input: CreateCommitStatusInput): Promise<CommitStatus>;
}

export interface GitHostBackend {
    // Deliberately NOT a closed union — mirrors `StorageBackend.kind` (brief §3.2): a
    // third-party git host should be addable the same way a third-party Jira competitor is.
    readonly kind: string;
    readonly gitHost: GitHost;
}
