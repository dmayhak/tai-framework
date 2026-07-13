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
});
