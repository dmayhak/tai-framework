import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StorageConnectivityError } from "../../storage/interface.js";
import { toRepoId, toPullRequestId, toCommitSha } from "../interface.js";
import { RestClient, apiTokenAuth, BitbucketRejection } from "./rest-client.js";
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

describe("listRepositories", () => {
    it("walks Bitbucket's `next`-URL pagination and maps every repo in the workspace", async () => {
        const host = hostWith(
            stubFetch((_method, url) => {
                if (url.includes("page2")) return json({ values: [{ ...REPO_JSON, name: "second-repo" }] });
                assert.ok(url.endsWith("/repositories/dmayhak"));
                return json({
                    values: [REPO_JSON],
                    next: "https://api.bitbucket.org/2.0/repositories/dmayhak?page2",
                });
            })
        );
        const repos = await host.listRepositories("dmayhak");
        assert.deepEqual(
            repos.map((r) => r.name),
            ["tai-framework", "second-repo"]
        );
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

describe("getCurrentUser", () => {
    // TAI-213/214 (found live, 2026-08-26): the real, mapped identity from GET /user — NOT
    // an email-based synthetic HumanRef, which can never match a PullRequestRef's own
    // reviewer/participant entries (Bitbucket users carry no email at all).
    it("hits /user and maps the response through toHumanRef", async () => {
        const host = hostWith(
            stubFetch((_method, url) => {
                assert.ok(url.endsWith("/user"));
                return json({ account_id: "712020:abc", display_name: "del", uuid: "{xyz}" });
            })
        );
        const me = await host.getCurrentUser();
        assert.equal(me.id, "712020:abc");
        assert.equal(me.displayName, "del");
        assert.equal(me.email, undefined);
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
    it("appends a state= query param mapped to Bitbucket's uppercase vocabulary, alongside fields=", async () => {
        const host = hostWith(
            stubFetch((_method, url) => {
                assert.match(url, /\?fields=%2Bvalues\.participants&state=MERGED$/);
                return json({ values: [PR_JSON] });
            })
        );
        const prs = await host.listPullRequests(REPO, "merged");
        assert.equal(prs.length, 1);
    });

    // TAI-213/214 (found live, 2026-08-26): without this, every PullRequestRef built from
    // listPullRequests reported empty `reviewers` regardless of real approval state —
    // Bitbucket's list-PRs endpoint omits `participants` by default, unlike the single-PR
    // endpoint. `fields=+values.participants` (percent-encoded to %2B — a bare `+` in a query
    // string means space) asks for it back explicitly.
    it("always requests fields=+values.participants, even with no state filter", async () => {
        const host = hostWith(
            stubFetch((_method, url) => {
                assert.match(url, /\?fields=%2Bvalues\.participants$/);
                return json({ values: [PR_JSON] });
            })
        );
        const prs = await host.listPullRequests(REPO);
        assert.equal(prs.length, 1);
    });

    it("maps a populated participants array into real reviewer/approval state, not the empty-array default", async () => {
        const host = hostWith(
            stubFetch(() =>
                json({
                    values: [
                        {
                            ...PR_JSON,
                            participants: [
                                {
                                    user: { account_id: "abc123", display_name: "Del" },
                                    role: "PARTICIPANT",
                                    state: "approved",
                                },
                            ],
                        },
                    ],
                })
            )
        );
        const prs = await host.listPullRequests(REPO);
        assert.equal(prs[0]?.reviewers.length, 1);
        assert.equal(prs[0]?.reviewers[0]?.status, "approved");
    });
});

describe("listPullRequests updatedSince (TAI-562)", () => {
    const at = (id: number, updated: string) => ({ ...PR_JSON, id, updated_on: updated, links: { html: { href: `https://bitbucket.org/dmayhak/tai-framework/pull-requests/${id}` } } });

    it("asks for the newest-updated first, and without updatedSince the query is unchanged", async () => {
        const urls: string[] = [];
        const host = hostWith(stubFetch((_m, url) => { urls.push(url); return json({ values: [at(1, "2026-10-10T00:00:00Z")] }); }));
        await host.listPullRequests(REPO, "merged", { updatedSince: "2026-10-01T00:00:00Z" });
        await host.listPullRequests(REPO, "merged");
        assert.match(urls[0]!, /state=MERGED&sort=-updated_on$/);
        assert.match(urls[1]!, /\?fields=%2Bvalues\.participants&state=MERGED$/, "no option, same query as before");
    });

    it("stops paging once a page reaches a PR older than updatedSince, and returns only the newer ones", async () => {
        const requested: string[] = [];
        const host = hostWith(
            stubFetch((_m, url) => {
                requested.push(url);
                if (url.includes("page=2")) assert.fail("page 2 must not be requested: page 1 already reached an older PR");
                return json({ values: [at(3, "2026-10-12T00:00:00Z"), at(2, "2026-10-09T00:00:00Z"), at(1, "2026-09-01T00:00:00Z")], next: "https://api.bitbucket.org/2.0/x?page=2" });
            })
        );
        const prs = await host.listPullRequests(REPO, "merged", { updatedSince: "2026-10-01T00:00:00Z" });
        assert.deepEqual(prs.map((p) => p.id), ["3", "2"]);
        assert.equal(requested.length, 1, "one page read, not the whole history");
    });

    it("keeps paging while every PR on the page is still inside the window", async () => {
        const requested: string[] = [];
        const host = hostWith(
            stubFetch((_m, url) => {
                requested.push(url);
                return url.includes("page=2")
                    ? json({ values: [at(1, "2026-10-02T00:00:00Z")] })
                    : json({ values: [at(2, "2026-10-12T00:00:00Z")], next: "https://api.bitbucket.org/2.0/x?page=2" });
            })
        );
        const prs = await host.listPullRequests(REPO, "merged", { updatedSince: "2026-10-01T00:00:00Z" });
        assert.deepEqual(prs.map((p) => p.id), ["2", "1"]);
        assert.equal(requested.length, 2);
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

describe("unapprovePullRequest (TAI-217/219)", () => {
    it("issues a DELETE to the /approve endpoint", async () => {
        const calls: { method: string; url: string }[] = [];
        const host = hostWith(
            stubFetch((method, url) => {
                calls.push({ method, url });
                return json(undefined);
            })
        );
        await host.unapprovePullRequest(REPO, toPullRequestId("7"));
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.method, "DELETE");
        assert.ok(calls[0]?.url.endsWith("/pullrequests/7/approve"));
    });

    // TAI-217/219 (found live, 2026-08-26): NOT idempotent, contrary to an earlier assumption
    // in this same PR — Bitbucket's DELETE .../approve returns 404 when there's nothing to
    // withdraw, which must propagate as a real BitbucketRejection, not be swallowed.
    it("propagates a real rejection when there's nothing to withdraw, rather than silently no-op'ing", async () => {
        const host = hostWith(stubFetch(() => json({ error: { message: "You haven't approved this pull request." } }, 404)));
        await assert.rejects(
            () => host.unapprovePullRequest(REPO, toPullRequestId("7")),
            (err: unknown) => err instanceof BitbucketRejection && err.reason === "You haven't approved this pull request."
        );
    });
});

describe("addInlineComment (TAI-207)", () => {
    it("posts to the same comments endpoint as addPullRequestComment, with an inline anchor", async () => {
        let capturedBody: unknown;
        const host = hostWith(
            stubFetch((method, url, body) => {
                assert.equal(method, "POST");
                assert.ok(url.endsWith("/repositories/dmayhak/tai-framework/pullrequests/7/comments"));
                capturedBody = body;
                return json({ id: 99, content: { raw: "found a bug" }, user: { account_id: "acct-1", display_name: "Del" }, created_on: "2026-08-28T00:00:00Z", updated_on: "2026-08-28T00:00:00Z" });
            })
        );
        const comment = await host.addInlineComment(REPO, toPullRequestId("7"), {
            path: "src/db.ts",
            line: 42,
            body: "found a bug",
        });
        assert.deepEqual(capturedBody, {
            content: { raw: "found a bug" },
            inline: { path: "src/db.ts", to: 42 },
        });
        assert.equal(comment.body, "found a bug");
    });

    // Bitbucket rejects (400) when `line` isn't actually part of the PR's diff -- a real,
    // expected rejection (a finding can point at a line the diff doesn't touch), not a
    // connectivity fault. Propagates as a BitbucketRejection, same as every other mutation
    // here -- callers (cli.ts's comment-findings) decide what to do about it, not this layer.
    it("propagates a real rejection (e.g. line not part of the diff) as a BitbucketRejection", async () => {
        const host = hostWith(stubFetch(() => json({ error: { message: "line 42 is not part of the diff" } }, 400)));
        await assert.rejects(
            () => host.addInlineComment(REPO, toPullRequestId("7"), { path: "src/db.ts", line: 42, body: "x" }),
            (err: unknown) => err instanceof BitbucketRejection && err.reason === "line 42 is not part of the diff"
        );
    });
});

describe("listPullRequestComments (TAI-383)", () => {
    const user = { account_id: "acct-1", display_name: "Del" };
    const c = (id: number, raw: string, extra: Record<string, unknown> = {}) => ({
        id,
        content: { raw },
        user,
        created_on: `2026-10-02T14:0${id}:00Z`,
        updated_on: `2026-10-02T14:0${id}:00Z`,
        ...extra,
    });

    it("walks the `next`-URL pagination and maps author, body and times", async () => {
        const host = hostWith(
            stubFetch((method, url) => {
                assert.equal(method, "GET");
                if (url.includes("page2")) return json({ values: [c(2, "second")] });
                assert.ok(url.includes("/repositories/dmayhak/tai-framework/pullrequests/7/comments"));
                return json({
                    values: [c(1, "first")],
                    next: "https://api.bitbucket.org/2.0/repositories/dmayhak/tai-framework/pullrequests/7/comments?page2",
                });
            })
        );
        const comments = await host.listPullRequestComments(REPO, toPullRequestId("7"));
        assert.deepEqual(comments.map((x) => x.body), ["first", "second"]);
        assert.equal(comments[0]?.author.displayName, "Del");
        assert.equal(comments[0]?.createdAt, "2026-10-02T14:01:00Z");
    });

    it("carries an inline anchor (path + destination line) when the comment has one", async () => {
        const host = hostWith(stubFetch(() => json({ values: [c(1, "bug here", { inline: { path: "src/db.ts", to: 42, from: null } }), c(2, "general")] })));
        const [inline, general] = await host.listPullRequestComments(REPO, toPullRequestId("7"));
        assert.deepEqual(inline?.inline, { path: "src/db.ts", line: 42 });
        assert.equal(general?.inline, undefined);
    });

    it("leaves out deleted comments", async () => {
        const host = hostWith(stubFetch(() => json({ values: [c(1, "gone", { deleted: true }), c(2, "kept")] })));
        const comments = await host.listPullRequestComments(REPO, toPullRequestId("7"));
        assert.deepEqual(comments.map((x) => x.body), ["kept"]);
    });
});

describe("listPullRequestActivity (TAI-462)", () => {
    const user = { account_id: "acct-1", display_name: "Del" };
    const upd = (date: string, hash: string) => ({ update: { date, state: "OPEN", source: { commit: { hash } } }, pull_request: {} });

    it("returns updates, approvals and change requests oldest first, across pages, leaving other kinds out", async () => {
        const host = hostWith(
            stubFetch((method, url) => {
                assert.equal(method, "GET");
                if (url.includes("page2")) return json({ values: [upd("2026-10-08T10:00:00Z", "aaa111")] });
                assert.ok(url.includes("/repositories/dmayhak/tai-framework/pullrequests/7/activity"));
                return json({
                    // Bitbucket's own order: newest first.
                    values: [
                        { changes_requested: { date: "2026-10-08T10:05:00Z", user }, pull_request: {} },
                        { comment: { id: 1, created_on: "2026-10-08T10:04:00Z" }, pull_request: {} },
                        upd("2026-10-08T10:03:00Z", "bbb222"),
                        { approval: { date: "2026-10-08T10:02:00Z", user }, pull_request: {} },
                    ],
                    next: "https://api.bitbucket.org/2.0/repositories/dmayhak/tai-framework/pullrequests/7/activity?page2",
                });
            })
        );
        const activity = await host.listPullRequestActivity(REPO, toPullRequestId("7"));
        assert.deepEqual(
            activity.map((a) => (a.kind === "update" ? `update ${a.sourceCommit}` : `${a.kind} ${a.human.displayName}`)),
            ["update aaa111", "approval Del", "update bbb222", "changesRequested Del"]
        );
    });

    it("skips an update entry that carries no source commit", async () => {
        const host = hostWith(stubFetch(() => json({ values: [{ update: { date: "2026-10-08T10:00:00Z", source: { commit: null } }, pull_request: {} }] })));
        assert.deepEqual(await host.listPullRequestActivity(REPO, toPullRequestId("7")), []);
    });
});

describe("mergePullRequest — the §3.3 rejection-vs-connectivity split", () => {
    it("returns ok:true with the merged PR on success", async () => {
        const host = hostWith(stubFetch(() => json({ ...PR_JSON, state: "MERGED" })));
        const res = await host.mergePullRequest(REPO, toPullRequestId("7"), "squash");
        assert.equal(res.ok, true);
        assert.equal(res.ok === true ? res.pullRequest.state : undefined, "merged");
    });

    it("always asks Bitbucket to close the source branch (brief §6 — a branch is scoped to one work unit)", async () => {
        let capturedBody: unknown;
        const host = hostWith(
            stubFetch((_method, _url, body) => {
                capturedBody = body;
                return json({ ...PR_JSON, state: "MERGED" });
            })
        );
        await host.mergePullRequest(REPO, toPullRequestId("7"), "squash");
        assert.deepEqual(capturedBody, { merge_strategy: "squash", close_source_branch: true });
    });

    it("sets close_source_branch even with no explicit strategy", async () => {
        let capturedBody: unknown;
        const host = hostWith(
            stubFetch((_method, _url, body) => {
                capturedBody = body;
                return json({ ...PR_JSON, state: "MERGED" });
            })
        );
        await host.mergePullRequest(REPO, toPullRequestId("7"));
        assert.deepEqual(capturedBody, { close_source_branch: true });
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

describe("createCommitStatus (TAI-534)", () => {
    it("posts a build status on the commit in Bitbucket's own spelling, and returns it mapped back", async () => {
        const calls: { url: string; method: string; body: unknown }[] = [];
        const host = hostWith(
            stubFetch((method, url, body) => {
                calls.push({ url, method, body });
                return json({ key: "tai-check", name: "TAI check", state: "SUCCESSFUL", url: "https://example.test/pr/7" });
            })
        );
        const created = await host.createCommitStatus(REPO, toCommitSha("abc123def456"), {
            key: "tai-check",
            name: "TAI check",
            state: "successful",
            url: "https://example.test/pr/7",
            description: "passed in 30s: npm test",
        });
        assert.equal(calls.length, 1);
        assert.match(calls[0]!.url, /\/commit\/abc123def456\/statuses\/build$/);
        assert.equal(calls[0]!.method, "POST");
        assert.deepEqual(calls[0]!.body, { key: "tai-check", name: "TAI check", state: "SUCCESSFUL", url: "https://example.test/pr/7", description: "passed in 30s: npm test" });
        assert.deepEqual(created, { key: "tai-check", name: "TAI check", state: "successful", url: "https://example.test/pr/7" });
    });

    it("spells a failed result FAILED and leaves out a description that was not given", async () => {
        let body: Record<string, unknown> = {};
        const host = hostWith(
            stubFetch((_method, _url, sent) => {
                body = sent as Record<string, unknown>;
                return json({ key: "tai-check", name: "TAI check", state: "FAILED" });
            })
        );
        const created = await host.createCommitStatus(REPO, toCommitSha("abc123def456"), { key: "tai-check", name: "TAI check", state: "failed", url: "https://example.test/pr/7" });
        assert.equal(body["state"], "FAILED");
        assert.ok(!("description" in body));
        assert.equal(created.state, "failed");
    });
});

