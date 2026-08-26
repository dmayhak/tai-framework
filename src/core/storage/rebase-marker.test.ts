import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status, SubtaskType } from "../schema/story-schema.js";
import { toIssueKey, toHumanId, type Issue, type Comment } from "./interface.js";
import { REBASE_NEEDED_MARKER, rebaseNeededCommentBody, hasUnresolvedRebaseMarker } from "./rebase-marker.js";

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

describe("rebaseNeededCommentBody", () => {
    it("starts with the marker and includes the PR url", () => {
        const body = rebaseNeededCommentBody("https://bitbucket.org/x/y/pull-requests/1");
        assert.ok(body.startsWith(REBASE_NEEDED_MARKER));
        assert.ok(body.includes("https://bitbucket.org/x/y/pull-requests/1"));
    });
});

describe("hasUnresolvedRebaseMarker", () => {
    it("false when there are no comments at all", () => {
        assert.equal(hasUnresolvedRebaseMarker(issue({ comments: [] })), false);
    });

    it("false when comments exist but none is a Rebase needed: marker", () => {
        assert.equal(
            hasUnresolvedRebaseMarker(issue({ comments: [comment("just a note"), comment("Q: anything?")] })),
            false
        );
    });

    it("true when a Rebase needed: marker is present", () => {
        assert.equal(
            hasUnresolvedRebaseMarker(
                issue({ comments: [comment("some other comment"), comment(rebaseNeededCommentBody("https://x/1"))] })
            ),
            true
        );
    });

    it("still true after a SECOND conflict posts a second marker — no counting/latest-wins needed", () => {
        const first = comment(rebaseNeededCommentBody("https://x/1"), "c1");
        const second = comment(rebaseNeededCommentBody("https://x/1"), "c2");
        assert.equal(hasUnresolvedRebaseMarker(issue({ comments: [first, second] })), true);
    });

    it("only matches at the START of the comment body, not mid-body mentions", () => {
        assert.equal(
            hasUnresolvedRebaseMarker(issue({ comments: [comment("unrelated text mentioning Rebase needed: nope")] })),
            false
        );
    });
});
