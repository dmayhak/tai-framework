/**
 * TAI Framework — the timer, kick-off-now, pause and status of the unattended Dev service (Epic TAI-763, Story TAI-772).
 *
 * `install <project>` writes a oneshot service and a timer into the systemd user directory and enables the timer; `uninstall` undoes it;
 * `kick` starts the same service unit the timer starts; `pause` and `resume` keep a switch on disk; `status` reports everything a person
 * needs to see why nothing is running. Linux systemd only: `install` and `kick` refuse elsewhere, and `run` and `setup` stay
 * platform-neutral, so another installer (launchd) can be added without touching them. Everything that touches systemd, the file system,
 * the clock or the process list is injected, so the rules are tested offline; the two things only a real machine can answer (the timer
 * after a suspend, linger while logged out) are checked live and recorded on the Dev ticket.
 */

import { dirname, join } from "node:path";

import { DEFAULT_CAP, DEFAULT_WAIT_HOURS } from "./real.js";
import { readLockHolder, type LockInfo } from "./lock.js";
import type { ProjectEntry } from "./setup.js";
import { readLastRun, readLimitedUntil, readPause, readPreflightNote, clearPause, writePause } from "./state.js";

export const DEFAULT_INTERVAL_MINUTES = 30;

/** `tai-dev@<project>.service` and `.timer`: the same name serves a person (`journalctl --user -u tai-dev@<project>`) and the unit files. */
export const serviceUnitName = (project: string): string => `tai-dev@${project}.service`;
export const timerUnitName = (project: string): string => `tai-dev@${project}.timer`;

/** The state directory of a project's run: where `service setup` made the clone, one level up (`<root>/<key>`), unless `service run state=` says otherwise. */
export const stateDirOf = (entry: ProjectEntry): string => dirname(entry.clone);

export interface SystemctlResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface TimerDeps {
    /** `process.platform`. */
    readonly platform: string;
    /** The systemd user unit directory (`~/.config/systemd/user`). */
    readonly unitDir: string;
    /** The file's text, or null when it is not there. */
    readonly readFile: (path: string) => Promise<string | null>;
    readonly writeFile: (path: string, text: string) => Promise<void>;
    /** True when a file was removed, false when there was none. */
    readonly removeFile: (path: string) => Promise<boolean>;
    /** `systemctl --user <args>`; rejects when the program is not there. */
    readonly systemctl: (args: readonly string[]) => Promise<SystemctlResult>;
    /** The command a unit runs to start this program (`node ... cli.ts`), as separate words. */
    readonly command: readonly string[];
    /** PATH of the person installing, so a unit (which gets a bare PATH from systemd) finds `git` and `claude`. */
    readonly path: string | undefined;
    /** Whether the user's services keep running while logged out; null when it cannot be told. */
    readonly lingerEnabled: () => Promise<boolean | null>;
    /** The user name for the linger line. */
    readonly user: string;
    readonly now: () => Date;
    readonly isAlive: (pid: number, startedAt: string) => boolean | Promise<boolean>;
    /** True in an AI session (the same markers the autonomy guard reads). */
    readonly aiSession: () => boolean;
    readonly say: (line: string) => void;
}

/** One word of a unit's `ExecStart=` or `Environment=` line: quoted, with the characters systemd itself reads (`\`, `"`, `%`, `$`) escaped. */
export function unitWord(word: string, expandsVariables = true): string {
    // `$` is a variable in ExecStart= but means nothing in Environment=, so it is doubled only where systemd reads it. `%` is a specifier in both.
    const escaped = word.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, expandsVariables ? "$$$$" : "$$");
    return /^[A-Za-z0-9_./:@=,+-]+$/.test(word) ? escaped : `"${escaped}"`;
}

