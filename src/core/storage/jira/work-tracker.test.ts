import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status } from "../../schema/story-schema.js";
import { StorageConnectivityError, toIssueKey, toHumanId } from "../interface.js";
import { RestClient, apiTokenAuth } from "./rest-client.js";
import { createJiraWorkTracker } from "./work-tracker.js";

const PERSONA_FIELD = "customfield_10105";

/** A fetch stub that replays canned responses, so these stay offline and deterministic. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    return ((input: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(handler(String(input), init ?? {}))) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function trackerWith(fetchImpl: typeof fetch) {
    const client = new RestClient({
        siteUrl: "https://example.atlassian.net",
        auth: apiTokenAuth("a@b.c", "token"),
        fetchImpl,
    });
    return createJiraWorkTracker(client, { personaFieldId: PERSONA_FIELD });
}

describe("error model — the §3.3 / §3.6 split", () => {
    /**
     * REGRESSION. Jira answers `PUT /issue/{key}/assignee` with 404 when the accountId
     * doesn't exist. An earlier version of the client treated 404 as a blanket "not found"
     * and THREW, which meant a genuine backend rejection escaped as an exception instead of
     * `{ok: false}` — collapsing the exact distinction brief §3.3 (escalate, no retry) and
     * §3.6 (queue and replay) depend on. Found by driving the backend against live Jira;
     * no unit test would have caught it, because it hinges on which status code Jira picks.
     */
    it("returns ok:false when Jira 404s an invalid assignee (does NOT throw)", async () => {
        const wt = trackerWith(
            stubFetch((url) => {
                if (url.includes("/assignee")) {
                    return json(
                        { errorMessages: ["Specified user does not exist or you do not have required permissions"] },
                        404
                    );
                }
                throw new Error(`unexpected call: ${url}`);
            })
        );

        const res = await wt.assignIssue(toIssueKey("TAI-21"), {
            id: toHumanId("nope"),
            displayName: "Nobody",
        });

        assert.equal(res.ok, false);
        assert.match(res.ok === false ? res.reason : "", /Specified user does not exist/);
    });

    it("surfaces Jira's rejection reason verbatim (it gets journaled and shown to a human)", async () => {
        const wt = trackerWith(
            stubFetch(() => json({ errors: { summary: "Summary is required." } }, 400))
        );
        const res = await wt.assignIssue(toIssueKey("TAI-1"), null);
        assert.equal(res.ok, false);
        assert.equal(res.ok === false ? res.reason : "", "summary: Summary is required.");
    });

    it("throws StorageConnectivityError on a 5xx (Atlassian down, not Atlassian saying no)", async () => {
        const wt = trackerWith(stubFetch(() => new Response("bad gateway", { status: 502 })));
        await assert.rejects(
            () => wt.getIssue(toIssueKey("TAI-1")),
            (err: unknown) => err instanceof StorageConnectivityError
        );
    });

    it("throws StorageConnectivityError when the network is unreachable", async () => {
        const wt = trackerWith(
            stubFetch(() => {
                throw new TypeError("fetch failed");
            })
        );
        await assert.rejects(
            () => wt.getIssue(toIssueKey("TAI-1")),
            (err: unknown) => err instanceof StorageConnectivityError
        );
    });

    it("still maps 404 to null on getIssue — 'absent' is opted into, not assumed", async () => {
        const wt = trackerWith(stubFetch(() => json({ errorMessages: ["Issue does not exist"] }, 404)));
        assert.equal(await wt.getIssue(toIssueKey("TAI-9999")), null);
    });
});

describe("createIssue", () => {
    it("re-fetches after create — Jira's create response omits custom fields", async () => {
        // The create response carries key/id/self only: no persona, no status, no timestamps.
        // Returning a hand-assembled Issue from it would be a guess, so the backend re-reads.
        const calls: string[] = [];
        const wt = trackerWith(
            stubFetch((url, init) => {
                calls.push(`${init.method ?? "GET"} ${url.split("atlassian.net")[1]?.split("?")[0]}`);
                if (init.method === "POST") return json({ key: "TAI-99" });
                return json({
                    key: "TAI-99",
                    fields: {
                        project: { key: "TAI" },
                        issuetype: { name: "Dev" },
                        summary: "s",
                        status: { name: "To Do" },
                        created: "2026-07-13T00:00:00.000-0600",
                        updated: "2026-07-13T00:00:00.000-0600",
                        [PERSONA_FIELD]: { value: "Developer" },
                    },
                });
            })
        );

        const issue = await wt.createIssue({
            projectKey: "TAI",
            issueType: "epic",
            summary: "s",
        });

        assert.deepEqual(calls, ["POST /rest/api/2/issue", "GET /rest/api/2/issue/TAI-99"]);
        // The value that only exists because of the re-fetch:
        assert.equal(issue.persona, "developer");
        assert.equal(issue.status, Status.ToDo);
    });
});

