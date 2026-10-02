import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reparentViolation } from "./reparent-gate.js";
import type { Issue } from "./interface.js";

function issue(key: string, issueType: string, projectKey = "TAI"): Issue {
    return { key, projectKey, issueType } as unknown as Issue;
}

describe("reparentViolation (TAI-372/379)", () => {
    const epic = issue("TAI-1", "epic");

    it("allows a Story or Bug to move under an Epic in the same project", () => {
        assert.equal(reparentViolation(issue("TAI-5", "story"), epic), null);
        assert.equal(reparentViolation(issue("TAI-6", "bug"), epic), null);
    });

    it("rejects re-parenting a subtask, naming the Jira UI as the way (human decision 2026-10-02)", () => {
        const reason = reparentViolation(issue("TAI-7", "dev"), issue("TAI-5", "story"));
        assert.match(reason ?? "", /subtask/i);
        assert.match(reason ?? "", /Jira UI/);
    });

    it("rejects re-parenting an Epic (nothing sits above it)", () => {
        assert.match(reparentViolation(epic, issue("TAI-2", "epic")) ?? "", /epic/i);
    });

    it("rejects a new parent that is not an Epic", () => {
        assert.match(reparentViolation(issue("TAI-5", "story"), issue("TAI-8", "story")) ?? "", /must be an Epic/);
    });

    it("rejects a missing new parent", () => {
        assert.match(reparentViolation(issue("TAI-5", "story"), null) ?? "", /not found/i);
    });

    it("rejects a parent in a different project", () => {
        assert.match(reparentViolation(issue("TAI-5", "story"), issue("OTH-1", "epic", "OTH")) ?? "", /same project/i);
    });
});
