/**
 * TAI Framework — `git-pr review-prep` (TAI-425 ADR, Confluence page 52559873)
 *
 * Everything the review flow used to ask the session to do by hand — read the Code Reviewer's
 * persona file, fetch and diff the PR, remember the findings schema and the stop-and-wait rule —
 * is printed by one read-only command instead, so it is IN the output the session just read
 * rather than in skill prose it may not follow (the TAI-423 class of failure).
 *
 * This module is the pure half: the diff gathering (local git, as before — no GitHost change) and
 * the rendering. `cli.ts` does the I/O around it (roster gate, PR lookup, persona load).
 *
 * Output order matters (ADR decision 4/9): persona, PR facts, instructions, THEN the diff, last.
 * Hosts truncate long tool output from the tail, so the diff is the only thing that can be cut,
 * never the persona or the instructions; and the diff is budgeted so the whole output fits.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { renderPersonaTurn } from "../persona/turn.js";
import { sameHuman } from "../personas/roster.js";
import type { HumanRef } from "../storage/interface.js";
import type { PullRequestRef } from "./interface.js";

const execFileAsync = promisify(execFile);

/** Total characters the whole review-prep output aims for (ADR decision 9). Claude Code's Bash
 *  tool truncates long output (default ~30,000 characters); stay well under the smallest host's limit. */
export const OUTPUT_BUDGET = 24_000;
/** The diff always gets at least this much, however large the persona and instructions are. */
export const DIFF_FLOOR = 4_000;
/** Largest window (in lines) of the per-chunk commands for a file too big for one command's output; the
 *  actual window shrinks for long lines so each window stays under 80% of the host's output limit. */
export const CHUNK_LINES = 300;
const MIN_CHUNK_LINES = 50;

const MAX_DESCRIPTION_CHARS = 2_000;

// ---------- input safety ----------

/** Branch names come from the git host, so they are untrusted input to a local git call. Refuses
 *  what could turn into an option or a refspec (leading "-", ":"), and whitespace/control characters. */
export function assertSafeBranchName(name: string): void {
    if (name.length === 0 || name.startsWith("-") || name.includes(":") || /[\s\x00-\x1f\x7f]/.test(name)) {
        throw new Error(`Refusing unsafe branch name ${JSON.stringify(name)} — not passed to git.`);
    }
}

/** Reduces a git remote URL (ssh, https with or without credentials, `.git`, trailing slash, or a
 *  plain path) to a lowercase `workspace/repo`, or null when there is nothing to extract. */
