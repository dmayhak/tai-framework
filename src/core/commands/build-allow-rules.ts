/**
 * TAI-649: the Claude Code rules an unattended Dev build needs (Story TAI-648).
 *
 * `do-dev-tasks` starts `claude -p` runs that have nobody to approve a command. A run stops at the first command the
 * project's rules do not cover, so this module names the narrow set a build uses, and checks a project's settings
 * files against it before any run starts. It never writes anything: the person adds the rules to their own settings.
 *
 * What it never allows: `git-pr merge`, `git-pr review` and `init` (ADR decision 9: permission to merge is a separate
 * opt-in), and a force push. The deny entries make a force push refuse even where a broader rule would let it through.
 *
 * Limits, accepted. The allow set is narrow in the commands it names, not in every argument: `issue *` allows an
 * `issue transition` to any state (a build moves its own ticket), and `git checkout *`, `git switch *` and `git push origin *`
 * allow what the deny entries do not take back. Those are the destructive forms (a force push, a `--delete`, `--mirror` or
 * `--prune` push, a branch delete, a forced or resetting checkout or switch, a checkout that discards the working tree) and a
 * push to `main` or `master`. A push to the default branch under another name, or by a refspec such as `HEAD:refs/heads/main`,
 * is not refused. The allow side names `--as developer` and not `--as=developer`, since the prompts TAI writes use the space
 * form. Combined short flags on a push are denied only as `-uf` and `-f*`, not in every combination. The deny entries spell out
 * every persona name `--as` takes (the built-in ids, their short names and the project's own, when its personas page can be
 * read) and never a `*`, since a `*` spans spaces and `--as * init *` would refuse any command that merely contains the word.
 * And the check reads only the settings files under the directory the command runs from and the user's own, so a headless
 * run started elsewhere, managed settings and `ask` rules can judge differently than the warning says. A person's own deny
 * rule that refuses a required command is read, since a deny beats an allow.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { personaSpellings } from "./claude-allow-rule.js";
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

/**
 * What a build never does with git: a force push in any spelling (the flags, and a `+` before a refspec), a push with
 * `--delete`, `--mirror` or `--prune`, a push to `main` or `master`, a branch delete, a forced or resetting checkout or
 * switch, and a checkout that discards work. A delete by refspec (`git push origin :branch`) is not refused: its pattern
 * would end in `:*`, which Claude Code reads as its older prefix form, so it cannot be written here.
 */
const GIT_DENY: readonly string[] = [
    "git push *--force*",
    "git push * -f*",
    "git push -f*",
    "git push *+*",
    "git push *--delete*",
    "git push *--mirror*",
    "git push *--prune*",
    ...["main", "master"].flatMap((b) => [`git push origin ${b}`, `git push origin ${b} *`, `git push -u origin ${b}`, `git push -u origin ${b} *`, `git push *:${b}`]),
    "git push -uf*",
    "git branch -D*",
    "git branch -d*",
    "git branch --delete*",
    "git branch -f*",
    "git branch --force*",
    "git branch -M*",
    "git checkout -f*",
    "git checkout *--force*",
    "git checkout -B*",
    "git switch -f*",
    "git switch *--discard-changes*",
    "git switch -C*",
    "git checkout -- *",
    "git checkout .",
];

/** The TAI commands a build must never reach, however they are spelled (see `denySpellings`). */
const NEVER_SUBCOMMANDS: readonly string[] = ["git-pr merge", "git-pr review", "init"];

/**
 * Every spelling of the CLI that reaches `sub`: bare, then each persona name after `--as` and after `--as=`. A persona is
 * spelled out, never a `*`: a `*` spans spaces, so `--as * init *` would also match `--as developer issue comment ... "run
 * init" ...` and refuse a build's own ticket commands (see `claude-allow-rule.ts`).
 */
function denySpellings(cli: string, sub: string, names: readonly string[]): string[] {
    return [`Bash(${cli} ${sub} *)`, ...names.flatMap((n) => [`Bash(${cli} --as ${n} ${sub} *)`, `Bash(${cli} --as=${n} ${sub} *)`])];
}

/**
 * The commands inside a compound command: split on `&&`, `||`, `;`, `|`, a lone `&` and a newline, but not inside quotes or
 * after a backslash, and not at the `&` of a redirect (`2>&1`, `&>`). Claude Code matches each part against the rules on its
 * own, so a rule that holds the whole chain would match none of them. A `*` in a part is read as a wildcard.
 */
