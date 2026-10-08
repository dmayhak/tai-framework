/**
 * TAI Framework — structured review-findings contract for tai-pr's review step
 * (TAI-209 ADR, Confluence page 30343169)
 *
 * Cole's review step emits ONLY this structured data, never composed prose — rendering to
 * human-readable markdown happens here, deterministically, not in the model's own turn.
 * This is what actually removes the narrative-conclusion-as-stopping-point risk TAI-202/203
 * hit (ADR Decision §2): there's no narrative for the model to compose, so there's nothing
 * for a "looks done" trap to form around. `git-pr render-findings`/`comment-findings`
 * (`cli.ts`) are the only callers — the model runs those, never authors this markdown by
 * hand.
 *
 * Severity taxonomy and rendering shape follow reviewd's own proven design
 * (`reviewd`'s `models.py`/`commenter.py`) — ADR Decision §1/§2 — with one
 * deliberate departure: `leaning`/`leaningReason` replace reviewd's `approve: bool`, since
 * nothing in tai-pr auto-approves (brief §3.4) and Cole's own decision axis is the ternary
 * approve/requestChanges/neither a human always makes, not a bot's auto-approve gate.
 */

import { readFileSync } from "node:fs";

export type FindingSeverity = "critical" | "suggestion" | "nitpick" | "good";

const SEVERITY_ORDER: readonly FindingSeverity[] = ["critical", "suggestion", "nitpick", "good"];

const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
    critical: "🔴",
    suggestion: "🟡",
    nitpick: "🔵",
    good: "🟢",
};

export interface ReviewFinding {
    readonly severity: FindingSeverity;
    readonly category: string;
    readonly title: string;
    readonly file: string;
    readonly line?: number;
    readonly issue: string;
    readonly fix?: string;
}

export type ReviewLeaning = "approve" | "requestChanges" | "neither";

export interface ReviewFindings {
    readonly overview: string;
    readonly findings: readonly ReviewFinding[];
    readonly leaning: ReviewLeaning;
    readonly leaningReason: string;
}

const VALID_SEVERITIES: readonly string[] = SEVERITY_ORDER;
const VALID_LEANINGS: readonly string[] = ["approve", "requestChanges", "neither"];

function requireString(obj: Record<string, unknown>, field: string, context: string): string {
    const value = obj[field];
    if (typeof value !== "string") throw new Error(`${context} is missing a string "${field}".`);
    return value;
}

/**
 * Parses and validates a `ReviewFindings` payload — either a raw JSON string, or `@<path>`
 * to read the JSON from a file (ADR Decision §2: "written to a temp file or passed
 * inline"). Throws with a specific, actionable message on any structural problem rather
 * than silently coercing — this is model-authored input, not a trusted internal call site.
 */
export function parseReviewFindings(raw: string): ReviewFindings {
    const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`Findings input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Findings input must be a JSON object.");
    }
    const obj = parsed as Record<string, unknown>;

    const overview = requireString(obj, "overview", "Findings JSON");
    if (!Array.isArray(obj["findings"])) throw new Error('Findings JSON is missing a "findings" array.');
    const leaning = obj["leaning"];
    if (typeof leaning !== "string" || !VALID_LEANINGS.includes(leaning)) {
        throw new Error(`Findings JSON "leaning" must be one of ${VALID_LEANINGS.join("|")}, got ${JSON.stringify(leaning)}.`);
    }
    const leaningReason = requireString(obj, "leaningReason", "Findings JSON");

    const findings: ReviewFinding[] = (obj["findings"] as unknown[]).map((raw, i) => {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            throw new Error(`Finding at index ${i} is not an object.`);
        }
        const f = raw as Record<string, unknown>;
        const context = `Finding at index ${i}`;
        const severity = f["severity"];
        if (typeof severity !== "string" || !VALID_SEVERITIES.includes(severity)) {
            throw new Error(`${context} has invalid "severity" ${JSON.stringify(severity)} — expected one of ${VALID_SEVERITIES.join("|")}.`);
        }
        const category = requireString(f, "category", context);
        const title = requireString(f, "title", context);
        const file = requireString(f, "file", context);
        const issue = requireString(f, "issue", context);
        if (f["line"] !== undefined && typeof f["line"] !== "number") {
            throw new Error(`${context}'s "line" must be a number if present.`);
        }
        if (f["fix"] !== undefined && typeof f["fix"] !== "string") {
            throw new Error(`${context}'s "fix" must be a string if present.`);
        }
        return {
            severity: severity as FindingSeverity,
            category,
            title,
            file,
            issue,
            ...(f["line"] !== undefined ? { line: f["line"] as number } : {}),
            ...(f["fix"] !== undefined ? { fix: f["fix"] as string } : {}),
        };
    });

    return { overview, findings, leaning: leaning as ReviewLeaning, leaningReason };
}

