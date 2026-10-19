import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StorageConnectivityError, toHumanId } from "../../storage/interface.js";
import { toRepoId, toPullRequestId, toCommitSha } from "../interface.js";
import { RestClient, tokenAuth, GitHubRejection, nextLink } from "./rest-client.js";
import { createGitHubGitHost } from "./git-host.js";
import { SELF_REVIEW_MARKER } from "./mappers.js";

interface Call {
    readonly method: string;
    readonly url: string;
    readonly body: unknown;
    readonly headers: Record<string, string>;
}

/** A fetch stub that replays canned responses and records every call, offline. */
function stubFetch(handler: (method: string, url: string, body: unknown) => Response | Promise<Response>, calls: Call[] = []) {
    return ((input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(init.body as string) : undefined;
        const method = (init?.method ?? "GET") as string;
        calls.push({ method, url: String(input), body, headers: (init?.headers ?? {}) as Record<string, string> });
        return Promise.resolve(handler(method, String(input), body));
    }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}

function hostWith(fetchImpl: typeof fetch, allowSelfReview = false) {
    const client = new RestClient({ auth: tokenAuth("tok"), fetchImpl });
    return createGitHubGitHost(client, { allowSelfReview });
}

const API = "https://api.github.com";
const REPO = toRepoId("octo/widgets");
const PR_ID = toPullRequestId("5");

const REPO_JSON = { full_name: "octo/widgets", name: "widgets", default_branch: "main", html_url: "https://github.com/octo/widgets" };

const PR_JSON = {
    number: 5,
    title: "TAI-1 - TAI-2 - thing",
    body: "desc",
    state: "open",
    merged_at: null,
    head: { ref: "TAI-1-thing", sha: "head2", repo: { full_name: "octo/widgets" } },
    base: { ref: "main" },
    user: { login: "author" },
    requested_reviewers: [],
    created_at: "2026-10-17T10:00:00Z",
    updated_at: "2026-10-17T11:00:00Z",
    html_url: "https://github.com/octo/widgets/pull/5",
};

const path = (url: string): string => url.replace(API, "").split("?")[0]!;

describe("rest client", () => {
    it("sends the bearer token and GitHub's API headers", async () => {
        const calls: Call[] = [];
        const host = hostWith(stubFetch(() => json({ login: "me", name: "Me" }), calls));
        const me = await host.getCurrentUser();
        assert.equal(me.id, "me");
        assert.equal(me.displayName, "Me");
        assert.equal(calls[0]!.headers["Authorization"], "Bearer tok");
        assert.equal(calls[0]!.headers["Accept"], "application/vnd.github+json");
    });

    it("turns a 4xx into a GitHubRejection with GitHub's message and details", async () => {
        const host = hostWith(stubFetch(() => json({ message: "Validation Failed", errors: [{ message: "No commits between main and x" }] }, 422)));
        await assert.rejects(
            host.createPullRequest({ repo: REPO, title: "t", sourceBranch: "x", destinationBranch: "main" }),
            (err: unknown) => err instanceof GitHubRejection && err.reason === "Validation Failed: No commits between main and x"
        );
    });

    it("turns a 5xx or a network failure into a StorageConnectivityError", async () => {
        await assert.rejects(hostWith(stubFetch(() => json({}, 502))).getCurrentUser(), StorageConnectivityError);
        const offline = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
        await assert.rejects(hostWith(offline).getCurrentUser(), StorageConnectivityError);
    });

    it("treats 429 and a 403 with no requests left as a temporary failure, and a plain 403 as a refusal", async () => {
        await assert.rejects(hostWith(stubFetch(() => json({ message: "slow down" }, 429))).getCurrentUser(), StorageConnectivityError);
        await assert.rejects(
            hostWith(stubFetch(() => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" }))).getCurrentUser(),
            StorageConnectivityError
        );
        await assert.rejects(hostWith(stubFetch(() => json({ message: "Must have admin rights" }, 403))).getCurrentUser(), GitHubRejection);
    });

    it("reads the next page from the Link header", () => {
        assert.equal(
            nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"'),
            "https://api.github.com/x?page=2"
        );
        assert.equal(nextLink('<https://api.github.com/x?page=1>; rel="prev"'), undefined);
        assert.equal(nextLink(null), undefined);
    });
});

describe("repositories and branches", () => {
    it("getRepository maps a found repository and returns null on a 404", async () => {
        assert.equal((await hostWith(stubFetch(() => json(REPO_JSON))).getRepository(REPO))?.defaultBranch, "main");
        assert.equal(await hostWith(stubFetch(() => json({ message: "Not Found" }, 404))).getRepository(REPO), null);
    });

    it("listRepositories walks an organization's pages", async () => {
        const host = hostWith(
            stubFetch((_m, url) => {
                if (url.includes("page=2")) return json([{ ...REPO_JSON, name: "second" }]);
                assert.equal(path(url), "/orgs/octo/repos");
                return json([REPO_JSON], 200, { link: `<${API}/orgs/octo/repos?per_page=100&page=2>; rel="next"` });
            })
        );
        assert.deepEqual(
            (await host.listRepositories("octo")).map((r) => r.name),
            ["widgets", "second"]
        );
    });

    it("listRepositories falls back to the token owner's own repositories when the owner is not an organization", async () => {
        const host = hostWith(
            stubFetch((_m, url) => {
                if (path(url) === "/orgs/me/repos") return json({ message: "Not Found" }, 404);
                if (path(url) === "/user") return json({ login: "me" });
                assert.equal(path(url), "/user/repos");
                assert.ok(url.includes("affiliation=owner"));
                return json([REPO_JSON]);
            })
        );
        assert.equal((await host.listRepositories("me")).length, 1);
    });

    it("listRepositories reads another user's public repositories", async () => {
        const host = hostWith(
            stubFetch((_m, url) => {
                if (path(url) === "/orgs/someone/repos") return json({ message: "Not Found" }, 404);
                if (path(url) === "/user") return json({ login: "me" });
                assert.equal(path(url), "/users/someone/repos");
                return json([REPO_JSON]);
            })
        );
        assert.equal((await host.listRepositories("someone")).length, 1);
    });

    it("listBranches stops at the limit", async () => {
        const host = hostWith(stubFetch(() => json([{ name: "main" }, { name: "a" }, { name: "b" }])));
        assert.deepEqual(await host.listBranches(REPO, 2), ["main", "a"]);
    });
});

describe("createPullRequest", () => {
    it("opens the PR, then requests the reviewers by login, leaving out the author", async () => {
        const calls: Call[] = [];
        const host = hostWith(
            stubFetch((method, url) => {
                if (path(url) === "/repos/octo/widgets/pulls") return json(PR_JSON, 201);
                assert.equal(path(url), "/repos/octo/widgets/pulls/5/requested_reviewers");
                return json({ ...PR_JSON, requested_reviewers: [{ login: "bob" }] }, 201);
            }, calls)
        );
        const pr = await host.createPullRequest({
            repo: REPO,
            title: "t",
            description: "d",
            sourceBranch: "TAI-1-thing",
            destinationBranch: "main",
            reviewers: [
                { id: toHumanId("bob"), displayName: "Bob" },
                { id: toHumanId("author"), displayName: "Author" },
            ],
        });
        assert.deepEqual(calls[0]!.body, { title: "t", head: "TAI-1-thing", base: "main", body: "d" });
        assert.deepEqual(calls[1]!.body, { reviewers: ["bob"] });
        assert.deepEqual(
            pr.reviewers.map((r) => [r.human.id, r.status]),
            [["bob", "pending"]]
        );
    });

    it("leaves out the author whatever the case of the login on the page (PR 215 review)", async () => {
        const calls: Call[] = [];
        const host = hostWith(stubFetch((_m, url) => (path(url).endsWith("/requested_reviewers") ? json(PR_JSON, 201) : json(PR_JSON, 201)), calls));
        await host.createPullRequest({
            repo: REPO,
            title: "t",
            sourceBranch: "x",
            destinationBranch: "main",
            reviewers: [
                { id: toHumanId("bob"), displayName: "Bob" },
                { id: toHumanId("AUTHOR"), displayName: "Author" },
            ],
        });
        assert.deepEqual(calls[1]!.body, { reviewers: ["bob"] });
    });

    it("keeps the PR when the reviewer request is refused", async () => {
        const host = hostWith(
            stubFetch((_m, url) =>
                path(url).endsWith("/requested_reviewers") ? json({ message: "Reviews may only be requested from collaborators." }, 422) : json(PR_JSON, 201)
            )
        );
        const pr = await host.createPullRequest({
            repo: REPO,
            title: "t",
            sourceBranch: "x",
            destinationBranch: "main",
            reviewers: [{ id: toHumanId("stranger"), displayName: "S" }],
        });
        assert.equal(pr.id, "5");
    });
});

describe("getPullRequest and listPullRequests", () => {
    it("getPullRequest reads the reviews too, and returns null on a 404", async () => {
        const host = hostWith(
            stubFetch((_m, url) => {
                if (path(url).endsWith("/reviews")) return json([{ id: 1, user: { login: "bob" }, state: "APPROVED", commit_id: "head2", submitted_at: "2026-10-17T11:00:00Z" }]);
                return json(PR_JSON);
            })
        );
        const pr = await host.getPullRequest(REPO, PR_ID);
        assert.deepEqual(
            pr?.reviewers.map((r) => [r.human.id, r.status]),
            [["bob", "approved"]]
        );
        assert.equal(await hostWith(stubFetch(() => json({ message: "Not Found" }, 404))).getPullRequest(REPO, PR_ID), null);
    });

    it("lists merged PRs from the closed ones, without reading their reviews", async () => {
        const calls: Call[] = [];
        const host = hostWith(
            stubFetch(
                () =>
                    json([
                        { ...PR_JSON, number: 1, state: "closed", merged_at: "2026-10-16T00:00:00Z" },
                        { ...PR_JSON, number: 2, state: "closed", merged_at: null },
                    ]),
                calls
            )
        );
        const prs = await host.listPullRequests(REPO, "merged");
        assert.deepEqual(
            prs.map((p) => [p.id, p.state]),
            [["1", "merged"]]
        );
        assert.ok(calls[0]!.url.includes("state=closed"));
        assert.equal(calls.length, 1);
    });

    it("with updatedSince reads newest-updated first and stops at the first page that reaches an older PR", async () => {
        const calls: Call[] = [];
        const host = hostWith(
            stubFetch(
                (_m, url) => {
                    if (path(url).endsWith("/reviews")) return json([]);
                    return json(
                        [
                            { ...PR_JSON, number: 9, updated_at: "2026-10-17T00:00:00Z" },
                            { ...PR_JSON, number: 8, updated_at: "2026-10-01T00:00:00Z" },
                        ],
                        200,
                        { link: `<${API}/repos/octo/widgets/pulls?page=2>; rel="next"` }
                    );
                },
                calls
            )
        );
        const prs = await host.listPullRequests(REPO, "open", { updatedSince: "2026-10-10T00:00:00Z" });
        assert.deepEqual(
            prs.map((p) => p.id),
            ["9"]
        );
        assert.ok(calls[0]!.url.includes("sort=updated") && calls[0]!.url.includes("direction=desc"));
        assert.equal(calls.filter((c) => path(c.url) === "/repos/octo/widgets/pulls").length, 1);
    });
});

describe("reviewPullRequest", () => {
    function reviewHost(login: string, allowSelfReview: boolean, calls: Call[]) {
        return hostWith(
            stubFetch((method, url) => {
                if (path(url) === "/user") return json({ login });
                if (method === "GET") return json(PR_JSON);
                return json({ id: 1 });
            }, calls),
            allowSelfReview
        );
    }

    it("approves with one call carrying the comment as the body", async () => {
        const calls: Call[] = [];
        await reviewHost("bob", false, calls).reviewPullRequest(REPO, PR_ID, "approve", "LGTM");
        const post = calls.find((c) => c.method === "POST")!;
        assert.equal(path(post.url), "/repos/octo/widgets/pulls/5/reviews");
        assert.deepEqual(post.body, { event: "APPROVE", body: "LGTM" });
    });

    it("a change request gets a default body, since GitHub requires one", async () => {
        const calls: Call[] = [];
        await reviewHost("bob", false, calls).reviewPullRequest(REPO, PR_ID, "requestChanges");
        assert.deepEqual(calls.find((c) => c.method === "POST")!.body, { event: "REQUEST_CHANGES", body: "Changes requested." });
    });

    it("refuses the author's own approval, naming TAI_PR_SELF_REVIEW, when self-review is off", async () => {
        const calls: Call[] = [];
        await assert.rejects(reviewHost("author", false, calls).reviewPullRequest(REPO, PR_ID, "approve"), /TAI_PR_SELF_REVIEW/);
        assert.equal(calls.filter((c) => c.method === "POST").length, 0);
    });

    it("records the author's approval as a stamped COMMENT review on the head commit when self-review is on", async () => {
        const calls: Call[] = [];
        await reviewHost("author", true, calls).reviewPullRequest(REPO, PR_ID, "approve", "Checked it.");
        assert.deepEqual(calls.find((c) => c.method === "POST")!.body, {
            event: "COMMENT",
            commit_id: "head2",
            body: `${SELF_REVIEW_MARKER}\n\nChecked it.`,
        });
    });

    it("refuses the author's own change request either way", async () => {
        await assert.rejects(reviewHost("author", true, []).reviewPullRequest(REPO, PR_ID, "requestChanges"), GitHubRejection);
    });
});

describe("unapprovePullRequest", () => {
    it("dismisses the current human's latest approval", async () => {
        const calls: Call[] = [];
        const host = hostWith(
            stubFetch((method, url) => {
                if (path(url) === "/user") return json({ login: "bob" });
                if (path(url).endsWith("/reviews"))
                    return json([
                        { id: 1, user: { login: "bob" }, state: "APPROVED", commit_id: "a", submitted_at: "2026-10-17T10:00:00Z" },
                        { id: 2, user: { login: "bob" }, state: "APPROVED", commit_id: "b", submitted_at: "2026-10-17T11:00:00Z" },
                    ]);
                if (method === "GET") return json(PR_JSON);
                return json({});
            }, calls)
        );
        await host.unapprovePullRequest(REPO, PR_ID);
        const put = calls.find((c) => c.method === "PUT")!;
        assert.equal(path(put.url), "/repos/octo/widgets/pulls/5/reviews/2/dismissals");
        assert.deepEqual(put.body, { message: "Approval withdrawn.", event: "DISMISS" });
    });

    it("edits a self-review to say it was withdrawn", async () => {
        const calls: Call[] = [];
        const host = hostWith(
            stubFetch((method, url) => {
                if (path(url) === "/user") return json({ login: "author" });
                if (path(url).endsWith("/reviews"))
                    return json([{ id: 3, user: { login: "author" }, state: "COMMENTED", body: SELF_REVIEW_MARKER, commit_id: "head2", submitted_at: "2026-10-17T10:00:00Z" }]);
                if (method === "GET") return json(PR_JSON);
                return json({});
            }, calls),
            true
        );
        await host.unapprovePullRequest(REPO, PR_ID);
        const put = calls.find((c) => c.method === "PUT")!;
        assert.equal(path(put.url), "/repos/octo/widgets/pulls/5/reviews/3");
        assert.deepEqual(put.body, { body: "Self-review: withdrawn" });
    });

    it("throws when there is no approval to withdraw", async () => {
        const host = hostWith(
            stubFetch((_m, url) => {
                if (path(url) === "/user") return json({ login: "bob" });
                if (path(url).endsWith("/reviews")) return json([]);
                return json(PR_JSON);
            })
        );
        await assert.rejects(host.unapprovePullRequest(REPO, PR_ID), GitHubRejection);
    });
});

describe("comments", () => {
    it("posts a general comment as an issue comment", async () => {
        const calls: Call[] = [];
        const host = hostWith(stubFetch(() => json({ id: 7, user: { login: "bob" }, body: "hi", created_at: "t", updated_at: "t" }, 201), calls));
        const c = await host.addPullRequestComment(REPO, PR_ID, "hi");
        assert.equal(path(calls[0]!.url), "/repos/octo/widgets/issues/5/comments");
        assert.equal(c.id, "7");
    });

    it("anchors an inline comment to the head commit's right side", async () => {
        const calls: Call[] = [];
        const host = hostWith(
            stubFetch((method) => (method === "GET" ? json(PR_JSON) : json({ id: 8, user: { login: "bob" }, body: "x", path: "a.ts", line: 3, created_at: "t", updated_at: "t" }, 201)), calls)
        );
        await host.addInlineComment(REPO, PR_ID, { path: "a.ts", line: 3, body: "x" });
        assert.deepEqual(calls.find((c) => c.method === "POST")!.body, { body: "x", commit_id: "head2", path: "a.ts", line: 3, side: "RIGHT" });
    });

    it("lists issue comments, inline comments and review bodies, oldest first", async () => {
        const host = hostWith(
            stubFetch((_m, url) => {
                if (path(url).endsWith("/issues/5/comments")) return json([{ id: 1, user: { login: "a" }, body: "general", created_at: "2026-10-17T12:00:00Z", updated_at: "2026-10-17T12:00:00Z" }]);
                if (path(url).endsWith("/pulls/5/comments"))
                    return json([{ id: 2, user: { login: "b" }, body: "inline", path: "x.ts", line: 4, created_at: "2026-10-17T10:00:00Z", updated_at: "2026-10-17T10:00:00Z" }]);
                return json([
                    { id: 3, user: { login: "c" }, state: "APPROVED", body: "review body", commit_id: "h", submitted_at: "2026-10-17T11:00:00Z" },
                    { id: 4, user: { login: "c" }, state: "APPROVED", body: "", commit_id: "h", submitted_at: "2026-10-17T11:30:00Z" },
                ]);
            })
        );
        const comments = await host.listPullRequestComments(REPO, PR_ID);
        assert.deepEqual(
            comments.map((c) => c.body),
            ["inline", "review body", "general"]
        );
        assert.deepEqual(comments[0]!.inline, { path: "x.ts", line: 4 });
    });
});

describe("listPullRequestActivity", () => {
    it("is built from the reviews, each decision preceded by its commit", async () => {
        const host = hostWith(
            stubFetch((_m, url) =>
                path(url).endsWith("/reviews")
                    ? json([{ id: 1, user: { login: "bob" }, state: "APPROVED", commit_id: "c1", submitted_at: "2026-10-17T10:00:00Z" }])
                    : json(PR_JSON)
            )
        );
        const activity = await host.listPullRequestActivity(REPO, PR_ID);
        assert.deepEqual(
            activity.map((a) => a.kind),
            ["update", "approval"]
        );
    });
});

describe("mergePullRequest", () => {
    it("merges with a merge commit by default and deletes the same-repo source branch", async () => {
        const calls: Call[] = [];
        const host = hostWith(
            stubFetch((method) => {
                if (method === "PUT") return json({ merged: true, sha: "m" });
                if (method === "DELETE") return json(undefined, 204);
                return json({ ...PR_JSON, state: "closed", merged_at: "2026-10-17T12:00:00Z" });
            }, calls)
        );
        const result = await host.mergePullRequest(REPO, PR_ID);
        assert.equal(result.ok, true);
        assert.equal(result.ok && result.pullRequest.state, "merged");
        assert.deepEqual(calls.find((c) => c.method === "PUT")!.body, { merge_method: "merge" });
        assert.equal(path(calls.find((c) => c.method === "DELETE")!.url), "/repos/octo/widgets/git/refs/heads/TAI-1-thing");
    });

    it("checks the head and deletes the branch when the repo id is typed in another case (PR 215 review)", async () => {
        const calls: Call[] = [];
        const host = hostWith(
            stubFetch((method, url) => {
                if (url.includes("/git/ref/heads/")) return json({ object: { sha: "newer" } });
                if (method === "GET") return json(PR_JSON);
                return json({ merged: true });
            }, calls)
        );
        const result = await host.mergePullRequest(toRepoId("Octo/Widgets"), PR_ID, undefined, { expectedHead: toCommitSha("head2") });
        assert.equal(result.ok, false, "the guard ran");
        assert.equal(calls.some((c) => c.method === "PUT"), false);
    });

    it("maps squash and fastForward onto GitHub's merge methods", async () => {
        for (const [strategy, method] of [
            ["squash", "squash"],
            ["fastForward", "rebase"],
        ] as const) {
            const calls: Call[] = [];
            const host = hostWith(stubFetch((m) => (m === "PUT" ? json({ merged: true }) : json({ ...PR_JSON, head: { ...PR_JSON.head, repo: null } })), calls));
            await host.mergePullRequest(REPO, PR_ID, strategy);
            assert.deepEqual(calls.find((c) => c.method === "PUT")!.body, { merge_method: method });
            assert.equal(calls.some((c) => c.method === "DELETE"), false, "a branch from a fork is never deleted");
        }
    });

    it("with an expected head, refuses when the branch has moved, without merging (TAI-585)", async () => {
        const calls: Call[] = [];
        const host = hostWith(
            stubFetch((method, url) => {
                if (path(url) === "/repos/octo/widgets/git/ref/heads/TAI-1-thing") return json({ object: { sha: "newer" } });
                if (method === "GET") return json(PR_JSON);
                return json({ merged: true });
            }, calls)
        );
        const result = await host.mergePullRequest(REPO, PR_ID, undefined, { expectedHead: toCommitSha("head2") });
        assert.equal(result.ok, false);
        assert.match(result.ok ? "" : result.reason, /branch has moved to newer since head2/);
        assert.equal(calls.some((c) => c.method === "PUT"), false);
    });

    it("with an expected head the branch still has, merges and asks GitHub to hold it to that commit", async () => {
        const calls: Call[] = [];
        const host = hostWith(
            stubFetch((method, url) => {
                if (path(url) === "/repos/octo/widgets/git/ref/heads/TAI-1-thing") return json({ object: { sha: "head2" } });
                if (method === "PUT") return json({ merged: true });
                if (method === "DELETE") return json(undefined, 204);
                return json(PR_JSON);
            }, calls)
        );
        const result = await host.mergePullRequest(REPO, PR_ID, undefined, { expectedHead: toCommitSha("head2") });
        assert.equal(result.ok, true);
        assert.deepEqual(calls.find((c) => c.method === "PUT")!.body, { merge_method: "merge", sha: "head2" });
    });

    it("returns GitHub's reason when the merge is refused", async () => {
        const host = hostWith(stubFetch(() => json({ message: "Pull Request is not mergeable" }, 405)));
        assert.deepEqual(await host.mergePullRequest(REPO, PR_ID), { ok: false, reason: "Pull Request is not mergeable" });
    });

    it("still reports the merge when the branch cannot be deleted", async () => {
        const host = hostWith(
            stubFetch((method) => {
                if (method === "PUT") return json({ merged: true });
                if (method === "DELETE") return json({ message: "Reference does not exist" }, 422);
                return json(PR_JSON);
            })
        );
        assert.equal((await host.mergePullRequest(REPO, PR_ID)).ok, true);
    });
});

describe("commit statuses", () => {
    it("reads both commit statuses and check runs", async () => {
        const host = hostWith(
            stubFetch((_m, url) => {
                if (path(url).endsWith("/status")) return json({ statuses: [{ context: "tai/check", state: "success", description: "TAI check" }] });
                assert.equal(path(url), "/repos/octo/widgets/commits/abc/check-runs");
                return json({ total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "failure" }] });
            })
        );
        const statuses = await host.getCommitStatuses(REPO, toCommitSha("abc"));
        assert.deepEqual(
            statuses.map((s) => [s.key, s.state]),
            [
                ["tai/check", "successful"],
                ["test", "failed"],
            ]
        );
    });

    it("reads every page of the combined status, so a later failing context still counts (PR 215 review)", async () => {
        const host = hostWith(
            stubFetch((_m, url) => {
                if (path(url).endsWith("/check-runs")) return json({ total_count: 0, check_runs: [] });
                if (url.includes("page=2")) return json({ statuses: [{ context: "late", state: "failure" }] });
                return json({ statuses: [{ context: "early", state: "success" }] }, 200, { link: `<${API}/repos/octo/widgets/commits/abc/status?per_page=100&page=2>; rel="next"` });
            })
        );
        assert.deepEqual(
            (await host.getCommitStatuses(REPO, toCommitSha("abc"))).map((s) => [s.key, s.state]),
            [
                ["early", "successful"],
                ["late", "failed"],
            ]
        );
    });

    it("a rate-limited check-runs read is a connectivity failure, not the permission fallback (PR 215 review)", async () => {
        const calls: Call[] = [];
        const host = hostWith(
            stubFetch((_m, url) => (path(url).endsWith("/status") ? json({ statuses: [] }) : json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" })), calls)
        );
        await assert.rejects(host.getCommitStatuses(REPO, toCommitSha("abc")), StorageConnectivityError);
        assert.equal(calls.some((c) => c.url.includes("/actions/runs")), false);
    });

    it("reads the Actions workflow runs when the token cannot read check runs (TAI-585)", async () => {
        const host = hostWith(
            stubFetch((_m, url) => {
                if (path(url).endsWith("/status")) return json({ statuses: [] });
                if (path(url).endsWith("/check-runs")) return json({ message: "Resource not accessible by personal access token" }, 403);
                assert.equal(path(url), "/repos/octo/widgets/actions/runs");
                assert.ok(url.includes("head_sha=abc"));
                return json({ total_count: 1, workflow_runs: [{ name: "CI", status: "completed", conclusion: "failure", html_url: "https://x" }] });
            })
        );
        assert.deepEqual(await host.getCommitStatuses(REPO, toCommitSha("abc")), [{ key: "CI", name: "CI", state: "failed", url: "https://x" }]);
    });

    it("names the Actions permission when neither can be read, rather than skipping CI", async () => {
        const host = hostWith(
            stubFetch((_m, url) => (path(url).endsWith("/status") ? json({ statuses: [] }) : json({ message: "Resource not accessible by personal access token" }, 403)))
        );
        await assert.rejects(host.getCommitStatuses(REPO, toCommitSha("abc")), /Actions: read/);
    });

    it("posts a status with the key as its context", async () => {
        const calls: Call[] = [];
        const host = hostWith(stubFetch(() => json({ context: "tai-check", state: "success", description: "ran by del", target_url: "https://x" }, 201), calls));
        const created = await host.createCommitStatus(REPO, toCommitSha("abc"), {
            key: "tai-check",
            name: "TAI check",
            state: "successful",
            url: "https://x",
            description: "ran by del",
        });
        assert.equal(path(calls[0]!.url), "/repos/octo/widgets/statuses/abc");
        assert.deepEqual(calls[0]!.body, { state: "success", context: "tai-check", target_url: "https://x", description: "ran by del" });
        assert.deepEqual(created, { key: "tai-check", name: "TAI check", state: "successful", url: "https://x" });
    });
});

describe("RepoId", () => {
    it("refuses a malformed id", async () => {
        await assert.rejects(hostWith(stubFetch(() => json({}))).getRepository(toRepoId("nope")), /owner\/repo/);
    });
});
