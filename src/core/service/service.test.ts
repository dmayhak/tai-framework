import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLock, LOCK_FILE } from "./lock.js";
import { cloneEnvironment, cloneIsGitRepo, parseServiceRunArgs, parseServiceSetupArgs, runCloneWork } from "./real.js";
import { checkFailure, credentialVariables, isInside, localPreflightFailure, missingCredential, realPath, type Env } from "./preflight.js";
import { refreshClone, type RefreshGit } from "./refresh.js";
import { clearPause, pauseStopReason, readLastRun, readLimitedUntil, readPause, readPreflightNote, writeLimitedUntil, writePause } from "./state.js";
import { runServiceTick, type ServiceTickDeps, type WorkSummary } from "./run.js";

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tai-service-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const GITHUB_ENV: Env = {
    TAI_JIRA_SITE_URL: "https://x.atlassian.net",
    TAI_JIRA_EMAIL: "a@b.c",
    TAI_JIRA_API_TOKEN: "t",
    TAI_GIT_HOST: "github",
    GITHUB_TOKEN: "g",
    TAI_REVIEWER_GITHUB_TOKEN: "r",
    TAI_REVIEWER_EMAIL: "r@b.c",
};
const FACTS = { aiSession: false, clonePath: "/c/repo", cloneIsGitRepo: true, envFileFound: true, env: GITHUB_ENV };

