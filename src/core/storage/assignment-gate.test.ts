import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status } from "../schema/story-schema.js";
import { toIssueKey } from "./interface.js";
import { entryGateReason, isAssignmentGateReason } from "./assignment-gate.js";

describe("isAssignmentGateReason (TAI-249/260 ADR)", () => {
    it("matches entryGateReason's actual generated text", () => {
        const reason = entryGateReason(toIssueKey("TAI-1"), Status.InProgress);
        assert.equal(isAssignmentGateReason(reason), true);
    });

    it("matches regardless of which issue key or target status generated it", () => {
        assert.equal(isAssignmentGateReason(entryGateReason(toIssueKey("TAI-999"), Status.InReview)), true);
    });

    it("does not match an unrelated rejection reason", () => {
        assert.equal(isAssignmentGateReason("CI status not green for abc123 — build: failed."), false);
    });

    it("does not match the exit-side gate's own message (a different rule, must not be conflated)", () => {
        assert.equal(isAssignmentGateReason('TAI-1 is "In Progress" and has no Assignee. A ticket may not be unassigned while in a non-terminal, non-To-Do status (brief §5.5).'), false);
    });
});
