import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toRepoId } from "../interface.js";
import { evaluateMergeGate } from "../merge-gate.js";
import {
    SELF_REVIEW_MARKER,
    checkRunToCommitStatus,
    isSelfReview,
    toCommitStatus,
    toGitHubStatusState,
    toPullRequestActivity,
    toPullRequestRef,
    toPullRequestState,
    toReviewers,
    type GitHubPullRequestJson,
    type GitHubReviewJson,
} from "./mappers.js";

const REPO = toRepoId("octo/widgets");
const AUTHOR = { login: "author" };

const PR: GitHubPullRequestJson = {
    number: 5,
    title: "TAI-1 - TAI-2 - thing",
    body: null,
    state: "open",
    merged_at: null,
    head: { ref: "TAI-1-thing", sha: "c2", repo: { full_name: "octo/widgets" } },
    base: { ref: "main" },
    user: AUTHOR,
    requested_reviewers: [{ login: "carol" }],
    created_at: "2026-10-17T10:00:00Z",
    updated_at: "2026-10-17T11:00:00Z",
    html_url: "https://github.com/octo/widgets/pull/5",
};

function review(id: number, login: string, state: GitHubReviewJson["state"], commit: string, at: string, body = ""): GitHubReviewJson {
    return { id, user: { login }, state, commit_id: commit, submitted_at: at, body };
}

describe("toPullRequestState", () => {
    it("maps open, merged (closed with merged_at) and declined (closed without)", () => {
        assert.equal(toPullRequestState({ state: "open", merged_at: null }), "open");
        assert.equal(toPullRequestState({ state: "closed", merged_at: "2026-10-17T00:00:00Z" }), "merged");
        assert.equal(toPullRequestState({ state: "closed", merged_at: null }), "declined");
    });
});

describe("toReviewers", () => {
    it("keeps each human's latest standing decision and lists undecided requested reviewers as pending", () => {
        const reviews = [
            review(1, "bob", "CHANGES_REQUESTED", "c1", "2026-10-17T10:10:00Z"),
            review(2, "bob", "COMMENTED", "c1", "2026-10-17T10:11:00Z"),
            review(3, "bob", "APPROVED", "c2", "2026-10-17T10:20:00Z"),
            review(4, "dave", "DISMISSED", "c1", "2026-10-17T10:05:00Z"),
        ];
        const reviewers = toReviewers(PR, reviews, false);
        assert.deepEqual(
            reviewers.map((r) => [r.human.id, r.status]),
            [
                ["bob", "approved"],
                ["carol", "pending"],
            ]
        );
    });

    it("a COMMENT review does not undo an approval", () => {
        const reviews = [review(1, "bob", "APPROVED", "c2", "2026-10-17T10:20:00Z"), review(2, "bob", "COMMENTED", "c2", "2026-10-17T10:30:00Z")];
        assert.equal(toReviewers(PR, reviews, false)[0]?.status, "approved");
    });

    it("with no reviews read (a closed PR in a list), only the requested reviewers", () => {
        assert.deepEqual(
            toReviewers(PR, null, false).map((r) => r.human.id),
            ["carol"]
        );
    });
});

describe("self-review (TAI-583 ADR decision 1)", () => {
    const stamped = review(9, "author", "COMMENTED", "c2", "2026-10-17T10:40:00Z", `${SELF_REVIEW_MARKER}\n\nLooks right.`);

    it("recognises only the author's stamped COMMENT review", () => {
        assert.equal(isSelfReview(stamped, AUTHOR), true);
        assert.equal(isSelfReview({ ...stamped, user: { login: "mallory" } }, AUTHOR), false);
        assert.equal(isSelfReview({ ...stamped, body: "Self-review: withdrawn" }, AUTHOR), false);
        assert.equal(isSelfReview({ ...stamped, state: "APPROVED" }, AUTHOR), false);
    });

    it("counts as the author's approval only when allowed", () => {
        assert.equal(toReviewers(PR, [stamped], true).find((r) => r.human.id === "author")?.status, "approved");
        assert.equal(
            toReviewers(PR, [stamped], false).some((r) => r.human.id === "author"),
            false
        );
    });

    it("someone else's text with the stamp is not counted", () => {
        const forged = { ...stamped, user: { login: "mallory" } };
        assert.equal(
            toReviewers(PR, [forged], true).some((r) => r.human.id === "mallory"),
            false
        );
    });
});

