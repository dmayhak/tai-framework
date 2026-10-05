import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StoryType, SubtaskType } from "../schema/story-schema.js";
import { matchesIssueFilter, parseUpdatedSince } from "./issue-filter.js";
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
        component: "tai-framework",
        labels: ["backend", "urgent"],
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

    it("component matches exactly and labels requires every listed label (TAI-419)", () => {
        const f = (extra: Partial<IssueFilter>): IssueFilter => ({ projectKey: "TAI", ...extra });
        assert.equal(matchesIssueFilter(issue(), f({ component: "tai-framework" })), true);
        assert.equal(matchesIssueFilter(issue(), f({ component: "other" })), false);
        assert.equal(matchesIssueFilter(issue({ component: undefined }), f({ component: "tai-framework" })), false);
        assert.equal(matchesIssueFilter(issue(), f({ labels: ["backend"] })), true);
        assert.equal(matchesIssueFilter(issue(), f({ labels: ["backend", "urgent"] })), true);
        assert.equal(matchesIssueFilter(issue(), f({ labels: ["backend", "missing"] })), false);
        assert.equal(matchesIssueFilter(issue({ labels: [] }), f({ labels: ["backend"] })), false);
    });

    it("ignores limit and readYourWrites (those shape the query, not the match)", () => {
        assert.equal(matchesIssueFilter(issue(), { projectKey: "TAI", limit: 1, readYourWrites: true }), true);
    });
});

describe("parseUpdatedSince (TAI-420 review): one strict contract for both backends", () => {
    it("accepts a date, or a date-time that names its timezone, and returns the instant in epoch ms", () => {
        assert.equal(parseUpdatedSince("2026-10-02"), Date.UTC(2026, 9, 2));
        assert.equal(parseUpdatedSince("2026-10-02T10:00:00Z"), Date.UTC(2026, 9, 2, 10));
        assert.equal(parseUpdatedSince("2026-10-02T10:00:00.250Z"), Date.UTC(2026, 9, 2, 10, 0, 0, 250));
        assert.equal(parseUpdatedSince("2026-10-02T10:00Z"), Date.UTC(2026, 9, 2, 10));
        assert.equal(parseUpdatedSince("2026-10-02T12:00:00+02:00"), Date.UTC(2026, 9, 2, 10));
        assert.equal(parseUpdatedSince("2026-10-02T04:00:00-0600"), Date.UTC(2026, 9, 2, 10));
    });

    it("rejects everything else with a message naming the accepted form: relative offsets, a bare local time, free text", () => {
        for (const bad of ["-7d", "2026-07-13 09:00", "2026-07-13T09:00:00", "last tuesday", "2026-13-45", ""]) {
            assert.throws(() => parseUpdatedSince(bad), /Invalid updatedSince .* ISO 8601/, JSON.stringify(bad));
        }
    });
});

describe("matchesIssueFilter updatedSince compares instants, not strings (TAI-420 review)", () => {
    it("an offset date-time and the equivalent Z date-time agree", () => {
        const i = issue({ updatedAt: "2026-10-02T10:00:00.000Z" });
        assert.equal(matchesIssueFilter(i, { projectKey: "TAI", updatedSince: "2026-10-02T12:00:00+02:00" }), true);
        assert.equal(matchesIssueFilter(i, { projectKey: "TAI", updatedSince: "2026-10-02T12:00:01+02:00" }), false);
    });

    it("an invalid updatedSince throws here too, so the filesystem backend rejects what Jira rejects", () => {
        assert.throws(() => matchesIssueFilter(issue(), { projectKey: "TAI", updatedSince: "-7d" }), /Invalid updatedSince/);
    });
});
