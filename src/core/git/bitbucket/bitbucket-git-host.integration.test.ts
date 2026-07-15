/**
 * Exercises the Bitbucket `GitHost` backend against the REAL `tai-framework` repo (TAI-37
 * acceptance criteria — "exercised against the real tai-framework repo, same pattern as
 * TAI-11's integration-test harness"). Skips cleanly when credentials are absent — `npm
 * test` must stay green offline, same discipline as the Jira conformance suite.
 *
 * READ-ONLY BY DESIGN. Unlike the Jira conformance suite (which targets a disposable
 * scratch project, TAIT), there is no scratch repo to point this at — TAI-37 explicitly
 * wants the REAL repo exercised. Repeatedly creating/merging real pull requests every time
 * `npm test` runs would spam the actual repo's PR history and pipeline minutes budget
 * (`bitbucket-pipelines-gotchas` memory: ~3 min/month currently used of a 50 min budget —
 * an automated PR-per-test-run habit would eat into that fast). The create/approve/merge
 * half of the acceptance criteria ("at least one real PR created, reviewed, and merged
 * through the new mechanism end-to-end") is exercised as a deliberate one-off action, not
 * as a repeatable automated test — see TAI-38's own worklog/comments for that run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toRepoId, toCommitSha } from "../interface.js";
import { RestClient, apiTokenAuth } from "./rest-client.js";
import { createBitbucketBackend } from "./bitbucket-backend.js";

const EMAIL = process.env["TAI_TEST_BITBUCKET_EMAIL"];
const API_TOKEN = process.env["TAI_TEST_BITBUCKET_API_TOKEN"];
const WORKSPACE = process.env["TAI_TEST_BITBUCKET_WORKSPACE"];

// The real repo this project ships from — deliberately hardcoded (not read from a
// separately-named env var), same reasoning as the Jira suite's hardcoded PROJECT_KEY:
// nothing here should be redirectable by a misconfigured environment variable.
const REPO_SLUG = "tai-framework";

const skip =
    EMAIL && API_TOKEN && WORKSPACE
        ? false
        : "TAI_TEST_BITBUCKET_EMAIL / TAI_TEST_BITBUCKET_API_TOKEN / TAI_TEST_BITBUCKET_WORKSPACE not set — " +
          "set them to run this suite against the real tai-framework repo.";

describe("bitbucket GitHost: tai-framework (live, read-only)", { skip }, () => {
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

    it("getCommitStatuses reports the pipeline's own build status for HEAD of master", async () => {
        // The commit resolution itself only needs `RepoRef`/branch listing, which this
        // backend already proved above — reuse Bitbucket's own branch API response for the
        // current master hash rather than shelling out to git, so this stays a pure
        // GitHost-surface exercise.
        const headHash = await currentMasterCommitHash();
        const statuses = await backend.gitHost.getCommitStatuses(repo, toCommitSha(headHash));
        // This project's own bitbucket-pipelines.yml (TAI-32) runs on every push to master —
        // by the time TAI-37 exists, master has multiple green builds (see the
        // bitbucket-pipelines-gotchas memory). A commit with zero statuses would mean either
        // the pipeline never ran or this call is hitting the wrong commit.
        assert.ok(statuses.length > 0, "expected at least one commit status on master's HEAD");
    });

    async function currentMasterCommitHash(): Promise<string> {
        const client = new RestClient({ auth: apiTokenAuth(EMAIL ?? "", API_TOKEN ?? "") });
        const branch = await client.request<{ target: { hash: string } }>(
            "GET",
            `/repositories/${WORKSPACE}/${REPO_SLUG}/refs/branches/master`
        );
        return branch.target.hash;
    }
});
