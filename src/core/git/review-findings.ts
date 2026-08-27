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
        throw new Error(`Findings input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
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
 * Deterministically renders `ReviewFindings` to markdown — grouped by severity, same shape
 * reviewd's own `commenter.py` uses (severity sections, per-finding file:line, bottom-line
 * leaning). This is the ONLY place this markdown gets composed — `git-pr render-findings`
 * (preview) and `comment-findings` (post) both call this rather than the model authoring
 * the write-up itself (ADR Decision §2).
 */
export function renderReviewFindings(findings: ReviewFindings): string {
    const lines: string[] = ["## Review", "", findings.overview, ""];

    const grouped = new Map<FindingSeverity, ReviewFinding[]>();
    for (const f of findings.findings) {
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