describe("toPullRequestActivity", () => {
    it("puts the commit each decision was cast on just before it, oldest first", () => {
        const activity = toPullRequestActivity(
            [review(1, "bob", "APPROVED", "c1", "2026-10-17T10:00:00Z"), review(2, "carol", "CHANGES_REQUESTED", "c2", "2026-10-17T11:00:00Z")],
            AUTHOR,
            false
        );
        assert.deepEqual(
            activity.map((a) => (a.kind === "update" ? `update:${a.sourceCommit}` : `${a.kind}:${a.human.id}`)),
            ["update:c1", "approval:bob", "update:c2", "changesRequested:carol"]
        );
    });

    it("lets the merge gate tell a fresh approval from a stale one, unchanged", () => {
        const reviews = [review(1, "bob", "APPROVED", "c1", "2026-10-17T10:00:00Z"), review(2, "carol", "APPROVED", "c2", "2026-10-17T11:00:00Z")];
        const pr = toPullRequestRef(PR, REPO, reviews, false);
        const verdict = evaluateMergeGate({
            pullRequest: pr,
            activity: toPullRequestActivity(reviews, AUTHOR, false),
            requiredApprovals: 2,
            testTiers: [],
            uat: [],
        });
        assert.deepEqual(
            verdict.freshApprovals.map((h) => h.id),
            ["carol"]
        );
        assert.deepEqual(
            verdict.staleApprovals.map((h) => h.id),
            ["bob"]
        );
        assert.equal(verdict.ok, false);
    });

    it("a recorded self-review on the current commit meets a one-approval gate when allowed", () => {
        const reviews = [review(1, "author", "COMMENTED", "c2", "2026-10-17T10:00:00Z", SELF_REVIEW_MARKER)];
        const verdict = evaluateMergeGate({
            pullRequest: toPullRequestRef(PR, REPO, reviews, true),
            activity: toPullRequestActivity(reviews, AUTHOR, true),
            requiredApprovals: 1,
            testTiers: [],
            uat: [],
        });
        assert.equal(verdict.ok, true);
    });
});

describe("toPullRequestRef", () => {
    it("maps the PR's fields", () => {
        const pr = toPullRequestRef(PR, REPO, [], false);
        assert.equal(pr.id, "5");
        assert.equal(pr.sourceBranch, "TAI-1-thing");
        assert.equal(pr.destinationBranch, "main");
        assert.equal(pr.sourceCommit, "c2");
        assert.equal(pr.author.id, "author");
        assert.equal(pr.description, undefined);
        assert.equal(pr.url, "https://github.com/octo/widgets/pull/5");
    });
});

describe("commit statuses and check runs", () => {
    it("maps a status's context to its key and its state", () => {
        assert.deepEqual(toCommitStatus({ context: "tai/check", state: "failure", description: "TAI check", target_url: "https://x" }), {
            key: "tai/check",
            name: "TAI check",
            state: "failed",
            url: "https://x",
        });
        assert.equal(toCommitStatus({ context: "ci", state: "error" }).state, "failed");
        assert.equal(toCommitStatus({ context: "ci", state: "pending" }).state, "inProgress");
    });

    it("spells our states as GitHub's, with stopped as an error", () => {
        assert.equal(toGitHubStatusState("successful"), "success");
        assert.equal(toGitHubStatusState("failed"), "failure");
        assert.equal(toGitHubStatusState("inProgress"), "pending");
        assert.equal(toGitHubStatusState("stopped"), "error");
    });

    it("maps a check run's status and conclusion", () => {
        const state = (status: string, conclusion: string | null) =>
            checkRunToCommitStatus({ name: "ci", status: status as "completed", conclusion }).state;
        assert.equal(state("in_progress", null), "inProgress");
        assert.equal(state("queued", null), "inProgress");
        assert.equal(state("completed", "success"), "successful");
        assert.equal(state("completed", "skipped"), "successful");
        assert.equal(state("completed", "neutral"), "successful");
        assert.equal(state("completed", "cancelled"), "stopped");
        assert.equal(state("completed", "failure"), "failed");
        assert.equal(state("completed", "timed_out"), "failed");
        assert.equal(state("completed", "action_required"), "failed");
    });
});
