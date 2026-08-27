import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseReviewFindings, renderReviewFindings, type ReviewFindings } from "./review-findings.js";

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

describe("renderReviewFindings", () => {
    it("groups findings by severity in fixed order (critical, suggestion, nitpick, good)", () => {
        const rendered = renderReviewFindings(validFindings);
        const criticalIndex = rendered.indexOf("### 🔴 Critical");
        const nitpickIndex = rendered.indexOf("### 🔵 Nitpick");
        assert.ok(criticalIndex >= 0 && nitpickIndex >= 0);
        assert.ok(criticalIndex < nitpickIndex);
    });

    it("includes each finding's file, line, issue, and fix", () => {
        const rendered = renderReviewFindings(validFindings);
        assert.match(rendered, /src\/db\.ts.*line 42/);
        assert.match(rendered, /User input is concatenated directly into the query\./);
        assert.match(rendered, /```suggestion\n\s*use a parameterized query\n\s*```/);
    });

    it("omits empty severity sections", () => {
        const rendered = renderReviewFindings(validFindings);
        assert.ok(!rendered.includes("### 🟡 Suggestion"));
        assert.ok(!rendered.includes("### 🟢 Good"));
    });

    it("renders a 'no issues found' line when findings is empty", () => {
        const rendered = renderReviewFindings({ ...validFindings, findings: [] });
        assert.match(rendered, /No issues found/);
    });

    it("always ends with the leaning and its reason, never a decision", () => {
        const rendered = renderReviewFindings(validFindings);
        assert.match(rendered, /\*\*Leaning: Request changes\*\* — The SQL injection issue must be fixed before merge\./);
    });
});