/** The service and timer unit files for a project, from its config entry. The same entry gives the same text, so a re-run changes nothing. */
export function renderUnits(entry: ProjectEntry, command: readonly string[], path: string | undefined, root: string): { readonly service: string; readonly timer: string } {
    const interval = entry.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
    const run = [...command, "service", "run", `clone=${entry.clone}`, `state=${stateDirOf(entry)}`, `root=${root}`, `wait=${entry.waitHours ?? DEFAULT_WAIT_HOURS}`, `cap=${entry.cap ?? DEFAULT_CAP}`];
    const service = [
        "[Unit]",
        `Description=TAI unattended Dev service: one run for ${entry.key}`,
        "",
        "[Service]",
        "Type=oneshot",
        "TimeoutStartSec=infinity",
        ...(path ? [`Environment=${unitWord(`PATH=${path}`, false)}`] : []),
        `ExecStart=${run.map((w) => unitWord(w)).join(" ")}`,
        "",
    ].join("\n");
    const timer = [
        "[Unit]",
        `Description=TAI unattended Dev service: timer for ${entry.key}`,
        "",
        "[Timer]",
        "OnBootSec=2min",
        "OnActiveSec=1min",
        // Counted from the end of the last run, so a long run is never overtaken, and a tick missed while the machine slept comes late, not twice.
        `OnUnitInactiveSec=${interval}min`,
        `Unit=${serviceUnitName(entry.key)}`,
        "",
        "[Install]",
        "WantedBy=timers.target",
        "",
    ].join("\n");
    return { service, timer };
}

/** Why units cannot be managed here, or null when they can. Asked before anything is changed. */
export async function systemdRefusal(deps: TimerDeps): Promise<string | null> {
    if (deps.platform !== "linux") return `The timer is Linux systemd only (this is ${deps.platform}); nothing was changed. \`tai service run\` still works anywhere: start it by hand or from your own scheduler.`;
    try {
        const r = await deps.systemctl(["--version"]);
        if (r.code === 0) {
            const bus = await deps.systemctl(["is-system-running"]);
            // "degraded" and the like print on stdout; anything on stderr means systemctl could not ask a user manager at all (no bus, a refused connection, another locale's wording).
            if (bus.stderr.trim() !== "") return `\`systemctl --user\` cannot reach a user manager here (${bus.stderr.trim().split("\n")[0]}); nothing was changed.`;
            return null;
        }
    } catch {
        // the program is not there
    }
    return "`systemctl --user` is not available here; nothing was changed. The timer needs systemd.";
}

const lingerLine = (user: string): string => `Logged-out runs need linger: \`loginctl enable-linger ${user}\` (without it the timer stops when you log out).`;

export async function installTimer(entry: ProjectEntry, deps: TimerDeps, root: string): Promise<{ readonly changed: boolean }> {
    const refusal = await systemdRefusal(deps);
    if (refusal) throw new Error(refusal);
    const units = renderUnits(entry, deps.command, deps.path, root);
    const servicePath = join(deps.unitDir, serviceUnitName(entry.key));
    const timerPath = join(deps.unitDir, timerUnitName(entry.key));
    let changed = false;
    for (const [path, text] of [[servicePath, units.service], [timerPath, units.timer]] as const) {
        if ((await deps.readFile(path)) === text) continue;
        await deps.writeFile(path, text);
        changed = true;
    }
    if (changed) await run(deps, ["daemon-reload"]);
    await run(deps, ["enable", "--now", timerUnitName(entry.key)]);
    // `enable --now` starts nothing on a timer that is already active, so a changed interval would not be in force: restart the timer (never the service, which may be mid-run).
    if (changed) await run(deps, ["restart", timerUnitName(entry.key)]);
    deps.say(changed ? `Installed ${timerUnitName(entry.key)} (every ${entry.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES} minutes after a run ends) and ${serviceUnitName(entry.key)} in ${deps.unitDir}. The timer was (re)started, so a tick runs about a minute from now.` : `Already installed: ${timerUnitName(entry.key)} (the unit files are as they would be written); the timer is enabled.`);
    deps.say(`Look at it with \`tai service status ${entry.key}\`; its log is \`journalctl --user -u ${serviceUnitName(entry.key)}\`.`);
    if ((await deps.lingerEnabled()) === false) deps.say(lingerLine(deps.user));
    return { changed };
}

async function run(deps: TimerDeps, args: readonly string[]): Promise<SystemctlResult> {
    const r = await deps.systemctl(args);
    if (r.code !== 0) throw new Error(`\`systemctl --user ${args.join(" ")}\` failed (exit ${r.code}): ${(r.stderr || r.stdout).trim() || "no message"}`);
    return r;
}

