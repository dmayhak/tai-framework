/**
 * Exercises the GitHub `GitHost` backend live against a scratch repository (TAI-585, TAI-583 ADR).
 * Skips cleanly when credentials are absent, so `npm test` stays green offline, as the Bitbucket
 * suite does.
 *
 * The repository is always `<owner>/tai-test`: the name is hardcoded, so no environment variable
 * can point this destructive suite at a real repository. Only the owner comes from the
 * environment.
 *
 * Two identities, because GitHub refuses an approval from a PR's author:
 * - `TAI_TEST_GITHUB_TOKEN`: the author. Opens, comments on and merges the PRs.
 * - `TAI_TEST_GITHUB_REVIEWER_TOKEN`: a second account with write access. Approves and requests
 *   changes. Without it, the review cases are skipped and the rest still run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toHumanId } from "../../storage/interface.js";
import { toCommitSha, toRepoId, type CommitSha, type PullRequestRef } from "../interface.js";
import { evaluateMergeGate } from "../merge-gate.js";
import { RestClient, GitHubRejection, tokenAuth } from "./rest-client.js";
import { createGitHubBackend } from "./github-backend.js";

const TOKEN = process.env["TAI_TEST_GITHUB_TOKEN"];
const REVIEWER_TOKEN = process.env["TAI_TEST_GITHUB_REVIEWER_TOKEN"];
const OWNER = process.env["TAI_TEST_GITHUB_OWNER"];
const REPO_NAME = "tai-test";

const skip =
    TOKEN && OWNER ? false : "TAI_TEST_GITHUB_TOKEN / TAI_TEST_GITHUB_OWNER not set — set them to run this suite against <owner>/tai-test.";
const reviewSkip = skip || (REVIEWER_TOKEN ? false : "TAI_TEST_GITHUB_REVIEWER_TOKEN not set — the review cases need a second account.");

const repo = toRepoId(`${OWNER}/${REPO_NAME}`);
const author = createGitHubBackend({ auth: tokenAuth(TOKEN ?? "") }).gitHost;
const selfReviewing = createGitHubBackend({ auth: tokenAuth(TOKEN ?? ""), allowSelfReview: true }).gitHost;
const reviewer = createGitHubBackend({ auth: tokenAuth(REVIEWER_TOKEN ?? "") }).gitHost;
const raw = (): RestClient => new RestClient({ auth: tokenAuth(TOKEN ?? "") });

describe("github GitHost: tai-test (live)", { skip }, () => {
    it("reads the current user, the repository and its branches", async () => {
        const me = await author.getCurrentUser();
        assert.ok(me.id.length > 0);
        const ref = await author.getRepository(repo);
        assert.equal(ref?.name, REPO_NAME);
        assert.ok((await author.listBranches(repo)).includes(ref!.defaultBranch));
        assert.ok((await author.listRepositories(OWNER!)).some((r) => r.id === repo));
    });

    it("comments, statuses, listing and a squash merge that deletes the branch", async () => {
        const base = await defaultBranch();
        const branch = `it-merge-${Date.now()}`;
        await seedBranch(branch, base, "Integration test: merge");
        const pr = await author.createPullRequest({ repo, title: "Integration test: merge", sourceBranch: branch, destinationBranch: base });
        try {
            assert.equal(pr.state, "open");

            const general = await author.addPullRequestComment(repo, pr.id, "Integration test comment.");
            assert.equal(general.body, "Integration test comment.");
            await author.addInlineComment(repo, pr.id, { path: `${branch}.txt`, line: 1, body: "Inline integration test comment." });
            const comments = await author.listPullRequestComments(repo, pr.id);
            assert.ok(comments.some((c) => c.body === "Integration test comment." && !c.inline));
            assert.ok(comments.some((c) => c.inline?.path === `${branch}.txt` && c.inline.line === 1));

            const status = await author.createCommitStatus(repo, pr.sourceCommit, {
                key: "tai-integration",
                name: "TAI integration",
                state: "successful",
                url: "https://example.com/tai-integration",
            });
            assert.equal(status.state, "successful");
            const statuses = await author.getCommitStatuses(repo, pr.sourceCommit);
            assert.ok(statuses.some((s) => s.key === "tai-integration" && s.state === "successful"));

            assert.ok((await author.listPullRequests(repo, "open")).some((p) => p.id === pr.id));

            // A merge held to an older commit than the branch's is refused (TAI-585).
            const checked = (await waitForHead(pr.id, pr.sourceCommit)).sourceCommit;
            const pushed = await addCommit(branch, "Integration test: a commit after the check");
            const refused = await author.mergePullRequest(repo, pr.id, "squash", { expectedHead: checked });
            assert.equal(refused.ok, false);

            const merged = await author.mergePullRequest(repo, pr.id, "squash", { expectedHead: pushed });
            assert.equal(merged.ok, true, merged.ok ? "" : merged.reason);
            assert.equal(merged.ok && merged.pullRequest.state, "merged");
            assert.ok(!(await author.listBranches(repo)).includes(branch), "the source branch is deleted on merge");

            const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            assert.ok((await author.listPullRequests(repo, "merged", { updatedSince: since })).some((p) => p.id === pr.id));
        } finally {
            await closeAndDelete(pr.id, branch);
        }
    });

    it("refuses the author's own approval, and records it as a counted self-review when allowed", async () => {
        const base = await defaultBranch();
        const branch = `it-self-${Date.now()}`;
        await seedBranch(branch, base, "Integration test: self-review");
        const pr = await author.createPullRequest({ repo, title: "Integration test: self-review", sourceBranch: branch, destinationBranch: base });
        try {
            await assert.rejects(author.reviewPullRequest(repo, pr.id, "approve"), /TAI_PR_SELF_REVIEW/);
            await assert.rejects(author.reviewPullRequest(repo, pr.id, "requestChanges"), GitHubRejection);

            await selfReviewing.reviewPullRequest(repo, pr.id, "approve", "Checked by the integration suite.");
            const reviewed = await selfReviewing.getPullRequest(repo, pr.id);
            assert.equal(reviewed?.reviewers.find((r) => r.human.id === pr.author.id)?.status, "approved");
            const gate = evaluateMergeGate({
                pullRequest: reviewed!,
                activity: await selfReviewing.listPullRequestActivity(repo, pr.id),
                requiredApprovals: 1,
                testTiers: [],
                uat: [],
            });
            assert.equal(gate.ok, true, gate.blockers.join(" "));
            // Without the setting, the same review does not count.
            assert.equal((await author.getPullRequest(repo, pr.id))?.reviewers.some((r) => r.human.id === pr.author.id), false);

            await selfReviewing.unapprovePullRequest(repo, pr.id);
            assert.equal((await selfReviewing.getPullRequest(repo, pr.id))?.reviewers.some((r) => r.status === "approved"), false);
        } finally {
            await closeAndDelete(pr.id, branch);
        }
    });
});

describe("github GitHost: tai-test reviews from a second account (live)", { skip: reviewSkip }, () => {
    it("requests the reviewer, and the merge gate tells a fresh approval from a stale one", async () => {
        const reviewerLogin = (await reviewer.getCurrentUser()).id;
        const base = await defaultBranch();
        const branch = `it-review-${Date.now()}`;
        await seedBranch(branch, base, "Integration test: review");
        const pr = await author.createPullRequest({
            repo,
            title: "Integration test: review",
            sourceBranch: branch,
            destinationBranch: base,
            reviewers: [{ id: toHumanId(reviewerLogin), displayName: reviewerLogin }],
        });
        try {
            assert.deepEqual(
                pr.reviewers.map((r) => [r.human.id, r.status]),
                [[reviewerLogin, "pending"]]
            );

            await reviewer.reviewPullRequest(repo, pr.id, "requestChanges", "Needs work (integration test).");
            assert.equal((await author.getPullRequest(repo, pr.id))?.reviewers.find((r) => r.human.id === reviewerLogin)?.status, "changesRequested");

            await reviewer.reviewPullRequest(repo, pr.id, "approve", "Approved by the integration suite.");
            let current = await waitForHead(pr.id, pr.sourceCommit);
            assert.equal(current.reviewers.find((r) => r.human.id === reviewerLogin)?.status, "approved");
            let gate = evaluateMergeGate({ pullRequest: current, activity: await author.listPullRequestActivity(repo, pr.id), requiredApprovals: 1, testTiers: [], uat: [] });
            assert.equal(gate.ok, true, gate.blockers.join(" "));

            // A new commit makes the approval stale. GitHub reports the PR's new head a few seconds
            // after the push (found live), so wait for it.
            const pushed = await addCommit(branch, "Integration test: a later commit");
            current = await waitForHead(pr.id, pushed);
            gate = evaluateMergeGate({ pullRequest: current, activity: await author.listPullRequestActivity(repo, pr.id), requiredApprovals: 1, testTiers: [], uat: [] });
            assert.equal(gate.ok, false);
            assert.deepEqual(
                gate.staleApprovals.map((h) => h.id),
                [reviewerLogin]
            );

            // Withdrawing the approval dismisses it.
            await reviewer.unapprovePullRequest(repo, pr.id);
            assert.notEqual((await author.getPullRequest(repo, pr.id))?.reviewers.find((r) => r.human.id === reviewerLogin)?.status, "approved");
        } finally {
            await closeAndDelete(pr.id, branch);
        }
    });
});

// ---------- Fixture helpers (raw REST, outside GitHost's surface, as in the Bitbucket suite) ----------

async function defaultBranch(): Promise<string> {
    return (await author.getRepository(repo))!.defaultBranch;
}

async function branchSha(branch: string): Promise<CommitSha> {
    const ref = await raw().request<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${branch}`);
    return toCommitSha(ref.object.sha);
}

async function seedBranch(branch: string, base: string, message: string): Promise<void> {
    await raw().request("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: await branchSha(base) });
    await raw().request("PUT", `/repos/${repo}/contents/${branch}.txt`, {
        message,
        branch,
        content: Buffer.from(`Integration test fixture — ${new Date().toISOString()}\n`).toString("base64"),
    });
}

/** Commits a change to the branch's fixture file and returns the new commit. */
async function addCommit(branch: string, message: string): Promise<CommitSha> {
    const file = await raw().request<{ sha: string }>("GET", `/repos/${repo}/contents/${branch}.txt?ref=${branch}`);
    const written = await raw().request<{ commit: { sha: string } }>("PUT", `/repos/${repo}/contents/${branch}.txt`, {
        message,
        branch,
        sha: file.sha,
        content: Buffer.from(`Changed — ${new Date().toISOString()}\n`).toString("base64"),
    });
    return toCommitSha(written.commit.sha);
}

/** The PR once GitHub reports `head` as its source commit; GitHub updates it a few seconds after a push. */
async function waitForHead(prId: PullRequestRef["id"], head: CommitSha): Promise<PullRequestRef> {
    for (let i = 0; i < 30; i++) {
        const pr = await author.getPullRequest(repo, prId);
        if (pr?.sourceCommit === head) return pr;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`PR ${prId} never reported head ${head}`);
}

async function closeAndDelete(prId: string, branch: string): Promise<void> {
    await raw().request("PATCH", `/repos/${repo}/pulls/${prId}`, { state: "closed" }).catch(() => {});
    await raw().request("DELETE", `/repos/${repo}/git/refs/heads/${branch}`).catch(() => {});
}
