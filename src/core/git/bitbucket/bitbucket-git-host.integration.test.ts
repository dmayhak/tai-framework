/**
 * Exercises the Bitbucket `GitHost` backend live against two real repos (TAI-37 acceptance
 * criteria — "exercised against the real tai-framework repo, same pattern as TAI-11's
 * integration-test harness"). Skips cleanly when credentials are absent — `npm test` must
 * stay green offline, same discipline as the Jira conformance suite.
 *
 * TWO REPOS, TWO PURPOSES:
 * - `tai-framework` — the real repo. READ-ONLY here, deliberately: repeatedly creating or
 *   merging real pull requests every time `npm test` runs would spam its actual PR history
 *   and pipeline minutes budget (`bitbucket-pipelines-gotchas` memory: ~3 min/month of a 50
 *   min budget — an automated PR-per-run habit would eat into that fast).
 * - `TAIT` (`dmayhak/tait`) — a disposable scratch repo created for exactly this purpose,
 *   the Bitbucket analogue of the Jira `TAIT` scratch project used by
 *   `storage/jira/jira-backend.conformance.test.ts`. Destructive PR create/approve/
 *   requestChanges/merge/comment coverage lives here, freely repeatable.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toRepoId, toCommitSha } from "../interface.js";
import { RestClient, apiTokenAuth } from "./rest-client.js";
import { createBitbucketBackend } from "./bitbucket-backend.js";

const EMAIL = process.env["TAI_TEST_BITBUCKET_EMAIL"];
const API_TOKEN = process.env["TAI_TEST_BITBUCKET_API_TOKEN"];
const WORKSPACE = process.env["TAI_TEST_BITBUCKET_WORKSPACE"];

const skip =
    EMAIL && API_TOKEN && WORKSPACE
        ? false
        : "TAI_TEST_BITBUCKET_EMAIL / TAI_TEST_BITBUCKET_API_TOKEN / TAI_TEST_BITBUCKET_WORKSPACE not set — " +
          "set them to run this suite against the real Bitbucket repos.";

function rawClient(): RestClient {
    return new RestClient({ auth: apiTokenAuth(EMAIL ?? "", API_TOKEN ?? "") });
}

// ---------- tai-framework: read-only ----------

describe("bitbucket GitHost: tai-framework (live, read-only)", { skip }, () => {
    // The real repo this project ships from — deliberately hardcoded (not read from a
    // separately-named env var), same reasoning as the Jira suite's hardcoded PROJECT_KEY:
    // nothing here should be redirectable by a misconfigured environment variable.
    const REPO_SLUG = "tai-framework";
    const backend = createBitbucketBackend({ auth: apiTokenAuth(EMAIL ?? "", API_TOKEN ?? "") });
    const repo = toRepoId(`${WORKSPACE}/${REPO_SLUG}`);

    it("getRepository finds the real repo with master as its default branch", async () => {
        const ref = await backend.gitHost.getRepository(repo);
        assert.equal(ref?.name, REPO_SLUG);
        assert.equal(ref?.defaultBranch, "master");
    });

    it("listBranches includes master", async () => {
        const branches = await backend.gitHost.listBranches(repo);
        assert.ok(branches.includes("master"));
    });

    it("getCommitStatuses returns cleanly for HEAD of master (TAI-230: Pipelines is manual-only now)", async () => {
        const headHash = await branchTipHash(REPO_SLUG, "master");
        const statuses = await backend.gitHost.getCommitStatuses(repo, headHash);
        // bitbucket-pipelines.yml (TAI-32) originally ran on every push to master, so by
        // TAI-37 master had multiple green builds. REVISED (TAI-230, 2026-08-27): the
        // pipeline is now `custom:` (manual-only) after hitting the 50 build-minute/month
        // free-tier quota twice — a commit with zero statuses is the ordinary case now, not
        // a sign something's wrong (see isGreen, TAI-230/250). This just confirms the call
        // itself works against the real repo; it no longer asserts statuses exist.
        assert.ok(Array.isArray(statuses));
    });
});

// ---------- TAIT: destructive ----------

describe("bitbucket GitHost: TAIT (live, destructive)", { skip }, () => {
    const REPO_SLUG = "tait";
    const backend = createBitbucketBackend({ auth: apiTokenAuth(EMAIL ?? "", API_TOKEN ?? "") });
    const repo = toRepoId(`${WORKSPACE}/${REPO_SLUG}`);

    it("creates, approves, and merges a real PR end-to-end (close_source_branch cleans up after itself)", async () => {
        const branch = `demo-merge-${Date.now()}`;
        await seedBranch(REPO_SLUG, branch, "Demo commit — happy-path merge test");

        const pr = await backend.gitHost.createPullRequest({
            repo,
            title: "Integration test: happy path",
            sourceBranch: branch,
            destinationBranch: "master",
        });
        assert.equal(pr.state, "open");
        assert.equal(pr.sourceBranch, branch);

        await backend.gitHost.reviewPullRequest(repo, pr.id, "approve", "Approved by the integration suite.");
        const reviewed = await backend.gitHost.getPullRequest(repo, pr.id);
        assert.ok(
            reviewed?.reviewers.some((r) => r.status === "approved"),
            "the approval must be visible via getPullRequest — this is the exact gap TAI-38's " +
                "live demo found and fixed for the real repo (mappers.ts)"
        );

        const merge = await backend.gitHost.mergePullRequest(repo, pr.id, "squash");
        assert.equal(merge.ok, true);
        assert.equal(merge.ok === true ? merge.pullRequest.state : undefined, "merged");

        // No manual branch cleanup needed — mergePullRequest always sets
        // close_source_branch (git-host.ts), verified here by confirming Bitbucket actually
        // removed it, not just that we asked it to.
        const branches = await backend.gitHost.listBranches(repo);
        assert.ok(!branches.includes(branch), "Bitbucket should have deleted the source branch on merge");
    });

    it("requestChanges is visible via getPullRequest, distinct from approved", async () => {
        const branch = `demo-request-changes-${Date.now()}`;
        await seedBranch(REPO_SLUG, branch, "Demo commit — request-changes test");

        const pr = await backend.gitHost.createPullRequest({
            repo,
            title: "Integration test: request changes",
            sourceBranch: branch,
            destinationBranch: "master",
        });

        await backend.gitHost.reviewPullRequest(repo, pr.id, "requestChanges", "Needs work (integration test).");
        const reviewed = await backend.gitHost.getPullRequest(repo, pr.id);
        assert.ok(reviewed?.reviewers.some((r) => r.status === "changesRequested"));

        // Cleanup: decline + delete the branch directly via REST. `decline` isn't a GitHost
        // operation at all — TAI-33's ADR scopes GitHost to create/approve/requestChanges/
        // merge/commit-status, not decline — so bypassing the interface here is correct, not
        // a workaround, same as the Jira suite's disposeIssue going straight to REST.
        await rawClient()
            .request("POST", `/repositories/${WORKSPACE}/${REPO_SLUG}/pullrequests/${pr.id}/decline`)
            .catch(() => {});
        await deleteBranch(REPO_SLUG, branch);
    });

    it("addPullRequestComment posts a real, readable comment", async () => {
        const branch = `demo-comment-${Date.now()}`;
        await seedBranch(REPO_SLUG, branch, "Demo commit — comment test");

        const pr = await backend.gitHost.createPullRequest({
            repo,
            title: "Integration test: comment",
            sourceBranch: branch,
            destinationBranch: "master",
        });

        const comment = await backend.gitHost.addPullRequestComment(repo, pr.id, "Integration test comment.");
        assert.equal(comment.body, "Integration test comment.");
        assert.equal(comment.author.displayName.length > 0, true);

        await rawClient()
            .request("POST", `/repositories/${WORKSPACE}/${REPO_SLUG}/pullrequests/${pr.id}/decline`)
            .catch(() => {});
        await deleteBranch(REPO_SLUG, branch);
    });

    it("listPullRequests filters by state", async () => {
        const branch = `demo-list-${Date.now()}`;
        await seedBranch(REPO_SLUG, branch, "Demo commit — listPullRequests test");
        const pr = await backend.gitHost.createPullRequest({
            repo,
            title: "Integration test: list filter",
            sourceBranch: branch,
            destinationBranch: "master",
        });

        const open = await backend.gitHost.listPullRequests(repo, "open");
        assert.ok(open.some((p) => p.id === pr.id));
        const merged = await backend.gitHost.listPullRequests(repo, "merged");
        assert.ok(!merged.some((p) => p.id === pr.id));

        await rawClient()
            .request("POST", `/repositories/${WORKSPACE}/${REPO_SLUG}/pullrequests/${pr.id}/decline`)
            .catch(() => {});
        await deleteBranch(REPO_SLUG, branch);
    });

    it("getCommitStatuses returns an empty array for a repo with no pipeline configured", async () => {
        const branch = `demo-statuses-${Date.now()}`;
        await seedBranch(REPO_SLUG, branch, "Demo commit — no-pipeline statuses test");
        const hash = await branchTipHash(REPO_SLUG, branch);
        const statuses = await backend.gitHost.getCommitStatuses(repo, hash);
        assert.deepEqual([...statuses], [], "TAIT has no bitbucket-pipelines.yml — never any statuses");
        await deleteBranch(REPO_SLUG, branch);
    });
});

// ---------- Fixture helpers (raw REST — deliberately outside GitHost's own surface) ----------

/**
 * Branch creation/commits are plain git concerns, not `GitHost` operations — TAI-33's ADR
 * scopes `GitHost` to PR CRUD, review, merge, and commit status only (brief §6: branches are
 * created via git, not the storage/git-host plugin layer). So fixture setup here goes
 * straight through `RestClient`, the same way `jira-backend.conformance.test.ts`'s
 * `ensureComponent` bypasses `WorkTracker` for one-time fixture provisioning.
 */