export function normalizeRemoteUrl(url: string): string | null {
    const cleaned = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
    const segments = cleaned.split(/[/:]/).filter((s) => s.length > 0);
    if (segments.length < 2) return null;
    return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`.toLowerCase();
}

/** Always single-quotes (file paths from a diff may hold spaces or shell metacharacters). */
export function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quotes only when the word has characters a shell would act on. */
function shellWord(s: string): string {
    return /^[A-Za-z0-9._\/@=+,:-]+$/.test(s) ? s : shellQuote(s);
}

// ---------- diff gathering ----------

export interface DiffFile {
    readonly path: string;
    readonly patch: string;
}

export type DiffResult =
    | { readonly kind: "ok"; readonly range: string; readonly stat: string; readonly files: readonly DiffFile[] }
    | { readonly kind: "unavailable"; readonly reason: string };

/** Splits a unified diff on its `diff --git` headers; a file's path is the `b/` side of its header. */
export function splitDiffByFile(raw: string): DiffFile[] {
    if (raw.length === 0) return [];
    const parts = raw.split(/^(?=diff --git )/m).filter((p) => p.length > 0);
    return parts.map((patch) => {
        const header = /^diff --git a\/(.+) b\/(.+)$/m.exec(patch);
        return { path: header ? header[2]! : "(unknown file)", patch };
    });
}

async function git(args: readonly string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=off", ...args], {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
}

function errorText(err: unknown): string {
    const e = err as { stderr?: string; message?: string };
    return (e.stderr?.trim() || e.message || String(err)).split("\n")[0]!;
}

export interface GatherDiffInput {
    readonly cwd: string;
    /** `workspace/repo`, as given on the command line. */
    readonly repo: string;
    readonly sourceBranch: string;
    readonly destinationBranch: string;
}

/** Local git, as the review flow always did (ADR decision 7). Never throws: every failure is an
 *  `unavailable` result with a reason, so the persona and the PR facts still print (decision 8). */
export async function gatherDiff(input: GatherDiffInput): Promise<DiffResult> {
    try {
        assertSafeBranchName(input.sourceBranch);
        assertSafeBranchName(input.destinationBranch);
    } catch (err) {
        return { kind: "unavailable", reason: (err as Error).message };
    }

    let origin: string;
    try {
        origin = (await git(["remote", "get-url", "origin"], input.cwd)).trim();
    } catch (err) {
        return { kind: "unavailable", reason: `this directory is not a git repository with an origin remote (${errorText(err)})` };
    }
    if (normalizeRemoteUrl(origin) !== input.repo.toLowerCase()) {
        return { kind: "unavailable", reason: `this directory is not a clone of ${input.repo} (its origin is ${origin})` };
    }

    const src = input.sourceBranch;
    const dest = input.destinationBranch;
    try {
        await git(
            ["fetch", "origin", `+refs/heads/${src}:refs/remotes/origin/${src}`, `+refs/heads/${dest}:refs/remotes/origin/${dest}`],
            input.cwd
        );
    } catch (err) {
        return { kind: "unavailable", reason: `git fetch from origin failed (${errorText(err)})` };
    }

    const range = `origin/${dest}...origin/${src}`;
    try {
        const stat = (await git(["diff", "--no-color", "--no-ext-diff", "--stat", range], input.cwd)).trimEnd();
        const raw = await git(["diff", "--no-color", "--no-ext-diff", range], input.cwd);
        return { kind: "ok", range, stat, files: splitDiffByFile(raw) };
    } catch (err) {
        return { kind: "unavailable", reason: `git diff ${range} failed (${errorText(err)})` };
    }
}

// ---------- rendering ----------

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** The diff section. `budget` is the characters this section may use; whole files are shown in diff
 *  order until one does not fit, and everything from there on is listed with the exact command to
 *  read it (ADR decision 9) — never cut mid-file, never silent. */
export function renderChanges(diff: DiffResult, budget: number, fetchLimit: number = OUTPUT_BUDGET): string {
    const lines: string[] = ["## Changes", ""];

    if (diff.kind === "unavailable") {
        lines.push(
            `**No diff is available:** ${diff.reason}.`,
            "",
            "Do not write findings without a diff. Tell the human, and run this command again from a clone of the PR's repo."
        );
        return lines.join("\n");
    }

    lines.push(`Range: \`${diff.range}\``, "", "```", diff.stat, "```");
    if (diff.files.length === 0) {
        lines.push("", "This PR has no changed files.");
        return lines.join("\n");
    }

    let used = lines.join("\n").length;
    let cut = diff.files.length;
    const shown: string[] = [];
    for (let i = 0; i < diff.files.length; i++) {
        const block = "\n\n```diff\n" + diff.files[i]!.patch.trimEnd() + "\n```";
        if (used + block.length > budget) {
            cut = i;
            break;
        }
        used += block.length;
        shown.push(block);
    }
    lines.push(shown.join(""));

    if (cut < diff.files.length) {
        const omitted = diff.files.slice(cut);
        const chars = omitted.reduce((n, f) => n + f.patch.length, 0);
        lines.push(
            "",
            `**⚠️ DIFF NOT SHOWN IN FULL — ${plural(omitted.length, "file", "files")}, ${chars} characters omitted.** ` +
                `You MUST run every command below (from the directory you ran this in) and read its output before writing findings:`,
            ""
        );
        for (const f of omitted) {
            const base = `git diff ${shellWord(diff.range)} -- ${shellQuote(f.path)}`;
            // `budget` is what THIS output has left; a follow-up command's own output is limited by the host,
            // not by this output, so a file is only windowed when one command could not hold it (`fetchLimit`).
            if (f.patch.length <= fetchLimit) {
                lines.push(`- \`${base}\``);
                continue;
            }
            const total = f.patch.split("\n").length - (f.patch.endsWith("\n") ? 1 : 0);
            const avgLine = Math.max(1, f.patch.length / total);
            const window = Math.min(CHUNK_LINES, Math.max(MIN_CHUNK_LINES, Math.floor((fetchLimit * 0.8) / avgLine)));
            lines.push(`- \`${f.path}\` is too large to read in one piece; read it in ${window}-line windows:`);
            for (let start = 1; start <= total; start += window) {
                lines.push(`  - \`${base} | sed -n '${start},${start + window - 1}p'\``);
            }
        }
    }
    return lines.join("\n");
}

