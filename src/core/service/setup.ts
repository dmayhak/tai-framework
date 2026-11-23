/**
 * TAI Framework — `tai service setup <project>`: the service's own clone (Epic TAI-763, Story TAI-771).
 *
 * Reads the project's entry from `<root>/projects.json`, clones its remote to the entry's clone path, gives the clone its own `.tai/`,
 * copies the person's `.claude/settings.local.json` (permission rules, no secrets) into it, and says what the person still has to do by
 * hand: write the clone's own `.env` (never copied), type the attestation command in a plain terminal (never written here), and work on
 * a branch in their own checkout. Everything that touches git or the file system is injected, so the rules are tested without either.
 * No service manager is named here: a timer installer is a separate piece, so a launchd one can be added without touching this.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { CREDENTIAL_ROLES, credentialVariables, type Env } from "./preflight.js";

export const PROJECTS_FILE = "projects.json";
export const DEFAULT_ROOT_UNDER_HOME = ".local/share/tai-service";

/** One project the service works: its key, where to clone it from and to, and the run's settings. */
export interface ProjectEntry {
    readonly key: string;
    readonly remote: string;
    /** Absolute path of the service's clone. */
    readonly clone: string;
    /** For the timer (a later Story); read and checked here so one file holds a project's settings. */
    readonly intervalMinutes?: number;
    readonly waitHours?: number;
    readonly cap?: number;
}

const ENTRY_SHAPE = `{ "projects": [ { "key": "tai", "remote": "<git remote URL>", "clone": "<optional path>", "intervalMinutes": 30, "waitHours": 5, "cap": 3 } ] }`;
const KNOWN_FIELDS = new Set(["key", "remote", "clone", "intervalMinutes", "waitHours", "cap"]);
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** root= first, then TAI_SERVICE_ROOT, then `~/.local/share/tai-service`. */
export function resolveServiceRoot(given: string | undefined, env: Env, home: string = homedir()): string {
    const chosen = given?.trim() || (env["TAI_SERVICE_ROOT"] ?? "").trim();
    return chosen ? resolve(chosen) : join(home, DEFAULT_ROOT_UNDER_HOME);
}

function positive(value: unknown, field: string, whole: boolean, where: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (whole && !Number.isInteger(value))) {
        throw new Error(`${where}: ${field} must be a positive ${whole ? "whole " : ""}number (got ${JSON.stringify(value)}).`);
    }
    return value;
}

