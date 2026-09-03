import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { markdownToStorage, storageToMarkdown } from "./storage-format.js";

/** The property that actually matters: content TAI writes must survive a round trip. */
function roundTrip(md: string): string {
    return storageToMarkdown(markdownToStorage(md));
}

describe("markdown -> storage", () => {
    it("maps headings, paragraphs, and emphasis", () => {
        const s = markdownToStorage("# Title\n\nSome **bold** and *italic* text.");
        assert.match(s, /<h1>Title<\/h1>/);
        assert.match(s, /<strong>bold<\/strong>/);
        assert.match(s, /<em>italic<\/em>/);
    });

    it("escapes XHTML so page content cannot inject markup", () => {
        const s = markdownToStorage("A <script>alert(1)</script> & an ampersand");
        assert.doesNotMatch(s, /<script>/);
        assert.match(s, /&lt;script&gt;/);
        assert.match(s, /&amp;/);
    });

    it("does not mangle emphasis characters inside code spans", () => {
        const s = markdownToStorage("Use `a ** b` carefully");
        assert.match(s, /<code>a \*\* b<\/code>/);
        assert.doesNotMatch(s, /<strong>/);
    });

    it("wraps fenced code in the code macro with its language", () => {
        const s = markdownToStorage("```ts\nconst x = 1;\n```");
        assert.match(s, /ac:name="code"/);
        assert.match(s, /<ac:parameter ac:name="language">ts<\/ac:parameter>/);
        assert.match(s, /\[CDATA\[const x = 1;\]\]/);
    });

    it("maps a mermaid fence onto the adf-extension node", () => {
        // The recipe interface.ts documents and the project verified live. Without this,
        // Confluence renders "Unknown macro" — the reason a plain markdown fence is not enough.
        const s = markdownToStorage("```mermaid\ngraph TD;\nA-->B;\n```");
        assert.match(s, /<ac:adf-extension>/);
        assert.match(s, /<ac:adf-node type="extension">/);
        assert.match(s, /key="source"/);
        assert.match(s, /<ac:adf-fallback>/);
        // Source must be entity-escaped, never CDATA-wrapped (that's the code macro's rule).
        assert.match(s, /graph TD;/);
        assert.doesNotMatch(s, /<!\[CDATA\[graph/);
    });

    it("builds tables and lists", () => {
        const table = markdownToStorage("| A | B |\n| --- | --- |\n| 1 | 2 |");
        assert.match(table, /<table><tbody><tr><th>A<\/th><th>B<\/th><\/tr><tr><td>1<\/td><td>2<\/td><\/tr>/);
        assert.match(markdownToStorage("- one\n- two"), /<ul><li>one<\/li><li>two<\/li><\/ul>/);
        assert.match(markdownToStorage("1. one\n2. two"), /<ol><li>one<\/li><li>two<\/li><\/ol>/);
    });
});

describe("round trip (the contract: TAI's own content survives)", () => {
    it("headings", () => {
        assert.equal(roundTrip("# One\n\n## Two"), "# One\n\n## Two");
    });

    it("paragraph with emphasis, code, and a link", () => {
        const md = "Read **the brief** and `interface.ts` at [docs](https://x.test).";
        assert.equal(roundTrip(md), md);
    });

    it("a code span containing angle brackets, e.g. a <KEY>-style CLI placeholder (TAI-295)", () => {
        // Found live writing an ADR: `/tai-work <KEY>` round-tripped to `/tai-work ` --
        // storageToMarkdown's tag-strip pass was mistaking the unescaped placeholder for a
        // real, unrecognized HTML tag and silently dropping it.
        const md = "Run `/tai-work <ISSUE-KEY>` to start.";
        assert.equal(roundTrip(md), md);
    });

    it("a code span containing multiple angle-bracket placeholders", () => {
        const md = "See `.tai/cache/<project>/links/<key>.json` for the snapshot.";
        assert.equal(roundTrip(md), md);
    });

    it("fenced code, verbatim", () => {
        const md = "```ts\nconst x = 1;\nif (x > 0) { go(); }\n```";
        assert.equal(roundTrip(md), md);
    });

    it("mermaid diagrams — the whole reason this converter exists", () => {
        const md = "```mermaid\ngraph TD;\n  A-->B;\n```";
        assert.equal(roundTrip(md), md);
    });

    it("bullet and ordered lists", () => {
        assert.equal(roundTrip("- one\n- two"), "- one\n- two");
        assert.equal(roundTrip("1. one\n2. two"), "1. one\n2. two");
    });

    it("tables", () => {
        const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
        assert.equal(roundTrip(md), md);
    });

    it("a realistic ADR fragment, whole", () => {
        const md = [
            "# Status",
            "",
            "Accepted. Supersedes the **MCP-client** design.",
            "",
            "## Decision",
            "",
            "- Direct REST over `fetch`",
            "- Auth is injected",
            "",
            "| Condition | Behavior |",
            "| --- | --- |",
            "| 5xx | throw |",
            "| 4xx | return ok:false |",
        ].join("\n");
        assert.equal(roundTrip(md), md);
    });

    it("preserves characters that the MCP wrapper corrupted (+, **, _)", () => {
        // The wrapper ate `+` characters and escaped `**` nondeterministically while this
        // project's own backlog was being written. Direct REST + this converter must not.
        const md = "Node 20+ and `api_token` with **bold** intact";
        assert.equal(roundTrip(md), md);
    });
});

describe("storage -> markdown (best-effort for human-authored pages)", () => {
    it("recovers text from markup it has no markdown equivalent for", () => {
        const md = storageToMarkdown('<p>Hello <span style="color:red">world</span></p>');
        assert.equal(md, "Hello world");
    });

    it("decodes the entities Confluence emits", () => {
        assert.equal(storageToMarkdown("<p>A &mdash; B &sect;3.2 &amp; C</p>"), "A — B §3.2 & C");
    });

    it("drops empty blocks rather than emitting blank lines", () => {
        assert.equal(storageToMarkdown("<p></p><p>real</p>"), "real");
    });

    /**
     * REGRESSION SUITE. Every block-level element in REAL Confluence storage format carries
     * a `local-id` attribute (and often more) — this was found live: reading the actual TAIT
     * Home page through this function returned 99 characters out of a full page, because
     * every tag regex here used to require a bare, attribute-free opening tag.
     */
    describe("tolerates attributes real Confluence content always carries", () => {
        it("headings with local-id", () => {
            assert.equal(storageToMarkdown('<h2 local-id="8263dac94caf">Title</h2>'), "## Title");
        });

        it("paragraphs with local-id", () => {
            assert.equal(storageToMarkdown('<p local-id="abc">Hello</p>'), "Hello");
        });

        it("lists and list items with local-id", () => {
            assert.equal(
                storageToMarkdown('<ul local-id="a"><li local-id="b">one</li><li local-id="c">two</li></ul>'),
                "- one\n- two"
            );
        });

        it("tables, rows, and cells with local-id", () => {
            const storage =
                '<table local-id="t"><tbody><tr local-id="r1"><th local-id="c1">A</th></tr>' +
                '<tr local-id="r2"><td local-id="c2">1</td></tr></tbody></table>';
            assert.equal(storageToMarkdown(storage), "| A |\n| --- |\n| 1 |");
        });

        it("blockquotes with local-id", () => {
            assert.equal(
                storageToMarkdown('<blockquote local-id="q"><p local-id="p">quoted</p></blockquote>'),
                "> quoted"
            );
        });

        /**
         * REGRESSION, found live (not in any unit test — this is why the live re-verification
         * mattered). A self-closing empty `<p local-id="x" />` isn't distinguished from a real
         * opening tag by `[^>]*`, so the paragraph regex went hunting forward for the NEXT
         * `</p>` anywhere in the document — swallowing everything in between, including an
         * already-resolved earlier block's placeholder token, which then leaked into the
         * final markdown as literal `@@TAI_BLOCK_N@@` text instead of being replaced.
         */
        it("does not let a self-closing empty <p /> swallow everything up to the next </p>", () => {
            const storage =
                "<h2>Heading</h2>" +
                '<p local-id="empty" />' +
                "<p>Real paragraph that must not be swallowed</p>";
            const md = storageToMarkdown(storage);
            assert.doesNotMatch(md, /@@TAI_BLOCK/, "no raw placeholder token should ever leak into output");
            assert.match(md, /## Heading/);
            assert.match(md, /Real paragraph that must not be swallowed/);
        });

        it("normalizes self-closing forms of every block tag, not just <p>", () => {
            const storage = '<h2 local-id="x" /><p>after</p>';
            const md = storageToMarkdown(storage);
            assert.doesNotMatch(md, /@@TAI_BLOCK/);
            assert.match(md, /after/);
        });

        it("a code macro whose attributes precede ac:name (real Confluence ordering)", () => {
            // Real pages put ac:local-id / ac:macro-id / ac:schema-version BEFORE ac:name —
            // found on the live TAIT Home page. A regex requiring ac:name="code" to be first
            // or only never matches this, and previously dropped the whole macro.
            const storage =
                '<ac:structured-macro ac:local-id="x" ac:macro-id="y" ac:name="code" ac:schema-version="1">' +
                "<ac:plain-text-body><![CDATA[select 1;]]></ac:plain-text-body></ac:structured-macro>";
            assert.equal(storageToMarkdown(storage), "```\nselect 1;\n```");
        });

        it("the full TAIT Home page shape survives (condensed live reproduction)", () => {
            // A condensed version of the actual page that exposed the bug: a panel-wrapped
            // heading, then an attributed paragraph and list — all previously vanished.
            const storage =
                '<ac:structured-macro ac:local-id="a" ac:macro-id="b" ac:name="panel" ac:schema-version="1">' +
                '<ac:rich-text-body><h2 local-id="h">Welcome</h2>' +
                '<p local-id="p1">Some intro text.</p></ac:rich-text-body></ac:structured-macro>' +
                '<h3 local-id="h3">Next steps</h3>' +
                '<ul local-id="u"><li local-id="l1">Do the thing</li></ul>';
            const md = storageToMarkdown(storage);
            // The panel macro itself has no markdown equivalent, so it degrades to plain text
            // via the leftover-content fallback — but nothing inside it disappears.
            assert.match(md, /## Welcome/);
            assert.match(md, /Some intro text\./);
            assert.match(md, /### Next steps/);
            assert.match(md, /- Do the thing/);
        });
    });

    it("recovers a link even when Confluence adds attributes beyond href", () => {
        // Confluence's own editor commonly emits extra attributes on <a> (e.g.
        // data-linked-resource-id). A stricter match used to let the href fall through to the
        // generic tag-strip, silently turning the link into plain text with no href at all.
        const md = storageToMarkdown('<p><a href="https://x.test" data-linked-resource-id="1">docs</a></p>');
        assert.equal(md, "[docs](https://x.test)");
    });

    it("degrades genuinely unrecognized markup to text instead of dropping it", () => {
        // No block regex recognizes a bare <div>, but its content must still survive.
        const md = storageToMarkdown('<div class="whatever">Surviving text</div><p>And a real paragraph</p>');
        assert.match(md, /Surviving text/);
        assert.match(md, /And a real paragraph/);
    });
});

describe("CDATA safety (the ]]> escape, TAI-15 code review)", () => {
    it("a code block containing the literal sequence ]]> does not corrupt the storage output", () => {
        const md = "```\na]]>b\n```";
        const storage = markdownToStorage(md);
        // The literal sequence must not appear unescaped mid-CDATA — it must be split across
        // a CDATA-close/reopen boundary per the standard XML technique.
        assert.doesNotMatch(storage, /a\]\]>b/);
        assert.match(storage, /a\]\]\]\]><!\[CDATA\[>b/);
    });

    it("round-trips a code block containing ]]> back to the original markdown", () => {
        const md = "```\na]]>b\n```";
        assert.equal(storageToMarkdown(markdownToStorage(md)), md);
    });
});