/** The review steps, once (ADR decision 5), with this PR's repo and id filled in so every command is
 *  copy-ready. Moved here from the tai-pr skill body; the strictness of the stop-and-wait boundary is unchanged. */
export function renderReviewInstructions(input: { readonly repo: string; readonly prId: string }): string {
    const { repo, prId } = input;
    return [
        "Review this PR as the persona above, in this session, following these steps in order. Run the `git-pr` commands named here through the same `cli.ts` command prefix you used for `review-prep`.",
        "",
        "1. **Read the diff in the Changes section at the end of this output.** If it says **DIFF NOT SHOWN IN FULL**, run every command it lists before writing findings. If it says **No diff is available**, do not review: tell the human why and stop. Apply your Core Principles to what the diff actually changed, against the linked ticket's requirements. You never edit code and never commit a fix into the PR under review; required changes are findings.",
        "2. **Build your findings as a single structured JSON object** (TAI-209 ADR), never prose, conforming to:",
        "",
        "```json",
        "{",
        '  "overview": "2-3 sentence high-level assessment",',
        '  "findings": [',
        "    {",
        '      "severity": "critical|suggestion|nitpick|good",',
        '      "category": "Security|Performance|Logic|Style|Architecture|...",',
        '      "title": "brief title",',
        '      "file": "path/to/file.ts",',
        '      "line": 42,',
        '      "issue": "one short paragraph, no line breaks",',
        '      "fix": "exact replacement for the single line at \\"line\\", or omit"',
        "    }",
        "  ],",
        '  "leaning": "approve|requestChanges|neither",',
        '  "leaningReason": "one sentence — your own rationale, never a decision"',
        "}",
        "```",
        "",
        "`line`, when given, is the line number in the NEW (current) version of the file — the same numbering the diff's `+` side uses. A finding about a deleted line, or one you can only place on the old side of the diff, should omit `line` rather than guess (TAI-207: `line` anchors a real inline PR comment, so a wrong or old-side number posts to the wrong place or is rejected by Bitbucket). `line`/`fix` are optional per finding, everything else is required. An empty `findings` array is a valid, preferred outcome for clean code — don't invent issues to justify the review. Write this JSON to a temporary file (your host's own scratch location if it has one, otherwise any plain temp path); every command below takes it as `@<path>`, never as prose you type into the command yourself.",
        "3. **Run `git-pr render-findings @<path>`, then paste its ENTIRE stdout verbatim into your own reply as ordinary chat text — then STOP. This is the complete output of \"review this PR,\" full stop.** A tool call's own output is not reliably visible to the human as chat content (TAI-258) — running the command is not enough, and neither is summarizing it. Quote the real markdown it printed, in full, **including the numbered \"what would you like to do?\" list at its end (TAI-411), which is how the human learns their options; never trim it.** Do NOT, in this same turn: run `git-pr comment-findings`, run `git-pr review`, or ask a question via any interactive tool. End your turn right here and wait for the human's own next message, an ordinary NEW turn, not a same-turn continuation.",
        "",
        "   Why this is strict (TAI-202/203, found live 2026-08-25): a session that asks a question with no findings shown leaves the human unable to answer it; a session that shows findings and tries to ask in the same turn reliably stops after stating its own recommendation. Don't try to word around it a third time — stopping after step 3 is correct behavior, not a bug. Structured findings remove the narrative-conclusion trap at its root (you never compose the write-up; `render-findings`' own stdout is what the human sees), but the stop-and-wait boundary stays exactly as strict. Don't relax it because the text is machine-rendered.",
        "",
        "4. **When the human's own next message tells you what to do, that ordinary reply is the trigger.** They may answer in plain language (\"post it and approve,\" \"don't post, request changes,\" \"neither\") or with a bare number from the list `render-findings` ended with: **1** post and approve, **2** post the findings only, **3** approve only (no comment), **4** post and request changes, **5** neither (nothing is run). Interpret it and act:",
        `   - To post the findings: \`git-pr comment-findings ${repo} ${prId} @<path>\` — the same file from step 2, never retyped or re-composed as prose.`,
        `   - To record a decision: \`git-pr review ${repo} ${prId} approve\` or \`git-pr review ${repo} ${prId} requestChanges\` — only because they said so explicitly; "neither" or no clear decision means no \`review\` call at all.`,
        "   - If their reply is genuinely ambiguous about either the posting or the decision, ask ONE clarifying question, not two — bundle the comment-posting choice and the approve/request-changes decision into a single `AskUserQuestion` call (one call, multiple sub-questions), pre-filled with your own stated leaning as the suggested answer for the human to confirm or override.",
        "",
        "This applies even when you already know the diff well (e.g. you wrote it earlier this session): reviewing and recording a decision are two separate steps, and the human decides the outcome of each, every time. Never chain from reading the diff into `review` or `merge` on your own initiative. No condition here ever auto-approves (brief §3.4: human sign-off is the default) — running `review` or `comment-findings` without the human having said to, in their own words, is always wrong, however clean the diff looked.",
        "",
        "If a command errors, report the error to the human rather than guessing or proceeding anyway.",
    ].join("\n");
}

