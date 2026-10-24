/**
 * TAI-588/589: the Claude Code allow rule `init run` offers.
 *
 * A Claude Code session in auto mode judges each Bash command with a classifier, so a routine run of TAI's own
 * CLI (dozens of `page link` calls in a clean-up) can stall when it denies one. This module builds a narrow rule
 * for TAI's ticket, page and read-only commands, and merges it into a project's `.claude/settings.local.json`:
 * the personal, uncommitted file, because the rule names this machine's TAI install path.
 *
 * What it never allows: `git-pr merge`, `git-pr review`, `init`, and every other subcommand. A merge or an
 * approval still reaches the human.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { PERSONA_ALIASES, Persona } from "../schema/story-schema.js";

/** Subcommands the rule covers, each bare and with each persona id spelled out after `--as`. A persona is spelled
 *  out, never a `*`: Claude Code's `*` matches any characters including spaces, so `--as * issue *` would also match
 *  `--as x git-pr merge ... issue ...` and let a merge or an approval run without reaching the human. */
const COVERED_SUBCOMMANDS: readonly string[] = [
    "issue",
    "page",
    "ready",
    "pr-ready",
    "work",
    "verify",
    "git-pr review-prep",
    "git-pr comments",
    "git-pr render-findings",
];

/** A persona name as `--as` accepts it (the same shape `extractActingPersona` in cli.ts checks). */
const PERSONA_NAME_SHAPE = /^[a-zA-Z][a-zA-Z0-9-]*$/;

/**
 * Every name `--as` takes without a project lookup, plus `extraPersonaIds` (the project's own personas): each
 * built-in id, each built-in's short names, and any extra id of the right shape. Sorted, no duplicates; an id that
 * is not a valid `--as` value is left out rather than written into a rule.
 */
export function personaSpellings(extraPersonaIds: readonly string[] = []): string[] {
    const names = new Set<string>(Object.values(Persona));
    for (const aliases of Object.values(PERSONA_ALIASES)) for (const alias of aliases) names.add(alias);
    for (const id of extraPersonaIds) if (PERSONA_NAME_SHAPE.test(id)) names.add(id);
    return [...names].sort();
}

/**
 * The `Bash(...)` allow entries for the CLI of the install at `taiHome`, in a stable order: each covered
 * subcommand bare, then with each persona name after `--as` and after `--as=`.
 */
export function buildAllowRules(taiHome: string, extraPersonaIds: readonly string[] = []): string[] {
    const cli = `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts`;
    const names = personaSpellings(extraPersonaIds);
    const rules: string[] = [];
    for (const sub of COVERED_SUBCOMMANDS) {
        rules.push(`Bash(${cli} ${sub} *)`);
        for (const name of names) {
            rules.push(`Bash(${cli} --as ${name} ${sub} *)`);
            rules.push(`Bash(${cli} --as=${name} ${sub} *)`);
        }
    }
    return rules;
}

/**
 * What the allow-rule prompt shows for `rules`. The bare rules are listed in full; the many `--as <name>` and
 * `--as=<name>` rules are one line per subcommand, since the same words repeat for every persona name.
 */
export function describeAllowRules(rules: readonly string[], taiHome: string, personaNames: readonly string[]): string {
    const prefix = `Bash(npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts `;
    const bare = rules.filter((r) => r.startsWith(prefix) && !/^--as[ =]/.test(r.slice(prefix.length)));
    const withPersona = rules.length - bare.length;
    const lines = bare.map((r) => `  ${r}`);
    if (withPersona > 0) {
        lines.push(
            `  ...and ${withPersona} more: each of those subcommands after \`--as <name>\` and \`--as=<name>\` for ` +
                `${personaNames.length} persona names (${personaNames.join(", ")}).`
        );
    }
    return lines.join("\n");
}

export type MergeResult =
    | { readonly ok: true; readonly content: string; readonly added: readonly string[]; readonly present: readonly string[] }
    | { readonly ok: false; readonly reason: string };

/**
 * Merges `rules` into the JSON text of a settings file (`null` for no file yet). Every other key and every existing
 * allow entry is kept, in order; a rule already present is not added again. A file that is not a JSON object, or
 * whose `permissions` or `permissions.allow` is the wrong shape, is refused rather than overwritten.
 */
export function mergeAllowRules(existing: string | null, rules: readonly string[]): MergeResult {
    let settings: Record<string, unknown> = {};
    if (existing !== null && existing.trim() !== "") {
        let parsed: unknown;
        try {
            parsed = JSON.parse(existing);
        } catch {
            return { ok: false, reason: "it is not valid JSON" };
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "it is not a JSON object" };
        settings = parsed as Record<string, unknown>;
    }

    const permissions = settings["permissions"];
    if (permissions !== undefined && (typeof permissions !== "object" || permissions === null || Array.isArray(permissions))) {
        return { ok: false, reason: "its `permissions` is not an object" };
    }
    const permissionsObject = (permissions ?? {}) as Record<string, unknown>;
    const allow = permissionsObject["allow"];
    if (allow !== undefined && !Array.isArray(allow)) return { ok: false, reason: "its `permissions.allow` is not a list" };
    const allowList: unknown[] = [...((allow as unknown[] | undefined) ?? [])];

    const added: string[] = [];
    const present: string[] = [];
    for (const rule of rules) {
        if (allowList.includes(rule)) present.push(rule);
        else {
            allowList.push(rule);
            added.push(rule);
        }
    }

    const merged = { ...settings, permissions: { ...permissionsObject, allow: allowList } };
    return { ok: true, content: `${JSON.stringify(merged, null, 2)}\n`, added, present };
}

export function settingsLocalPath(cwd: string): string {
    return path.join(cwd, ".claude", "settings.local.json");
}

/** Reads the project's settings file, or `null` when there is none. */
export async function readSettingsLocal(cwd: string): Promise<string | null> {
    try {
        return await readFile(settingsLocalPath(cwd), "utf-8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
    }
}

/** Written to a temporary file in the same directory and renamed over the target, so an interrupted write leaves the old file. */
export async function writeSettingsLocal(cwd: string, content: string): Promise<void> {
    const file = settingsLocalPath(cwd);
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    try {
        await writeFile(temp, content, "utf-8");
        await rename(temp, file);
    } catch (err) {
        await rm(temp, { force: true });
        throw err;
    }
}
