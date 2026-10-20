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
 * (the `reviewd` project's `models.py`/`commenter.py`) — ADR Decision §1/§2 — with one
 * deliberate departure: `leaning`/`leaningReason` replace reviewd's `approve: bool`, since
 * nothing in tai-pr auto-approves (brief §3.4) and Cole's own decision axis is the ternary
 * approve/requestChanges/neither a human always makes, not a bot's auto-approve gate.
 */

import { createHash } from "node:crypto";
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

/** TAI-527 ADR decision 1: which PR, at which commit, the review is of. Copied from review-prep's output. */
export interface ReviewOf {
    readonly repo: string;
    readonly pr: string;
    readonly commit: string;
}

/**
 * TAI-527 ADR decision 1: what the review is based on. Self-declared — code cannot prove it — but
 * required, printed with the review and cross-checked against the PR's changed files, so "no issues"
 * and "did not look" stop looking the same.
 */
export interface ReviewCoverage {
    /** Changed files the reviewer read in full. At least one. */
    readonly filesRead: readonly string[];
    /** Commands actually run for this review (tests, lint, a grep), each as typed. May be empty. */
    readonly commandsRun: readonly string[];
    /** Claims from the ticket or the author checked against the code, each with how. May be empty. */
    readonly claimsVerified: readonly string[];
    /** What was not read, run or checked. Never empty: "nothing" is not an answer a review can give. */
    readonly notChecked: string;
}

export interface ReviewFindings {
    readonly reviewOf: ReviewOf;
    readonly overview: string;
    readonly coverage: ReviewCoverage;
    readonly findings: readonly ReviewFinding[];
    readonly leaning: ReviewLeaning;
    readonly leaningReason: string;
}

/** What review-prep saved about the PR's diff, for the cross-check (`review-prep.ts` writes it). */
export interface ReviewManifest {
    readonly repo: string;
    readonly pr: string;
    readonly commit: string;
    readonly files: readonly string[];
    readonly diffLines: number;
}

/** A diff at least this big with no issue raised gets a line saying so (TAI-527 ADR). */
export const LARGE_DIFF_LINES = 200;
export const LARGE_DIFF_FILES = 8;

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

    const reviewOf = parseReviewOf(obj["reviewOf"]);
    const overview = requireString(obj, "overview", "Findings JSON");
    const coverage = parseCoverage(obj["coverage"]);
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

    return { reviewOf, overview, coverage, findings, leaning: leaning as ReviewLeaning, leaningReason };
}

const COVERAGE_HELP =
    'Add it as review-prep\'s steps describe: "coverage": { "filesRead": [...], "commandsRun": [...], "claimsVerified": [...], "notChecked": "..." }.';

function stringList(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        throw new Error(`Findings JSON "coverage.${field}" must be an array of strings. ${COVERAGE_HELP}`);
    }
    return (value as string[]).map(oneLine).filter((v) => v !== "");
}

/** Coverage entries are posted to the PR inside code formatting: keep each on one line and free of backticks. */
function oneLine(value: string): string {
    return value.replace(/\s+/g, " ").replace(/`/g, "'").trim();
}

/** The usual short hash. Anything shorter is too little to say two hashes name the same commit. */
export const MIN_COMMIT_HASH = 7;

/** Hosts hand out commit hashes at different lengths; one is the other's prefix when they name the
 *  same commit. Both must be at least a short hash long, so a mistyped one-character value cannot
 *  pass as a match. */
export function sameCommitHash(a: string, b: string): boolean {
    return a.length >= MIN_COMMIT_HASH && b.length >= MIN_COMMIT_HASH && (a.startsWith(b) || b.startsWith(a));
}

function parseReviewOf(raw: unknown): ReviewOf {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error('Findings JSON is missing "reviewOf" — copy it from review-prep\'s output: "reviewOf": { "repo": "...", "pr": "...", "commit": "..." }.');
    }
    const o = raw as Record<string, unknown>;
    const repo = requireString(o, "repo", 'Findings JSON "reviewOf"').trim();
    const commit = requireString(o, "commit", 'Findings JSON "reviewOf"').trim();
    const prRaw = o["pr"];
    if (typeof prRaw !== "string" && typeof prRaw !== "number") throw new Error('Findings JSON "reviewOf" is missing "pr".');
    const pr = String(prRaw).trim();
    if (repo === "" || pr === "" || commit === "") throw new Error('Findings JSON "reviewOf" needs a non-empty repo, pr and commit.');
    if (!/^[0-9a-f]+$/i.test(commit) || commit.length < MIN_COMMIT_HASH) {
        throw new Error(`Findings JSON "reviewOf.commit" must be a commit hash of at least ${MIN_COMMIT_HASH} characters, copied from review-prep's output; got ${JSON.stringify(commit)}.`);
    }
    return { repo, pr, commit };
}

