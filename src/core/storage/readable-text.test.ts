import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LONG_PARAGRAPH, longestParagraph, wallOfTextNote } from "./readable-text.js";

const sentence = "A sentence of about fifty characters, give or take. ";

describe("longestParagraph", () => {
    it("measures a single paragraph", () => {
        assert.equal(longestParagraph("abc def"), 7);
    });

    it("joins hard-wrapped lines of one paragraph and stops at a blank line", () => {
        assert.equal(longestParagraph("abc\ndef\n\nxy"), 7);
    });

    it("counts every list item on its own, whatever the marker", () => {
        assert.equal(longestParagraph("Intro\n* one\n* twotwo\n- three\n1. four\n# five"), 8);
    });

    it("does not count a code block, in wiki markup or markdown", () => {
        const code = "x".repeat(900);
        assert.equal(longestParagraph(`before\n{code:bash}\n${code}\n{code}\nafter`), 6);
        assert.equal(longestParagraph(`before\n\`\`\`\n${code}\n\`\`\`\nafter`), 6);
        assert.equal(longestParagraph(`{code}${code}{code}\nafter`), 5);
    });
});

describe("wallOfTextNote", () => {
    const wall = sentence.repeat(14);

    it("says nothing about text that reads fine, or about no text", () => {
        assert.equal(wallOfTextNote("description", "Short.\n\n* one\n* two"), null);
        assert.equal(wallOfTextNote("description", undefined), null);
        assert.equal(wallOfTextNote("description", `${sentence.repeat(6)}\n\n${sentence.repeat(6)}`), null);
    });

    it("points out a long unbroken paragraph, with its length and the command that fixes it", () => {
        assert.ok(wall.trim().length > LONG_PARAGRAPH);
        const note = wallOfTextNote("description", wall, "issue update TAI-1 description=…");
        assert.match(note ?? "", new RegExp(`this description has an unbroken ${wall.trim().length}-character paragraph`));
        assert.match(note ?? "", /blank line/);
        assert.match(note ?? "", /Rewrite it with `issue update TAI-1 description=…`\._$/);
    });

    it("has no fix command to offer for a comment", () => {
        assert.match(wallOfTextNote("comment", wall) ?? "", /this comment has .* Keep the next one shorter\._$/);
    });
});