export async function uninstallTimer(entry: ProjectEntry, deps: TimerDeps): Promise<{ readonly removed: boolean }> {
    const refusal = await systemdRefusal(deps);
    if (refusal) throw new Error(refusal);
    const servicePath = join(deps.unitDir, serviceUnitName(entry.key));
    const timerPath = join(deps.unitDir, timerUnitName(entry.key));
    if ((await deps.readFile(servicePath)) === null && (await deps.readFile(timerPath)) === null) {
        deps.say(`Nothing to remove: ${timerUnitName(entry.key)} and ${serviceUnitName(entry.key)} are not installed.`);
        return { removed: false };
    }
    // The timer is stopped and disabled before the files go (a unit that is not loaded makes this fail, which is the state we want anyway; any other failure stops the removal).
    // The service unit is NOT stopped: a run going may be between a build and a merge, and a stop would kill it there.
    const stopped = await deps.systemctl(["disable", "--now", timerUnitName(entry.key)]);
    // Only "this unit is not loaded" is fine; any other failure leaves the timer active, and deleting its files then would strand it with no way back through this command.
    if (stopped.code !== 0 && !/not loaded|does not exist|No such file|not found/i.test(stopped.stderr)) throw new Error(`Could not stop ${timerUnitName(entry.key)}: ${stopped.stderr.trim() || stopped.stdout.trim() || "no message"}; nothing was removed.`);
    await deps.removeFile(timerPath);
    await deps.removeFile(servicePath);
    await run(deps, ["daemon-reload"]);
    deps.say(`Removed ${timerUnitName(entry.key)} and ${serviceUnitName(entry.key)}. The clone and its state are left as they were.`);
    const going = await readLockHolder(stateDirOf(entry), deps.isAlive);
    if (going) deps.say(`A run is still going (pid ${going.pid}, started ${going.startedAt}) and was not stopped: it ends on its own, or \`tai service pause ${entry.key}\` ends it after its current ticket. No new tick will start.`);
    return { removed: true };
}

/** `kick`: starts the service unit the timer starts, so a kicked run has the timer's environment and the same lock. Refused from an AI session. */
export async function kickService(entry: ProjectEntry, deps: TimerDeps, root: string): Promise<void> {
    if (deps.aiSession()) {
        throw new Error("`tai service kick` is refused from an AI session: the unattended run is refused there too, and a person starts it from a plain terminal. The timer needs no one.");
    }
    const refusal = await systemdRefusal(deps);
    if (refusal) throw new Error(refusal);
    const unit = serviceUnitName(entry.key);
    if ((await deps.readFile(join(deps.unitDir, unit))) === null) throw new Error(`${unit} is not installed: run \`tai service install ${entry.key}\` first.`);
    const pausedAll = await readPause(root);
    const paused = pausedAll ?? (await readPause(stateDirOf(entry)));
    // A paused project would start, log a skip and exit: say so instead of starting it.
    if (paused) throw new Error(`${pausedAll ? "Every project is" : `${entry.key} is`} paused (since ${paused.since}): a run would start nothing, so it was not started. \`tai service resume${pausedAll ? "" : ` ${entry.key}`}\` first.`);
    // `--no-block`: the run can last hours, and the lock (not this command) is what keeps a second one out.
    await run(deps, ["start", "--no-block", unit]);
    deps.say(`Started ${unit}; it runs now and its log is \`journalctl --user -u ${unit} -f\`.`);
}

/** `pause`: one file per project in its state directory. Pausing twice keeps the first time. */
export async function pauseProjects(entries: readonly ProjectEntry[], deps: Pick<TimerDeps, "now" | "say">): Promise<void> {
    for (const entry of entries) {
        const added = await writePause(stateDirOf(entry), deps.now());
        deps.say(added ? `Paused ${entry.key}: no tick starts a run, and a run going finishes its current ticket and then stops. \`tai service resume ${entry.key}\` lifts it; it has no expiry.` : `${entry.key} was already paused.`);
    }
}

/** `pause` with no project: one file in the service root, read by every tick and run, so it covers a project added later too. */
export async function pauseAll(root: string, deps: Pick<TimerDeps, "now" | "say">): Promise<void> {
    const added = await writePause(root, deps.now());
    deps.say(added ? "Paused every project: no tick starts a run, and a run going finishes its current ticket and then stops. `tai service resume` lifts it; it has no expiry. A pause set on one project is kept apart and still applies." : "Every project was already paused.");
}

export async function resumeAll(root: string, deps: Pick<TimerDeps, "say">): Promise<void> {
    deps.say((await clearPause(root)) ? "Resumed every project (the pause for all). A pause set on one project, if any, still applies: `tai service status` shows it." : "Every project was not paused (no pause for all was set).");
}