function parseCoverage(raw: unknown): ReviewCoverage {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`Findings JSON is missing "coverage": a review has to say what it is based on. ${COVERAGE_HELP}`);
    }
    const o = raw as Record<string, unknown>;
    const filesRead = stringList(o["filesRead"], "filesRead");
    const commandsRun = stringList(o["commandsRun"], "commandsRun");
    const claimsVerified = stringList(o["claimsVerified"], "claimsVerified");
    const notChecked = typeof o["notChecked"] === "string" ? oneLine(o["notChecked"]) : "";
    if (filesRead.length === 0) throw new Error('Findings JSON "coverage.filesRead" is empty: a review that read no file is not a review.');
    if (notChecked === "") {
        throw new Error('Findings JSON "coverage.notChecked" is empty. Say what you did not read, run or check; every review leaves something out.');
    }
    return { filesRead, commandsRun, claimsVerified, notChecked };
}

/** Changed files the reviewer did not list under `filesRead`. Paths compare exactly, after trimming a leading "./". */
export function unreadChangedFiles(coverage: ReviewCoverage, manifest: ReviewManifest): string[] {
    const norm = (p: string): string => p.replace(/^\.\//, "");
    const read = new Set(coverage.filesRead.map(norm));
    return manifest.files.filter((f) => !read.has(norm(f)));
}

/** `git` and any options before its subcommand: `-C <dir>`, `-c <k=v>`, `--no-pager`, `--git-dir=<dir>` (TAI-543). A `-C`/`-c` value never starts with a dash: otherwise `-C -C -C ...` can be split many ways and the match backtracks exponentially. */
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+[^\s-]\S*|--?[\w-]+(?:=\S+)?))*`;

/**
 * TAI-541: does a listed command search the PR's branch for something beyond its diff? `git grep`,
 * `git ls-tree` and `git log -S`/`-G` do; so does `git show <ref>:<path>` of a file the PR did not change
 * (needs the manifest's changed-file list, so without one `git show` does not count). A plain text match
 * on what the reviewer typed: it cannot tell a useful search from a pointless one, only a review that
 * ran none from one that did.
 */
export function searchesBranch(command: string, changedFiles: readonly string[] | null): boolean {
    if (new RegExp(`${GIT}\\s+(?:grep|ls-tree)\\b`).test(command)) return true;
    if (new RegExp(`${GIT}\\s+log\\b[^|;&]*\\s-[SG]`).test(command)) return true;
    const show = new RegExp(`${GIT}\\s+show(?:\\s+-\\S+)*\\s+[^\\s-]\\S*?:(\\S+)`).exec(command);
    if (show && changedFiles) {
        const path = show[1]!.replace(/^\.\//, "").replace(/["')]+$/, "");
        return !changedFiles.includes(path);
    }
    return false;
}

/** TAI-541: a verified claim has a how when it reads "<claim> — <how checked>" or "<claim>: <how checked>". */
export function claimGivesHow(claim: string): boolean {
    return /(?:\s[—–-]{1,2}\s|:\s)\S/.test(claim);
}

/** True when the review raises nothing but praise. */
export function raisesNoIssue(findings: ReviewFindings): boolean {
    return findings.findings.every((f) => f.severity === "good");
}

/**
 * The lines the CLI adds about a review's basis: changed files not claimed as read, a review of a
 * different commit than the one review-prep saw, and an empty review of a large diff. `manifest` is
 * `null` when review-prep was not run in this clone for this PR; that is said too. `liveCommit` is
 * the PR's head as the git host reports it now, when the caller has asked: `reviewOf.commit` is
 * copied from the same review-prep run as the manifest, so only the live head can show that the
 * author pushed after the review was prepared. `null` means the caller asked and could not find
 * out, which is said: "not moved" and "could not check" must not look the same. `undefined` means
 * nobody asked.
 */
export function coverageNotes(findings: ReviewFindings, manifest: ReviewManifest | null, liveCommit?: string | null): string[] {
    const notes: string[] = [];
    if (!findings.coverage.commandsRun.some((c) => searchesBranch(c, manifest?.files ?? null))) {
        notes.push("**No command that searched the branch is listed** (`git grep`, `git ls-tree`, `git log -S`, or a `git show` of a file the PR did not change). A change can leave the old form behind outside its diff; this review would not have found it.");
    }
    const noHow = findings.coverage.claimsVerified.filter((c) => !claimGivesHow(c));
    if (noHow.length > 0) {
        notes.push(`**${noHow.length} of ${findings.coverage.claimsVerified.length} verified claims do not say how they were checked** (no "claim — how" or "claim: how"): ${noHow.map((c) => `"${c.length > 60 ? `${c.slice(0, 57)}...` : c}"`).join("; ")}`);
    }
    if (liveCommit === null) {
        notes.push("_Could not check whether the PR has moved since this review was prepared._");
    } else if (liveCommit !== undefined && !sameCommitHash(liveCommit, findings.reviewOf.commit)) {
        notes.push(`**This review is of commit ${findings.reviewOf.commit}. The PR is now at ${liveCommit}: the changes pushed since have NOT been reviewed.**`);
    }
    if (!manifest) return [...notes, "_Not cross-checked: `review-prep` has not been run for this PR in this clone, so the list of changed files is unknown._"];
    if (!sameCommitHash(manifest.commit, findings.reviewOf.commit)) {
        notes.push(`**This review is of commit ${findings.reviewOf.commit}; the PR was at ${manifest.commit} when \`review-prep\` last ran here.**`);
    }
    const unread = unreadChangedFiles(findings.coverage, manifest);
    if (unread.length > 0) {
        notes.push(`**${unread.length} of ${manifest.files.length} changed files are not listed as read:** ${unread.map((f) => `\`${f}\``).join(", ")}`);
    }
    if (raisesNoIssue(findings) && (manifest.diffLines >= LARGE_DIFF_LINES || manifest.files.length >= LARGE_DIFF_FILES)) {
        notes.push(`**No issue was raised on a diff of ${manifest.files.length} files and ${manifest.diffLines} lines.** Check what this review is based on before relying on it.`);
    }
    return notes;
}

function renderCoverage(coverage: ReviewCoverage, notes: readonly string[]): string[] {
    const list = (items: readonly string[]): string => (items.length === 0 ? "none" : items.map((i) => `\`${i}\``).join(", "));
    const lines = [
        "### What this review is based on",
        "",
        `- **Files read (${coverage.filesRead.length}):** ${list(coverage.filesRead)}`,
        `- **Commands run:** ${list(coverage.commandsRun)}`,
        `- **Claims verified:** ${coverage.claimsVerified.length === 0 ? "none" : ""}`,
        ...coverage.claimsVerified.map((c) => `  - ${c}`),
        `- **Not checked:** ${coverage.notChecked}`,
    ];
    if (notes.length > 0) lines.push("", ...notes);
    return lines;
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
    } = partitionInlineFindings(findings.findings),
    manifest: ReviewManifest | null = null,
    liveCommit?: string | null
): string {
    const lines: string[] = ["## Review", "", findings.overview, "", ...renderCoverage(findings.coverage, coverageNotes(findings, manifest, liveCommit)), ""];

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

/**
 * TAI-575: the last line of `render-findings`' output and of `review-prep`'s. The guard below can prove the findings were
 * rendered, never that the list was shown to the human; this line is for that, since a session once ended with "reply with
 * a number" and no list on screen.
 */
export const SHOW_THE_HUMAN_REMINDER =
    "(Show this list to the human as chat text, then stop and wait for their reply: nothing is posted until they answer.)";

/** `git-pr render-findings`' output: the rendered findings, then the next-step options. */
export function renderFindingsPreview(findings: ReviewFindings, manifest: ReviewManifest | null = null, liveCommit?: string | null): string {
    return `${renderReviewFindings(findings, undefined, manifest, liveCommit)}\n\n${renderFindingsNextSteps(findings.leaning)}\n\n${SHOW_THE_HUMAN_REMINDER}`;
}

/**
 * TAI-527: why an approval may not be recorded right now, or `null`. An approval counts for the
 * PR's current commit (the merge gate), so it must not be cast on a commit nobody prepared a review
 * of: when review-prep last ran in this clone for an older commit, the newer changes are unseen.
 * With no manifest there is nothing to compare (a human who reviewed elsewhere), and it goes ahead.
 */
export function approvalOfUnpreparedCommit(manifest: ReviewManifest | null, liveCommit: string): string | null {
    if (!manifest || sameCommitHash(manifest.commit, liveCommit)) return null;
    return (
        `Not approved: the PR is now at commit ${liveCommit}, and \`review-prep\` last ran here for ${manifest.commit}. ` +
        "The changes pushed since have not been reviewed. Run `review-prep` again, review what changed, then approve."
    );
}

/** The same rule keyed by the decision: only an approval is gated. A request for changes always goes through. */
export function reviewDecisionRefusal(decision: "approve" | "requestChanges", manifest: ReviewManifest | null, liveCommit: string): string | null {
    return decision === "approve" ? approvalOfUnpreparedCommit(manifest, liveCommit) : null;
}

// ---------- TAI-575: findings must have been rendered before they are posted or a decision is cast ----------

/** A stable hash of what `render-findings` rendered: the findings by content, whatever the whitespace of the file they came in. */
export function hashFindings(findings: ReviewFindings): string {
    return createHash("sha256").update(JSON.stringify(findings)).digest("hex");
}

/** What `render-findings` recorded for a PR in this clone. */
export interface RenderedFindingsRecord {
    readonly hash: string;
}

/**
 * Why `comment-findings` may not post these findings, or `null`. They must be the ones `render-findings` rendered for this
 * PR, so what reaches the PR is what the human was shown (or was meant to be). It cannot tell the list was actually shown.
 */
export function unrenderedFindingsRefusal(findings: ReviewFindings, rendered: RenderedFindingsRecord | null): string | null {
    if (!rendered) {
        return (
            "Not posted: `render-findings` has not been run on these findings for this PR here. Run it on the same findings file, " +
            "show its output to the human as chat text, and wait for their reply; then post. Nothing was posted."
        );
    }
    if (rendered.hash !== hashFindings(findings)) {
        return (
            "Not posted: these findings differ from the findings that were rendered for this PR. Run `render-findings` again on " +
            "this file, show the human the result, and wait for their reply; then post. Nothing was posted."
        );
    }
    return null;
}

/**
 * Why a review decision (approve or request changes) may not be recorded, or `null`. Once `review-prep` has run for the PR here,
 * the findings must have been rendered before the human decides. With no manifest there is nothing to compare: a human who
 * reviewed elsewhere and only approves is not blocked.
 */
export function unrenderedDecisionRefusal(
    _decision: "approve" | "requestChanges",
    manifest: ReviewManifest | null,
    rendered: RenderedFindingsRecord | null
): string | null {
    if (!manifest || rendered) return null;
    return (
        "Not recorded: `review-prep` ran here for this PR but no findings have been rendered since. Run `render-findings` on your " +
        "findings, show the list to the human as chat text, and wait for their reply; then decide. Nothing was recorded."
    );
}