/** The entries of the project list, checked; a problem names the file. A relative clone path is read against the root; a leading `~/` is the home directory. */
export function parseProjects(text: string, root: string, configPath: string, home: string = homedir()): readonly ProjectEntry[] {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new Error(`${configPath} is not valid JSON (${e instanceof Error ? e.message : String(e)}). An entry looks like: ${ENTRY_SHAPE}`, { cause: e });
    }
    const list = (data as { projects?: unknown } | null)?.projects;
    if (!Array.isArray(list)) throw new Error(`${configPath} must hold a "projects" list. An entry looks like: ${ENTRY_SHAPE}`);
    const seen = new Set<string>();
    return list.map((raw, i): ProjectEntry => {
        const where = `${configPath}, entry ${i + 1}`;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: an entry is an object. It looks like: ${ENTRY_SHAPE}`);
        const e = raw as Record<string, unknown>;
        for (const field of Object.keys(e)) if (!KNOWN_FIELDS.has(field)) throw new Error(`${where}: unknown field "${field}" (known: ${[...KNOWN_FIELDS].join(", ")}).`);
        if (typeof e["key"] !== "string" || !SAFE_KEY.test(e["key"])) throw new Error(`${where}: "key" must be a name of letters, digits, dots, dashes and underscores.`);
        if (typeof e["remote"] !== "string" || e["remote"].trim() === "") throw new Error(`${where}: "remote" must be the git remote URL.`);
        if (e["clone"] !== undefined && (typeof e["clone"] !== "string" || e["clone"].trim() === "")) throw new Error(`${where}: "clone" must be a path.`);
        if (seen.has(e["key"])) throw new Error(`${where}: the key "${e["key"]}" is listed twice.`);
        seen.add(e["key"]);
        const intervalMinutes = positive(e["intervalMinutes"], "intervalMinutes", true, where);
        const waitHours = positive(e["waitHours"], "waitHours", false, where);
        const cap = positive(e["cap"], "cap", true, where);
        const given = e["clone"] as string | undefined;
        const path = given === undefined ? undefined : given === "~" ? home : given.startsWith("~/") ? join(home, given.slice(2)) : given;
        const clone = path === undefined ? join(root, e["key"], "repo") : isAbsolute(path) ? path : resolve(root, path);
        return { key: e["key"], remote: e["remote"].trim(), clone, ...(intervalMinutes === undefined ? {} : { intervalMinutes }), ...(waitHours === undefined ? {} : { waitHours }), ...(cap === undefined ? {} : { cap }) };
    });
}

export function findProject(entries: readonly ProjectEntry[], key: string, configPath: string): ProjectEntry {
    const found = entries.find((p) => p.key === key);
    if (found) return found;
    throw new Error(`No project "${key}" in ${configPath}. Projects listed there: ${entries.length === 0 ? "none" : entries.map((p) => p.key).join(", ")}. Add an entry: ${ENTRY_SHAPE}`);
}

/** Lower-cases the host of `[user@]host`, leaving the user, which a server may keep case-sensitive. */
function lowerHost(authority: string): string {
    const at = authority.lastIndexOf("@");
    return `${authority.slice(0, at + 1)}${authority.slice(at + 1).toLowerCase()}`;
}

/** Without a closing slash or `.git`, and with the host (not the user or the path, which a host may keep case-sensitive) in lower case. */
function normalizeRemote(remote: string): string {
    const bare = remote.trim().replace(/\/+$/, "").replace(/\.git$/, "");
    const url = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i.exec(bare);
    if (url) return `${url[1]!.toLowerCase()}${lowerHost(url[2]!)}${url[3]}`;
    const scp = /^([^/:]+):(.*)$/.exec(bare);
    return scp ? `${lowerHost(scp[1]!)}:${scp[2]}` : bare;
}

/** One remote written with or without `.git` or a closing slash is still that remote. */
export function sameRemote(a: string, b: string): boolean {
    return normalizeRemote(a) === normalizeRemote(b);
}

/** A remote as it may be printed: any `user:token@` written into a URL is left out (up to the last `@` before the path, so a password holding an `@` is left out whole, and every URL in a text, not only the first), because secrets live in `.env`, not in a terminal or a log. */
export function redactRemote(remote: string): string {
    return remote.replace(/\/\/[^/\s]*@/g, "//");
}

/** A path as one word in a command a person pastes: left bare when it is plain, else single-quoted. */
export function shellQuote(path: string): string {
    return /^[A-Za-z0-9_./:@%+=,-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** What is at the clone path. A clone with no `origin` is `remote: null`. */
export type PathState = { readonly kind: "absent" } | { readonly kind: "empty-dir" } | { readonly kind: "clone"; readonly remote: string | null } | { readonly kind: "other" };

export interface SetupDeps {
    /** The file's text, or null when it is not there. */
    readonly readFile: (path: string) => Promise<string | null>;
    readonly inspect: (path: string) => Promise<PathState>;
    readonly clone: (remote: string, path: string) => Promise<void>;
    readonly makeDir: (path: string) => Promise<void>;
    readonly fileExists: (path: string) => Promise<boolean>;
    /** Copies a file, making the folders above the target. */
    readonly copyFile: (from: string, to: string) => Promise<void>;
    /** The first thing the unattended run's preflight still finds missing in the clone (the same checks), or null. */
    readonly stillMissing: (clonePath: string) => Promise<string | null>;
    readonly say: (line: string) => void;
}

export interface SetupArgs {
    readonly project: string;
    readonly root: string;
    /** The person's own checkout, where the permission rules are copied from. */
    readonly from: string;
}

const SETTINGS_FILE = ".claude/settings.local.json";

/** The `.env` the clone needs, by role, from the preflight's own table, so the two cannot drift. */
function envLines(clonePath: string): string[] {
    const lines = [`The clone's own .env (${join(clonePath, ".env")}) needs these, written in your own editor (setup never copies your .env):`];
    for (const role of CREDENTIAL_ROLES) {
        const usual = credentialVariables(role, {});
        const github = credentialVariables(role, { TAI_GIT_HOST: "github" });
        const same = usual.join() === github.join();
        lines.push(`  * ${role}: ${usual.join(", ")}${same ? "" : ` (with TAI_GIT_HOST=github: ${github.join(", ")})`}`);
    }
    lines.push("  * and the project's own settings (TAI_PROJECT_KEY and the rest; the clone's .env.example lists them).");
    return lines;
}

export async function runServiceSetup(args: SetupArgs, deps: SetupDeps): Promise<{ readonly changed: boolean; readonly clonePath: string }> {
    const configPath = join(args.root, PROJECTS_FILE);
    const text = await deps.readFile(configPath);
    if (text === null) throw new Error(`There is no project list at ${configPath}. Make it with one entry per project: ${ENTRY_SHAPE}`);
    const entry = findProject(parseProjects(text, args.root, configPath), args.project, configPath);
    const clonePath = entry.clone;

    // Decide everything that can refuse before changing anything.
    const found = await deps.inspect(clonePath);
    if (found.kind === "other") throw new Error(`${clonePath} exists and is not a clone of ${redactRemote(entry.remote)}: it was left untouched. Move it away or set another "clone" path for ${entry.key} in ${configPath}.`);
    if (found.kind === "clone" && (found.remote === null || !sameRemote(found.remote, entry.remote))) {
        throw new Error(`${clonePath} is a git clone of ${found.remote === null ? "no remote" : redactRemote(found.remote)}, not ${redactRemote(entry.remote)}: it was left untouched. Move it away, set another "clone" path for ${entry.key} in ${configPath}${found.remote === null ? "" : `, or set its "remote" back to ${redactRemote(found.remote)} if the clone is the one you want`}.`);
    }

    const done: string[] = [];
    const kept: string[] = [];
    if (found.kind === "clone") kept.push(`the clone ${clonePath} (${redactRemote(entry.remote)})`);
    else {
        await deps.clone(entry.remote, clonePath);
        done.push(`cloned ${redactRemote(entry.remote)} to ${clonePath}`);
    }

    const taiDir = join(clonePath, ".tai");
    if (await deps.fileExists(taiDir)) kept.push("its own .tai/");
    else {
        await deps.makeDir(taiDir);
        done.push("gave the clone its own .tai/ (its own Jira cache and attestation)");
    }

    const source = join(args.from, SETTINGS_FILE);
    const target = join(clonePath, SETTINGS_FILE);
    const notes: string[] = [];
    if (resolve(args.from) === resolve(clonePath)) notes.push(`${SETTINGS_FILE}: from= is the clone itself, so there is nothing to copy.`);
    else if (await deps.fileExists(target)) kept.push(`its ${SETTINGS_FILE}`);
    else if (await deps.fileExists(source)) {
        await deps.copyFile(source, target);
        done.push(`copied ${SETTINGS_FILE} from ${args.from} (permission rules, no secrets)`);
    } else notes.push(`There is no ${SETTINGS_FILE} in ${args.from}, so none was copied: the preflight will name the permission rules the unattended run needs. Use from=<path> for the checkout that has them.`);

    if (done.length === 0) deps.say(`Nothing changed: already in place: ${kept.join(", ")}.`);
    else {
        for (const d of done) deps.say(`Setup ${d}.`);
        if (kept.length > 0) deps.say(`Already in place: ${kept.join(", ")}.`);
    }
    for (const n of notes) deps.say(n);

    deps.say("");
    for (const line of envLines(clonePath)) deps.say(line);
    deps.say("");
    deps.say("Then turn DEV-YOLO on for the clone. The attestation is not written here: type this in a plain terminal (not an AI session), against the clone's own .tai/:");
    deps.say(`  tai --project ${shellQuote(clonePath)} settings set dev-yolo true`);
    deps.say("(`tai` is the short command that `bin/tai-link` in the TAI checkout puts on your path; until it is linked, run `bin/tai` from that checkout in its place.)");
    deps.say("");

    // The work is done by now; a check that cannot answer is said, not allowed to end the command in an error after the hand-off.
    let missing: string | null;
    try {
        missing = await deps.stillMissing(clonePath);
    } catch (e) {
        missing = `could not check what is still missing (${e instanceof Error ? e.message : String(e)}); run \`tai service run clone=${shellQuote(clonePath)}\` to see it`;
    }
    deps.say(missing === null ? `Nothing is missing: \`tai service run clone=${shellQuote(clonePath)}\` can start a run.` : `Still missing: ${missing}.`);
    deps.say("Work on a branch, not main, in your own checkout: the service fast-forwards main in its clone and merges to it often, so commits made on main there would conflict when you pull.");
    return { changed: done.length > 0, clonePath };
}