const LEANING_LABEL: Record<ReviewLeaning, string> = {
    approve: "Approve",
    requestChanges: "Request changes",
    neither: "Neither",
};

function renderFinding(f: ReviewFinding): string {
    const loc = f.line !== undefined ? `\`${f.file}\` (line ${f.line})` : `\`${f.file}\``;
    const lines = [`- **${f.title}** — ${loc}`, `  ${f.issue}`];
    if (f.fix) lines.push(`  \`\`\`suggestion\n  ${f.fix}\n  \`\`\``);
    return lines.join("\n");
}

/**
 * TAI-209 ADR Decision §4: the inline-vs-summary threshold is hardcoded to `critical` only
 * for v1 (matches reviewd's own default `inline_comments_for: ["critical"]`) — no config
 * surface yet. A finding also needs a `line` to be inline-postable at all (Bitbucket's
 * inline-comment API anchors to a specific file+line; `file` alone can't anchor).
 */
export function isInlineEligible(f: ReviewFinding): boolean {
    return f.severity === "critical" && f.line !== undefined;
}

/**
 * Splits `findings` into the ones that get posted as inline PR comments vs. the ones that
 * stay in the summary comment (TAI-207/209: "mirrors reviewd's inline_comments_for
 * pattern") — shared by `renderReviewFindings` (so the preview accurately reflects what
 * `comment-findings` will actually do) and `comment-findings` itself (`cli.ts`), which needs
 * the raw `ReviewFinding`s, not just rendered text, to call `GitHost.addInlineComment` per
 * finding.
 */
export function partitionInlineFindings(findings: readonly ReviewFinding[]): {
    readonly inline: readonly ReviewFinding[];
    readonly summary: readonly ReviewFinding[];
} {
    const inline: ReviewFinding[] = [];
    const summary: ReviewFinding[] = [];
    for (const f of findings) (isInlineEligible(f) ? inline : summary).push(f);
    return { inline, summary };
}

/**
 * The body posted via `GitHost.addInlineComment` for one inline-eligible finding — no
 * file:line prefix (unlike `renderFinding`'s summary form), since Bitbucket's own inline
 * anchor already places the comment at that exact line. Same shape reviewd's
 * `_format_inline_comment` uses.
 */
export function renderInlineComment(f: ReviewFinding): string {
    const parts = [`${SEVERITY_EMOJI[f.severity]} **${f.title}**`, f.issue];
    if (f.fix) parts.push(`\`\`\`suggestion\n${f.fix}\n\`\`\``);
    return parts.join("\n\n");
}

const MAX_TALLY_DOTS = 3;

/**
 * Compact emoji tally of `inline` findings for the summary comment, e.g. "🔴🔴🔴+2 — posted
 * as inline comments" — same shape reviewd's `_format_inline_tally` uses, so a human sees
 * at a glance that SOME findings were pulled out of the summary and posted inline instead,
 * rather than the summary silently having fewer findings than expected.
 */
function renderInlineTally(inline: readonly ReviewFinding[]): string {
    const counts = new Map<FindingSeverity, number>();
    for (const f of inline) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);

    const parts: string[] = [];
    for (const severity of SEVERITY_ORDER) {
        const count = counts.get(severity) ?? 0;
        if (count === 0) continue;
        const shown = Math.min(count, MAX_TALLY_DOTS);
        const overflow = count > MAX_TALLY_DOTS ? `+${count - MAX_TALLY_DOTS}` : "";
        parts.push(SEVERITY_EMOJI[severity].repeat(shown) + overflow);
    }
    return `${parts.join(" ")} — posted as inline comments`;
}