async function seedBranch(repoSlug: string, branchName: string, message: string): Promise<void> {
    const hash = await branchTipHash(repoSlug, "master");
    await rawClient().request("POST", `/repositories/${WORKSPACE}/${repoSlug}/refs/branches`, {
        name: branchName,
        target: { hash },
    });

    // Bitbucket's file-write endpoint is multipart/form-data, unlike every other call this
    // backend makes — RestClient.request is JSON-only by design (git/bitbucket/rest-client.ts
    // has no reason to support multipart for anything GitHost itself does), so this one write
    // goes around it with a raw `fetch` + `FormData` instead of extending RestClient for a
    // shape only test fixtures ever need.
    const auth = apiTokenAuth(EMAIL ?? "", API_TOKEN ?? "");
    const form = new FormData();
    form.set(`${branchName}.txt`, `Integration test fixture — ${new Date().toISOString()}`);
    form.set("message", message);
    form.set("branch", branchName);
    const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${WORKSPACE}/${repoSlug}/src`, {
        method: "POST",
        headers: await auth.headers(),
        body: form,
    });
    if (!res.ok) {
        throw new Error(`seedBranch: commit to ${branchName} failed (${res.status}): ${await res.text()}`);
    }
}

async function branchTipHash(repoSlug: string, branch: string) {
    const b = await rawClient().request<{ target: { hash: string } }>(
        "GET",
        `/repositories/${WORKSPACE}/${repoSlug}/refs/branches/${branch}`
    );
    return toCommitSha(b.target.hash);
}

async function deleteBranch(repoSlug: string, branchName: string): Promise<void> {
    await rawClient()
        .request("DELETE", `/repositories/${WORKSPACE}/${repoSlug}/refs/branches/${branchName}`)
        .catch(() => {});
}
