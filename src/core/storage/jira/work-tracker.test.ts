import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status, SubtaskType } from "../../schema/story-schema.js";
import {
    StorageConnectivityError,
    toIssueKey,
    toHumanId,
    toPageId,
    type DocStore,
    type Page,
    type PageRef,
} from "../interface.js";
import { RestClient, apiTokenAuth } from "./rest-client.js";
import { createJiraWorkTracker } from "./work-tracker.js";
import { EMPTY_TYPE_ALIAS_MAP } from "./mappers.js";

const PERSONA_FIELD = "customfield_10105";
const SPACE_KEY = "TA";

/**
 * A minimal DocStore fake — every test in this file except "the review gate" describe block
 * transitions a `Dev` subtask, which `reviewGateApplies` short-circuits on `issue.issueType`
 * alone (review-gate.ts) before ever touching the DocStore. So the default fake here never
 * actually gets called; `pages` lets the review-gate tests below configure a real Persona
 * Roster page when they need one.
 */
function fakeDocStore(pages: Page[] = []): DocStore {
    const notImplemented = (): never => {
        throw new Error("not implemented in this test fake");
    };
    return {
        async getPage(ref: PageRef): Promise<Page | null> {
            if ("id" in ref) return pages.find((p) => p.id === ref.id) ?? null;
            return pages.find((p) => p.spaceKey === ref.spaceKey && p.title === ref.title) ?? null;
        },
        createPage: notImplemented,
        updatePage: notImplemented,
        addComment: notImplemented,
        editComment: notImplemented,
        getChildren: notImplemented,
        getLinkedIssues: notImplemented,
        listAttachments: notImplemented,
        getAttachment: notImplemented,
    };
}

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

function trackerWith(fetchImpl: typeof fetch, docStore: DocStore = fakeDocStore()) {
    const client = new RestClient({
        siteUrl: "https://example.atlassian.net",
        auth: apiTokenAuth("a@b.c", "token"),
        fetchImpl,
    });
    return createJiraWorkTracker(client, {
        personaFieldId: PERSONA_FIELD,
        docStore,
        spaceKey: SPACE_KEY,
        aliases: EMPTY_TYPE_ALIAS_MAP,
    });
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

    // TAI-226/228: found live (TAI-192 work) -- a second "dev" subtask (TAI-224) got created
    // under a story that already had one (TAI-193, Done) with no guard catching it.
    describe("duplicate-subtask guard (TAI-226/227/228)", () => {
        it("rejects a second subtask of the same type under the same parent, without ever calling Jira's create endpoint", async () => {
            const calls: string[] = [];
            const wt = trackerWith(
                stubFetch((url, init) => {
                    const path = url.split("atlassian.net")[1]?.split("?")[0];
                    calls.push(`${init.method ?? "GET"} ${path}`);
                    if (path === "/rest/api/2/search/jql") {
                        return json({
                            issues: [
                                {
                                    key: "TAI-193",
                                    fields: {
                                        project: { key: "TAI" },
                                        issuetype: { name: "Dev" },
                                        summary: "First dev subtask",
                                        status: { name: "Done" },
                                        parent: { key: "TAI-192" },
                                        created: "2026-08-25T00:00:00.000-0600",
                                        updated: "2026-08-25T00:00:00.000-0600",
                                        [PERSONA_FIELD]: { value: "Developer" },
                                    },
                                },
                            ],
                        });
                    }
                    throw new Error(`unexpected call: ${path}`);
                })
            );

            await assert.rejects(
                () =>
                    wt.createIssue({
                        projectKey: "TAI",
                        issueType: SubtaskType.Dev,
                        parentKey: toIssueKey("TAI-192"),
                        summary: "Accidental duplicate",
                    }),
                /TAI-193 \(Done\) already exists/
            );
            assert.deepEqual(calls, ["POST /rest/api/2/search/jql"]);
        });

        it("allows the create when allowDuplicate: true is passed, skipping the guard's search entirely", async () => {
            const calls: string[] = [];
            const wt = trackerWith(
                stubFetch((url, init) => {
                    const path = url.split("atlassian.net")[1]?.split("?")[0];
                    calls.push(`${init.method ?? "GET"} ${path}`);
                    if (init.method === "POST" && path === "/rest/api/2/issue") return json({ key: "TAI-224" });
                    if (path === "/rest/api/2/issue/TAI-224") {
                        return json({
                            key: "TAI-224",
                            fields: {
                                project: { key: "TAI" },
                                issuetype: { name: "Dev" },
                                summary: "Deliberate redo",
                                status: { name: "To Do" },
                                parent: { key: "TAI-192" },
                                created: "2026-08-26T00:00:00.000-0600",
                                updated: "2026-08-26T00:00:00.000-0600",
                                [PERSONA_FIELD]: { value: "Developer" },
                            },
                        });
                    }
                    throw new Error(`unexpected call: ${path}`);
                })
            );

            const issue = await wt.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                parentKey: toIssueKey("TAI-192"),
                summary: "Deliberate redo",
                allowDuplicate: true,
            });
            assert.equal(issue.key, "TAI-224");
            assert.deepEqual(calls, ["POST /rest/api/2/issue", "GET /rest/api/2/issue/TAI-224"]);
        });
    });
});

