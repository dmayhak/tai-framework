/**
 * TAI Framework — does this repo already have code? (TAI-471)
 *
 * `/tai-kickoff` asks this so a project that is onboarded with an existing system gets that
 * system mapped before discovery starts (the "Map the existing system" Spike, `personas/pm.md`
 * item 1). Read-only: one `git ls-files`.
 *
 * "Code" is every tracked file that is not plainly a document or a repo housekeeping file. It is
 * a deny-list on purpose: TAI cannot know a target project's languages, and miscounting a config
 * file as code only costs a Spike the human can decline, while missing a whole language would
 * skip the mapping silently.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExistingCode {
    /** Tracked files that count as code. */
    readonly codeFiles: number;
    /** The first few, for the briefing to show what was counted. */
    readonly examples: readonly string[];
}

const DOC_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg"]);
const HOUSEKEEPING_NAMES: ReadonlySet<string> = new Set(["license", "licence", "notice", "authors", "codeowners", "changelog", "readme"]);
const EXAMPLES = 5;

/** True for a tracked path that counts as code: not a document, not a dot-file or anything under a
 *  dot-directory (`.github/`, `.claude/`, `.tai/`), not a licence-style housekeeping file. */
export function isCodePath(file: string): boolean {
    const parts = file.split("/");
    if (parts.some((part) => part.startsWith("."))) return false;
    const base = parts.at(-1)!.toLowerCase();
    const ext = path.extname(base);
    if (DOC_EXTENSIONS.has(ext)) return false;
    return !HOUSEKEEPING_NAMES.has(ext ? base.slice(0, -ext.length) : base);
}

export function countExistingCode(trackedFiles: readonly string[]): ExistingCode {
    const code = trackedFiles.filter(isCodePath);
    return { codeFiles: code.length, examples: code.slice(0, EXAMPLES) };
}

/** What `git ls-files` shows for `cwd`, or `null` when this is not a git repo (or git is unavailable). */
export async function detectExistingCode(cwd: string): Promise<ExistingCode | null> {
    try {
        const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd, maxBuffer: 64 * 1024 * 1024 });
        return countExistingCode(stdout.split("\0").filter((f) => f !== ""));
    } catch {
        return null;
    }
}
