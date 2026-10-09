import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toHumanId, toIssueKey, type Comment, type Issue, type WorkTracker } from "./interface.js";
import { isHandoff, latestHandoff, postIssueComment } from "./handoff.js";

const KEY = toIssueKey("TAI-2");
const del = { id: toHumanId("del"), displayName: "Del" };

function comment(n: number, body: string): Comment {
    const at = `2026-01-${String(n).padStart(2, "0")}T10:00:00Z`;
    return { id: String(n), author: del, body, createdAt: at, updatedAt: at };
}

/** Just the three methods `postIssueComment` uses, over an in-memory comment list. */
class FakeTracker {
    readonly calls: string[] = [];
    editError: Error | null = null;
    constructor(public comments: Comment[] | null) {}
    async getIssue(): Promise<Issue | null> {
        return this.comments === null ? null : ({ key: KEY, comments: this.comments } as unknown as Issue);
    }
    async addComment(_key: string, body: string): Promise<Comment> {
        this.calls.push("add");
        const added = comment((this.comments?.length ?? 0) + 1, body);
        this.comments?.push(added);
        return added;
    }
    async editComment(_key: string, commentId: string, body: string): Promise<Comment> {
        this.calls.push(`edit ${commentId}`);
        if (this.editError) throw this.editError;
        const edited = { ...this.comments!.find((c) => c.id === commentId)!, body, updatedAt: "2026-02-01T10:00:00Z" };
        this.comments = this.comments!.map((c) => (c.id === commentId ? edited : c));
        return edited;
    }
}
const asTracker = (fake: FakeTracker): Pick<WorkTracker, "getIssue" | "addComment" | "editComment"> =>
    fake as unknown as Pick<WorkTracker, "getIssue" | "addComment" | "editComment">;

describe("Handoff: marker", () => {
    it("is read from the first line only, whatever the case or spacing", () => {
        assert.ok(isHandoff("Handoff: tests green."));
        assert.ok(isHandoff("  handoff : tests green."));
        assert.ok(!isHandoff("Note\nHandoff: not on the first line."));
        assert.ok(!isHandoff("Handoff notes without the colon"));
    });

    it("finds the latest hand-off comment, or none", () => {
        const comments = [comment(1, "Handoff: old."), comment(2, "A question."), comment(3, "Handoff: new."), comment(4, "Later chatter.")];
        assert.equal(latestHandoff(comments)?.id, "3");
        assert.equal(latestHandoff([comment(1, "A question.")]), null);
    });
});

describe("postIssueComment", () => {
    it("adds an ordinary comment", async () => {
        const fake = new FakeTracker([comment(1, "Handoff: old.")]);
        const result = await postIssueComment(asTracker(fake), KEY, "A question.");
        assert.deepEqual(fake.calls, ["add"]);
        assert.equal(result.replaced, false);
        assert.equal(result.comment.body, "A question.");
    });

    it("adds the first hand-off comment on a ticket", async () => {
        const fake = new FakeTracker([comment(1, "A question.")]);
        const result = await postIssueComment(asTracker(fake), KEY, "Handoff: first.");
        assert.deepEqual(fake.calls, ["add"]);
        assert.equal(result.replaced, false);
    });

    it("replaces the ticket's latest hand-off comment instead of adding another", async () => {
        const fake = new FakeTracker([comment(1, "Handoff: older."), comment(2, "Handoff: old."), comment(3, "A question.")]);
        const result = await postIssueComment(asTracker(fake), KEY, "Handoff: new state.");
        assert.deepEqual(fake.calls, ["edit 2"]);
        assert.equal(result.replaced, true);
        assert.equal(result.comment.id, "2");
        assert.deepEqual(
            fake.comments!.map((c) => c.body),
            ["Handoff: older.", "Handoff: new state.", "A question."]
        );
    });

    it("adds a new hand-off comment when the old one cannot be edited, and says why", async () => {
        const fake = new FakeTracker([comment(1, "Handoff: someone else's.")]);
        fake.editError = new Error("403: not the author");
        const result = await postIssueComment(asTracker(fake), KEY, "Handoff: mine.");
        assert.deepEqual(fake.calls, ["edit 1", "add"]);
        assert.equal(result.replaced, false);
        assert.match(result.editFailure ?? "", /403/);
    });

    it("fails on a ticket that does not exist rather than posting blind", async () => {
        const fake = new FakeTracker(null);
        await assert.rejects(() => postIssueComment(asTracker(fake), KEY, "Handoff: x."), /TAI-2/);
        assert.deepEqual(fake.calls, []);
    });
});
