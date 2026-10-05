import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { renderUnreadableIssuesNote, reportUnreadableIssue, takeUnreadableIssues } from "./unreadable-issues.js";

describe("unreadable-issues collector (TAI-405)", () => {
    beforeEach(() => void takeUnreadableIssues());

    test("reporting warns once per key and names the key and the type", () => {
        const warnings: string[] = [];
        reportUnreadableIssue({ key: "TAIT-5", typeName: "Task" }, (m) => warnings.push(m));
        reportUnreadableIssue({ key: "TAIT-5", typeName: "Task" }, (m) => warnings.push(m));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, /TAIT-5/);
        assert.match(warnings[0]!, /"Task"/);
    });

    test("take returns what was skipped and clears the collector", () => {
        reportUnreadableIssue({ key: "TAIT-5", typeName: "Task" }, () => {});
        reportUnreadableIssue({ key: "TAIT-9", typeName: "Epic Task" }, () => {});
        assert.deepEqual(takeUnreadableIssues().map((i) => i.key), ["TAIT-5", "TAIT-9"]);
        assert.deepEqual(takeUnreadableIssues(), []);
    });

    test("the note is absent when nothing was skipped, and otherwise names each ticket plus the way out", () => {
        assert.equal(renderUnreadableIssuesNote([]), undefined);
        const note = renderUnreadableIssuesNote([
            { key: "TAIT-5", typeName: "Task" },
            { key: "TAIT-9", typeName: "Epic Task" },
        ])!;
        assert.match(note, /Skipped 2 tickets/);
        assert.match(note, /TAIT-5 \("Task"\), TAIT-9 \("Epic Task"\)/);
        assert.match(note, /Type Aliases Confluence page/);
        assert.match(note, /issue update <KEY> persona=<PERSONA>/);
        assert.match(note, /unmanaged/);
    });
});
