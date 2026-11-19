/**
 * TAI Framework — the real pieces behind `tai service run` and `tai service check` (Epic TAI-763, Story TAI-770).
 *
 * `run.ts` takes everything it touches as an argument; this file is what the command passes in: the arguments and their defaults, the
 * clone's own `.env`, git in the clone, and the two child commands that run IN the clone with its own configuration (`service check`
 * for the checks that read Jira, and `do-dev-tasks` for the work itself). Parsing is tested; the process and git pieces are thin.
 */

import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseEnv, promisify } from "node:util";

import { defaultBranch } from "../commands/dev-tasks-git.js";
import { readWorkingTree } from "../git/local-check.js";
import { parseWaitHours } from "../commands/usage-limit.js";
import type { RunSummary } from "../commands/do-dev-tasks.js";
import type { ClonePosition, RefreshGit } from "./refresh.js";
import type { Env } from "./preflight.js";
import type { WorkSummary } from "./run.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_WAIT_HOURS = 5;
export const DEFAULT_CAP = 3;
export const RESULT_FILE = "run-result.json";

export interface ServiceRunArgs {
    readonly clonePath: string;
    readonly stateDir: string;
    readonly waitHours: number;
    readonly cap: number;
}

/**
 * `service run clone=<path> [state=<dir>] [wait=<hours>] [cap=<tickets>]`. Each can come from the environment instead (TAI_SERVICE_CLONE,
 * TAI_SERVICE_STATE, TAI_SERVICE_WAIT, TAI_SERVICE_CAP), so a unit file or an orchestrator sets them without arguments. The state
 * directory defaults to the clone's parent (`<state>/repo`); the wait defaults to the five-hour window and the cap to 3 tickets.
 * A mistyped flag is refused, because it must not start a real run.
 */
export function parseServiceRunArgs(args: readonly (string | undefined)[], env: Env = {}): ServiceRunArgs {
    const given = args.filter((a): a is string => a !== undefined && a !== "");
    const values = new Map<string, string>();
    for (const a of given) {
        const m = /^(clone|state|wait|cap)=(.*)$/.exec(a);
        if (!m) throw new Error(`service run takes only clone=<path>, state=<dir>, wait=<hours> and cap=<tickets> (got: ${a}).`);
        if (values.has(m[1]!)) throw new Error(`service run takes only one ${m[1]}= (got it twice).`);
        values.set(m[1]!, m[2]!);
    }
    const pick = (name: string, envName: string): string | undefined => values.get(name) ?? ((env[envName] ?? "").trim() || undefined);
    const clone = pick("clone", "TAI_SERVICE_CLONE");
    if (!clone) throw new Error("service run needs the clone's path: clone=<path> (or TAI_SERVICE_CLONE).");
    const clonePath = resolve(clone);
    const stateRaw = pick("state", "TAI_SERVICE_STATE");
    const waitRaw = pick("wait", "TAI_SERVICE_WAIT");
    const capRaw = pick("cap", "TAI_SERVICE_CAP");
    if (capRaw !== undefined && !/^[1-9][0-9]*$/.test(capRaw)) throw new Error(`cap= takes a whole number of tickets, 1 or more (got: ${capRaw}).`);
    return {
        clonePath,
        stateDir: stateRaw ? resolve(stateRaw) : dirname(clonePath),
        waitHours: waitRaw === undefined ? DEFAULT_WAIT_HOURS : parseWaitHours(waitRaw),
        cap: capRaw === undefined ? DEFAULT_CAP : Number(capRaw),
    };
}

async function exists(path: string, kind: "file" | "dir"): Promise<boolean> {
    try {
        const s = await stat(path);
        return kind === "file" ? s.isFile() : s.isDirectory();
    } catch {
        return false;
    }
}

/**
 * The system variables a child may inherit: where programs and the home directory are, the locale, the terminal, the proxy and
 * certificate settings, git's and ssh's own, and the ones Claude signs in with (`ANTHROPIC_*`, the OAuth token, the config directory), and the run's time limit (`TAI_DEV_RUN_TIMEOUT_MIN`). Everything else the launching shell holds, above all a TAI_*, JIRA, GITHUB or BITBUCKET
 * credential that came from whatever directory the command was started in, is left out, so the clone sees ONLY the credentials in
 * its own `.env`. A missing role then shows as missing instead of being filled from the wrong place. The AI-session markers are
 * not in the list on purpose.
 */
const INHERITED = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TERM|TZ|TMPDIR|PWD|SSH_AUTH_SOCK|LC_.*|XDG_.*|NODE_.*|GIT_.*|SSL_CERT_.*|NO_PROXY|no_proxy|HTTPS?_PROXY|https?_proxy|ALL_PROXY|all_proxy|ANTHROPIC_.*|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR|TAI_DEV_RUN_TIMEOUT_MIN)$/;