export interface ReviewPrepInput {
    readonly persona: { readonly displayName: string; readonly id: string; readonly prompt: string };
    /** `workspace/repo`, as given on the command line. */
    readonly repo: string;
    readonly pr: PullRequestRef;
    readonly actingHuman: HumanRef;
    /** The ticket the PR is linked to, or null when none was found. */
    readonly linkedKey: string | null;
    readonly diff: DiffResult;
}

function renderPullRequestSection(pr: PullRequestRef): string {
    const reviewers =
        pr.reviewers.length === 0 ? "none" : pr.reviewers.map((r) => `${r.human.displayName} (${r.status})`).join(", ");
    const description = (pr.description ?? "").trim();
    const shortDescription =
        description.length > MAX_DESCRIPTION_CHARS ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}… (truncated)` : description;
    return [
        "## Pull request",
        "",
        `- Title: ${pr.title}`,
        `- URL: ${pr.url}`,
        `- Author: ${pr.author.displayName}`,
        `- Branches: ${pr.sourceBranch} → ${pr.destinationBranch}`,
        `- State: ${pr.state}`,
        `- Reviewers: ${reviewers}`,
        ...(shortDescription ? ["", "Description:", "", shortDescription] : []),
    ].join("\n");
}

/** The whole `git-pr review-prep` output (ADR decisions 3, 4, 6, 9). */
export function renderReviewPrep(input: ReviewPrepInput): string {
    const { pr, actingHuman } = input;
    const prId = String(pr.id);
    const selfReview = sameHuman(pr.author, actingHuman);

    const linked = input.linkedKey
        ? `${input.linkedKey} — read it for the requirements this diff is reviewed against (and any linked design).`
        : "No linked ticket found for this PR.";
    const who = actingHuman.email ?? actingHuman.displayName;

    const before = [
        `# Review prep: ${input.repo} PR ${prId}`,
        "",
        renderPullRequestSection(pr),
        "",
        "## Linked ticket",
        "",
        linked,
        "",
        "## Reviewing as",
        "",
        `${actingHuman.displayName} (${who}) — on the "PR Reviewers" roster.`,
        ...(selfReview
            ? [
                  "",
                  "Note: you authored this PR. Cole's default is not to review work he authored, but a solo developer may legitimately review their own (brief §4, open item 8.3), so the review proceeds — the human decides the outcome.",
              ]
            : []),
        "",
        "## How to review",
        "",
        renderReviewInstructions({ repo: input.repo, prId }),
        "",
        "",
    ].join("\n");

    const prefix = renderPersonaTurn(input.persona, before);
    const remaining = Math.max(DIFF_FLOOR, OUTPUT_BUDGET - prefix.length);
    return prefix + renderChanges(input.diff, remaining) + "\n";
}
