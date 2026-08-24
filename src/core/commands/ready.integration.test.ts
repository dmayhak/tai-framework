/**
 * TAI-110 IntegrationTest, updated for rev 52 (TAI-159/TAI-160): exercises the approved-PR-
 * merge surfacing/trigger against REAL backends — Jira TAIT (`WorkTracker`: Story/Dev
 * subtask creation, transition, `createRemoteLink`/`getRemoteLinks`) and Bitbucket TAIT
 * (`GitHost`: real branch, real PR, real `reviewPullRequest`/`listPullRequests`/
 * `getCommitStatuses`) — the ready.test.ts unit suite already covers this logic against
 * fakes; this is the real acceptance bar, same discipline as
 * `link-precedence.integration.test.ts` (TAI-100) and `jira-backend.conformance.test.ts`.
 * Skips cleanly when either credential set is absent. CodeReview retired going forward
 * (rev 52) — the anchor is now an In-Progress Dev subtask, not a Done CodeReview subtask;
 * `findCodeReviewSiblingForLink`'s own coverage was removed along with the function itself
 * (git-pr create links directly to the Dev subtask now, no sibling lookup).
 *
 * CI-STATUS COVERAGE, SCOPED HONESTLY: TAIT has no `bitbucket-pipelines.yml` — confirmed by
 * `bitbucket-git-host.integration.test.ts`'s own "getCommitStatuses returns an empty array
 * for a repo with no pipeline configured" test — so a TAIT-hosted PR can never have real
 * green CI, and this suite does NOT fabricate one (that would defeat the point of a REAL-
 * backend test). Split honestly instead:
 *   - The "no CI info => not surfaced" negative path is proven for real, end-to-end, against
 *     TAIT (search -> getRemoteLinks -> real listPullRequests match -> real
 *     getCommitStatuses -> isGreen, all real calls).
 *   - `isGreen`'s positive (green) interpretation is proven separately, read-only, against
 *     `tai-framework`'s own real, always-green `master` HEAD — same reason
 *     `bitbucket-git-host.integration.test.ts` uses it read-only for exactly this: repeatedly
 *     opening new PRs against the real project repo would spend its real PR history /
 *     pipeline-minutes budget for no reason (`bitbucket-pipelines-gotchas` memory).
 *   - ready.test.ts's fake-`GitHost` unit tests already prove the full positive (green PR
 *     surfaced) path; this file doesn't re-fake that, it proves the real pieces those fakes
 *     stand in for actually behave the way the fakes assumed.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import type { IssueKey, WorkTracker } from "../storage/interface.js";
import { apiTokenAuth as jiraApiTokenAuth } from "../storage/jira/rest-client.js";
import { createJiraBackend } from "../storage/jira/jira-backend.js";
import {
    toCommitSha,
    toRepoId,
    type GitHost,
    type RepoId,
} from "../git/interface.js";
import { createBitbucketBackend, apiTokenAuth as bitbucketApiTokenAuth } from "../git/bitbucket/bitbucket-backend.js";
import { RestClient } from "../git/bitbucket/rest-client.js";
import { findReadyWork } from "./ready.js";
import { isGreen } from "./git-pr.js";

const JIRA_SITE_URL = process.env["TAI_TEST_JIRA_SITE_URL"];
const JIRA_EMAIL = process.env["TAI_TEST_JIRA_EMAIL"];
const JIRA_API_TOKEN = process.env["TAI_TEST_JIRA_API_TOKEN"];

const BB_EMAIL = process.env["TAI_TEST_BITBUCKET_EMAIL"];
const BB_API_TOKEN = process.env["TAI_TEST_BITBUCKET_API_TOKEN"];
const BB_WORKSPACE = process.env["TAI_TEST_BITBUCKET_WORKSPACE"];

const PROJECT_KEY = "TAIT"; // hardcoded — same reasoning as jira-backend.conformance.test.ts
const REPO_SLUG = "tait"; // hardcoded — same reasoning as bitbucket-git-host.integration.test.ts

const skip =
    JIRA_SITE_URL && JIRA_EMAIL && JIRA_API_TOKEN && BB_EMAIL && BB_API_TOKEN && BB_WORKSPACE
        ? false
        : "TAI_TEST_JIRA_SITE_URL/EMAIL/API_TOKEN and TAI_TEST_BITBUCKET_EMAIL/API_TOKEN/WORKSPACE " +
          "not all set — set them to run this suite against the TAIT scratch project + repo.";

function rawBitbucketClient(): RestClient {
    return new RestClient({ auth: bitbucketApiTokenAuth(BB_EMAIL ?? "", BB_API_TOKEN ?? "") });
}

async function branchTipHash(repoSlug: string, branch: string) {
    const b = await rawBitbucketClient().request<{ target: { hash: string } }>(
        "GET",
        `/repositories/${BB_WORKSPACE}/${repoSlug}/refs/branches/${branch}`
    );
    return toCommitSha(b.target.hash);
}

/** Same fixture-setup pattern as `bitbucket-git-host.integration.test.ts`'s own
 *  `seedBranch` — branch/commit creation is plain git, outside `GitHost`'s own surface. */
