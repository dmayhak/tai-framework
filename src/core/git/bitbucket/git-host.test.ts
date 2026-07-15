import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StorageConnectivityError } from "../../storage/interface.js";
import { toRepoId, toPullRequestId, toCommitSha } from "../interface.js";
import { RestClient, apiTokenAuth } from "./rest-client.js";
import { createBitbucketGitHost } from "./git-host.js";

/** A fetch stub that replays canned responses, so these stay offline and deterministic
 *  — same shape as `storage/jira/work-tracker.test.ts`'s harness. */
function stubFetch(handler: (method: string, url: string, body: unknown) => Response | Promise<Response>) {
    return ((input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        return Promise.resolve(handler((init?.method ?? "GET") as string, String(input), body));
    }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
    return new Response(body === undefined ? "" : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function hostWith(fetchImpl: typeof fetch) {
    const client = new RestClient({ auth: apiTokenAuth("a@b.c", "token"), fetchImpl });
    return createBitbucketGitHost(client);
}

const REPO = toRepoId("dmayhak/tai-framework");

const REPO_JSON = {
    full_name: "dmayhak/tai-framework",
    name: "tai-framework",
    mainbranch: { name: "master" },
    links: { html: { href: "https://bitbucket.org/dmayhak/tai-framework" } },
};

const PR_JSON = {
    id: 7,
    title: "TAI-38 Dev: GitHost interface",
    state: "OPEN",
    source: { branch: { name: "TAI-37-git-host" }, commit: { hash: "abc123" } },
    destination: { branch: { name: "master" } },
    author: { account_id: "acct-1", display_name: "Del" },
    participants: [],
    created_on: "2026-07-15T10:00:00Z",
    updated_on: "2026-07-15T10:00:00Z",
    links: { html: { href: "https://bitbucket.org/dmayhak/tai-framework/pull-requests/7" } },
};

describe("getRepository", () => {
    it("maps a found repository", async () => {
        const host = hostWith(stubFetch(() => json(REPO_JSON)));
        const repo = await host.getRepository(REPO);
        assert.equal(repo?.name, "tai-framework");
        assert.equal(repo?.defaultBranch, "master");
    });

    it("returns null, not a throw, when Bitbucket 404s", async () => {
        const host = hostWith(stubFetch(() => json({ error: { message: "Repository not found" } }, 404)));
        const repo = await host.getRepository(REPO);
        assert.equal(repo, null);
    });
});

describe("listBranches", () => {
    it("walks Bitbucket's `next`-URL pagination", async () => {
        const host = hostWith(
            stubFetch((_method, url) => {
                if (url.includes("page2")) return json({ values: [{ name: "develop" }] });
                return json({
                    values: [{ name: "master" }],
                    next: "https://api.bitbucket.org/2.0/repositories/dmayhak/tai-framework/refs/branches?page2",
                });
            })
        );
        const branches = await host.listBranches(REPO);
        assert.deepEqual(branches, ["master", "develop"]);
    });
});

describe("createPullRequest", () => {
    it("posts the source/destination shape and maps the response", async () => {
        let capturedBody: unknown;
        const host = hostWith(
            stubFetch((method, url, body) => {
                assert.equal(method, "POST");
                assert.ok(url.endsWith("/repositories/dmayhak/tai-framework/pullrequests"));
                capturedBody = body;
                return json(PR_JSON);
            })
        );
        const pr = await host.createPullRequest({
            repo: REPO,
            title: "TAI-38 Dev: GitHost interface",
            sourceBranch: "TAI-37-git-host",
            destinationBranch: "master",
        });
        assert.equal(pr.id, "7");
        assert.equal(pr.sourceBranch, "TAI-37-git-host");
        assert.deepEqual(capturedBody, {
            title: "TAI-38 Dev: GitHost interface",
            source: { branch: { name: "TAI-37-git-host" } },
            destination: { branch: { name: "master" } },
        });
    });
});

describe("getPullRequest", () => {
    it("returns null, not a throw, for a missing PR", async () => {
        const host = hostWith(stubFetch(() => json({ error: { message: "not found" } }, 404)));
        const pr = await host.getPullRequest(REPO, toPullRequestId("999"));
        assert.equal(pr, null);
    });
});

describe("listPullRequests", () => {
    it("appends a ?state= query param mapped to Bitbucket's uppercase vocabulary", async () => {
        const host = hostWith(
            stubFetch((_method, url) => {
                assert.match(url, /\?state=MERGED$/);
                return json({ values: [PR_JSON] });
            })
        );
        const prs = await host.listPullRequests(REPO, "merged");
        assert.equal(prs.length, 1);
    });
});

describe("reviewPullRequest", () => {
    it("approve hits the /approve endpoint with no comment call when comment is omitted", async () => {
        const calls: string[] = [];
        const host = hostWith(
            stubFetch((method, url) => {
                calls.push(`${method} ${url}`);
                return json(undefined);
            })
        );
        await host.reviewPullRequest(REPO, toPullRequestId("7"), "approve");
        assert.equal(calls.length, 1);
        assert.ok(calls[0]?.endsWith("/pullrequests/7/approve"));
    });

    it("requestChanges hits /request-changes, then posts a comment when given", async () => {
        const calls: { url: string; body: unknown }[] = [];
        const host = hostWith(
            stubFetch((_method, url, body) => {
                calls.push({ url, body });
                return json(undefined);
            })
        );
        await host.reviewPullRequest(REPO, toPullRequestId("7"), "requestChanges", "please add tests");
        assert.equal(calls.length, 2);
        assert.ok(calls[0]?.url.endsWith("/pullrequests/7/request-changes"));
        assert.ok(calls[1]?.url.endsWith("/pullrequests/7/comments"));
        assert.deepEqual(calls[1]?.body, { content: { raw: "please add tests" } });
    });
});

describe("mergePullRequest — the §3.3 rejection-vs-connectivity split", () => {
    it("returns ok:true with the merged PR on success", async () => {
        const host = hostWith(stubFetch(() => json({ ...PR_JSON, state: "MERGED" })));
        const res = await host.mergePullRequest(REPO, toPullRequestId("7"), "squash");
        assert.equal(res.ok, true);
        assert.equal(res.ok === true ? res.pullRequest.state : undefined, "merged");
    });

    it("returns ok:false (never throws) when Bitbucket rejects the merge — e.g. not approved yet", async () => {
        const host = hostWith(
            stubFetch(() => json({ error: { message: "This pull request requires approval before merging." } }, 400))
        );
        const res = await host.mergePullRequest(REPO, toPullRequestId("7"));
        assert.equal(res.ok, false);
        assert.match(res.ok === false ? res.reason : "", /requires approval/);
    });

    it("throws StorageConnectivityError on a 5xx (Bitbucket down, not Bitbucket saying no)", async () => {
        const host = hostWith(stubFetch(() => new Response("bad gateway", { status: 502 })));
        await assert.rejects(
            () => host.mergePullRequest(REPO, toPullRequestId("7")),
            (err: unknown) => err instanceof StorageConnectivityError
        );
    });
});

describe("getCommitStatuses", () => {
    it("maps every status in the (paginated) list", async () => {
        const host = hostWith(
            stubFetch(() =>
                json({
                    values: [
                        { key: "build", name: "Typecheck & test", state: "SUCCESSFUL" },
                        { key: "deploy", name: "Deploy", state: "INPROGRESS" },
                    ],
                })
            )
        );
        const statuses = await host.getCommitStatuses(REPO, toCommitSha("abc123"));
        assert.deepEqual(
            statuses.map((s) => s.state),
            ["successful", "inProgress"]
        );
    });
});

describe("malformed RepoId", () => {
    it("throws a clear error rather than silently hitting a bad URL", async () => {
        const host = hostWith(stubFetch(() => json(REPO_JSON)));
        await assert.rejects(() => host.getRepository(toRepoId("not-a-workspace-slash-slug")), /Malformed RepoId/);
    });
});