/**
 * Deterministically renders `ReviewFindings` to markdown — grouped by severity, same shape
 * reviewd's own `commenter.py` uses (severity sections, per-finding file:line, bottom-line
 * leaning). This is the ONLY place this markdown gets composed — `git-pr render-findings`
 * (preview) and `comment-findings` (post) both call this rather than the model authoring
 * the write-up itself (ADR Decision §2).
 *
 * TAI-207: inline-eligible findings (`partitionInlineFindings`) are excluded from the
 * severity sections below and replaced with a one-line tally — same split reviewd's own
 * `_format_summary_comment` makes (`summary_findings = findings not in inline_ids`) — so
 * this rendering accurately previews what `comment-findings` will actually post where, not
 * just what the summary comment alone will contain.
 *
 * `partition` defaults to the eligibility-based split (correct for `render-findings`'
 * preview, where nothing has actually been posted anywhere yet). `comment-findings`
 * (`cli.ts`) passes an EXPLICIT partition instead, computed from what actually succeeded
 * after attempting each inline post — a finding whose inline post failed falls back into
 * `summary` there rather than vanishing (it's eligible, but not actually posted, so it must
 * not be excluded from the one place it's still visible).
 */
export function renderReviewFindings(
    findings: ReviewFindings,
    partition: {
        readonly inline: readonly ReviewFinding[];
        readonly summary: readonly ReviewFinding[];
    } = partitionInlineFindings(findings.findings)
): string {
    const lines: string[] = ["## Review", "", findings.overview, ""];

    const { inline, summary } = partition;
    if (inline.length > 0) lines.push(renderInlineTally(inline), "");

    const grouped = new Map<FindingSeverity, ReviewFinding[]>();
    for (const f of summary) {
        const bucket = grouped.get(f.severity) ?? [];
        bucket.push(f);
        grouped.set(f.severity, bucket);
    }

    for (const severity of SEVERITY_ORDER) {
        const bucket = grouped.get(severity);
        if (!bucket || bucket.length === 0) continue;
        lines.push(`### ${SEVERITY_EMOJI[severity]} ${severity[0]!.toUpperCase()}${severity.slice(1)} (${bucket.length})`, "");
        for (const f of bucket) lines.push(renderFinding(f), "");
    }

    if (findings.findings.length === 0) lines.push("_No issues found._", "");

    lines.push(`**Leaning: ${LEANING_LABEL[findings.leaning]}** — ${findings.leaningReason}`);

    return lines.join("\n");
}

const NEXT_STEP_OPTIONS: readonly { readonly text: string; readonly suggestedFor?: ReviewLeaning }[] = [
    { text: "post and approve", suggestedFor: "approve" },
    { text: "post the findings only" },
    { text: "approve only (no comment)" },
    { text: "post and request changes", suggestedFor: "requestChanges" },
    { text: "neither", suggestedFor: "neither" },
];

/**
 * TAI-411: the numbered "what next?" list shown after the findings preview. The review flow
 * deliberately stops after printing the findings (TAI-202/203/209 -- no same-turn question), so this
 * list is what tells the human what they can say next. It is produced HERE, deterministically, and
 * arrives inside the stdout the session pastes verbatim -- never composed by the model.
 *
 * Used ONLY by `renderFindingsPreview` (the `render-findings` CLI action). It must never be added to
 * `renderReviewFindings`, which `comment-findings` posts to the PR: this list is for the human at the
 * terminal, not part of the review.
 */
export function renderFindingsNextSteps(leaning: ReviewLeaning): string {
    const lines = NEXT_STEP_OPTIONS.map(
        (o, i) => `${i + 1}. ${o.text}${o.suggestedFor === leaning ? " (suggested)" : ""}`
    );
    return ["---", "Nothing has been posted yet. What would you like to do? Reply with a number or plain words:", ...lines].join("\n");
}

/** `git-pr render-findings`' output: the rendered findings, then the next-step options. */
export function renderFindingsPreview(findings: ReviewFindings): string {
    return `${renderReviewFindings(findings)}\n\n${renderFindingsNextSteps(findings.leaning)}`;
}
