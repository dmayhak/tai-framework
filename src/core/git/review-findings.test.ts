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
    coverageNotes,
    unreadChangedFiles,
    raisesNoIssue,
    LARGE_DIFF_LINES,
    type ReviewFindings,
    type ReviewManifest,
} from "./review-findings.js";

const validFindings: ReviewFindings = {
    reviewOf: { repo: "acme/widgets", pr: "7", commit: "abc123def456" },
    overview: "Small, well-scoped change.",
    coverage: {
        filesRead: ["src/db.ts"],
        commandsRun: ["npm test"],
        claimsVerified: ["The query is parameterized: read src/db.ts line 42, it is not."],
        notChecked: "The migration files; I did not run the linter.",
    },
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

describe("the coverage block and reviewOf (TAI-527 ADR decision 1)", () => {
    const without = (field: string): string => {
        const copy = JSON.parse(JSON.stringify(validFindings)) as Record<string, unknown>;
        delete copy[field];
        return JSON.stringify(copy);
    };
    const withCoverage = (patch: Record<string, unknown>): string => JSON.stringify({ ...validFindings, coverage: { ...validFindings.coverage, ...patch } });

    it("refuses a payload with no coverage block, saying what to add", () => {
        assert.throws(() => parseReviewFindings(without("coverage")), /missing "coverage": a review has to say what it is based on.*"filesRead"/s);
    });

    it("refuses a payload with no reviewOf", () => {
        assert.throws(() => parseReviewFindings(without("reviewOf")), /missing "reviewOf" — copy it from review-prep's output/);
    });

    it("refuses a review that read no file, or that leaves notChecked empty", () => {
        assert.throws(() => parseReviewFindings(withCoverage({ filesRead: [] })), /"coverage\.filesRead" is empty/);
        assert.throws(() => parseReviewFindings(withCoverage({ filesRead: ["  "] })), /"coverage\.filesRead" is empty/);
        assert.throws(() => parseReviewFindings(withCoverage({ notChecked: "  " })), /"coverage\.notChecked" is empty/);
    });

    it("refuses a coverage list that is not an array of strings", () => {
        assert.throws(() => parseReviewFindings(withCoverage({ commandsRun: "npm test" })), /"coverage\.commandsRun" must be an array of strings/);
        assert.throws(() => parseReviewFindings(withCoverage({ claimsVerified: [1] })), /"coverage\.claimsVerified" must be an array of strings/);
    });

    it("accepts a review that ran nothing and verified no claim, as long as it says what it did not check", () => {
        const parsed = parseReviewFindings(withCoverage({ commandsRun: [], claimsVerified: [] }));
        assert.deepEqual(parsed.coverage.commandsRun, []);
        assert.deepEqual(parsed.coverage.claimsVerified, []);
    });

    it("accepts a numeric pr in reviewOf and keeps it as text", () => {
        const parsed = parseReviewFindings(JSON.stringify({ ...validFindings, reviewOf: { repo: "acme/widgets", pr: 7, commit: "abc" } }));
        assert.equal(parsed.reviewOf.pr, "7");
    });

    it("prints the coverage with the review, where it will be posted", () => {
        const out = renderReviewFindings(validFindings);
        assert.match(out, /### What this review is based on/);
        assert.match(out, /- \*\*Files read \(1\):\*\* `src\/db\.ts`/);
        assert.match(out, /- \*\*Commands run:\*\* `npm test`/);
        assert.match(out, / {2}- The query is parameterized: read src\/db\.ts line 42, it is not\./);
        assert.match(out, /- \*\*Not checked:\*\* The migration files; I did not run the linter\./);
        assert.ok(out.indexOf("### What this review is based on") < out.indexOf("**Leaning:"));
    });

    it("says none where a list is empty", () => {
        const out = renderReviewFindings({ ...validFindings, coverage: { ...validFindings.coverage, commandsRun: [], claimsVerified: [] } });
        assert.match(out, /- \*\*Commands run:\*\* none/);
        assert.match(out, /- \*\*Claims verified:\*\* none/);
    });
});

describe("cross-checking a review against the PR's changed files (TAI-527)", () => {
    const manifest = (over: Partial<ReviewManifest> = {}): ReviewManifest => ({ repo: "acme/widgets", pr: "7", commit: "abc123def456", files: ["src/db.ts", "src/api.ts"], diffLines: 40, ...over });
    const clean: ReviewFindings = { ...validFindings, findings: [{ severity: "good", category: "Style", title: "Tidy", file: "src/db.ts", issue: "Reads well." }], leaning: "approve" };

    it("names every changed file the reviewer did not list as read", () => {
        assert.deepEqual(unreadChangedFiles(validFindings.coverage, manifest()), ["src/api.ts"]);
        assert.deepEqual(unreadChangedFiles({ ...validFindings.coverage, filesRead: ["./src/db.ts", "src/api.ts"] }, manifest()), []);
        assert.match(coverageNotes(validFindings, manifest()).join("\n"), /\*\*1 of 2 changed files are not listed as read:\*\* `src\/api\.ts`/);
    });

    it("says so when review-prep has not been run for this PR in this clone", () => {
        assert.match(coverageNotes(validFindings, null).join("\n"), /Not cross-checked: `review-prep` has not been run for this PR in this clone/);
    });

    it("says when the review is of a different commit than review-prep last saw", () => {
        assert.match(coverageNotes(validFindings, manifest({ commit: "fff000" })).join("\n"), /This review is of commit abc123def456; the PR was at fff000/);
    });

    it("flags a review that raises no issue on a large diff, and not one on a small diff or with a real finding", () => {
        const all = { ...clean, coverage: { ...clean.coverage, filesRead: ["src/db.ts", "src/api.ts"] } };
        assert.equal(raisesNoIssue(all), true);
        assert.match(coverageNotes(all, manifest({ diffLines: LARGE_DIFF_LINES })).join("\n"), /No issue was raised on a diff of 2 files and 200 lines/);
        assert.deepEqual(coverageNotes(all, manifest({ diffLines: LARGE_DIFF_LINES - 1 })), []);
        const withIssue = { ...validFindings, coverage: all.coverage };
        assert.equal(raisesNoIssue(withIssue), false);
        assert.deepEqual(coverageNotes(withIssue, manifest({ diffLines: 5000 })), []);
    });

    it("the notes are part of the rendered review and of the preview", () => {
        assert.match(renderReviewFindings(validFindings, undefined, manifest()), /1 of 2 changed files are not listed as read/);
        assert.match(renderFindingsPreview(validFindings, manifest()), /1 of 2 changed files are not listed as read/);
    });
});
