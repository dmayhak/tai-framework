import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseCommentMarker, skippedSubtaskTypeTokens } from "./comment-markers.js";
import { toHumanId, type Comment } from "./interface.js";

function comment(body: string, id = "c1"): Comment {
    const author = { id: toHumanId("del@example.com"), displayName: "Del", email: "del@example.com" };
    return { id, author, body, createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z" };
}

describe("Skipped: marker (TAI-443)", () => {
    test("parses one type and a reason after an em dash", () => {
        const m = parseCommentMarker(comment("Skipped: ux-design — backend-only epic"));
        assert.equal(m?.kind, "Skipped");
        assert.deepEqual(m?.skippedTypes, ["uxdesign"]);
        assert.equal(m?.note, "backend-only epic");
    });

    test("parses several types separated by commas and 'and'", () => {
        assert.deepEqual(parseCommentMarker(comment("Skipped: requirements, ux-design"))?.skippedTypes, ["requirements", "uxdesign"]);
        assert.deepEqual(parseCommentMarker(comment("skipped: Requirements and UxDesign - not needed"))?.skippedTypes, [
            "requirements",
            "uxdesign",
        ]);
    });

    test("a type spelled with a space instead of a hyphen still names that type", () => {
        assert.ok(parseCommentMarker(comment("Skipped: ux design — backend-only"))?.skippedTypes?.includes("uxdesign"));
        assert.ok(parseCommentMarker(comment("Skipped: requirements, ux design"))?.skippedTypes?.includes("uxdesign"));
        assert.ok(parseCommentMarker(comment("Skipped: requirements, ux design"))?.skippedTypes?.includes("requirements"));
    });

    test("every reason separator ends the type list: em dash, en dash, ' - ' and ' -- '", () => {
        for (const sep of ["\u2014", "\u2013", " - ", " -- "]) {
            const m = parseCommentMarker(comment(`Skipped: ux-design ${sep} backend-only epic`));
            assert.deepEqual(m?.skippedTypes, ["uxdesign"], `separator ${JSON.stringify(sep)}`);
            assert.equal(m?.note, "backend-only epic", `separator ${JSON.stringify(sep)}`);
        }
    });

    test("a hyphen inside a word does not end the type list", () => {
        const m = parseCommentMarker(comment("Skipped: ux-design, epic-review"));
        assert.deepEqual(m?.skippedTypes, ["uxdesign", "epicreview"]);
        assert.equal(m?.note, undefined);
    });

    test("a marker with no types is a marker with an empty list", () => {
        assert.deepEqual(parseCommentMarker(comment("Skipped: — because"))?.skippedTypes, []);
    });

    test("only the first line counts, like the other markers", () => {
        assert.equal(parseCommentMarker(comment("note\nSkipped: ux-design")), null);
    });

    test("skippedSubtaskTypeTokens unions every Skipped: comment and ignores the rest", () => {
        const tokens = skippedSubtaskTypeTokens([
            comment("Skipped: ux-design — backend-only", "a"),
            comment("Approved: ok", "b"),
            comment("Skipped: requirements", "c"),
            comment("chatter about Skipped: epic-review", "d"),
        ]);
        assert.deepEqual([...tokens].sort(), ["requirements", "uxdesign"]);
    });
});
