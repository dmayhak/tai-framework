import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    toHumanId,
    toIssueKey,
    toPageId,
    type CascadeWarning,
    type Comment,
    type HumanRef,
    type Issue,
    type IssueLink,
    type Page,
} from "../core/storage/interface.js";
import { DependencyRelation, Persona, Status, StoryType, SubtaskType } from "../core/schema/story-schema.js";
import {
    parseIssueSearchFilter,
    parsePageGetRef,
    resolveCreatePriority,
    renderChangeNotes,
    renderIssueSearchResults,
    renderLinkedIssues,
    renderIssueDetail,
    renderCascadeWarnings,
} from "./cli.js";

const AUTHOR: HumanRef = { id: toHumanId("del@example.com"), displayName: "Del", email: "del@example.com" };

function makeIssue(overrides: Partial<Issue> = {}): Issue {
    return {
        key: toIssueKey("TAI-1"),
        projectKey: "TAI",
        issueType: SubtaskType.Dev,
        summary: "A test issue",
        status: Status.ToDo,
        assignee: null,
        persona: null,
        labels: [],
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
        comments: [],
        ...overrides,
    };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
    return {
        id: "c1",
        author: AUTHOR,
        body: "A comment.",
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
        ...overrides,
    };
}

describe("parseIssueSearchFilter", () => {
    it("defaults to the given projectKey when none is passed in fields", () => {
        assert.deepEqual(parseIssueSearchFilter({}, "TAI"), { projectKey: "TAI" });
    });

    it("an explicit projectKey field overrides the default", () => {
        assert.deepEqual(parseIssueSearchFilter({ projectKey: "OTHER" }, "TAI"), { projectKey: "OTHER" });
    });

    it("splits status/type on commas", () => {
        const filter = parseIssueSearchFilter({ status: "To Do,In Progress", type: "dev,bug" }, "TAI");
        assert.deepEqual(filter.statuses, ["To Do", "In Progress"]);
        assert.deepEqual(filter.issueTypes, ["dev", "bug"]);
    });

    it("passes through persona/parent/updatedSince/limit", () => {
        const filter = parseIssueSearchFilter(
            { persona: "developer", parent: "TAI-1", updatedSince: "2026-01-01", limit: "200" },
            "TAI"
        );
        assert.equal(filter.persona, "developer");
        assert.equal(filter.parentKey, "TAI-1");
        assert.equal(filter.updatedSince, "2026-01-01");
        assert.equal(filter.limit, 200);
    });

    it("omits a field entirely when not given -- unfiltered on that axis, not narrowed", () => {
        const filter = parseIssueSearchFilter({}, "TAI");
        assert.equal("statuses" in filter, false);
        assert.equal("issueTypes" in filter, false);
        assert.equal("limit" in filter, false);
    });
});

describe("resolveCreatePriority", () => {
    it("an explicit priority always wins, regardless of the parent's priority", () => {
        assert.equal(resolveCreatePriority("Low", SubtaskType.Dev, "High"), "Low");
    });

    it("an explicit priority wins even with no parent priority available", () => {
        assert.equal(resolveCreatePriority("Low", SubtaskType.Dev, undefined), "Low");
    });

    it("inherits the parent's priority for a subtask when none was given explicitly", () => {
        assert.equal(resolveCreatePriority(undefined, SubtaskType.Dev, "High"), "High");
    });

    it("resolves to undefined (Jira's own default) when neither an explicit nor a parent priority exists", () => {
        assert.equal(resolveCreatePriority(undefined, SubtaskType.Dev, undefined), undefined);
    });

    it("does NOT inherit for a Story/Bug/Spike -- only actual subtask issue types", () => {
        assert.equal(resolveCreatePriority(undefined, StoryType.Story, "High"), undefined);
        assert.equal(resolveCreatePriority(undefined, StoryType.Bug, "High"), undefined);
        assert.equal(resolveCreatePriority(undefined, "epic", "High"), undefined);
    });
});

describe("parsePageGetRef", () => {
    it("parses an id=<PAGE-ID> first argument as the by-id form", () => {
        assert.deepEqual(parsePageGetRef("id=12345", undefined), { id: toPageId("12345") });
    });

    it("parses <SPACE-KEY> <TITLE> as the by-space-and-title form", () => {
        assert.deepEqual(parsePageGetRef("TA", "Persona Roster"), { spaceKey: "TA", title: "Persona Roster" });
    });

    it("returns null when neither id= nor a title is given -- caller's job to error", () => {
        assert.equal(parsePageGetRef("TA", undefined), null);
    });
});