describe("transition", () => {
    it("matches on destination status, not on the transition's own name", async () => {
        // Jira transition names and their destination statuses routinely differ
        // ("Start work" -> "In Progress"). The caller asked for a Status, so we match on `to`.
        let posted: unknown;
        const wt = trackerWith(
            stubFetch((url, init) => {
                if (url.includes("/transitions") && init.method === "GET") {
                    return json({
                        transitions: [
                            { id: "21", name: "Start work", to: { name: "In Progress" } },
                            { id: "41", name: "Finish", to: { name: "Done" } },
                        ],
                    });
                }
                if (url.includes("/transitions") && init.method === "POST") {
                    posted = JSON.parse(String(init.body));
                    return new Response(null, { status: 204 });
                }
                return json({
                    key: "TAI-21",
                    fields: {
                        project: { key: "TAI" },
                        issuetype: { name: "Dev" },
                        summary: "s",
                        status: { name: "In Progress" },
                        // Assigned, or the §5.5 gate would (correctly) block this before Jira
                        // is ever called.
                        assignee: { accountId: "a1", displayName: "del" },
                        created: "x",
                        updated: "y",
                    },
                });
            })
        );

        const res = await wt.transition(toIssueKey("TAI-21"), Status.InProgress);
        assert.equal(res.ok, true);
        assert.deepEqual(posted, { transition: { id: "21" } });
    });

    /**
     * Brief §5.5 (rev 19): no unassigned work in progress. Enforced here, in the storage
     * plugin's transition op, alongside the other checkpoint checks — never per-persona.
     */
    describe("the assignment gate", () => {
        function trackerFor(assignee: unknown) {
            return trackerWith(
                stubFetch((url, init) => {
                    if (url.includes("/transitions") && init.method === "GET") {
                        return json({
                            transitions: [
                                { id: "21", name: "Start", to: { name: "In Progress" } },
                                { id: "41", name: "Done", to: { name: "Done" } },
                                { id: "2", name: "Cancel", to: { name: "Canceled" } },
                            ],
                        });
                    }
                    if (init.method === "POST") return new Response(null, { status: 204 });
                    return json({
                        key: "TAI-21",
                        fields: {
                            project: { key: "TAI" },
                            issuetype: { name: "Dev" },
                            summary: "s",
                            status: { name: "To Do" },
                            assignee,
                            created: "x",
                            updated: "y",
                        },
                    });
                })
            );
        }

        it("blocks In Progress when nobody is assigned", async () => {
            const res = await trackerFor(null).transition(toIssueKey("TAI-21"), Status.InProgress);
            assert.equal(res.ok, false);
            assert.match(res.ok === false ? res.reason : "", /no Assignee/i);
        });

        it("blocks In Review when nobody is assigned", async () => {
            const res = await trackerFor(null).transition(toIssueKey("TAI-21"), Status.InReview);
            assert.equal(res.ok, false);
        });

        it("allows In Progress once a human is assigned", async () => {
            const res = await trackerFor({ accountId: "a1", displayName: "del" }).transition(
                toIssueKey("TAI-21"),
                Status.InProgress
            );
            assert.equal(res.ok, true);
        });

        it("exempts terminal states — once work stops, an owner no longer matters", async () => {
            const done = await trackerFor(null).transition(toIssueKey("TAI-21"), Status.Done);
            assert.equal(done.ok, true);
            const canceled = await trackerFor(null).transition(toIssueKey("TAI-21"), Status.Canceled);
            assert.equal(canceled.ok, true);
        });
    });

    it("rejects (ok:false) when the target status is unreachable from here", async () => {
        const wt = trackerWith(
            stubFetch(() =>
                json({ transitions: [{ id: "11", name: "Reopen", to: { name: "To Do" } }] })
            )
        );
        const res = await wt.transition(toIssueKey("TAI-21"), Status.Done);
        assert.equal(res.ok, false);
        assert.match(res.ok === false ? res.reason : "", /No transition .* "Done"/);
    });
});

describe("createLink", () => {
    /**
     * Direction is the single easiest thing to get backwards here, and getting it backwards
     * silently inverts every precedence edge in the project. Verified against live Jira:
     * for the "Blocks" type, the INWARD issue blocks the OUTWARD issue.
     * `createLink(from, DependsOn, to)` means "from depends on to", so `to` is the blocker
     * and therefore `to` goes in the inward slot.
     */
    it("puts the blocker in the inward slot", async () => {
        let body: { inwardIssue: { key: string }; outwardIssue: { key: string } } | undefined;
        const wt = trackerWith(
            stubFetch((_url, init) => {
                body = JSON.parse(String(init.body));
                return new Response(null, { status: 201 });
            })
        );

        // "TAI-11 depends on TAI-10" — i.e. TAI-10 blocks TAI-11.
        await wt.createLink(toIssueKey("TAI-11"), "depends-on" as never, toIssueKey("TAI-10"));

        assert.equal(body?.inwardIssue.key, "TAI-10", "the blocker goes inward");
        assert.equal(body?.outwardIssue.key, "TAI-11", "the blocked goes outward");
    });
});

describe("linkPage", () => {
    /**
     * REGRESSION. `object.url` must be a genuine URL — Jira's remote-link API validates it
     * and 400s on a bare page id ("Invalid 'URL'..."). Found by running the conformance suite
     * (TAI-15) against live Jira, not by any unit test, since a stub fetch will happily accept
     * whatever string you hand it.
     */
    it("builds a real, resolvable Confluence URL, not the bare page id", async () => {
        let body: { object: { url: string } } | undefined;
        const wt = trackerWith(
            stubFetch((_url, init) => {
                body = JSON.parse(String(init.body));
                return new Response(null, { status: 201 });
            })
        );
        await wt.linkPage(toIssueKey("TAI-13"), "12058646" as never);
        assert.equal(
            body?.object.url,
            "https://example.atlassian.net/wiki/pages/viewpage.action?pageId=12058646"
        );
    });
});