function splitCompound(command: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quote: string | null = null;
    for (let i = 0; i < command.length; i++) {
        const c = command[i]!;
        if (quote) {
            current += c;
            if (c === "\\" && quote === '"' && i + 1 < command.length) current += command[++i]!;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            current += c;
        } else if (c === "\\" && i + 1 < command.length) {
            current += c + command[++i]!;
        } else if ((c === "&" && (current.endsWith(">") || command[i + 1] === ">")) || (c === "|" && current.endsWith(">"))) {
            current += c;
        } else if (c === "&" || c === "|" || c === ";" || c === "\n") {
            parts.push(current);
            current = "";
            if ((c === "&" || c === "|") && command[i + 1] === c) i++;
        } else {
            current += c;
        }
    }
    parts.push(current);
    return [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
}

/** The rules for the install at `taiHome`; `checkCommand` is the project's `TAI_CHECK_COMMAND`, each command in it allowed as it is written; `extraPersonaIds` are the project's own personas. */
export function buildRunRules(taiHome: string, checkCommand: string | null = null, extraPersonaIds: readonly string[] = []): BuildRules {
    const cli = cliCommand(taiHome);
    const allow: string[] = [];
    for (const sub of BUILD_SUBCOMMANDS) {
        allow.push(`Bash(${cli} ${sub} *)`);
        allow.push(`Bash(${cli} --as developer ${sub} *)`);
    }
    for (const g of GIT_ALLOW) allow.push(`Bash(${g})`);
    if (checkCommand) for (const part of splitCompound(checkCommand)) allow.push(`Bash(${part})`);
    const deny = GIT_DENY.map((g) => `Bash(${g})`);
    const names = personaSpellings(extraPersonaIds);
    for (const sub of NEVER_SUBCOMMANDS) deny.push(...denySpellings(cli, sub, names));
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

/**
 * Claude Code's `*` matches any characters, spaces included. The older prefix form `Bash(git status:*)` matches the
 * command itself and the command followed by a space and anything: `git status` and `git status -s`, not `git statusx`.
 */
function globMatches(pattern: string, command: string): boolean {
    const prefixForm = pattern.endsWith(":*");
    const body = prefixForm ? pattern.slice(0, -2) : pattern;
    const source = body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(prefixForm ? `^${source}(?: .*)?$` : `^${source}$`, "s").test(command);
}

/**
 * The commands a required pattern stands for: each `*` filled with nothing, or with one more word. A rule covers the
 * pattern only when it matches all of them, so a narrower rule (`git push --force*` against `git push *--force*`) is not
 * mistaken for it.
 */
function instances(pattern: string): string[] {
    const parts = pattern.split("*");
    let out = [parts[0]!];
    for (let i = 1; i < parts.length; i++) {
        const before = parts[i - 1]!;
        const atEnd = i === parts.length - 1 && parts[i] === "";
        const spaced = before === "" || before.endsWith(" ");
        const fills = atEnd ? (spaced ? ["", "x"] : ["", " x"]) : spaced ? ["", "x "] : ["", "x"];
        out = out.flatMap((o) => fills.map((f) => `${o}${f}${parts[i]}`));
    }
    return out;
}

/** A required entry is covered when one entry the project has matches every command the required one stands for. */
function covered(required: string, have: readonly string[]): boolean {
    const pattern = bashPattern(required);
    if (pattern === null) return true;
    const all = instances(pattern);
    return have.some((h) => {
        const p = bashPattern(h);
        return p !== null && all.every((c) => globMatches(p, c));
    });
}

/** A required allow entry is refused when a deny entry the project has matches its plain form (each `*` left empty): a deny beats an allow. */
function refused(required: string, deny: readonly string[]): boolean {
    const pattern = bashPattern(required);
    if (pattern === null) return false;
    const sample = pattern.replaceAll("*", "");
    return deny.some((d) => {
        const p = bashPattern(d);
        return p !== null && globMatches(p, sample);
    });
}

export interface RuleGaps {
    readonly allow: readonly string[];
    readonly deny: readonly string[];
}

/** The required entries that no entry in `have` covers, or that a deny of theirs refuses. A broader rule the person wrote counts as covering. */
export function missingRules(required: BuildRules, have: { readonly allow: readonly string[]; readonly deny: readonly string[] }): RuleGaps {
    return {
        allow: required.allow.filter((r) => !covered(r, have.allow) || refused(r, have.deny)),
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
        lines.push(`This project's Claude Code rules do not allow (or a deny rule of yours refuses) ${gaps.allow.length} command${gaps.allow.length === 1 ? "" : "s"} an unattended build uses, so a run will stop at the first one:`);
        lines.push(...gaps.allow.map((r) => `  ${r}`));
    }
    if (gaps.deny.length > 0) {
        lines.push(`Nothing refuses ${gaps.deny.length === 1 ? "this" : "these"}, so a run could force a push, delete a branch, or reach a merge, a review or init:`);
        lines.push(...gaps.deny.map((r) => `  ${r}`));
    }
    if (!checkConfigured) {
        lines.push("TAI_CHECK_COMMAND is not set, so a run has no check to record and the merge gate will not pass.");
    }
    if (lines.length === 0) return null;
    lines.push("Run `do-dev-tasks rules` to see the narrow rule set, and add it to your own .claude/settings.local.json yourself. TAI does not write it.");
    return lines.join("\n");
}