describe("renderIssueSearchResults", () => {
    it("renders \"No matches.\" for an empty result set, without a limit-hit warning", () => {
        const out = renderIssueSearchResults([], { projectKey: "TAI" });
        assert.match(out, /No matches\./);
        assert.doesNotMatch(out, /Hit the search limit/);
    });

    it("renders each issue's key/type/status/summary, persona, parent, and description", () => {
        const issue = makeIssue({
            key: toIssueKey("TAI-99"),
            issueType: StoryType.Bug,
            status: Status.InProgress,
            summary: "Something broke",
            persona: Persona.Developer,
            parentKey: toIssueKey("TAI-9"),
            description: "The actual broken behavior.",
        });
        const out = renderIssueSearchResults([issue], { projectKey: "TAI" });
        assert.match(out, /## TAI-99 \[bug\] In Progress — Something broke/);
        assert.match(out, /Persona: developer/);
        assert.match(out, /Parent: TAI-9/);
        assert.match(out, /The actual broken behavior\./);
    });

    it("falls back to a placeholder for a missing description", () => {
        const out = renderIssueSearchResults([makeIssue()], { projectKey: "TAI" });
        assert.match(out, /_\(no description\)_/);
    });

    it("includes the filter's scope line (status/type/persona/parent/updatedSince) when given", () => {
        const out = renderIssueSearchResults([], {
            projectKey: "TAI",
            statuses: [Status.ToDo],
            issueTypes: [SubtaskType.Dev],
            persona: Persona.Developer,
            parentKey: toIssueKey("TAI-1"),
            updatedSince: "2026-01-01",
        });
        assert.match(out, /status: To Do/);
        assert.match(out, /type: dev/);
        assert.match(out, /persona: developer/);
        assert.match(out, /parent: TAI-1/);
        assert.match(out, /updatedSince: 2026-01-01/);
    });

    it("warns when the result count hits the effective limit (explicit or default)", () => {
        const issues = [makeIssue({ key: toIssueKey("TAI-1") }), makeIssue({ key: toIssueKey("TAI-2") })];
        const hit = renderIssueSearchResults(issues, { projectKey: "TAI", limit: 2 });
        assert.match(hit, /Hit the search limit \(2\)/);

        const notHit = renderIssueSearchResults(issues, { projectKey: "TAI", limit: 3 });
        assert.doesNotMatch(notHit, /Hit the search limit/);
    });
});

describe("renderLinkedIssues", () => {
    it("renders \"None.\" when both directions are empty", () => {
        assert.equal(renderLinkedIssues([], []), "None.");
    });

    it("renders outgoing links with an arrow-right and incoming with an arrow-left", () => {
        const outgoing: readonly IssueLink[] = [{ relation: DependencyRelation.DependsOn, key: toIssueKey("TAI-2") }];
        const incoming: readonly IssueLink[] = [{ relation: DependencyRelation.RelatesTo, key: toIssueKey("TAI-3") }];
        const out = renderLinkedIssues(outgoing, incoming);
        assert.match(out, /- depends-on → TAI-2 \(outgoing\)/);
        assert.match(out, /- relates-to ← TAI-3 \(incoming\)/);
    });
});

describe("renderIssueDetail", () => {
    it("renders full detail: description, comments, linked issues, linked pages", async () => {
        const issue = makeIssue({
            key: toIssueKey("TAI-42"),
            summary: "A fully-linked ticket",
            description: "Full description text.",
            persona: Persona.Pm,
            priority: "High",
            labels: ["a", "b"],
            comments: [makeComment({ body: "First comment." })],
        });
        const page: Page = {
            id: toPageId("100"),
            spaceKey: "TA",
            title: "Linked Page",
            content: "content",
            createdAt: "2026-08-28T00:00:00.000Z",
            updatedAt: "2026-08-28T00:00:00.000Z",
            comments: [],
        };

        const out = await renderIssueDetail(
            {
                workTracker: {
                    getLinkedIssues: async (_key, _relation, direction) =>
                        direction === "outgoing" ? [{ relation: DependencyRelation.DependsOn, key: toIssueKey("TAI-1") }] : [],
                    getLinkedPages: async () => [toPageId("100")],
                },
                docStore: { getPage: async () => page },
            },
            issue
        );

        assert.match(out, /# Issue TAI-42/);
        assert.match(out, /Full description text\./);
        assert.match(out, /### Del — 2026-08-28T00:00:00\.000Z\n\nFirst comment\./);
        assert.match(out, /depends-on → TAI-1 \(outgoing\)/);
        assert.match(out, /- Linked Page \(id: 100, space: TA\)/);
    });

    it("flags a linked page id that no longer resolves as MISSING, not silently dropped", async () => {
        const out = await renderIssueDetail(
            {
                workTracker: {
                    getLinkedIssues: async () => [],
                    getLinkedPages: async () => [toPageId("gone")],
                },
                docStore: { getPage: async () => null },
            },
            makeIssue()
        );
        assert.match(out, /\*\*MISSING\*\* — linked page id gone no longer exists/);
    });

    it("renders placeholders for no comments and no linked pages", async () => {
        const out = await renderIssueDetail(
            {
                workTracker: { getLinkedIssues: async () => [], getLinkedPages: async () => [] },
                docStore: { getPage: async () => null },
            },
            makeIssue()
        );
        assert.match(out, /_\(no comments\)_/);
        assert.match(out, /## Linked pages\n\nNone\./);
    });
});

describe("renderChangeNotes (TAI-285 ADR)", () => {
    it("returns undefined for an empty list -- nothing worth mentioning", () => {
        assert.equal(renderChangeNotes([]), undefined);
    });

    it("renders a mild note for a 'content' severity change", () => {
        const out = renderChangeNotes([{ key: toIssueKey("TAI-1"), severity: "content", fields: ["summary"] }]);
        assert.match(out!, /TAI-1/);
        assert.match(out!, /summary changed/);
        assert.doesNotMatch(out!, /⚠️/);
    });

    it("renders a prominent warning for a 'structural' severity change, telling the persona to confirm with the human", () => {
        const out = renderChangeNotes([{ key: toIssueKey("TAI-1"), severity: "structural", fields: ["status"] }]);
        assert.match(out!, /⚠️/);
        assert.match(out!, /TAI-1/);
        assert.match(out!, /status/);
        assert.match(out!, /confirm with the human/);
    });

    it("names the specific field(s) that changed, not a generic list of every possible cause (PR #85 review)", () => {
        const out = renderChangeNotes([{ key: toIssueKey("TAI-1"), severity: "structural", fields: ["assignee"] }]);
        assert.match(out!, /assignee/);
        assert.doesNotMatch(out!, /status\/priority/);
    });

    it("names multiple changed fields together, comma-separated", () => {
        const out = renderChangeNotes([{ key: toIssueKey("TAI-1"), severity: "structural", fields: ["status", "priority"] }]);
        assert.match(out!, /status, priority/);
    });

    it("names 'relationship' when that's the field that changed", () => {
        const out = renderChangeNotes([{ key: toIssueKey("TAI-1"), severity: "structural", fields: ["relationship"] }]);
        assert.match(out!, /relationship/);
    });

    it("renders one line per note when both the subtask and parent changed", () => {
        const out = renderChangeNotes([
            { key: toIssueKey("TAI-1"), severity: "content", fields: ["description"] },
            { key: toIssueKey("TAI-100"), severity: "structural", fields: ["status"] },
        ]);
        const lines = out!.split("\n");
        assert.equal(lines.length, 2);
        assert.match(lines[0]!, /TAI-1/);
        assert.match(lines[1]!, /⚠️ TAI-100/);
    });
});

describe("renderCascadeWarnings", () => {
    it("renders nothing for undefined or an empty array", () => {
        assert.equal(renderCascadeWarnings(undefined), "");
        assert.equal(renderCascadeWarnings([]), "");
    });

    it("renders one line per warning, each naming the key and reason", () => {
        const warnings: readonly CascadeWarning[] = [
            { key: toIssueKey("TAI-253"), reason: "TAI-253 has no Assignee." },
            { key: toIssueKey("TAI-9"), reason: "some other rejection" },
        ];
        const out = renderCascadeWarnings(warnings);
        assert.match(out, /⚠️ Cascade warning: TAI-253 — TAI-253 has no Assignee\./);
        assert.match(out, /⚠️ Cascade warning: TAI-9 — some other rejection/);
    });
});