export async function resumeProjects(entries: readonly ProjectEntry[], deps: Pick<TimerDeps, "say">): Promise<void> {
    for (const entry of entries) deps.say((await clearPause(stateDirOf(entry))) ? `Resumed ${entry.key}: the next tick runs as usual.` : `${entry.key} was not paused.`);
}

/** The line `list-timers` gives for a timer, as "NEXT LEFT LAST PASSED" without its two trailing unit names; "n/a" columns stay as they are. */
export function nextTickFrom(listTimersOutput: string, timerUnit: string): string | null {
    const line = listTimersOutput.split("\n").find((l) => l.includes(timerUnit));
    if (!line) return null;
    const words = line.trim().split(/\s+/);
    const at = words.indexOf(timerUnit);
    return (at > 0 ? words.slice(0, at) : words).join(" ");
}

function ago(from: string, now: Date): string {
    const minutes = Math.round((now.getTime() - Date.parse(from)) / 60_000);
    return Number.isNaN(minutes) ? from : `${from} (${minutes < 1 ? "just now" : minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`})`;
}

/**
 * `status`: everything a person looks at to see why nothing is running. A preflight that keeps failing is logged once and its tick
 * exits 0, so the timer looks green while no run starts: its note is shown here (the PR 59 review).
 */
export async function serviceStatus(entry: ProjectEntry, deps: TimerDeps, root: string): Promise<void> {
    const dir = stateDirOf(entry);
    const now = deps.now();
    const say = deps.say;
    say(`${entry.key}`);
    const installed = (await deps.readFile(join(deps.unitDir, timerUnitName(entry.key)))) !== null;
    if (!installed) say(`  Timer: not installed (\`tai service install ${entry.key}\`).`);
    else {
        let next: string | null;
        try {
            const r = await deps.systemctl(["list-timers", "--all", "--no-pager", "--no-legend", timerUnitName(entry.key)]);
            next = r.code === 0 ? nextTickFrom(r.stdout, timerUnitName(entry.key)) : null;
        } catch {
            next = null;
        }
        say(`  Next tick: ${next ?? "not scheduled (the timer is not loaded or systemctl could not be asked)"}`);
        // The unit pins the node, loader and checkout paths of whoever installed it. If they have moved the run fails inside systemd before any preflight note is written, so ask systemd.
        try {
            const failed = await deps.systemctl(["is-failed", serviceUnitName(entry.key)]);
            if (failed.code === 0) say(`  Unit: the last run FAILED in systemd (see \`journalctl --user -u ${serviceUnitName(entry.key)}\`). One cause is a moved node or checkout, which \`tai service install ${entry.key}\` fixes by rewriting the unit.`);
        } catch {
            // systemctl could not be asked: the line above already says so
        }
    }
    const holder: LockInfo | null = await readLockHolder(dir, deps.isAlive);
    say(holder ? `  Running now: pid ${holder.pid}, started ${ago(holder.startedAt, now)}` : "  Running now: no run holds the lock.");
    const pausedAll = await readPause(root);
    const paused = await readPause(dir);
    const sinceText = (p: { readonly since: string; readonly unreadable?: boolean }): string => (p.unreadable ? "(its file could not be read, so it counts as a pause)" : `since ${ago(p.since, now)}`);
    if (pausedAll) say(`  Pause: PAUSED for every project ${sinceText(pausedAll)}; \`tai service resume\` lifts it.`);
    if (paused) say(`  Pause: PAUSED ${sinceText(paused)}; \`tai service resume ${entry.key}\` lifts it.`);
    if (!pausedAll && !paused) say("  Pause: none.");
    const limited = await readLimitedUntil(dir, now);
    say(limited ? `  Limited until: ${limited.until} (${limited.text || "usage limit"}); ticks skip until then.` : "  Limited until: not limited.");
    const last = await readLastRun(dir);
    if (!last) say("  Last run: none recorded.");
    else {
        say(`  Last run: ${ago(last.started, now)} to ${last.ended}; ${last.stopReason}`);
        for (const t of last.tickets) say(`    ${t.key}: ${t.state}${t.detail ? ` (${t.detail})` : ""}`);
        for (const s of last.skipped ?? []) say(`    ${s.key}: left alone (${s.reason})`);
    }
    const note = await readPreflightNote(dir);
    say(note ? `  Preflight: FAILING since ${ago(note.since, now)}: ${note.message}\n    (the timer shows green while this is so: no run starts)` : "  Preflight: no failure recorded.");
}