/** A raw Jira issue of the given type, for the GET the backend does before/after a PUT. */
function rawIssue(key: string, issuetype: string, extra: Record<string, unknown> = {}) {
    return {
        key,
        fields: {
            project: { key: "TAI" },
            issuetype: { name: issuetype },
            summary: "s",
            status: { name: "Backlog" },
            created: "2026-10-02T00:00:00.000-0600",
            updated: "2026-10-02T00:00:00.000-0600",
            ...extra,
        },
    };
}

describe("updateIssue: parent= and labels= (TAI-372/379)", () => {
    function tracker(issues: Record<string, unknown>) {
        const puts: { path: string; body: unknown }[] = [];
        const wt = trackerWith(
            stubFetch((url, init) => {
                const path = url.split("atlassian.net")[1]?.split("?")[0] ?? "";
                if (init.method === "PUT") {
                    puts.push({ path, body: JSON.parse(String(init.body)) });
                    return new Response(null, { status: 204 });
                }
                const key = path.split("/").pop() ?? "";
                return issues[key] ? json(issues[key]) : json({ errorMessages: ["nope"] }, 404);
            })
        );
        return { wt, puts };
    }

    it("sends labels as the WHOLE list (replace), and [] to clear", async () => {
        const { wt, puts } = tracker({ "TAI-5": rawIssue("TAI-5", "Story") });
        await wt.updateIssue(toIssueKey("TAI-5"), { labels: ["a", "b"] });
        await wt.updateIssue(toIssueKey("TAI-5"), { labels: [] });
        assert.deepEqual(puts.map((p) => (p.body as { fields: unknown }).fields), [{ labels: ["a", "b"] }, { labels: [] }]);
    });

    it("rejects a label with a space up front, with no PUT (same rule the filesystem backend applies)", async () => {
        const { wt, puts } = tracker({ "TAI-5": rawIssue("TAI-5", "Story") });
        await assert.rejects(() => wt.updateIssue(toIssueKey("TAI-5"), { labels: ["has space"] }), /spaces/);
        assert.deepEqual(puts, []);
    });

    it("re-parents a Story under an Epic with PUT fields.parent = {key}", async () => {
        const { wt, puts } = tracker({
            "TAI-5": rawIssue("TAI-5", "Story"),
            "TAI-1": rawIssue("TAI-1", "Epic"),
        });
        await wt.updateIssue(toIssueKey("TAI-5"), { parentKey: toIssueKey("TAI-1") });
        assert.deepEqual(puts, [{ path: "/rest/api/2/issue/TAI-5", body: { fields: { parent: { key: "TAI-1" } } } }]);
    });

    it("rejects a subtask re-parent without ever calling Jira's PUT", async () => {
        const { wt, puts } = tracker({
            "TAI-7": rawIssue("TAI-7", "Dev", { parent: { key: "TAI-5" } }),
            "TAI-5": rawIssue("TAI-5", "Story"),
        });
        await assert.rejects(() => wt.updateIssue(toIssueKey("TAI-7"), { parentKey: toIssueKey("TAI-5") }), /subtask/i);
        assert.deepEqual(puts, []);
    });

    it("rejects a non-Epic parent and a missing parent, with no PUT", async () => {
        const { wt, puts } = tracker({
            "TAI-5": rawIssue("TAI-5", "Story"),
            "TAI-8": rawIssue("TAI-8", "Story"),
        });
        await assert.rejects(() => wt.updateIssue(toIssueKey("TAI-5"), { parentKey: toIssueKey("TAI-8") }), /must be an Epic/);
        await assert.rejects(() => wt.updateIssue(toIssueKey("TAI-5"), { parentKey: toIssueKey("TAI-404") }), /not found/i);
        assert.deepEqual(puts, []);
    });

    it("an update with neither field never fetches a parent", async () => {
        const urls: string[] = [];
        const wt = trackerWith(
            stubFetch((url, init) => {
                urls.push(`${init.method ?? "GET"} ${url.split("atlassian.net")[1]?.split("?")[0]}`);
                return init.method === "PUT" ? new Response(null, { status: 204 }) : json(rawIssue("TAI-5", "Story"));
            })
        );
        await wt.updateIssue(toIssueKey("TAI-5"), { summary: "x" });
        assert.deepEqual(urls, ["PUT /rest/api/2/issue/TAI-5", "GET /rest/api/2/issue/TAI-5"]);
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

    // TAI-220/221/222: a Subtask starting real work should cascade its parent Story to In
    // Progress -- a real write, recursing through transition() itself (so a Story's own
    // cascade to its Epic works the same way, one level further up).
    describe("the parent-status cascade gate", () => {
        interface FakeIssueState {
            status: string;
            assignee: { accountId: string; displayName: string } | null;
            issuetype: string;
            parentKey?: string;
        }

        /** A minimal, stateful multi-issue Jira fake -- mutates `issues[key].status` on a
         *  POST transition, so a subsequent GET (the cascade's own re-fetch, and the outer
         *  `asMutation` re-fetch after a real write) reflects it. Generic single-issue fakes
         *  elsewhere in this file don't need this since they never recurse across two keys. */
        function trackerForIssues(issues: Record<string, FakeIssueState>) {
            const calls: string[] = [];
            const wt = trackerWith(
                stubFetch((url, init) => {
                    const path = url.split("atlassian.net")[1]?.split("?")[0] ?? "";
                    calls.push(`${init.method ?? "GET"} ${path}`);
                    const match = path.match(/^\/rest\/api\/2\/issue\/([A-Za-z0-9-]+)(\/transitions)?$/);
                    if (!match) throw new Error(`unexpected call: ${path}`);
                    const [, key, transitionsSuffix] = match;
                    const rec = issues[key];
                    if (!rec) throw new Error(`unknown issue in fake: ${key}`);

                    if (transitionsSuffix && (init.method ?? "GET") === "GET") {
                        return json({ transitions: [{ id: "21", name: "Start", to: { name: "In Progress" } }] });
                    }
                    if (transitionsSuffix && init.method === "POST") {
                        rec.status = "In Progress";
                        return new Response(null, { status: 204 });
                    }
                    return json({
                        key,
                        fields: {
                            project: { key: "TAI" },
                            issuetype: { name: rec.issuetype },
                            summary: "s",
                            status: { name: rec.status },
                            assignee: rec.assignee,
                            ...(rec.parentKey ? { parent: { key: rec.parentKey } } : {}),
                            created: "x",
                            updated: "y",
                        },
                    });
                })
            );
            return { wt, calls };
        }

        it("cascades Subtask -> Story -> Epic, recursing through transition() itself", async () => {
            const issues: Record<string, FakeIssueState> = {
                "TAI-10": {
                    status: "To Do",
                    assignee: { accountId: "a1", displayName: "del" },
                    issuetype: "Dev",
                    parentKey: "TAI-1",
                },
                "TAI-1": {
                    status: "To Do",
                    assignee: { accountId: "a1", displayName: "del" },
                    issuetype: "Story",
                    parentKey: "TAI-0",
                },
                "TAI-0": { status: "To Do", assignee: { accountId: "a1", displayName: "del" }, issuetype: "Epic" },
            };
            const { wt } = trackerForIssues(issues);

            const result = await wt.transition(toIssueKey("TAI-10"), Status.InProgress);
            assert.equal(result.ok, true, "the child's own transition must still succeed");
            assert.equal(issues["TAI-1"]?.status, "In Progress", "the Story must have been cascaded");
            assert.equal(issues["TAI-0"]?.status, "In Progress", "the Epic must cascade one level further up");
            // TAI-304/311 ADR: affectedIssues carries every OTHER issue the cascade
            // actually mutated, so a caller (CachingWorkTracker) can cache all of them.
            if (result.ok) {
                const affectedKeys = (result.affectedIssues ?? []).map((i) => i.key).sort();
                assert.deepEqual(affectedKeys, ["TAI-0", "TAI-1"], "both the Story and the Epic must be reported");
            }
        });

        it("cascades to a Story and stops cleanly when the Story has no Epic (a legitimate, common shape)", async () => {
            const issues: Record<string, FakeIssueState> = {
                "TAI-10": {
                    status: "To Do",
                    assignee: { accountId: "a1", displayName: "del" },
                    issuetype: "Dev",
                    parentKey: "TAI-1",
                },
                // No parentKey -- a top-level Story with no Epic. Must not be assumed to
                // always have one just because a cascade path exists above it.
                "TAI-1": { status: "To Do", assignee: { accountId: "a1", displayName: "del" }, issuetype: "Story" },
            };
            const { wt } = trackerForIssues(issues);

            const result = await wt.transition(toIssueKey("TAI-10"), Status.InProgress);
            assert.equal(result.ok, true);
            assert.equal(issues["TAI-1"]?.status, "In Progress", "the Story must still cascade");
        });

        it("a rejected parent-cascade (parent unassigned) is best-effort -- the child's own transition still succeeds", async () => {
            const issues: Record<string, FakeIssueState> = {
                "TAI-10": {
                    status: "To Do",
                    assignee: { accountId: "a1", displayName: "del" },
                    issuetype: "Dev",
                    parentKey: "TAI-1",
                },
                "TAI-1": { status: "To Do", assignee: null, issuetype: "Story" },
            };
            const { wt } = trackerForIssues(issues);

            const result = await wt.transition(toIssueKey("TAI-10"), Status.InProgress);
            assert.equal(result.ok, true, "a rejected cascade must never block the child's own transition");
            assert.equal(issues["TAI-1"]?.status, "To Do", "the rejected parent cascade must not have applied");
        });

        it("does not cascade a Done or In Review parent backward -- and never even attempts the write", async () => {
            const issues: Record<string, FakeIssueState> = {
                "TAI-10": {
                    status: "To Do",
                    assignee: { accountId: "a1", displayName: "del" },
                    issuetype: "Dev",
                    parentKey: "TAI-1",
                },
                "TAI-1": { status: "Done", assignee: { accountId: "a1", displayName: "del" }, issuetype: "Story" },
            };
            const { wt, calls } = trackerForIssues(issues);

            const result = await wt.transition(toIssueKey("TAI-10"), Status.InProgress);
            assert.equal(result.ok, true);
            assert.equal(issues["TAI-1"]?.status, "Done", "a Done parent must never be moved backward");
            assert.ok(
                !calls.includes("POST /rest/api/2/issue/TAI-1/transitions"),
                "a Done parent must not even receive a transition attempt"
            );
        });
    });

    /**
     * TAI-41 ADR's "hard" checkpoint kind, TAI-42's own scope: REVIEW_GATES enforcement
     * (brief §3.3/§3.9/§5.6). Only Kickoff has a gate today (`REVIEW_GATES` in
     * story-schema.ts), triggered on In Review -> Done.
     */
    describe("the review gate", () => {
        const ROSTER_PAGE: Page = {
            id: toPageId("PAGE-1"),
            spaceKey: SPACE_KEY,
            title: "Persona Roster",
            content: [
                "| Persona | Authorized humans |",
                "| --- | --- |",
                "| PM | Perry ([perry@example.com](mailto:perry@example.com)) |",
                "| UX Designer | Uma ([uma@example.com](mailto:uma@example.com)) |",
            ].join("\n"),
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            comments: [],
        };

        function approvedComment(id: string, email: string, displayName: string) {
            return {
                id,
                author: { accountId: id, displayName, emailAddress: email },
                body: `Approved: looks good`,
                created: "x",
                updated: "x",
            };
        }

        function kickoffTrackerWith(comments: unknown[], status = "In Review") {
            return trackerWith(
                stubFetch((url, init) => {
                    if (url.includes("/transitions") && init.method === "GET") {
                        return json({ transitions: [{ id: "41", name: "Finish", to: { name: "Done" } }] });
                    }
                    if (url.includes("/transitions") && init.method === "POST") {
                        return new Response(null, { status: 204 });
                    }
                    return json({
                        key: "TAI-1",
                        fields: {
                            project: { key: "TAI" },
                            issuetype: { name: "Kickoff" },
                            summary: "s",
                            status: { name: status },
                            assignee: { accountId: "a1", displayName: "del" },
                            created: "x",
                            updated: "y",
                            comment: { comments },
                        },
                    });
                }),
                fakeDocStore([ROSTER_PAGE])
            );
        }

        it("blocks Done when a required reviewer's Approved: sign-off is missing", async () => {
            const wt = kickoffTrackerWith([approvedComment("c1", "perry@example.com", "Perry")]);
            const res = await wt.transition(toIssueKey("TAI-1"), Status.Done);
            assert.equal(res.ok, false);
            assert.match(res.ok === false ? res.reason : "", /missing.*sign-off.*UX Designer/is);
        });

        it("blocks Done when the commenter isn't in the Persona Roster for that persona", async () => {
            // Right marker, wrong human — "Approved:" from someone the roster doesn't list
            // under PM must not count, or anyone could satisfy the gate by typing the marker.
            const wt = kickoffTrackerWith([
                approvedComment("c1", "not-pm@example.com", "Not Perry"),
                approvedComment("c2", "uma@example.com", "Uma"),
            ]);
            const res = await wt.transition(toIssueKey("TAI-1"), Status.Done);
            assert.equal(res.ok, false);
            assert.match(res.ok === false ? res.reason : "", /PM/);
        });

        it("allows Done once both required reviewers have approved", async () => {
            const wt = kickoffTrackerWith([
                approvedComment("c1", "perry@example.com", "Perry"),
                approvedComment("c2", "uma@example.com", "Uma"),
            ]);
            const res = await wt.transition(toIssueKey("TAI-1"), Status.Done);
            assert.equal(res.ok, true);
        });

        it("re-scans fresh every call — an edited-away Approved: comment reopens the gate", async () => {
            // Same shape as "missing sign-off" above, just documenting the fresh-re-scan
            // property explicitly (brief §3.9): nothing here is a cached prior verdict, the
            // marker scan runs directly against whatever `issue.comments` this fetch returns.
            const wt = kickoffTrackerWith([approvedComment("c1", "perry@example.com", "Perry")]);
            const res = await wt.transition(toIssueKey("TAI-1"), Status.Done);
            assert.equal(res.ok, false);
        });

        /**
         * REGRESSION guard (found in self-review before this ever shipped). Neither backend
         * enforces strict workflow ordering (conformance.ts's `strictWorkflow: false` on both),
         * so a gate keyed to "current status is In Review" would be trivially bypassable by
         * transitioning straight from To Do / In Progress to Done. `reviewGateApplies` checks
         * only the target, not the source, specifically to close this off.
         */
        it("still blocks Done when skipping straight from To Do (no strict workflow to rely on)", async () => {
            const wt = kickoffTrackerWith([], "To Do");
            const res = await wt.transition(toIssueKey("TAI-1"), Status.Done);
            assert.equal(res.ok, false);
        });
    });

    it("rejects (ok:false) when the target status is unreachable from here", async () => {
        const wt = trackerWith(
            stubFetch((url) => {
                if (url.includes("/transitions")) {
                    return json({ transitions: [{ id: "11", name: "Reopen", to: { name: "To Do" } }] });
                }
                // The Done-target fetch (needed to check the review gate — review-gate.ts,
                // TAI-42) — a plain Dev subtask, so the gate itself is inapplicable here.
                return json({
                    key: "TAI-21",
                    fields: {
                        project: { key: "TAI" },
                        issuetype: { name: "Dev" },
                        summary: "s",
                        status: { name: "In Progress" },
                        created: "x",
                        updated: "y",
                    },
                });
            })
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

    /**
     * REGRESSION. Confirmed empirically against live Jira (2026-08-14, TAI-67/TAI-68): a
     * remote link with no `application`/`relationship` set to Confluence's own native shape
     * files under Jira's generic "Web Links" panel, indistinguishable from an arbitrary
     * human-added link. Setting these two fields to exactly what Confluence's own "Link"
     * action produces gets it into Jira's "Confluence content" panel AND Confluence's own
     * "Jira work items" panel on the page — both directions from one link, no
     * Confluence-page-side macro required.
     */
    it("sets application/relationship to Confluence's own native remote-link shape", async () => {
        let body: { application?: { type: string; name: string }; relationship?: string } | undefined;
        const wt = trackerWith(
            stubFetch((_url, init) => {
                body = JSON.parse(String(init.body));
                return new Response(null, { status: 201 });
            })
        );
        await wt.linkPage(toIssueKey("TAI-13"), "12058646" as never);
        assert.deepEqual(body?.application, { type: "com.atlassian.confluence", name: "Confluence" });
        assert.equal(body?.relationship, "Wiki Page");
    });
});

describe("resolveHuman (TAI-165/167 ADR)", () => {
    it("resolves a real Atlassian Account ID for a matching email, not the email itself", async () => {
        const wt = trackerWith(
            stubFetch((url) => {
                assert.ok(url.includes("/user/search?query=del%40mayhak.com"));
                return json([
                    {
                        accountId: "712020:00000000-0000-0000-0000-000000000001",
                        displayName: "del",
                        emailAddress: "del@mayhak.com",
                    },
                ]);
            })
        );
        const human = await wt.resolveHuman("del@mayhak.com");
        assert.equal(human?.id, "712020:00000000-0000-0000-0000-000000000001");
        assert.equal(human?.email, "del@mayhak.com");
    });

    it("returns null, not a throw, when no user matches", async () => {
        const wt = trackerWith(stubFetch(() => json([])));
        const human = await wt.resolveHuman("nobody@example.com");
        assert.equal(human, null);
    });
});
