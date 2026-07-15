/**
 * TAI Framework — Bitbucket Cloud API JSON -> GitHost shape mappers
 *
 * Bitbucket's own JSON objects, narrowed to only the fields this backend actually reads.
 * Kept separate from `git-host.ts` so the REST-shape/domain-shape boundary is one file,
 * mirroring `storage/jira/mappers.ts`'s split.
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
    type CommitStatus,
    type CommitStatusState,
} from "../interface.js";

// ---------- Bitbucket's raw JSON shapes (subset actually consumed) ----------

export interface BitbucketUserJson {
    readonly account_id?: string;
    readonly uuid?: string;
    readonly display_name?: string;
    readonly nickname?: string;
}

export interface BitbucketRepositoryJson {
    readonly full_name: string; // "workspace/repo_slug"
    readonly name: string;
    readonly mainbranch?: { readonly name: string };
    readonly links: { readonly html: { readonly href: string } };
}

export interface BitbucketParticipantJson {
    readonly user: BitbucketUserJson;
    readonly role: "REVIEWER" | "PARTICIPANT";
    readonly state: "approved" | "changes_requested" | null;
}

export interface BitbucketPullRequestJson {
    readonly id: number;
    readonly title: string;
    readonly description?: string;
    readonly state: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";
    readonly source: { readonly branch: { readonly name: string }; readonly commit: { readonly hash: string } };
    readonly destination: { readonly branch: { readonly name: string } };
    readonly author: BitbucketUserJson;
    readonly participants: readonly BitbucketParticipantJson[];
    readonly created_on: string;
    readonly updated_on: string;
    readonly links: { readonly html: { readonly href: string } };
}

export interface BitbucketCommitStatusJson {
    readonly key: string;
    readonly name: string;
    readonly state: "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "STOPPED";
    readonly url?: string;
}

export interface BitbucketCommentJson {
    readonly id: number;
    readonly content: { readonly raw: string };
    readonly user: BitbucketUserJson;
    readonly created_on: string;
    readonly updated_on: string;
}

// ---------- Mappers ----------

/**
 * Bitbucket user objects don't carry email (privacy) — `HumanRef.email` is optional, so it's
 * simply omitted, same as the Jira backend's `HumanRef` for a bare `accountId` lookup.
 * `account_id` is the stable opaque id; `uuid` is a fallback for the rare shape that omits
 * it (observed on some system/service-account actors).
 */
export function toHumanRef(user: BitbucketUserJson): HumanRef {
    const id = user.account_id ?? user.uuid ?? "unknown";
    return {
        id: toHumanId(id),
        displayName: user.display_name ?? user.nickname ?? id,
    };
}

export function toRepoRef(repo: BitbucketRepositoryJson): RepoRef {
    return {
        id: toRepoId(repo.full_name),
        name: repo.name,
        defaultBranch: repo.mainbranch?.name ?? "master",
        url: repo.links.html.href,
    };
}

const PR_STATE: Record<BitbucketPullRequestJson["state"], PullRequestState> = {
    OPEN: "open",
    MERGED: "merged",
    DECLINED: "declined",
    // SUPERSEDED has no separate slot in TAI's 3-state PullRequestState (interface.ts) —
    // it behaves like a closed/non-actionable PR for TAI's purposes, same bucket as DECLINED.
    SUPERSEDED: "declined",
};

function toReviewerStatus(state: BitbucketParticipantJson["state"]): PullRequestReviewer["status"] {
    if (state === "approved") return "approved";
    if (state === "changes_requested") return "changesRequested";
    return "pending";
}

export function toPullRequestRef(pr: BitbucketPullRequestJson, repo: RepoId): PullRequestRef {
    return {
        id: toPullRequestId(String(pr.id)),
        repo,
        title: pr.title,
        ...(pr.description !== undefined ? { description: pr.description } : {}),
        state: PR_STATE[pr.state],
        sourceBranch: pr.source.branch.name,
        destinationBranch: pr.destination.branch.name,
        author: toHumanRef(pr.author),
        // REGRESSION this fixes (found live, TAI-38's own end-to-end demo, 2026-07-15):
        // filtering strictly to role === "REVIEWER" silently dropped a real approval. A
        // human who approves a PR they were never formally requested to review lands in
        // `participants` with role PARTICIPANT, not REVIEWER — Bitbucket only assigns the
        // REVIEWER role to people added as reviewers at PR-creation time. TAI-34's
        // checkpoint cares whether SOMEONE actually reviewed, not just whether a formally
        // requested reviewer did — so this includes every REVIEWER-role participant
        // (requested, whether or not they've acted yet) plus any PARTICIPANT who has
        // actually left a decision (state is non-null). A PARTICIPANT with no decision
        // (state null — e.g. the author, a watcher) is correctly excluded either way.
        reviewers: pr.participants
            .filter((p) => p.role === "REVIEWER" || p.state !== null)
            .map((p) => ({ human: toHumanRef(p.user), status: toReviewerStatus(p.state) })),
        sourceCommit: toCommitSha(pr.source.commit.hash),
        url: pr.links.html.href,
        createdAt: pr.created_on,
        updatedAt: pr.updated_on,
    };
}

const COMMIT_STATUS_STATE: Record<BitbucketCommitStatusJson["state"], CommitStatusState> = {
    SUCCESSFUL: "successful",
    FAILED: "failed",
    INPROGRESS: "inProgress",
    STOPPED: "stopped",
};

export function toCommitStatus(status: BitbucketCommitStatusJson): CommitStatus {
    return {
        key: status.key,
        name: status.name,
        state: COMMIT_STATUS_STATE[status.state],
        ...(status.url !== undefined ? { url: status.url } : {}),
    };
}

export function toComment(c: BitbucketCommentJson): Comment {
    return {
        id: String(c.id),
        author: toHumanRef(c.user),
        body: c.content.raw,
        createdAt: c.created_on,
        updatedAt: c.updated_on,
    };
}
