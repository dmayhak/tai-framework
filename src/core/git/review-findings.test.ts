import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    parseReviewFindings,
    renderReviewFindings,
    renderFindingsNextSteps,
    renderFindingsPreview,
    partitionInlineFindings,
    isInlineEligible,
    renderInlineComment,
    type ReviewFindings,
} from "./review-findings.js";

const validFindings: ReviewFindings = {
    overview: "Small, well-scoped change.",
    findings: [
        {
            severity: "critical",
            category: "Security",
            title: "SQL injection",
            file: "src/db.ts",
            line: 42,
            issue: "User input is concatenated directly into the query.",
            fix: "use a parameterized query",
        },
        {
            severity: "nitpick",
            category: "Style",
            title: "Inconsistent naming",
            file: "src/db.ts",
            issue: "Prefer camelCase here to match the rest of the file.",
        },
    ],
    leaning: "requestChanges",
    leaningReason: "The SQL injection issue must be fixed before merge.",
};

describe("parseReviewFindings", () => {
    it("parses a valid findings object from a raw JSON string", () => {
        const parsed = parseReviewFindings(JSON.stringify(validFindings));
        assert.deepEqual(parsed, validFindings);
    });

    it("reads from a file when given an @path argument", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-findings-"));
        const file = path.join(dir, "findings.json");
        try {
            await writeFile(file, JSON.stringify(validFindings), "utf8");
            const parsed = parseReviewFindings(`@${file}`);
            assert.deepEqual(parsed, validFindings);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("throws on invalid JSON", () => {
        assert.throws(() => parseReviewFindings("{not json"), /not valid JSON/);
    });

    it("throws when the top-level value isn't an object", () => {
        assert.throws(() => parseReviewFindings("[]"), /must be a JSON object/);
    });

    it("throws when a required top-level field is missing", () => {
        const { overview: _overview, ...rest } = validFindings;
        assert.throws(() => parseReviewFindings(JSON.stringify(rest)), /"overview"/);
    });

    it("throws on an invalid leaning value rather than silently coercing", () => {
        assert.throws(
            () => parseReviewFindings(JSON.stringify({ ...validFindings, leaning: "yes" })),
            /"leaning" must be one of/
        );
    });

    it("throws on an invalid finding severity", () => {
        const bad = { ...validFindings, findings: [{ ...validFindings.findings[0], severity: "urgent" }] };
        assert.throws(() => parseReviewFindings(JSON.stringify(bad)), /invalid "severity"/);
    });

    it("throws when a finding is missing a required field", () => {
        const { issue: _issue, ...restFinding } = validFindings.findings[0]!;
        const bad = { ...validFindings, findings: [restFinding] };
        assert.throws(() => parseReviewFindings(JSON.stringify(bad)), /"issue"/);
    });

    it("accepts a finding with no line/fix (both optional)", () => {
        const minimal = {
            ...validFindings,
            findings: [{ severity: "good", category: "Architecture", title: "Clean split", file: "src/db.ts", issue: "Nicely factored." }],
        };
        const parsed = parseReviewFindings(JSON.stringify(minimal));
        assert.equal(parsed.findings[0]!.line, undefined);
        assert.equal(parsed.findings[0]!.fix, undefined);
    });
});

// A partition that treats nothing as inline -- isolates the pure severity-grouping/
// per-finding rendering behavior from TAI-207's default auto-partitioning (covered
// separately below), since `validFindings`' critical finding has a `line` and is
// therefore inline-eligible by default.
const noneInline = { inline: [], summary: validFindings.findings };

describe("renderReviewFindings", () => {
    it("groups findings by severity in fixed order (critical, suggestion, nitpick, good)", () => {
        const rendered = renderReviewFindings(validFindings, noneInline);
        const criticalIndex = rendered.indexOf("### 🔴 Critical");
        const nitpickIndex = rendered.indexOf("### 🔵 Nitpick");
        assert.ok(criticalIndex >= 0 && nitpickIndex >= 0);
        assert.ok(criticalIndex < nitpickIndex);
    });

    it("includes each finding's file, line, issue, and fix", () => {
        const rendered = renderReviewFindings(validFindings, noneInline);
        assert.match(rendered, /src\/db\.ts.*line 42/);
        assert.match(rendered, /User input is concatenated directly into the query\./);
        assert.match(rendered, /```suggestion\n\s*use a parameterized query\n\s*```/);
    });

    it("omits empty severity sections", () => {
        const rendered = renderReviewFindings(validFindings, noneInline);
        assert.ok(!rendered.includes("### 🟡 Suggestion"));
        assert.ok(!rendered.includes("### 🟢 Good"));
    });

    it("renders a 'no issues found' line when findings is empty", () => {
        const rendered = renderReviewFindings({ ...validFindings, findings: [] });
        assert.match(rendered, /No issues found/);
    });

    it("always ends with the leaning and its reason, never a decision", () => {
        const rendered = renderReviewFindings(validFindings, noneInline);
        assert.match(rendered, /\*\*Leaning: Request changes\*\* — The SQL injection issue must be fixed before merge\./);
    });

    // TAI-207: default partitioning (no explicit `partition` argument) pulls
    // critical+line findings out of the severity sections and into a tally instead --
    // this is what makes `render-findings`' preview match what `comment-findings` will
    // actually post where.
    it("by default, excludes a critical+line finding from its severity section and shows a tally instead", () => {
        const rendered = renderReviewFindings(validFindings);
        assert.ok(!rendered.includes("### 🔴 Critical"));
        assert.ok(!rendered.includes("**SQL injection**"));
        assert.match(rendered, /🔴 — posted as inline comments/);
        // The non-eligible nitpick finding still renders normally.
        assert.match(rendered, /Inconsistent naming/);
    });

    it("does not show a tally line when nothing is inline-eligible", () => {
        const rendered = renderReviewFindings(validFindings, noneInline);
        assert.ok(!rendered.includes("posted as inline comments"));
    });
});

describe("isInlineEligible / partitionInlineFindings (TAI-207)", () => {
    it("a critical finding with a line is eligible", () => {
        assert.equal(isInlineEligible(validFindings.findings[0]!), true);
    });

    it("a critical finding with no line is not eligible", () => {
        const { line: _line, ...withoutLine } = validFindings.findings[0]!;
        assert.equal(isInlineEligible(withoutLine), false);
    });

    it("a non-critical finding with a line is not eligible", () => {
        assert.equal(isInlineEligible({ ...validFindings.findings[0]!, severity: "suggestion" }), false);
    });

    it("splits findings into inline vs. summary buckets, preserving relative order within each", () => {
        const { inline, summary } = partitionInlineFindings(validFindings.findings);
        assert.deepEqual(inline, [validFindings.findings[0]]);
        assert.deepEqual(summary, [validFindings.findings[1]]);
    });
});

describe("renderInlineComment (TAI-207)", () => {
    it("renders the severity emoji, title, issue, and fix -- with no file:line prefix", () => {
        const rendered = renderInlineComment(validFindings.findings[0]!);
        assert.match(rendered, /^🔴 \*\*SQL injection\*\*/);
        assert.match(rendered, /User input is concatenated directly into the query\./);
        assert.match(rendered, /```suggestion\nuse a parameterized query\n```/);
        assert.ok(!rendered.includes("src/db.ts"));
    });

    it("omits the suggestion block when there's no fix", () => {
        const rendered = renderInlineComment(validFindings.findings[1]!);
        assert.ok(!rendered.includes("```suggestion"));
    });
});

describe("render-findings next-step options (TAI-411)", () => {
    const optionLines = (text: string) => text.split("\n").filter((l) => /^\d\. /.test(l));

    it("lists the five numbered options and says nothing has been posted yet", () => {
        const out = renderFindingsNextSteps("approve");
        assert.match(out, /Nothing has been posted yet\./);
        assert.deepEqual(
            optionLines(out).map((l) => l.replace(" (suggested)", "")),
            [
                "1. post and approve",
                "2. post the findings only",
                "3. approve only (no comment)",
                "4. post and request changes",
                "5. neither",
            ]
        );
    });

    it("marks exactly the option matching the leaning as suggested", () => {
        const suggested = (leaning: "approve" | "requestChanges" | "neither") =>
            optionLines(renderFindingsNextSteps(leaning)).filter((l) => l.includes("(suggested)"));
        assert.deepEqual(suggested("approve"), ["1. post and approve (suggested)"]);
        assert.deepEqual(suggested("requestChanges"), ["4. post and request changes (suggested)"]);
        assert.deepEqual(suggested("neither"), ["5. neither (suggested)"]);
    });

    it("the preview is the rendered findings followed by the options", () => {
        const preview = renderFindingsPreview(validFindings);
        assert.ok(preview.startsWith(renderReviewFindings(validFindings)));
        assert.ok(preview.endsWith(renderFindingsNextSteps(validFindings.leaning)));
    });

    it("the options NEVER appear in renderReviewFindings -- that is the text comment-findings posts to the PR", () => {
        for (const leaning of ["approve", "requestChanges", "neither"] as const) {
            const posted = renderReviewFindings({ ...validFindings, leaning });
            assert.ok(!posted.includes("Nothing has been posted yet"));
            assert.ok(!posted.includes("What would you like to do"));
            assert.equal(optionLines(posted).filter((l) => /post and approve|post the findings only/.test(l)).length, 0);
        }
    });
});
