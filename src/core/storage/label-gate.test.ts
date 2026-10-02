import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { labelViolation } from "./label-gate.js";

describe("labelViolation (TAI-379 review)", () => {
    it("accepts ordinary labels and an empty list", () => {
        assert.equal(labelViolation(["alpha", "beta-2", "x_y"]), null);
        assert.equal(labelViolation([]), null);
    });

    it("rejects a label containing whitespace, naming it (Jira rejects these with a 400)", () => {
        assert.match(labelViolation(["ok", "has space"]) ?? "", /"has space".*spaces/);
        assert.match(labelViolation(["tab\there"]) ?? "", /tab/);
    });

    it("rejects an empty or whitespace-only label: Jira silently drops it, the filesystem would keep it", () => {
        assert.match(labelViolation(["ok", ""]) ?? "", /empty/i);
        assert.match(labelViolation(["   "]) ?? "", /empty/i);
    });
});