/** The environment of the run in the clone: the allowlisted system variables of `base`, with the clone's own `.env` laid over them. */
export async function cloneEnvironment(clonePath: string, base: Env): Promise<{ readonly envFileFound: boolean; readonly env: NodeJS.ProcessEnv }> {
    const file = join(clonePath, ".env");
    let text: string | null;
    try {
        text = await readFile(file, "utf8");
    } catch {
        text = null;
    }
    const system: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(base)) if (value !== undefined && INHERITED.test(name)) system[name] = value;
    return { envFileFound: text !== null, env: { ...system, ...(text === null ? {} : parseEnv(text)) } };
}

export async function cloneIsGitRepo(clonePath: string): Promise<boolean> {
    return (await exists(clonePath, "dir")) && (await exists(join(clonePath, ".git"), "dir").then((d) => d || exists(join(clonePath, ".git"), "file")));
}

export function realRefreshGit(clonePath: string): RefreshGit {
    const git = async (...args: string[]): Promise<string> => (await execFileAsync("git", args, { cwd: clonePath })).stdout.trim();
    return {
        fetchPrune: async () => void (await git("fetch", "--prune")),
        position: async (): Promise<ClonePosition> => ({
            branch: await git("rev-parse", "--abbrev-ref", "HEAD"),
            defaultBranch: await defaultBranch(clonePath),
            clean: (await readWorkingTree(clonePath, ".tai")).porcelain.trim() === "",
        }),
        fastForward: async (branch) => void (await git("merge", "--ff-only", `origin/${branch}`)),
    };
}

/** Runs this same command line again with other arguments, in `cwd`, so a child sees the clone's own configuration under the same runner (tsx) as this process. */
function selfCommand(args: readonly string[]): { readonly command: string; readonly args: readonly string[] } {
    return { command: process.execPath, args: [...process.execArgv, process.argv[1]!, ...args] };
}

/** How long `service check` may take before it is stopped: it holds the run lock, so a hung Jira call must not hold it for ever. */
const CHECK_TIMEOUT_MS = 2 * 60 * 1000;

/** `service check` in the clone: the checks that read Jira and the permission rules. Its answer is one JSON line on stdout. */
export async function runCloneCheck(clonePath: string, env: NodeJS.ProcessEnv, timeoutMs = CHECK_TIMEOUT_MS): Promise<{ readonly ok: boolean; readonly reasons: readonly string[] }> {
    const { command, args } = selfCommand(["service", "check"]);
    return new Promise((done) => {
        const child = spawn(command, args, { cwd: clonePath, env, stdio: ["ignore", "pipe", "pipe"] });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
        child.on("error", (e) => {
            clearTimeout(timer);
            done({ ok: false, reasons: [`the check in the clone could not start: ${e.message}`] });
        });
        child.on("close", () => {
            clearTimeout(timer);
            if (timedOut) return done({ ok: false, reasons: [`the check in the clone did not answer within ${Math.round(timeoutMs / 1000)} seconds`] });
            const line = out.trim().split("\n").at(-1) ?? "";
            try {
                const v = JSON.parse(line) as { ok?: unknown; reasons?: unknown };
                if (typeof v.ok === "boolean" && Array.isArray(v.reasons)) return done({ ok: v.ok, reasons: v.reasons.map(String) });
            } catch {
                // fall through to the failure below
            }
            done({ ok: false, reasons: [`the check in the clone gave no answer: ${(err || out).trim().split("\n").at(-1) ?? "no output"}`] });
        });
    });
}

/** The stops that are passed on to a run in the clone. */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/**
 * `do-dev-tasks wait=<h> max=<n> result=<file>` in the clone, its output going to this process's own (the journal under a unit). Rejects
 * when the run left no summary, which is how a crash looks from here.
 */
export async function runCloneWork(clonePath: string, stateDir: string, env: NodeJS.ProcessEnv, options: { readonly waitHours: number; readonly cap: number }, launch: typeof selfCommand = selfCommand): Promise<WorkSummary> {
    await mkdir(stateDir, { recursive: true });
    const resultPath = join(stateDir, RESULT_FILE);
    await rm(resultPath, { force: true });
    const { command, args } = launch(["do-dev-tasks", `wait=${options.waitHours}`, `max=${options.cap}`, `result=${resultPath}`]);
    const code = await new Promise<number | null>((done, fail) => {
        const child = spawn(command, args, { cwd: clonePath, env, stdio: "inherit" });
        // A stop sent to this process (a `kill`, Ctrl-C, a closed terminal) goes on to the run, which is then waited for: no run may outlive
        // its command, and the lock stays ours until the run has ended, so the next tick cannot start a second one beside it.
        const forwarded = FORWARDED_SIGNALS.map((signal) => {
            const forward = (): void => void child.kill(signal);
            process.on(signal, forward);
            return [signal, forward] as const;
        });
        const stopForwarding = (): void => forwarded.forEach(([signal, forward]) => process.off(signal, forward));
        child.on("error", (e) => {
            stopForwarding();
            fail(e);
        });
        child.on("close", (c) => {
            stopForwarding();
            done(c);
        });
    });
    let summary: RunSummary;
    try {
        summary = JSON.parse(await readFile(resultPath, "utf8")) as RunSummary;
    } catch {
        throw new Error(`do-dev-tasks exited ${code ?? "on a signal"} and left no summary`);
    }
    return summary;
}
