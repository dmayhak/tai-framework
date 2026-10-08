import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status, StoryType, SubtaskType } from "../../schema/story-schema.js";
import {
    StorageConnectivityError,
    toIssueKey,
    toHumanId,
    toPageId,
    type DocStore,
    type Page,
    type PageRef,
} from "../interface.js";
import { UnreadableIssueError, takeUnreadableIssues } from "../unreadable-issues.js";
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

function trackerWith(fetchImpl: typeof fetch, docStore: DocStore = fakeDocStore(), flaggedFieldId: string | null = null) {
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
        flaggedFieldId,
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
                    // TAI-381: the guard also reads the parent's own (immediately consistent) subtasks
                    // field, in case the search index hasn't caught up with a just-created sibling.
                    if (path === "/rest/api/2/issue/TAI-192") return json({ key: "TAI-192", fields: { subtasks: [{ key: "TAI-193" }] } });
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
            assert.deepEqual(calls, ["POST /rest/api/2/search/jql", "GET /rest/api/2/issue/TAI-192"]);
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

    it("rejects an empty label up front, with no PUT", async () => {
        const { wt, puts } = tracker({ "TAI-5": rawIssue("TAI-5", "Story") });
        await assert.rejects(() => wt.updateIssue(toIssueKey("TAI-5"), { labels: [""] }), /empty/i);
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

describe("upward cascade: Kickoff exemption and the To Do cascade (TAI-374/387)", () => {
    interface Rec { status: string; issuetype: string; parentKey?: string }
    /** A stateful multi-issue Jira fake that understands both To Do and In Progress transitions. */
    function fake(issues: Record<string, Rec>) {
        const posted: string[] = [];
        const ids: Record<string, string> = { "11": "To Do", "21": "In Progress" };
        const wt = trackerWith(
            stubFetch((url, init) => {
                const path = url.split("atlassian.net")[1]?.split("?")[0] ?? "";
                const m = path.match(/^\/rest\/api\/2\/issue\/([A-Za-z0-9-]+)(\/transitions)?$/);
                if (!m) throw new Error(`unexpected call: ${path}`);
                const [, key, suffix] = m;
                const rec = issues[key as string];
                if (!rec) throw new Error(`unknown issue in fake: ${key}`);
                if (suffix && (init.method ?? "GET") === "GET") {
                    return json({ transitions: [{ id: "11", name: "Schedule", to: { name: "To Do" } }, { id: "21", name: "Start", to: { name: "In Progress" } }] });
                }
                if (suffix && init.method === "POST") {
                    const id = (JSON.parse(String(init.body)) as { transition: { id: string } }).transition.id;
                    rec.status = ids[id] as string;
                    posted.push(`${key} -> ${rec.status}`);
                    return new Response(null, { status: 204 });
                }
                return json({
                    key,
                    fields: {
                        project: { key: "TAI" },
                        issuetype: { name: rec.issuetype },
                        summary: "s",
                        status: { name: rec.status },
                        assignee: { accountId: "a1", displayName: "del" },
                        ...(rec.parentKey ? { parent: { key: rec.parentKey } } : {}),
                        created: "x",
                        updated: "y",
                    },
                });
            })
        );
        return { wt, posted };
    }

    it("a Kickoff Story going In Progress does not touch its Backlog Epic", async () => {
        const issues = { "TAI-1": { status: "Backlog", issuetype: "Epic" }, "TAI-2": { status: "To Do", issuetype: "Kickoff", parentKey: "TAI-1" } };
        const { wt, posted } = fake(issues);
        await wt.transition(toIssueKey("TAI-2"), Status.InProgress);
        assert.deepEqual(posted, ["TAI-2 -> In Progress"]);
        assert.equal(issues["TAI-1"].status, "Backlog");
    });

    it("a normal Story going In Progress still moves its Epic", async () => {
        const issues = { "TAI-1": { status: "Backlog", issuetype: "Epic" }, "TAI-2": { status: "To Do", issuetype: "Story", parentKey: "TAI-1" } };
        const { wt } = fake(issues);
        await wt.transition(toIssueKey("TAI-2"), Status.InProgress);
        assert.equal(issues["TAI-1"].status, "In Progress");
    });

    it("a subtask reaching To Do schedules its Backlog Story, which schedules the Backlog Epic", async () => {
        const issues = {
            "TAI-1": { status: "Backlog", issuetype: "Epic" },
            "TAI-2": { status: "Backlog", issuetype: "Story", parentKey: "TAI-1" },
            "TAI-3": { status: "Backlog", issuetype: "Dev", parentKey: "TAI-2" },
        };
        const { wt } = fake(issues);
        const result = await wt.transition(toIssueKey("TAI-3"), Status.ToDo);
        assert.equal(result.ok, true);
        assert.equal(issues["TAI-2"].status, "To Do");
        assert.equal(issues["TAI-1"].status, "To Do");
        if (result.ok) assert.deepEqual((result.affectedIssues ?? []).map((i) => i.key).sort(), ["TAI-1", "TAI-2"]);
    });

    it("a subtask of a Kickoff reaching To Do schedules the Kickoff but NOT the Epic", async () => {
        const issues = {
            "TAI-1": { status: "Backlog", issuetype: "Epic" },
            "TAI-2": { status: "Backlog", issuetype: "Kickoff", parentKey: "TAI-1" },
            "TAI-3": { status: "Backlog", issuetype: "Research", parentKey: "TAI-2" },
        };
        const { wt } = fake(issues);
        await wt.transition(toIssueKey("TAI-3"), Status.ToDo);
        assert.equal(issues["TAI-2"].status, "To Do");
        assert.equal(issues["TAI-1"].status, "Backlog");
    });

    it("the To Do cascade never regresses a parent that is already started", async () => {
        const issues = {
            "TAI-1": { status: "In Progress", issuetype: "Epic" },
            "TAI-2": { status: "In Progress", issuetype: "Story", parentKey: "TAI-1" },
            "TAI-3": { status: "Backlog", issuetype: "Dev", parentKey: "TAI-2" },
        };
        const { wt, posted } = fake(issues);
        await wt.transition(toIssueKey("TAI-3"), Status.ToDo);
        assert.deepEqual(posted, ["TAI-3 -> To Do"]);
    });
});

describe("read-your-write child lookup (TAI-381)", () => {
    // Jira's search index lags ~2-4s behind a create (measured live): POST /search/jql can miss a
    // just-created child while the PARENT's own `subtasks` field already lists it.
    function lagTracker(opts: { searchHits?: unknown[]; parentSubtasks: string[]; issues: Record<string, unknown> }) {
        const calls: string[] = [];
        const wt = trackerWith(
            stubFetch((url, init) => {
                const path = url.split("atlassian.net")[1]?.split("?")[0] ?? "";
                const subtasksOnly = url.includes("fields=subtasks");
                calls.push(`${init.method ?? "GET"} ${path}${subtasksOnly ? " (subtasks)" : ""}`);
                if (path === "/rest/api/2/search/jql") return json({ issues: opts.searchHits ?? [] });
                if (subtasksOnly) return json({ key: "TAI-10", fields: { subtasks: opts.parentSubtasks.map((key) => ({ key })) } });
                if (init.method === "POST" && path.endsWith("/transitions")) return new Response(null, { status: 204 });
                if (path.endsWith("/transitions")) {
                    return json({ transitions: [{ id: "41", name: "Cancel", to: { name: "Canceled" } }] });
                }
                if (init.method === "POST" && path === "/rest/api/2/issue") return json({ key: "TAI-99" });
                const key = path.split("/").pop() ?? "";
                return opts.issues[key] ? json(opts.issues[key]) : json({ errorMessages: ["nope"] }, 404);
            })
        );
        return { wt, calls };
    }
    const dev = (key: string, extra: Record<string, unknown> = {}) =>
        rawIssue(key, "Dev", { parent: { key: "TAI-10" }, [PERSONA_FIELD]: { value: "Developer" }, ...extra });

    it("a plain search never reads the parent (read-heavy callers pay nothing extra)", async () => {
        const { wt, calls } = lagTracker({ parentSubtasks: ["TAI-11"], issues: {} });
        await wt.search({ projectKey: "TAI", parentKey: toIssueKey("TAI-10") });
        assert.deepEqual(calls, ["POST /rest/api/2/search/jql"]);
    });

    it("with readYourWrites, finds a subtask the search missed by reading the parent's subtasks field", async () => {
        const { wt } = lagTracker({ parentSubtasks: ["TAI-11"], issues: { "TAI-11": dev("TAI-11") } });
        const found = await wt.search({ projectKey: "TAI", parentKey: toIssueKey("TAI-10"), readYourWrites: true });
        assert.deepEqual(found.map((i) => i.key), ["TAI-11"]);
    });

    it("does not duplicate a subtask the search already returned, and does not refetch it", async () => {
        const { wt, calls } = lagTracker({ searchHits: [dev("TAI-11")], parentSubtasks: ["TAI-11"], issues: { "TAI-11": dev("TAI-11") } });
        const found = await wt.search({ projectKey: "TAI", parentKey: toIssueKey("TAI-10"), readYourWrites: true });
        assert.deepEqual(found.map((i) => i.key), ["TAI-11"]);
        assert.ok(!calls.includes("GET /rest/api/2/issue/TAI-11"), "already had it from the search");
    });

    it("applies the rest of the filter to a subtask found only through the parent", async () => {
        const { wt } = lagTracker({ parentSubtasks: ["TAI-11"], issues: { "TAI-11": dev("TAI-11") } });
        const found = await wt.search({ projectKey: "TAI", parentKey: toIssueKey("TAI-10"), issueTypes: [StoryType.Bug], readYourWrites: true });
        assert.deepEqual(found, []);
    });

    it("the duplicate-subtask guard sees a just-created same-type sibling the search missed, and never creates", async () => {
        const { wt, calls } = lagTracker({ parentSubtasks: ["TAI-11"], issues: { "TAI-11": dev("TAI-11") } });
        await assert.rejects(
            () => wt.createIssue({ projectKey: "TAI", issueType: SubtaskType.Dev, parentKey: toIssueKey("TAI-10"), summary: "second dev" }),
            /second "dev" subtask/
        );
        assert.ok(!calls.includes("POST /rest/api/2/issue"), "must not have created the duplicate");
    });

    it("the downward cascade cancels a just-created child the search missed", async () => {
        const { wt, calls } = lagTracker({
            parentSubtasks: ["TAI-11"],
            issues: { "TAI-10": rawIssue("TAI-10", "Story", { status: { name: "In Progress" } }), "TAI-11": dev("TAI-11") },
        });
        await wt.transition(toIssueKey("TAI-10"), Status.Canceled);
        assert.ok(calls.includes("POST /rest/api/2/issue/TAI-11/transitions"), calls.join("\n"));
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
                    // TAI-476: the precedence gate's sibling lookup. These fixtures have no siblings; it is
                    // answered here and kept out of `calls`, which records the cascade's own traffic.
                    if (path === "/rest/api/2/search/jql") return json({ issues: [] });
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

describe("flagged (TAI-390): Jira's Flagged field, discovered by name", () => {
    const FLAGGED_FIELD = "customfield_10021";

    function tracker(flaggedFieldId: string | null, issueExtra: Record<string, unknown> = {}) {
        const puts: { path: string; body: unknown }[] = [];
        const gets: string[] = [];
        const wt = trackerWith(
            stubFetch((url, init) => {
                const path = url.split("atlassian.net")[1]?.split("?")[0] ?? "";
                if (init.method === "PUT") {
                    puts.push({ path, body: JSON.parse(String(init.body)) });
                    return new Response(null, { status: 204 });
                }
                gets.push(url);
                return json(rawIssue("TAI-5", "Story", issueExtra));
            }),
            fakeDocStore(),
            flaggedFieldId
        );
        return { wt, puts, gets };
    }

    it("sets the flag with update.<id> = [{value:Impediment}] and clears it with []", async () => {
        const { wt, puts } = tracker(FLAGGED_FIELD);
        await wt.updateIssue(toIssueKey("TAI-5"), { flagged: true });
        await wt.updateIssue(toIssueKey("TAI-5"), { flagged: false });
        assert.deepEqual(puts.map((p) => p.body), [
            { fields: { [FLAGGED_FIELD]: [{ value: "Impediment" }] } },
            { fields: { [FLAGGED_FIELD]: [] } },
        ]);
    });

    it("an update that leaves flagged undefined sends no Flagged field at all", async () => {
        const { wt, puts } = tracker(FLAGGED_FIELD);
        await wt.updateIssue(toIssueKey("TAI-5"), { summary: "x" });
        assert.deepEqual(puts.map((p) => p.body), [{ fields: { summary: "x" } }]);
    });

    it("requests the Flagged field and reads Impediment back as flagged: true", async () => {
        const { wt, gets } = tracker(FLAGGED_FIELD, { [FLAGGED_FIELD]: [{ value: "Impediment" }] });
        const issue = await wt.getIssue(toIssueKey("TAI-5"));
        assert.equal(issue?.flagged, true);
        assert.ok(gets[0]?.includes(FLAGGED_FIELD), "the Flagged field must be requested explicitly");
    });

    it("an empty or null Flagged field reads back as not flagged (flagged omitted)", async () => {
        for (const v of [[], null]) {
            const { wt } = tracker(FLAGGED_FIELD, { [FLAGGED_FIELD]: v });
            const issue = await wt.getIssue(toIssueKey("TAI-5"));
            assert.equal("flagged" in (issue ?? {}), false);
        }
    });

    it("with no Flagged field on the site: reads omit flagged, and setting it is rejected clearly with no PUT", async () => {
        const { wt, puts } = tracker(null);
        const issue = await wt.getIssue(toIssueKey("TAI-5"));
        assert.equal("flagged" in (issue ?? {}), false);
        await assert.rejects(
            () => wt.updateIssue(toIssueKey("TAI-5"), { flagged: true }),
            /no "Flagged" custom field/i
        );
        assert.deepEqual(puts, []);
    });

    it("clearing the flag on a site with no Flagged field is also rejected (not a silent no-op)", async () => {
        const { wt, puts } = tracker(null);
        await assert.rejects(() => wt.updateIssue(toIssueKey("TAI-5"), { flagged: false }), /no "Flagged" custom field/i);
        assert.deepEqual(puts, []);
    });
});

describe("search pagination (TAI-402)", () => {
    const rawIssue = (n: number) => ({
        key: `TAI-${n}`,
        fields: {
            project: { key: "TAI" },
            issuetype: { name: "Story" },
            summary: `S${n}`,
            status: { name: "To Do" },
            created: "2026-10-01T00:00:00.000-0600",
            updated: "2026-10-01T00:00:00.000-0600",
            [PERSONA_FIELD]: { value: "PM" },
        },
    });

    /** Serves 120 issues in pages, honoring maxResults + nextPageToken like Jira's /search/jql. */
    function pagedTracker(total: number) {
        const bodies: { maxResults: number; nextPageToken?: string }[] = [];
        const wt = trackerWith(
            stubFetch((url, init) => {
                assert.match(url, /\/rest\/api\/2\/search\/jql/);
                const body = JSON.parse(String(init.body)) as { maxResults: number; nextPageToken?: string };
                bodies.push(body);
                const start = body.nextPageToken ? Number(body.nextPageToken) : 0;
                const end = Math.min(start + body.maxResults, total);
                const issues = Array.from({ length: end - start }, (_, i) => rawIssue(start + i + 1));
                return json(end < total ? { issues, nextPageToken: String(end), isLast: false } : { issues, isLast: true });
            })
        );
        return { wt, bodies };
    }

    it("a bounded search asks for one page of `limit` and never follows the cursor", async () => {
        const { wt, bodies } = pagedTracker(120);
        const found = await wt.search({ projectKey: "TAI" });
        assert.equal(found.length, 50);
        assert.equal(bodies.length, 1);
        assert.equal(bodies[0]!.maxResults, 50);
    });

    it("an exhaustive search follows nextPageToken until isLast and returns every match", async () => {
        const { wt, bodies } = pagedTracker(120);
        const found = await wt.search({ projectKey: "TAI", exhaustive: true });
        assert.equal(found.length, 120);
        assert.equal(bodies.length, 2);
        assert.equal(found[119]!.key, "TAI-120");
    });

    it("an exhaustive search over a result that fits in one page makes one request", async () => {
        const { wt, bodies } = pagedTracker(7);
        assert.equal((await wt.search({ projectKey: "TAI", exhaustive: true })).length, 7);
        assert.equal(bodies.length, 1);
    });

    it("an exhaustive search that never ends throws rather than silently returning a truncated set", async () => {
        const wt = trackerWith(stubFetch(() => json({ issues: [rawIssue(1)], nextPageToken: "x", isLast: false })));
        await assert.rejects(() => wt.search({ projectKey: "TAI", exhaustive: true }), /Exhaustive search still had more results/);
    });
});

describe("unmapped Jira issue type (TAI-405)", () => {
    const row = (key: string, type: string) => ({
        key,
        fields: {
            project: { key: "TAI" },
            issuetype: { name: type },
            summary: `S ${key}`,
            status: { name: "To Do" },
            created: "2026-10-01T00:00:00.000-0600",
            updated: "2026-10-01T00:00:00.000-0600",
            [PERSONA_FIELD]: { value: "PM" },
        },
    });
    const trackerFor = (rows: ReturnType<typeof row>[]) =>
        trackerWith(
            stubFetch((url) =>
                /\/search\/jql/.test(url) ? json({ issues: rows, isLast: true }) : json(rows.find((r) => url.includes(`/issue/${r.key}`)))
            )
        );

    it("search skips the row of an unmapped type, reports it, and still returns the others", async () => {
        takeUnreadableIssues();
        const found = await trackerFor([row("TAI-1", "Story"), row("TAI-2", "Task"), row("TAI-3", "Story")]).search({ projectKey: "TAI" });
        assert.deepEqual(found.map((i) => i.key), ["TAI-1", "TAI-3"]);
        assert.deepEqual(takeUnreadableIssues(), [{ key: "TAI-2", typeName: "Task" }]);
    });

    it("an unrelated mapping failure in a row is still fatal (only the unmapped-type case is skipped)", async () => {
        const bad = row("TAI-2", "Story");
        bad.fields.status = { name: "Nonsense" };
        await assert.rejects(() => trackerFor([row("TAI-1", "Story"), bad]).search({ projectKey: "TAI" }));
    });

    it("reading that one issue by key still fails hard, naming the ticket and keeping the fix-it message", async () => {
        const wt = trackerFor([row("TAI-2", "Task")]);
        await assert.rejects(
            () => wt.getIssue(toIssueKey("TAI-2")),
            (e: unknown) =>
                e instanceof UnreadableIssueError && e.key === "TAI-2" && e.typeName === "Task" && /Unknown Jira issue type "Task"/.test(e.message)
        );
    });
});