async function seedBranch(repoSlug: string, branchName: string, message: string): Promise<void> {
    const hash = await branchTipHash(repoSlug, "master");
    await rawBitbucketClient().request("POST", `/repositories/${BB_WORKSPACE}/${repoSlug}/refs/branches`, {
        name: branchName,
        target: { hash },
    });

    const auth = bitbucketApiTokenAuth(BB_EMAIL ?? "", BB_API_TOKEN ?? "");
    const form = new FormData();
    form.set(`${branchName}.txt`, `Integration test fixture — ${new Date().toISOString()}`);
    form.set("message", message);
    form.set("branch", branchName);
    const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${BB_WORKSPACE}/${repoSlug}/src`, {
        method: "POST",
        headers: await auth.headers(),
        body: form,
    });
    if (!res.ok) {
        throw new Error(`seedBranch: commit to ${branchName} failed (${res.status}): ${await res.text()}`);
    }
}

async function deleteBranch(repoSlug: string, branchName: string): Promise<void> {
    await rawBitbucketClient()
        .request("DELETE", `/repositories/${BB_WORKSPACE}/${repoSlug}/refs/branches/${branchName}`)
        .catch(() => {});
}

describe("approved-PR-merge surfacing/trigger against real backends (TAIT)", { skip }, () => {
    let workTracker: WorkTracker;
    let gitHost: GitHost;
    let repo: RepoId;
    const createdKeys: IssueKey[] = [];
    const createdBranches: string[] = [];

    before(async () => {
        const backend = await createJiraBackend({
            siteUrl: JIRA_SITE_URL ?? "",
            spaceKey: PROJECT_KEY,
            auth: jiraApiTokenAuth(JIRA_EMAIL ?? "", JIRA_API_TOKEN ?? ""),
        });
        workTracker = backend.workTracker;
        gitHost = createBitbucketBackend({ auth: bitbucketApiTokenAuth(BB_EMAIL ?? "", BB_API_TOKEN ?? "") }).gitHost;
        repo = toRepoId(`${BB_WORKSPACE}/${REPO_SLUG}`);
    });

    after(async () => {
        for (const key of createdKeys) {
            await workTracker.addLabel(key, "tai-integration-fixture").catch(() => {});
            await workTracker.transition(key, Status.Canceled).catch(() => {});
        }
        for (const branch of createdBranches) {
            await deleteBranch(REPO_SLUG, branch);
        }
    });

    function track(key: IssueKey): IssueKey {
        createdKeys.push(key);
        return key;
    }

    test("end-to-end (rev 52): an In-Progress Dev subtask with a real approved+linked PR but no CI info is not surfaced as ready to merge", async () => {
        const story = await workTracker.createIssue({
            projectKey: PROJECT_KEY,
            issueType: StoryType.Story,
            summary: "TAI-110/TAI-160 fixture: readyToMerge negative case",
        });
        track(story.key);
        const dev = await workTracker.createIssue({
            projectKey: PROJECT_KEY,
            issueType: SubtaskType.Dev,
            summary: "TAI-110/TAI-160 fixture: Dev, no CI on TAIT",
            persona: Persona.Developer,
            parentKey: story.key,
        });
        track(dev.key);
        await workTracker.transition(dev.key, Status.InProgress);

        const branch = `tai-110-readytomerge-${Date.now()}`;
        createdBranches.push(branch);
        await seedBranch(REPO_SLUG, branch, "TAI-110/TAI-160 integration test fixture");
        const pr = await gitHost.createPullRequest({
            repo,
            title: "TAI-110/TAI-160 fixture PR (no CI on TAIT)",
            sourceBranch: branch,
            destinationBranch: "master",
        });

        await workTracker.createRemoteLink(dev.key, pr.url, pr.title);
        // Approve it for real, so this test isolates the CI-only exclusion (rev 52:
        // readyToTest/readyToMerge both also require the approval threshold — met here —
        // separately from the CI check this test is actually about).
        await gitHost.reviewPullRequest(repo, pr.id, "approve");

        // Confirms real getCommitStatuses genuinely returns nothing for this PR's real
        // commit — same live fact bitbucket-git-host.integration.test.ts's own "no pipeline
        // configured" test established, re-confirmed here on this specific fixture's commit.
        const statuses = await gitHost.getCommitStatuses(repo, pr.sourceCommit);
        assert.deepEqual([...statuses], []);
        assert.equal(isGreen(statuses), false);

        const result = await findReadyWork({
            workTracker,
            taiRoot: "/tmp/tai-110-unused", // rollupStatus reads this; irrelevant to readyToMerge
            projectKey: PROJECT_KEY,
            gitHost,
            repos: [repo],
        });
        assert.ok(
            result.readyToTest.some((c) => c.devSubtaskKey === dev.key),
            "readyToTest never checked CI, pre- or post-rev-52 — the approved PR belongs here"
        );
        assert.ok(
            !result.readyToMerge.some((c) => c.devSubtaskKey === dev.key),
            "no CI info must exclude the PR from readyToMerge, not silently treat it as ready"
        );

        // Cleanup: decline the real PR (not part of GitHost's own scope, same as
        // bitbucket-git-host.integration.test.ts's own decline-via-raw-REST cleanup).
        await rawBitbucketClient()
            .request("POST", `/repositories/${BB_WORKSPACE}/${REPO_SLUG}/pullrequests/${pr.id}/decline`)
            .catch(() => {});
    });

    test("once the linked PR is no longer open, it drops out of readyToTest/readyToMerge even with a matching remote link", async () => {
        const story = await workTracker.createIssue({
            projectKey: PROJECT_KEY,
            issueType: StoryType.Story,
            summary: "TAI-110/TAI-160 fixture: readyToMerge after decline",
        });
        track(story.key);
        const dev = await workTracker.createIssue({
            projectKey: PROJECT_KEY,
            issueType: SubtaskType.Dev,
            summary: "TAI-110/TAI-160 fixture: Dev, PR gets declined",
            persona: Persona.Developer,
            parentKey: story.key,
        });
        track(dev.key);
        await workTracker.transition(dev.key, Status.InProgress);

        const branch = `tai-110-declined-${Date.now()}`;
        createdBranches.push(branch);
        await seedBranch(REPO_SLUG, branch, "TAI-110/TAI-160 integration test fixture — will be declined");
        const pr = await gitHost.createPullRequest({
            repo,
            title: "TAI-110/TAI-160 fixture PR (will be declined)",
            sourceBranch: branch,
            destinationBranch: "master",
        });
        await workTracker.createRemoteLink(dev.key, pr.url, pr.title);

        await rawBitbucketClient().request(
            "POST",
            `/repositories/${BB_WORKSPACE}/${REPO_SLUG}/pullrequests/${pr.id}/decline`
        );

        const result = await findReadyWork({
            workTracker,
            taiRoot: "/tmp/tai-110-unused",
            projectKey: PROJECT_KEY,
            gitHost,
            repos: [repo],
        });
        assert.ok(!result.readyToTest.some((c) => c.devSubtaskKey === dev.key));
        assert.ok(!result.readyToMerge.some((c) => c.devSubtaskKey === dev.key));
    });
});

// ---------- isGreen() against real, known-green CI data ----------

const skipReadOnly =
    BB_EMAIL && BB_API_TOKEN && BB_WORKSPACE
        ? false
        : "TAI_TEST_BITBUCKET_EMAIL/API_TOKEN/WORKSPACE not set — set them to run this suite.";

describe("isGreen against tai-framework's own real pipeline (live, read-only)", { skip: skipReadOnly }, () => {
    // Deliberately the real project repo, deliberately read-only (no PR opened here) — same
    // reasoning as bitbucket-git-host.integration.test.ts's own read-only section: this
    // project's own bitbucket-pipelines.yml runs on every push to master, so master's HEAD
    // always has real, genuinely green commit statuses to assert against, without spending
    // any of the real repo's PR-history/pipeline-minutes budget to get them.
    test("isGreen(true) on tai-framework master's real HEAD commit statuses", async () => {
        const gitHost = createBitbucketBackend({
            auth: bitbucketApiTokenAuth(BB_EMAIL ?? "", BB_API_TOKEN ?? ""),
        }).gitHost;
        const repo = toRepoId(`${BB_WORKSPACE}/tai-framework`);
        const client = rawBitbucketClient();
        const branch = await client.request<{ target: { hash: string } }>(
            "GET",
            `/repositories/${BB_WORKSPACE}/tai-framework/refs/branches/master`
        );
        const statuses = await gitHost.getCommitStatuses(repo, toCommitSha(branch.target.hash));
        assert.ok(statuses.length > 0, "expected at least one real commit status on master's HEAD");
        assert.equal(isGreen(statuses), true, "master's HEAD must be green by the time this test exists");
    });
});
