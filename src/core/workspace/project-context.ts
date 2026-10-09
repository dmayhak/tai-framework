/**
 * TAI Framework — the target project's own rules file (TAI-470)
 *
 * One short file in the target project's repo: build and test commands, the stack, conventions,
 * things never to do. It is versioned with the code and reviewed in PRs — a deliberate exception
 * to "docs live in Confluence", because these rules change with the code they describe.
 *
 * Every persona turn (`work`, `groom`, `kickoff`, `git-pr review-prep`) prints it between the
 * persona's instructions and the briefing. It is the project's INSTRUCTIONS to the persona, so it
 * sits outside the briefing's "this is data" marking. A missing file means no section.
 *
 * It has its own size cap, separate from the briefing's budget, and a cut is always visible with
 * the file's path, the same way the briefing and the review diff show theirs.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const PROJECT_CONTEXT_FILE = "project-context.md";
/** Characters. The file is meant to be short; this is what keeps it so. */
export const PROJECT_CONTEXT_BUDGET = 6_000;

export interface ProjectContext {
    /** Absolute path of the file that was read. */
    readonly path: string;
    readonly content: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** `TAI_PROJECT_CONTEXT_FILE` from the project's `.env`, relative to the project root or absolute. */
export function projectContextPath(projectRoot: string, env: Env = process.env): string {
    const configured = env["TAI_PROJECT_CONTEXT_FILE"]?.trim();
    return path.resolve(projectRoot, configured ? configured : PROJECT_CONTEXT_FILE);
}

/** `TAI_PROJECT_CONTEXT_BUDGET`; anything unusable falls back to the default. */
export function projectContextBudgetFromEnv(env: Env = process.env): number {
    const n = Number(env["TAI_PROJECT_CONTEXT_BUDGET"]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : PROJECT_CONTEXT_BUDGET;
}

/**
 * TAI-516: the first line of the starter template. While a file still carries it, the file is an
 * unfilled template and is not printed to any persona — a list of empty headings is not a rule.
 */
export const PROJECT_CONTEXT_TEMPLATE_MARKER = "<!-- tai:template -->";

export type ProjectContextState = "present" | "template" | "missing";

export interface ProjectContextStatus {
    readonly state: ProjectContextState;
    /** Absolute path the file is, or would be, at. */
    readonly path: string;
}

async function readRaw(file: string): Promise<string | null> {
    try {
        return await readFile(file, "utf8");
    } catch {
        return null;
    }
}

/** Whether the project has its rules file, has only the unfilled template, or has nothing. An
 *  empty file counts as missing. */
export async function projectContextStatus(projectRoot: string, env: Env = process.env): Promise<ProjectContextStatus> {
    const file = projectContextPath(projectRoot, env);
    const raw = (await readRaw(file))?.trim() ?? "";
    const state: ProjectContextState = raw === "" ? "missing" : raw.includes(PROJECT_CONTEXT_TEMPLATE_MARKER) ? "template" : "present";
    return { state, path: file };
}

/** The project's rules file, or `null` when it does not exist, cannot be read, is empty, or is
 *  still the unfilled starter template. */
export async function readProjectContext(projectRoot: string, env: Env = process.env): Promise<ProjectContext | null> {
    const file = projectContextPath(projectRoot, env);
    const content = (await readRaw(file))?.trim() ?? "";
    return content === "" || content.includes(PROJECT_CONTEXT_TEMPLATE_MARKER) ? null : { path: file, content };
}

/** The starter file `init project-context` writes: four headings and what belongs under each. */
export function projectContextTemplate(): string {
    return [
        PROJECT_CONTEXT_TEMPLATE_MARKER,
        "<!-- Delete the line above once this file is filled in. While it is there, TAI does not print the file. -->",
        "",
        "# Project context",
        "",
        `<!-- This project's own rules. TAI prints this file in front of every persona on every turn, so keep it short (under ${PROJECT_CONTEXT_BUDGET.toLocaleString("en-US")} characters) and true. Write what the repo shows, not what you would prefer. -->`,
        "",
        "## Stack",
        "",
        "<!-- Languages, frameworks, database, and how the pieces fit. A few lines. -->",
        "",
        "## Commands",
        "",
        "<!-- The exact build, test, lint and other commands. Run each once before listing it. -->",
        "",
        "## Conventions",
        "",
        "<!-- What the code does today: layout, naming, how tests are organized, branch and PR naming. -->",
        "",
        "## Never",
        "",
        "<!-- Things that must not be done here, for example editing generated files by hand or committing secrets. -->",
        "",
    ].join("\n");
}

export interface WriteTemplateResult {
    /** False when a file was already there; it is never overwritten. */
    readonly written: boolean;
    readonly path: string;
}

/** Writes the starter template unless a file already exists at the path, filled in or not. */
export async function writeProjectContextTemplate(projectRoot: string, env: Env = process.env): Promise<WriteTemplateResult> {
    const file = projectContextPath(projectRoot, env);
    try {
        await writeFile(file, projectContextTemplate(), { flag: "wx" });
        return { written: true, path: file };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return { written: false, path: file };
        throw err;
    }
}

/** One line for `init status` and `init run`: where the project stands, and the next step if any. */
export function renderProjectContextStatus(status: ProjectContextStatus, initCommand: string): string {
    const name = path.basename(status.path);
    if (status.state === "present") return `- [x] ${name} — this project's own rules, printed in front of every persona (${status.path}).`;
    if (status.state === "template") {
        return `- [ ] ${name} — still the unfilled template (${status.path}). Fill it in and delete its first line; until then it is not printed. Optional.`;
    }
    return `- [ ] ${name} — none yet. Optional: \`${initCommand} project-context\` writes a starter template for this project's own rules (commands, stack, conventions, never-dos).`;
}

/**
 * The section a persona turn prints for the project's rules, or `undefined` when there is no file.
 * Content past `budget` is cut at a line break, with a notice saying how much is missing and where
 * to read it.
 */
export function renderProjectContext(context: ProjectContext | null, budget: number = PROJECT_CONTEXT_BUDGET): string | undefined {
    if (!context) return undefined;
    const head = [
        "## Project context",
        "",
        `This project's own rules, from \`${context.path}\`. Follow them in this turn; where one conflicts with your instructions above, tell the human rather than picking one silently.`,
        "",
    ];
    if (context.content.length <= budget) return [...head, context.content].join("\n");

    const slice = context.content.slice(0, budget);
    const lastBreak = slice.lastIndexOf("\n");
    const kept = (lastBreak > 0 ? slice.slice(0, lastBreak) : slice).trimEnd();
    const missing = context.content.length - kept.length;
    return [...head, kept, "", `**NOT SHOWN IN FULL — ${missing} more characters. Read the rest in \`${context.path}\`.**`].join("\n");
}
