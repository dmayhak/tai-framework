import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StoryType, SubtaskType } from "../schema/story-schema.js";
import { matchesIssueFilter } from "./issue-filter.js";
import type { Issue, IssueFilter } from "./interface.js";

const issue = (over: Record<string, unknown> = {}): Issue =>
    ({
        key: "TAI-11",
        projectKey: "TAI",
        issueType: "dev",
        status: "Backlog",
        assignee: { id: "u1", displayName: "U" },
        persona: "developer",
        parentKey: "TAI-10",
        updatedAt: "2026-10-02T10:00:00.000Z",
        ...over,
    }) as unknown as Issue;

describe("matchesIssueFilter (TAI-381)", () => {
    it("matches on the project alone", () => {
        assert.equal(matchesIssueFilter(issue(), { projectKey: "TAI" }), true);
        assert.equal(matchesIssueFilter(issue(), { projectKey: "OTHER" }), false);
    });

    it("applies each field the backends filter on", () => {
        const f = (extra: Partial<IssueFilter>): IssueFilter => ({ projectKey: "TAI", ...extra });
        assert.equal(matchesIssueFilter(issue(), f({ issueTypes: [SubtaskType.Dev] })), true);
        assert.equal(matchesIssueFilter(issue(), f({ issueTypes: [StoryType.Bug] })), false);
        assert.equal(matchesIssueFilter(issue(), f({ statuses: ["Backlog" as never] })), true);
        assert.equal(matchesIssueFilter(issue(), f({ statuses: ["Done" as never] })), false);
        assert.equal(matchesIssueFilter(issue(), f({ assignee: "u1" as never })), true);
        assert.equal(matchesIssueFilter(issue(), f({ assignee: "u2" as never })), false);
        assert.equal(matchesIssueFilter(issue(), f({ persona: "developer" as never })), true);
        assert.equal(matchesIssueFilter(issue(), f({ persona: "tester" as never })), false);
        assert.equal(matchesIssueFilter(issue(), f({ parentKey: "TAI-10" as never })), true);
        assert.equal(matchesIssueFilter(issue(), f({ parentKey: "TAI-99" as never })), false);
        assert.equal(matchesIssueFilter(issue(), f({ updatedSince: "2026-10-02T09:00:00.000Z" })), true);
        assert.equal(matchesIssueFilter(issue(), f({ updatedSince: "2026-10-02T11:00:00.000Z" })), false);
    });

    it("ignores limit and readYourWrites (those shape the query, not the match)", () => {
        assert.equal(matchesIssueFilter(issue(), { projectKey: "TAI", limit: 1, readYourWrites: true }), true);
    });
});
