import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { toIssueKey, toHumanId, type Issue, type Comment } from "./interface.js";
import {
    checkpointKind,
    parseCompletionMarker,
    latestCompletionMarker,
    evaluateAutocompletion,
    type AutocompletionConfig,
} from "./autocompletion.js";

const AUTHOR = { id: toHumanId("a1"), displayName: "Dario" };

function comment(body: string, id = "c1"): Comment {
    return { id, author: AUTHOR, body, createdAt: "x", updatedAt: "x" };
}

function issue(overrides: Partial<Issue>): Issue {
    return {
        key: toIssueKey("TAI-1"),
        projectKey: "TAI",
        issueType: SubtaskType.Dev,
        summary: "s",
        status: Status.InProgress,
        assignee: null,
        persona: null,
        labels: [],
        createdAt: "x",
        updatedAt: "x",
        comments: [],
        ...overrides,
    };
}

describe("checkpointKind (TAI-41 ADR, §8.23)", () => {
    it("is hard for a subtask in ALWAYS_HUMAN_GATED_SUBTASKS", () => {
        assert.equal(checkpointKind(issue({ issueType: SubtaskType.Uat })), "hard");
    });

    it("is hard for a story-level issue whose StoryType has a REVIEW_GATES entry", () => {
        assert.equal(checkpointKind(issue({ issueType: StoryType.Kickoff })), "hard");
    });

    it("is conditional for an ordinary subtask", () => {
        assert.equal(checkpointKind(issue({ issueType: SubtaskType.Dev })), "conditional");
        assert.equal(checkpointKind(issue({ issueType: SubtaskType.CodeReview })), "conditional");
    });

    it("is conditional for a story-level issue with no REVIEW_GATES entry", () => {
        assert.equal(checkpointKind(issue({ issueType: StoryType.Story })), "conditional");
        assert.equal(checkpointKind(issue({ issueType: StoryType.Spike })), "conditional");
    });
});

describe("parseCompletionMarker (§8.22)", () => {
    it("parses a Complete: marker with multiple condition results", () => {
        const parsed = parseCompletionMarker("Complete: Dev\nno-major-issues: PASS\nfewer-than-3-minor: FAIL");
        assert.equal(parsed?.subtaskType, "Dev");
        assert.equal(parsed?.results.get("no-major-issues"), true);
        assert.equal(parsed?.results.get("fewer-than-3-minor"), false);
    });

    it("returns null for a comment with no Complete: header", () => {
        assert.equal(parseCompletionMarker("Approved: looks good"), null);
        assert.equal(parseCompletionMarker("just a normal comment"), null);
    });

    it("is case-insensitive on the header and PASS/FAIL tokens", () => {
        const parsed = parseCompletionMarker("complete: Dev\nfoo: pass");
        assert.equal(parsed?.subtaskType, "Dev");
        assert.equal(parsed?.results.get("foo"), true);
    });

    it("skips blank lines and free-text notes after the marker rather than throwing", () => {
        const parsed = parseCompletionMarker("Complete: Dev\n\nsome free-text note\nfoo: PASS");
        assert.equal(parsed?.results.get("foo"), true);
        assert.equal(parsed?.results.size, 1);
    });

    it("no inference-fallback: a malformed condition line is simply absent, not inferred", () => {
        // Unlike Q:/Approved:/Rejected:, this deliberately does NOT try to guess "foo: kinda
        // passed I guess" means PASS — brief §8.22/TAI-41 ADR.
        const parsed = parseCompletionMarker("Complete: Dev\nfoo: kinda passed I guess");
        assert.equal(parsed?.results.has("foo"), false);
    });
});

describe("latestCompletionMarker", () => {
    it("returns null when no comment is a completion marker", () => {
        const i = issue({ comments: [comment("Approved: fine"), comment("just chatting")] });
        assert.equal(latestCompletionMarker(i), null);
    });

    it("returns the MOST RECENT marker, not the first — a superseded one doesn't linger", () => {
        const i = issue({
            comments: [
                comment("Complete: Dev\nfoo: FAIL", "c1"),
                comment("unrelated note", "c2"),
                comment("Complete: Dev\nfoo: PASS", "c3"),
            ],
        });
        assert.equal(latestCompletionMarker(i)?.results.get("foo"), true);
    });
});

describe("evaluateAutocompletion (§8.9 + §8.22)", () => {
    const twoConditions: AutocompletionConfig = {
        enabled: true,
        conditions: [
            { id: "no-major-issues", description: "Code review has no major issues." },
            { id: "fewer-than-3-minor", description: "Fewer than 3 minor issues." },
        ],
    };

    it("never autocompletes when the config is disabled", () => {
        const i = issue({ comments: [comment("Complete: Dev\nno-major-issues: PASS\nfewer-than-3-minor: PASS")] });
        const result = evaluateAutocompletion(i, { enabled: false });
        assert.equal(result.autocompleted, false);
        assert.deepEqual(result.unmet, []);
    });

    it("does not autocomplete when no Complete: marker exists at all", () => {
        const i = issue({ comments: [] });
        const result = evaluateAutocompletion(i, twoConditions);
        assert.equal(result.autocompleted, false);
        assert.deepEqual([...result.unmet].sort(), ["fewer-than-3-minor", "no-major-issues"]);
    });

    it("autocompletes once every condition reads PASS", () => {
        const i = issue({
            comments: [comment("Complete: Dev\nno-major-issues: PASS\nfewer-than-3-minor: PASS")],
        });
        const result = evaluateAutocompletion(i, twoConditions);
        assert.equal(result.autocompleted, true);
        assert.deepEqual(result.unmet, []);
    });

    it("does not autocomplete when even one condition reads FAIL", () => {
        const i = issue({
            comments: [comment("Complete: Dev\nno-major-issues: PASS\nfewer-than-3-minor: FAIL")],
        });
        const result = evaluateAutocompletion(i, twoConditions);
        assert.equal(result.autocompleted, false);
        assert.deepEqual(result.unmet, ["fewer-than-3-minor"]);
    });

    it("treats a condition the marker never mentions as unmet, not as passing by omission", () => {
        const i = issue({ comments: [comment("Complete: Dev\nno-major-issues: PASS")] });
        const result = evaluateAutocompletion(i, twoConditions);
        assert.equal(result.autocompleted, false);
        assert.deepEqual(result.unmet, ["fewer-than-3-minor"]);
    });

    it("an empty conditions list is vacuously satisfied (AND-only, v1)", () => {
        const i = issue({ comments: [] });
        const result = evaluateAutocompletion(i, { enabled: true, conditions: [] });
        assert.equal(result.autocompleted, true);
    });

    it("re-scans fresh every call — a later FAIL marker supersedes an earlier PASS", () => {
        const i = issue({
            comments: [
                comment("Complete: Dev\nno-major-issues: PASS\nfewer-than-3-minor: PASS", "c1"),
                comment("Complete: Dev\nno-major-issues: PASS\nfewer-than-3-minor: FAIL", "c2"),
            ],
        });
        const result = evaluateAutocompletion(i, twoConditions);
        assert.equal(result.autocompleted, false);
    });
});
