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

import { dirname, join, resolve } from "node:path";

import { DEFAULT_CAP, DEFAULT_WAIT_HOURS } from "./real.js";
import { readLockHolder, type LockInfo } from "./lock.js";
import type { ProjectEntry } from "./setup.js";
import { PAUSE_FILE, readLastRun, readLimitedUntil, readPause, readPreflightNote, clearPause, writePause } from "./state.js";

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
    /** The folder `install` was run from: the unit starts there, so a launcher flag typed relative to it (`--import tsx`) resolves as it did for the person. */
    readonly cwd: string;
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

/** The `root=` an installed service unit was written with (the words of its `ExecStart=` line, unquoted and unescaped as systemd reads them), or null when it has none. */
export const installedRoot = (serviceUnitText: string): string | null => installedArg(serviceUnitText, "root");
/** The `state=` an installed service unit was written with: where its runs keep the lock and read the project's pause. */
export const installedState = (serviceUnitText: string): string | null => installedArg(serviceUnitText, "state");

function installedArg(serviceUnitText: string, name: string): string | null {
    const line = serviceUnitText.split("\n").find((l) => l.startsWith("ExecStart="));
    if (!line) return null;
    // The service-run arguments come last, after the installer's own command words (node, its flags, the script), so the last match is the setting even if one of those words looks like one.
    let found: string | null = null;
    for (const m of line.slice("ExecStart=".length).matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
        const raw = m[1] ?? m[2] ?? "";
        const word = m[1] !== undefined ? raw.replace(/\\(["\\])/g, "$1") : raw;
        if (word.startsWith(`${name}=`)) found = word.slice(name.length + 1).replace(/%%/g, "%").replace(/\$\$/g, "$");
    }
    return found;
}

/**
 * The state directory the project's runs use: the `state=` its installed unit carries, else the one its entry gives. They differ when a clone path was
 * edited in the list after install; the unit keeps the old one until `install` is run again, so a pause or a status read from the new one would miss the run.
 */
async function effectiveStateDir(entry: ProjectEntry, deps: Pick<TimerDeps, "readFile" | "unitDir" | "say">): Promise<string> {
    const text = await deps.readFile(join(deps.unitDir, serviceUnitName(entry.key)));
    const unitState = text === null ? null : installedState(text);
    const listed = stateDirOf(entry);
    if (unitState === null || resolve(unitState) === resolve(listed)) return listed;
    deps.say(`${entry.key}: the installed unit uses the state directory ${unitState}, but the project list now gives ${listed}; the unit's is used here because that is where its runs look. \`tai service install ${entry.key}\` brings the unit up to date.`);
    return unitState;
}

/** The service and timer unit files for a project, from its config entry. The same entry gives the same text, so a re-run changes nothing. */
export function renderUnits(entry: ProjectEntry, command: readonly string[], path: string | undefined, root: string, workingDirectory?: string): { readonly service: string; readonly timer: string } {
    const interval = entry.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
    const run = [...command, "service", "run", `clone=${entry.clone}`, `state=${stateDirOf(entry)}`, `root=${root}`, `wait=${entry.waitHours ?? DEFAULT_WAIT_HOURS}`, `cap=${entry.cap ?? DEFAULT_CAP}`];
    const service = [
        "[Unit]",
        `Description=TAI unattended Dev service: one run for ${entry.key}`,
        "",
        "[Service]",
        "Type=oneshot",
        "TimeoutStartSec=infinity",
        // A systemd service starts in the user's home: the folder install was run from keeps a relative or bare launcher flag (`--import tsx`) resolving as it did for the person. `%` is a specifier here too.
        ...(workingDirectory ? [`WorkingDirectory=${workingDirectory.replace(/%/g, "%%")}`] : []),
        ...(path ? [`Environment=${unitWord(`PATH=${path}`, false)}`] : []),
        `ExecStart=${run.map((w) => unitWord(w)).join(" ")}`,
        "",
    ].join("\n");
    const timer = [
        "[Unit]",
        `Description=TAI unattended Dev service: timer for ${entry.key}`,
        "",
        "[Timer]",
        // Two ticks near boot are expected: OnBootSec is already past on a machine that has been up, so it alone would never tick a fresh install (the timer then waits for a run to end);
        // OnActiveSec makes a fresh install, and a boot with linger, tick after a minute. The lock and the cap make a second tick harmless.
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
            // "degraded" and the like print on stdout; a failure with nothing on stdout and a message on stderr means systemctl could not ask a user manager at all (no bus, a refused connection, another locale's wording); a warning beside a working answer does not refuse.
            if (bus.code !== 0 && bus.stdout.trim() === "" && bus.stderr.trim() !== "") return `\`systemctl --user\` cannot reach a user manager here (${bus.stderr.trim().split("\n")[0]}); nothing was changed.`;
            return null;
        }
    } catch {
        // the program is not there
    }
    return "`systemctl --user` is not available here; nothing was changed. The timer needs systemd.";
}

const lingerLine = (user: string): string => `Logged-out runs need linger: \`loginctl enable-linger ${user}\` (without it the timer stops when you log out).`;

/** What an AI session may not do: start unattended runs (`install`, `kick`) or lift a person's safety pause (`resume`). Stopping and reading stay open to it. */
function refuseFromAiSession(deps: Pick<TimerDeps, "aiSession">, what: string, why: string): void {
    if (deps.aiSession()) throw new Error(`\`tai service ${what}\` is refused from an AI session: ${why} A person runs it from a plain terminal.`);
}

export async function installTimer(entry: ProjectEntry, deps: TimerDeps, root: string): Promise<{ readonly changed: boolean }> {
    refuseFromAiSession(deps, "install", "it sets up an unattended timer that later runs with no AI marker, which a person decides.");
    const refusal = await systemdRefusal(deps);
    if (refusal) throw new Error(refusal);
    const units = renderUnits(entry, deps.command, deps.path, root, deps.cwd);
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
    deps.say(changed ? `Installed ${timerUnitName(entry.key)} (every ${entry.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES} minutes after a run ends) and ${serviceUnitName(entry.key)} in ${deps.unitDir}, running ${deps.command.join(" ")} (the program and checkout this install was run from: install again from the right one if that is not it). The timer was (re)started, so a tick runs about a minute from now.` : `Already installed: ${timerUnitName(entry.key)} (the unit files are as they would be written, running ${deps.command.join(" ")}); the timer is enabled.`);
    deps.say(`Look at it with \`tai service status ${entry.key}\`; its log is \`journalctl --user -u ${serviceUnitName(entry.key)}\`.`);
    if ((await deps.lingerEnabled()) === false) deps.say(lingerLine(deps.user));
    return { changed };
}

async function run(deps: TimerDeps, args: readonly string[]): Promise<SystemctlResult> {
    const r = await deps.systemctl(args);
    if (r.code !== 0) throw new Error(`\`systemctl --user ${args.join(" ")}\` failed (exit ${r.code}): ${(r.stderr || r.stdout).trim() || "no message"}`);
    return r;
}

/** True when systemd says it has no such unit (`LoadState=not-found`); false when it says anything else or cannot be asked. */
async function unitNotLoaded(deps: TimerDeps, unit: string): Promise<boolean> {
    try {
        const r = await deps.systemctl(["show", "--property=LoadState", "--value", unit]);
        return r.code === 0 && r.stdout.trim() === "not-found";
    } catch {
        return false;
    }
}

export async function uninstallTimer(entry: ProjectEntry, deps: TimerDeps): Promise<{ readonly removed: boolean }> {
    const refusal = await systemdRefusal(deps);
    if (refusal) throw new Error(refusal);
    const servicePath = join(deps.unitDir, serviceUnitName(entry.key));
    const timerPath = join(deps.unitDir, timerUnitName(entry.key));
    if ((await deps.readFile(servicePath)) === null && (await deps.readFile(timerPath)) === null) {
        // No files, but systemd may still have the timer loaded (files deleted by hand, or a reload that failed): stop it rather than report success.
        const stopped = await deps.systemctl(["disable", "--now", timerUnitName(entry.key)]);
        if (stopped.code === 0) {
            await run(deps, ["daemon-reload"]);
            deps.say(`The unit files for ${entry.key} were already gone, but systemd still had ${timerUnitName(entry.key)} loaded: it is stopped and disabled now.`);
            return { removed: true };
        }
        if (!(await unitNotLoaded(deps, timerUnitName(entry.key)))) throw new Error(`Could not stop ${timerUnitName(entry.key)}: ${stopped.stderr.trim() || stopped.stdout.trim() || "no message"}; nothing was changed.`);
        deps.say(`Nothing to remove: ${timerUnitName(entry.key)} and ${serviceUnitName(entry.key)} are not installed.`);
        return { removed: false };
    }
    // The timer is stopped and disabled before the files go (a unit that is not loaded makes this fail, which is the state we want anyway; any other failure stops the removal).
    // The service unit is NOT stopped: a run going may be between a build and a merge, and a stop would kill it there.
    const stopped = await deps.systemctl(["disable", "--now", timerUnitName(entry.key)]);
    // Only "this unit is not loaded" is fine; any other failure leaves the timer active, and deleting its files then would strand it with no way back through this command.
    // Asked by LoadState (`not-found`), which systemd does not translate, not by matching its message.
    if (stopped.code !== 0 && !(await unitNotLoaded(deps, timerUnitName(entry.key)))) throw new Error(`Could not stop ${timerUnitName(entry.key)}: ${stopped.stderr.trim() || stopped.stdout.trim() || "no message"}; nothing was removed.`);
    // The state directory is read from the unit, so it is asked before the unit file is removed.
    const stateDir = await effectiveStateDir(entry, deps);
    await deps.removeFile(timerPath);
    await deps.removeFile(servicePath);
    await run(deps, ["daemon-reload"]);
    deps.say(`Removed ${timerUnitName(entry.key)} and ${serviceUnitName(entry.key)}. The clone and its state are left as they were.`);
    const going = await readLockHolder(stateDir, deps.isAlive);
    if (going) deps.say(`A run is still going (pid ${going.pid}, started ${going.startedAt}) and was not stopped: it ends on its own, or \`tai service pause ${entry.key}\` ends it after its current ticket. No new tick will start.`);
    return { removed: true };
}

/** `kick`: starts the service unit the timer starts, so a kicked run has the timer's environment and the same lock. Refused from an AI session. */
export async function kickService(entry: ProjectEntry, deps: TimerDeps, root: string): Promise<void> {
    refuseFromAiSession(deps, "kick", "the unattended run is refused there too, and a person starts it from a plain terminal. The timer needs no one.");
    const refusal = await systemdRefusal(deps);
    if (refusal) throw new Error(refusal);
    const unit = serviceUnitName(entry.key);
    const installed = await deps.readFile(join(deps.unitDir, unit));
    if (installed === null) throw new Error(`${unit} is not installed: run \`tai service install ${entry.key}\` first.`);
    // The run reads the pause for all from the root the unit was installed with, so that is the one to look at, not the one this command was given.
    const pausedAll = await readPause(installedRoot(installed) ?? root);
    const paused = pausedAll ?? (await readPause(await effectiveStateDir(entry, deps)));
    // A paused project would start, log a skip and exit: say so instead of starting it.
    if (paused) throw new Error(`${pausedAll ? "Every project is" : `${entry.key} is`} paused (since ${paused.since}): a run would start nothing, so it was not started. \`tai service resume${pausedAll ? "" : ` ${entry.key}`}\` first.`);
    // `--no-block`: the run can last hours, and the lock (not this command) is what keeps a second one out.
    // A oneshot service that is already active ignores a start, so a run going is said instead of "it runs now".
    const going = await readLockHolder(await effectiveStateDir(entry, deps), deps.isAlive);
    await run(deps, ["start", "--no-block", unit]);
    if (going) {
        deps.say(`A run is already going (pid ${going.pid}, started ${going.startedAt}): ${unit} was asked to start, but a second run cannot hold the lock, so nothing new starts. It ends on its own.`);
        return;
    }
    deps.say(`Started ${unit}; it runs now and its log is \`journalctl --user -u ${unit} -f\`.`);
}

/** `pause`: one file per project in its state directory. Pausing twice keeps the first time. */
export async function pauseProjects(entries: readonly ProjectEntry[], deps: Pick<TimerDeps, "now" | "say" | "readFile" | "unitDir">): Promise<void> {
    for (const entry of entries) {
        const added = await writePause(await effectiveStateDir(entry, deps), deps.now());
        deps.say(added ? `Paused ${entry.key}: no tick starts a run, and a run going finishes its current ticket and then stops. \`tai service resume ${entry.key}\` lifts it; it has no expiry.` : `${entry.key} was already paused.`);
    }
}

/** `pause` with no project: one file in the service root, read by every tick and run, so it covers a project added later too. */
export async function pauseAll(root: string, deps: Pick<TimerDeps, "now" | "say">): Promise<void> {
    const added = await writePause(root, deps.now());
    const file = join(root, PAUSE_FILE);
    deps.say(added ? `Paused every project (${file}): no tick starts a run, and a run going finishes its current ticket and then stops. \`tai service resume\` lifts it; it has no expiry. A pause set on one project is kept apart and still applies. Timers installed with another root= read another file.` : `Every project was already paused (${file}).`);
}

export async function resumeAll(root: string, deps: Pick<TimerDeps, "say" | "aiSession">): Promise<void> {
    refuseFromAiSession(deps, "resume", "the pause is the person's safety switch, so only a person lifts it.");
    deps.say((await clearPause(root)) ? `Resumed every project (the pause for all, ${join(root, PAUSE_FILE)}). A pause set on one project, if any, still applies: \`tai service status\` shows it.` : `No pause for every project was set (${join(root, PAUSE_FILE)}).`);
}

export async function resumeProjects(entries: readonly ProjectEntry[], deps: Pick<TimerDeps, "say" | "aiSession" | "readFile" | "unitDir">): Promise<void> {
    refuseFromAiSession(deps, "resume", "the pause is the person's safety switch, so only a person lifts it.");
    for (const entry of entries) deps.say((await clearPause(await effectiveStateDir(entry, deps))) ? `Resumed ${entry.key}: the next tick runs as usual.` : `${entry.key} was not paused.`);
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
    const dir = await effectiveStateDir(entry, deps);
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
    // The run reads the pause for all from the root the unit was installed with, so that is the file that matters; a different root given here is said.
    const unitText = await deps.readFile(join(deps.unitDir, serviceUnitName(entry.key)));
    const unitRoot = (unitText === null ? null : installedRoot(unitText)) ?? root;
    if (resolve(unitRoot) !== resolve(root)) say(`  Root: the installed unit uses ${unitRoot}, not ${root}; the pause for every project is read from the unit's root.`);
    const pausedAll = await readPause(unitRoot);
    const paused = await readPause(dir);
    const sinceText = (p: { readonly since: string; readonly unreadable?: boolean }): string => (p.unreadable ? "(its file could not be read, so it counts as a pause)" : `since ${ago(p.since, now)}`);
    if (pausedAll) say(`  Pause: PAUSED for every project (${join(unitRoot, PAUSE_FILE)}) ${sinceText(pausedAll)}; \`tai service resume\` lifts it.`);
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

/** `status` for the chosen projects; with none listed it says so and still shows the pause for every project, which lives in the root. */
export async function serviceStatusAll(entries: readonly ProjectEntry[], deps: TimerDeps, root: string, configPath: string, problems: readonly string[] = []): Promise<void> {
    // A clash in the list is a line, not a refusal: status is where a person looks when something is wrong, so the other projects still show.
    for (const problem of problems) deps.say(`PROBLEM in the project list: ${problem}`);
    if (entries.length === 0) {
        deps.say(`No projects are listed in ${configPath}, so no timer runs.`);
        const pausedAll = await readPause(root);
        deps.say(pausedAll ? `Pause: PAUSED for every project (${join(root, PAUSE_FILE)}) since ${pausedAll.unreadable ? "(its file could not be read, so it counts as a pause)" : pausedAll.since}; \`tai service resume\` lifts it.` : "Pause: none.");
        return;
    }
    for (const entry of entries) await serviceStatus(entry, deps, root);
}
