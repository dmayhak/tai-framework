/**
 * TAI-649: the Claude Code rules an unattended Dev build needs (Story TAI-648).
 *
 * `do-dev-tasks` starts `claude -p` runs that have nobody to approve a command. A run stops at the first command the
 * project's rules do not cover, so this module names the narrow set a build uses, and checks a project's settings
 * files against it before any run starts. It never writes anything: the person adds the rules to their own settings.
 *
 * What it never allows: `git-pr merge`, `git-pr review` and `init` (ADR decision 9: permission to merge is a separate
 * opt-in), and a force push. The deny entries make a force push refuse even where a broader rule would let it through.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { cliCommand } from "./headless-claude.js";

export interface BuildRules {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
}

/** TAI subcommands a build uses: the ticket, its briefing, the PR and the recorded check. */
const BUILD_SUBCOMMANDS: readonly string[] = ["issue", "work", "page", "git-pr create", "git-pr check", "git-pr comments"];

/** Git commands a build uses. Pushing is limited to `origin`; the deny entries below take the force forms back out. */
const GIT_ALLOW: readonly string[] = [
    "git status*",
    "git diff*",
    "git log*",
    "git fetch*",
    "git branch*",
    "git checkout *",
    "git switch *",
    "git add *",
    "git commit *",
    "git push -u origin *",
    "git push origin *",
];

/** A force push in any spelling: the flags, and a `+` before a refspec. */
const GIT_DENY: readonly string[] = ["git push *--force*", "git push * -f*", "git push -f*", "git push *+*", "git push *--delete*"];

/** The rules for the install at `taiHome`; `checkCommand` is the project's `TAI_CHECK_COMMAND`, allowed as it is written. */
export function buildRunRules(taiHome: string, checkCommand: string | null = null): BuildRules {
    const cli = cliCommand(taiHome);
    const allow: string[] = [];
    for (const sub of BUILD_SUBCOMMANDS) {
        allow.push(`Bash(${cli} ${sub} *)`);
        allow.push(`Bash(${cli} --as developer ${sub} *)`);
    }
    for (const g of GIT_ALLOW) allow.push(`Bash(${g})`);
    if (checkCommand) allow.push(`Bash(${checkCommand})`);
    const deny = GIT_DENY.map((g) => `Bash(${g})`);
    for (const sub of ["git-pr merge", "git-pr review", "init"]) deny.push(`Bash(${cli} ${sub} *)`);
    return { allow, deny };
}

/** The `permissions` block to paste into `.claude/settings.local.json`. */
export function renderRulesJson(rules: BuildRules): string {
    return `${JSON.stringify({ permissions: { allow: rules.allow, deny: rules.deny } }, null, 2)}\n`;
}

/** The text inside `Bash(...)`, or `null` when the entry is for another tool. A bare `Bash` allows every command. */
function bashPattern(entry: string): string | null {
    if (entry === "Bash") return "*";
    const m = /^Bash\((.*)\)$/s.exec(entry);
    return m ? m[1]! : null;
}

/** Claude Code's `*` matches any characters, spaces included. */
function globMatches(pattern: string, command: string): boolean {
    const re = new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
    return re.test(command);
}

/** A required entry is covered when some entry the project has matches the command the required one stands for. */
function covered(required: string, have: readonly string[]): boolean {
    const pattern = bashPattern(required);
    if (pattern === null) return true;
    const sample = pattern.replaceAll("*", "");
    return have.some((h) => {
        const p = bashPattern(h);
        return p !== null && globMatches(p, sample);
    });
}

export interface RuleGaps {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
}

/** The required entries that no entry in `have` covers. A broader rule the person wrote counts as covering. */
export function missingRules(required: BuildRules, have: { readonly allow: readonly string[]; readonly deny: readonly string[] }): RuleGaps {
    return {
        allow: required.allow.filter((r) => !covered(r, have.allow)),
        deny: required.deny.filter((r) => !covered(r, have.deny)),
    };
}

/** The allow and deny lists of one settings file (JSON text); anything unreadable counts as having none. */
export function parsePermissions(text: string | null): { readonly allow: string[]; readonly deny: string[] } {
    const out = { allow: [] as string[], deny: [] as string[] };
    if (text === null) return out;
    try {
        const permissions = (JSON.parse(text) as { permissions?: { allow?: unknown; deny?: unknown } }).permissions;
        for (const key of ["allow", "deny"] as const) {
            const list = permissions?.[key];
            if (Array.isArray(list)) out[key] = list.filter((e): e is string => typeof e === "string");
        }
    } catch {
        // Not JSON: the file contributes nothing, and the gap is reported.
    }
    return out;
}

async function readIfThere(file: string): Promise<string | null> {
    try {
        return await readFile(file, "utf-8");
    } catch {
        return null;
    }
}

/** The project's and the user's Claude Code settings files that a headless run reads. */
export async function readPermissionFiles(cwd: string, home: string = os.homedir()): Promise<{ readonly allow: string[]; readonly deny: string[] }> {
    const files = [path.join(cwd, ".claude", "settings.local.json"), path.join(cwd, ".claude", "settings.json"), path.join(home, ".claude", "settings.json")];
    const all = { allow: [] as string[], deny: [] as string[] };
    for (const file of files) {
        const p = parsePermissions(await readIfThere(file));
        all.allow.push(...p.allow);
        all.deny.push(...p.deny);
    }
    return all;
}

/** What to tell the person before a run starts, or `null` when the rules cover the build. Plain lines, nothing blocked. */
export function readinessWarning(gaps: RuleGaps, checkConfigured: boolean): string | null {
    const lines: string[] = [];
    if (gaps.allow.length > 0) {
        lines.push(`This project's Claude Code rules do not allow ${gaps.allow.length} command${gaps.allow.length === 1 ? "" : "s"} an unattended build uses, so a run will stop at the first one:`);
        lines.push(...gaps.allow.map((r) => `  ${r}`));
    }
    if (gaps.deny.length > 0) {
        lines.push(`Nothing refuses ${gaps.deny.length === 1 ? "this" : "these"}, so a run could force a push or reach a merge, a review or init:`);
        lines.push(...gaps.deny.map((r) => `  ${r}`));
    }
    if (!checkConfigured) {
        lines.push("TAI_CHECK_COMMAND is not set, so a run has no check to record and the merge gate will not pass.");
    }
    if (lines.length === 0) return null;
    lines.push("Run `do-dev-tasks rules` to see the narrow rule set, and add it to your own .claude/settings.local.json yourself. TAI does not write it.");
    return lines.join("\n");
}