describe("preflight (TAI-770 AC-2)", () => {
    it("passes when the clone, its .env and every credential role are there", () => {
        assert.equal(localPreflightFailure(FACTS), null);
    });

    it("names the first missing piece, in order: AI session, clone, .env, then the credentials", () => {
        assert.match(localPreflightFailure({ ...FACTS, aiSession: true, cloneIsGitRepo: false })!, /AI session/);
        assert.match(localPreflightFailure({ ...FACTS, cloneIsGitRepo: false, envFileFound: false })!, /clone \/c\/repo is missing.*tai service setup <project>/);
        assert.match(localPreflightFailure({ ...FACTS, envFileFound: false })!, /no \.env \(\/c\/repo\/\.env\)/);
    });

    it("refuses a clone that is the folder the command was started in, or one inside it, but not a sibling or when unknown", () => {
        assert.match(localPreflightFailure({ ...FACTS, startedIn: "/c/repo" })!, /started from inside the clone \/c\/repo.*the service's own folder/);
        assert.match(localPreflightFailure({ ...FACTS, startedIn: "/c/repo/src" })!, /started from inside the clone/);
        assert.equal(localPreflightFailure({ ...FACTS, startedIn: "/c/repo-mine" }), null);
        assert.equal(localPreflightFailure({ ...FACTS, startedIn: "/home/me" }), null);
        assert.match(localPreflightFailure({ ...FACTS, clonePath: "/c/repo", startedIn: "/c/repo/..cache/x" })!, /started from inside the clone/, "a folder named with two dots is still inside");
        assert.equal(localPreflightFailure({ ...FACTS, clonePath: "/c/repo", startedIn: "/c" }), null, "the parent is not inside it");
        assert.equal(localPreflightFailure(FACTS), null, "no start folder given (the check the clone runs on itself)");
    });

    it("names a credential missing BY ROLE and which variable", () => {
        const { TAI_REVIEWER_GITHUB_TOKEN: _drop, ...noReviewer } = GITHUB_ENV;
        assert.deepEqual(missingCredential(noReviewer), { role: "reviewer", variables: ["TAI_REVIEWER_GITHUB_TOKEN"] });
        assert.match(localPreflightFailure({ ...FACTS, env: noReviewer })!, /the reviewer credential is incomplete.*TAI_REVIEWER_GITHUB_TOKEN is not set/);
        assert.match(localPreflightFailure({ ...FACTS, env: { ...GITHUB_ENV, TAI_JIRA_API_TOKEN: " " } })!, /the jira credential is incomplete.*TAI_JIRA_API_TOKEN/);
        assert.match(localPreflightFailure({ ...FACTS, env: { ...GITHUB_ENV, GITHUB_TOKEN: undefined } })!, /the git-host credential/);
    });

    it("takes Bitbucket's variables when the git host is not GitHub", () => {
        assert.deepEqual(credentialVariables("git-host", {}), ["BITBUCKET_EMAIL", "BITBUCKET_API_TOKEN"]);
        assert.deepEqual(credentialVariables("merge", { TAI_GIT_HOST: "GitHub" }), ["GITHUB_TOKEN"]);
    });

    it("turns the clone's own check into its first reason", () => {
        assert.equal(checkFailure({ ok: true, reasons: [] }), null);
        assert.equal(checkFailure({ ok: false, reasons: ["DEV-YOLO is off for a@b.c", "x"] }), "DEV-YOLO is off for a@b.c");
    });
});

describe("refreshClone (TAI-770 AC-3)", () => {
    function git(position: { branch: string; clean: boolean }, log: string[] = []): RefreshGit {
        return {
            fetchPrune: async () => void log.push("fetch --prune"),
            position: async () => ({ ...position, defaultBranch: "main" }),
            fastForward: async (b) => void log.push(`ff ${b}`),
        };
    }

    it("fast-forwards main when the tree is clean and on main", async () => {
        const log: string[] = [];
        assert.deepEqual(await refreshClone(git({ branch: "main", clean: true }, log)), { action: "fast-forwarded", branch: "main" });
        assert.deepEqual(log, ["fetch --prune", "ff main"]);
    });

    it("leaves a dirty tree (a paused ticket's work) untouched, after fetching", async () => {
        const log: string[] = [];
        const out = await refreshClone(git({ branch: "TAI-5-x", clean: false }, log));
        assert.equal(out.action, "left-alone");
        assert.deepEqual(log, ["fetch --prune"]);
    });

    it("leaves a clean tree on another branch (a branch under way) untouched", async () => {
        const log: string[] = [];
        const out = await refreshClone(git({ branch: "TAI-5-x", clean: true }, log));
        assert.equal(out.action, "left-alone");
        assert.match((out as { why: string }).why, /on TAI-5-x, not main/);
        assert.deepEqual(log, ["fetch --prune"]);
    });

    it("reports a git failure instead of throwing", async () => {
        const broken: RefreshGit = { ...git({ branch: "main", clean: true }), fetchPrune: async () => { throw new Error("network down"); } };
        assert.deepEqual(await refreshClone(broken), { action: "failed", why: "network down" });
    });
});

describe("runServiceTick", () => {
    interface Calls { say: string[]; work: number; refresh: number; preflight: number }
    function setup(over: Partial<ServiceTickDeps> = {}, summary: WorkSummary = { tickets: [], capReached: false, limit: null, stopReason: null }) {
        const calls: Calls = { say: [], work: 0, refresh: 0, preflight: 0 };
        let clock = Date.parse("2026-11-18T10:00:00Z");
        const deps: ServiceTickDeps = {
            stateDir: dir,
            waitHours: 5,
            cap: 3,
            lock: { pid: 500, now: () => new Date(clock), isAlive: () => true },
            now: () => new Date(clock),
            say: (l) => void calls.say.push(l),
            preflight: async () => (calls.preflight++, null),
            refresh: async () => (calls.refresh++, { action: "fast-forwarded", branch: "main" }),
            work: async () => (calls.work++, summary),
            ...over,
        };
        return { deps, calls, advance: (ms: number) => void (clock += ms) };
    }

    it("a second start while a run holds the lock does nothing, says so and exits 0 (AC-1)", async () => {
        await acquireLock(dir, { pid: 111, now: () => new Date("2026-11-18T09:00:00Z"), isAlive: () => true });
        const { deps, calls } = setup();
        const r = await runServiceTick(deps);
        assert.deepEqual(r, { status: "locked", exitCode: 0 });
        assert.deepEqual(calls.say, ["A run is already going (started 2026-11-18T09:00:00.000Z, pid 111); nothing started."]);
        assert.deepEqual([calls.preflight, calls.refresh, calls.work], [0, 0, 0]);
    });

    it("takes over a dead run's lock, says so, runs, and removes the lock afterwards (AC-1)", async () => {
        await writeFile(join(dir, LOCK_FILE), JSON.stringify({ pid: 111, startedAt: "2026-11-18T08:00:00.000Z" }));
        const { deps, calls } = setup({ lock: { pid: 500, now: () => new Date("2026-11-18T10:00:00Z"), isAlive: () => false } });
        assert.equal((await runServiceTick(deps)).status, "ran");
        assert.match(calls.say[0]!, /Took over a lock left by pid 111/);
        await assert.rejects(readFile(join(dir, LOCK_FILE), "utf8"), /ENOENT/);
    });

    it("a failed preflight starts no run, is logged once, and is logged again only when it changes (AC-2)", async () => {
        let message = "the reviewer credential is incomplete";
        const { deps, calls } = setup({ preflight: async () => message });
        const first = await runServiceTick(deps);
        assert.deepEqual(first, { status: "preflight-failed", exitCode: 0, message });
        await runServiceTick(deps);
        assert.equal(calls.say.length, 1, "the same failure is not logged again");
        assert.match(calls.say[0]!, /Not starting a run: the reviewer credential is incomplete/);
        message = "DEV-YOLO is off for a@b.c";
        await runServiceTick(deps);
        assert.equal(calls.say.length, 2);
        assert.deepEqual([calls.refresh, calls.work], [0, 0]);
        assert.equal((await readPreflightNote(dir))?.message, "DEV-YOLO is off for a@b.c");
    });

    it("a passing preflight clears the note, so the same failure later is logged again (AC-2)", async () => {
        let fail: string | null = "no .env";
        const { deps, calls } = setup({ preflight: async () => fail });
        await runServiceTick(deps);
        fail = null;
        await runServiceTick(deps);
        assert.equal(await readPreflightNote(dir), null);
        fail = "no .env";
        await runServiceTick(deps);
        assert.equal(calls.say.filter((l) => l.startsWith("Not starting")).length, 2);
    });

    it("refreshes the clone, then works with the wait and cap, and records last-run.json (AC-4, AC-6)", async () => {
        const seen: unknown[] = [];
        const { deps, calls } = setup({ work: async (o) => (seen.push(o), { tickets: [{ key: "TAI-1", state: "handed-on", detail: "merged" }, { key: "TAI-2", state: "pr-opened" }, { key: "TAI-3", state: "failed", detail: "x" }], capReached: true, limit: null, stopReason: null }) });
        const r = await runServiceTick(deps);
        assert.deepEqual(r, { status: "ran", exitCode: 0, stopReason: "cap reached" });
        assert.deepEqual(seen, [{ waitHours: 5, cap: 3 }]);
        assert.ok(calls.say.some((l) => l.startsWith("Cap reached: 3 tickets worked (cap 3)")));
        const last = await readLastRun(dir);
        assert.equal(last?.stopReason, "cap reached");
        assert.equal(last?.started, "2026-11-18T10:00:00.000Z");
        assert.equal(last?.tickets.length, 3);
        assert.equal(last?.tickets[0]?.state, "handed-on");
    });

    it("logs each ticket the pickup rule left alone and records them in last-run.json (TAI-773 AC-6)", async () => {
        const { deps, calls } = setup({}, { tickets: [], capReached: false, limit: null, stopReason: null, skipped: [{ key: "TAI-9", reason: "a comment came after the pause note (service pickup rule)" }] });
        await runServiceTick(deps);
        assert.ok(calls.say.includes("Left alone TAI-9: a comment came after the pause note (service pickup rule)."));
        assert.deepEqual((await readLastRun(dir))?.skipped, [{ key: "TAI-9", reason: "a comment came after the pause note (service pickup rule)" }]);
        const quiet = setup();
        await runServiceTick(quiet.deps);
        assert.equal((await readLastRun(dir))?.skipped, undefined, "no skipped key when nothing was left alone");
    });

    it("ends 'no ready tickets' when there was nothing to do", async () => {
        const { deps } = setup();
        assert.equal((await runServiceTick(deps) as { stopReason: string }).stopReason, "no ready tickets");
    });

    it("a run that ends paused writes limited-until; ticks skip until then; a tick after that starts a run (AC-5)", async () => {
        const limit = { text: "Weekly limit reached", resetsAt: "2026-11-20T17:00:00.000Z" };
        let summary: WorkSummary = { tickets: [{ key: "TAI-1", state: "paused" }], capReached: false, limit, stopReason: null };
        const { deps, calls, advance } = setup({ work: async () => (void (calls.work++), summary) });
        const r = await runServiceTick(deps);
        assert.match((r as { stopReason: string }).stopReason, /usage limit: Weekly limit reached \(limited until 2026-11-20T17:00:00.000Z\)/);
        assert.equal((await readLimitedUntil(dir, new Date("2026-11-18T10:30:00Z")))?.until, "2026-11-20T17:00:00.000Z");
        // the next tick, 30 minutes later
        advance(30 * 60_000);
        const skipped = await runServiceTick(deps);
        assert.deepEqual(skipped, { status: "limited", exitCode: 0, until: "2026-11-20T17:00:00.000Z" });
        assert.equal(calls.work, 1);
        assert.ok(calls.say.some((l) => l.includes("Skipping: the usage limit has not reset")));
        // after the reset
        advance(3 * 24 * 3_600_000);
        summary = { tickets: [], capReached: false, limit: null, stopReason: null };
        assert.equal((await runServiceTick(deps)).status, "ran");
        assert.equal(calls.work, 2);
        await assert.rejects(readFile(join(dir, "limited-until.json"), "utf8"), /ENOENT/, "the passed limit record is cleared");
    });

    it("a paused project starts nothing, logs it on every tick, and runs again once resumed (TAI-772 AC-4)", async () => {
        await writePause(dir, new Date("2026-11-18T08:00:00Z"));
        const { deps, calls } = setup();
        for (let i = 0; i < 2; i++) assert.deepEqual(await runServiceTick(deps), { status: "paused", exitCode: 0, since: "2026-11-18T08:00:00.000Z", scope: "project" });
        assert.deepEqual([calls.preflight, calls.refresh, calls.work], [0, 0, 0], "no check, refresh or run");
        assert.equal(calls.say.filter((l) => /paused by `tai service pause` since 2026-11-18T08:00:00\.000Z/.test(l)).length, 2);
        assert.equal(await clearPause(dir), true);
        assert.equal((await runServiceTick(deps)).status, "ran");
    });

    it("a pause for every project, kept in the service root, stops this project's tick too, and says which it is (TAI-772)", async () => {
        const rootDir = join(dir, "root");
        await writePause(rootDir, new Date("2026-11-18T07:00:00Z"));
        const { deps, calls } = setup({ rootDir });
        assert.deepEqual(await runServiceTick(deps), { status: "paused", exitCode: 0, since: "2026-11-18T07:00:00.000Z", scope: "all" });
        assert.ok(calls.say.some((l) => /every project is paused .*`tai service resume`/.test(l)));
        assert.deepEqual([calls.preflight, calls.refresh, calls.work], [0, 0, 0]);
        await clearPause(rootDir);
        assert.equal((await runServiceTick(deps)).status, "ran", "lifting the pause for all lets the tick run");
    });

    it("a limit with no reset time skips for a backoff, not forever", async () => {
        const { deps } = setup({ limitBackoffMs: 3_600_000 }, { tickets: [], capReached: false, limit: { text: "Your usage limit has been reached." }, stopReason: null });
        await runServiceTick(deps);
        assert.equal((await readLimitedUntil(dir, new Date("2026-11-18T10:00:00Z")))?.until, "2026-11-18T11:00:00.000Z");
    });

    it("records a stop, and a refresh failure starts no run (exit 1)", async () => {
        const stopped = setup({}, { tickets: [{ key: "TAI-1", state: "stopped" }], capReached: false, limit: null, stopReason: "Could not bring main up to date" });
        assert.equal((await runServiceTick(stopped.deps) as { stopReason: string }).stopReason, "stopped: Could not bring main up to date");
        const broken = setup({ refresh: async () => ({ action: "failed", why: "network down" }) });
        const r = await runServiceTick(broken.deps);
        assert.deepEqual(r, { status: "refresh-failed", exitCode: 1, why: "the clone could not be refreshed: network down" });
        assert.equal(broken.calls.work, 0);
        assert.match((await readLastRun(dir))!.stopReason, /could not be refreshed/);
    });

    it("a run that crashes without a summary is recorded and exits 1, and still releases the lock", async () => {
        const { deps } = setup({ work: async () => { throw new Error("exit 2"); } });
        const r = await runServiceTick(deps);
        assert.equal(r.exitCode, 1);
        assert.match((await readLastRun(dir))!.stopReason, /failed without a summary: exit 2/);
        await assert.rejects(readFile(join(dir, LOCK_FILE), "utf8"), /ENOENT/);
    });

    it("writes the limit record state it reads back (state file round trip)", async () => {
        await writeLimitedUntil(dir, { until: "2026-11-19T00:00:00.000Z", text: "t" });
        assert.equal((await readLimitedUntil(dir, new Date("2026-11-18T23:00:00Z")))?.text, "t");
        assert.equal(await readLimitedUntil(dir, new Date("2026-11-19T00:00:01Z")), null);
    });
});

describe("parseServiceRunArgs", () => {
    it("takes the clone, defaults the state to its parent, the wait to 5 hours and the cap to 3 (AC-6)", () => {
        assert.deepEqual(parseServiceRunArgs(["clone=/data/tai/proj/repo"], {}, "/home/me"), { clonePath: "/data/tai/proj/repo", stateDir: "/data/tai/proj", rootDir: "/home/me/.local/share/tai-service", waitHours: 5, cap: 3 });
        assert.equal(parseServiceRunArgs(["clone=/c", "root=/svc"], {}, "/home/me").rootDir, "/svc", "root= names the service root, where a pause for every project is kept");
        assert.equal(parseServiceRunArgs(["clone=/c"], { TAI_SERVICE_ROOT: "/env-root" }, "/home/me").rootDir, "/env-root");
    });

    it("reads each setting from the environment when no argument gives it, and an argument wins", () => {
        const env = { TAI_SERVICE_CLONE: "/c/repo", TAI_SERVICE_STATE: "/s", TAI_SERVICE_WAIT: "2", TAI_SERVICE_CAP: "7", TAI_SERVICE_ROOT: "/r" };
        assert.deepEqual(parseServiceRunArgs([], env), { clonePath: "/c/repo", stateDir: "/s", rootDir: "/r", waitHours: 2, cap: 7 });
        assert.equal(parseServiceRunArgs(["cap=1", "wait=1.5"], env).cap, 1);
        assert.equal(parseServiceRunArgs(["wait=1.5"], env).waitHours, 1.5);
    });

    it("refuses a missing clone, a mistyped flag, a repeat, a bad cap and a bad wait", () => {
        assert.throws(() => parseServiceRunArgs([]), /needs the clone's path/);
        assert.throws(() => parseServiceRunArgs(["clone=/c", "clon=/d"]), /takes only clone=/);
        assert.throws(() => parseServiceRunArgs(["clone=/c", "clone=/d"]), /only one clone=/);
        assert.throws(() => parseServiceRunArgs(["clone=/c", "cap=0"]), /whole number of tickets/);
        assert.throws(() => parseServiceRunArgs(["clone=/c", "wait=never"]), /wait= takes a number of hours/);
    });
});

describe("the clone's environment", () => {
    it("gives the run only the clone's own credentials plus the system variables, whatever the launching shell holds", async () => {
        await writeFile(join(dir, ".env"), "TAI_JIRA_EMAIL=clone@b.c\nGITHUB_TOKEN=from-clone\n");
        const { envFileFound, env } = await cloneEnvironment(dir, {
            TAI_JIRA_EMAIL: "stray@b.c",
            TAI_REVIEWER_GITHUB_TOKEN: "leaked",
            BITBUCKET_API_TOKEN: "leaked",
            CLAUDECODE: "1",
            PATH: "/usr/bin",
            HOME: "/home/x",
            LC_ALL: "C",
            HTTPS_PROXY: "http://p",
        });
        assert.equal(envFileFound, true);
        assert.deepEqual([env["TAI_JIRA_EMAIL"], env["GITHUB_TOKEN"]], ["clone@b.c", "from-clone"]);
        assert.deepEqual([env["PATH"], env["HOME"], env["LC_ALL"], env["HTTPS_PROXY"]], ["/usr/bin", "/home/x", "C", "http://p"]);
        for (const leaked of ["TAI_REVIEWER_GITHUB_TOKEN", "BITBUCKET_API_TOKEN", "CLAUDECODE"]) assert.equal(env[leaked], undefined, `${leaked} must not reach the clone`);
    });

    it("passes the run's time limit, so a limit set for the unit is not dropped", async () => {
        const { env } = await cloneEnvironment(dir, { TAI_DEV_RUN_TIMEOUT_MIN: "20", TAI_OTHER: "x" });
        assert.deepEqual([env["TAI_DEV_RUN_TIMEOUT_MIN"], env["TAI_OTHER"]], ["20", undefined]);
    });

    it("passes the variables Claude signs in with (OAuth token, config directory) but not the AI-session marker", async () => {
        const { env } = await cloneEnvironment(dir, { CLAUDE_CODE_OAUTH_TOKEN: "tok", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDECODE: "1" });
        assert.deepEqual([env["CLAUDE_CODE_OAUTH_TOKEN"], env["CLAUDE_CONFIG_DIR"]], ["tok", "/cfg"]);
        assert.deepEqual([env["CLAUDE_CODE_ENTRYPOINT"], env["CLAUDECODE"]], [undefined, undefined]);
    });

    it("says there is no .env, keeping only the system variables", async () => {
        const { envFileFound, env } = await cloneEnvironment(dir, { PATH: "/usr/bin", KEEP: "x" });
        assert.equal(envFileFound, false);
        assert.deepEqual([env["PATH"], env["KEEP"]], ["/usr/bin", undefined]);
    });

    it("knows a git repository (a .git directory or file) from a plain directory and a missing one", async () => {
        assert.equal(await cloneIsGitRepo(dir), false);
        await mkdir(join(dir, ".git"));
        assert.equal(await cloneIsGitRepo(dir), true);
        assert.equal(await cloneIsGitRepo(join(dir, "nope")), false);
    });
});

describe("runCloneWork", () => {
    // A stand-in for `do-dev-tasks`: it writes its result file (the `result=` argument) when it is told to stop, then exits.
    const fakeRun = (script: string) => (args: readonly string[]) => ({ command: process.execPath, args: ["-e", script, ...args] });
    const onStop = `
        const file = process.argv.find((a) => a.startsWith("result=")).slice(7);
        process.on("SIGTERM", () => { require("node:fs").writeFileSync(file, JSON.stringify({ outcome: "stopped" })); process.exit(0); });
        console.error("ready");
        setInterval(() => {}, 1000);
    `;

    it("passes a stop sent to this process on to the run, and waits for it to end (no run outlives its command)", async () => {
        const before = process.listenerCount("SIGTERM");
        const work = runCloneWork(dir, dir, process.env, { waitHours: 1, cap: 1 }, fakeRun(onStop));
        await new Promise((r) => setTimeout(r, 1500));
        process.emit("SIGTERM");
        const summary = (await work) as unknown as { outcome: string };
        assert.equal(summary.outcome, "stopped");
        assert.equal(process.listenerCount("SIGTERM"), before, "the forwarding is removed once the run has ended");
    });

    it("starts the run in the service pickup mode (TAI-773 AC-6)", async () => {
        let seen: readonly string[] = [];
        const launch = (args: readonly string[]) => ((seen = args), { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(process.argv.find((a) => a.startsWith("result=")).slice(7), JSON.stringify({ tickets: [], capReached: false, limit: null, stopReason: null }))`, ...args] });
        await runCloneWork(dir, dir, process.env, { waitHours: 2, cap: 4 }, launch);
        assert.ok(seen.includes("pickup=service"));
        assert.ok(seen.includes("wait=2") && seen.includes("max=4"));
    });

    it("hands the run the pause file to watch between tickets (TAI-772 AC-5)", async () => {
        let seen: readonly string[] = [];
        const launch = (args: readonly string[]) => ((seen = args), { command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(process.argv.find((a) => a.startsWith("result=")).slice(7), JSON.stringify({ tickets: [], capReached: false, limit: null, stopReason: null }))`, ...args] });
        await runCloneWork(dir, dir, process.env, { waitHours: 1, cap: 1 }, launch);
        assert.ok(seen.includes(`stopfile=${join(dir, "paused.json")}`));
        assert.ok(!seen.some((a) => a.startsWith("stopfile=") && a !== `stopfile=${join(dir, "paused.json")}`), "no root, no second file");
        await runCloneWork(dir, dir, process.env, { waitHours: 1, cap: 1, rootDir: "/svc" }, launch);
        assert.ok(seen.includes(`stopfile=${join(dir, "paused.json")}`) && seen.includes("stopfile=/svc/paused.json"), "the pause for every project is watched too");
    });

    it("rejects when the run leaves no summary", async () => {
        await assert.rejects(runCloneWork(dir, dir, process.env, { waitHours: 1, cap: 1 }, fakeRun("process.exit(3)")), /exited 3 and left no summary/);
    });
});

describe("service setup arguments (TAI-771)", () => {
    it("takes the project, root= and from=, and defaults from to the current directory", () => {
        assert.deepEqual(parseServiceSetupArgs(["tai"], "/here"), { project: "tai", root: undefined, from: "/here" });
        assert.deepEqual(parseServiceSetupArgs(["root=/r", "tai", "from=/p"], "/here"), { project: "tai", root: "/r", from: "/p" });
    });

    it("expands a leading ~ in from=", () => {
        assert.equal(parseServiceSetupArgs(["tai", "from=~/work/tai"], "/here", "/home/u").from, "/home/u/work/tai");
        assert.equal(parseServiceSetupArgs(["tai", "from=~x/tai"], "/here", "/home/u").from, `${process.cwd()}/~x/tai`);
    });

    it("refuses no project, two projects, a repeated flag or a mistyped one", () => {
        assert.throws(() => parseServiceSetupArgs([], "/h"), /Usage/);
        assert.throws(() => parseServiceSetupArgs(["a", "b"], "/h"), /Usage/);
        assert.throws(() => parseServiceSetupArgs(["a", "from=/x", "from=/y"], "/h"), /only one from=/);
        assert.throws(() => parseServiceSetupArgs(["a", "form=/x"], "/h"), /Usage/);
    });
});

function setupForPause() {
    const calls = { work: 0 };
    const deps: ServiceTickDeps = {
        stateDir: dir, waitHours: 5, cap: 3,
        lock: { pid: 500, now: () => new Date("2026-11-18T10:00:00Z"), isAlive: () => true },
        now: () => new Date("2026-11-18T10:00:00Z"),
        say: () => undefined,
        preflight: async () => null,
        refresh: async () => ({ action: "fast-forwarded", branch: "main" }),
        work: async () => (calls.work++, { tickets: [], capReached: false, limit: null, stopReason: null }),
    };
    return { deps, calls };
}

describe("pause state (TAI-772 AC-4)", () => {
    it("is a file that keeps its first time, has no expiry, and is removed only by clearPause", async () => {
        assert.equal(await readPause(dir), null);
        assert.equal(await writePause(dir, new Date("2026-11-18T08:00:00Z")), true);
        assert.equal(await writePause(dir, new Date("2027-01-01T00:00:00Z")), false, "pausing twice keeps the first time");
        assert.deepEqual(await readPause(dir), { since: "2026-11-18T08:00:00.000Z" });
        assert.equal(await clearPause(dir), true);
        assert.equal(await clearPause(dir), false);
        assert.equal(await readPause(dir), null);
    });

    it("a running do-dev-tasks sees it through the stop file, and sees nothing while there is none", async () => {
        const file = join(dir, "paused.json");
        assert.equal(await pauseStopReason(file), null);
        await writePause(dir, new Date("2026-11-18T08:00:00Z"));
        assert.match((await pauseStopReason(file))!, /paused by `tai service pause` \(since 2026-11-18T08:00:00\.000Z\)/);
    });

    it("a pause file that exists but cannot be read counts as a pause (it fails closed), for the tick and for a run going", async () => {
        const file = join(dir, "paused.json");
        for (const bad of ["not json", "", '{"since": 5}', '{"since": "not a time"}', "null"]) {
            await writeFile(file, bad);
            assert.deepEqual(await readPause(dir), { since: "unknown (the pause file exists but could not be read)", unreadable: true }, JSON.stringify(bad));
            assert.match((await pauseStopReason(file))!, /paused by `tai service pause`/);
        }
        const { deps, calls } = setupForPause();
        assert.equal((await runServiceTick(deps)).status, "paused");
        assert.equal(calls.work, 0);
        assert.equal(await writePause(dir, new Date("2026-11-18T08:00:00Z")), true, "a fresh pause rewrites a damaged one");
        assert.deepEqual(await readPause(dir), { since: "2026-11-18T08:00:00.000Z" });
        await rm(join(dir, "paused.json"));
        await mkdir(join(dir, "paused.json"));
        assert.equal((await readPause(dir))?.unreadable, true, "a file that cannot be read at all (here a folder) is a pause too");
        assert.equal(await writePause(dir, new Date("2026-11-19T08:00:00Z")), true, "pause replaces a folder in its place");
        assert.deepEqual(await readPause(dir), { since: "2026-11-19T08:00:00.000Z" });
        await rm(join(dir, "paused.json"));
        await mkdir(join(dir, "paused.json"));
        assert.equal(await clearPause(dir), true, "resume clears it instead of failing with EISDIR");
        assert.equal(await readPause(dir), null);
    });

    it("writes the pause whole, leaving no temporary file behind", async () => {
        await writePause(dir, new Date("2026-11-18T08:00:00Z"));
        assert.deepEqual((await readdir(dir)).filter((f) => f.includes("paused")), ["paused.json"]);
    });
});

describe("realPath (a symlinked clone is still the clone)", () => {
    it("resolves symlinks, keeps a folder that does not exist yet, and lets isInside see through a link", async () => {
        const base = await realpath(await mkdtemp(join(tmpdir(), "tai-real-")));
        try {
            await mkdir(join(base, "real", "repo"), { recursive: true });
            await symlink(join(base, "real"), join(base, "link"));
            assert.equal(await realPath(join(base, "link", "repo")), join(base, "real", "repo"));
            assert.equal(await realPath(join(base, "link", "later", "x")), join(base, "real", "later", "x"), "the part not made yet is kept as written");
            assert.equal(isInside(join(base, "link", "repo", "src"), join(base, "real", "repo")), false, "lexically they differ");
            assert.equal(isInside(await realPath(join(base, "link", "repo", "src")), await realPath(join(base, "real", "repo"))), true, "resolved, the folder is inside the clone");
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });
});
