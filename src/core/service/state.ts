/**
 * TAI Framework — what the unattended Dev service keeps in its state directory between ticks (Epic TAI-763, Story TAI-770).
 *
 * Three small JSON files: `limited-until.json` (the account's usage limit, so ticks skip until it resets, because the limit record of
 * `do-dev-tasks` lives in memory for one run only), `last-run.json` (what the last run did, for `tai service status`), and
 * `preflight.json` (the last failed-preflight message, so the same failure is logged once and again only when it changes).
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LIMITED_FILE = "limited-until.json";
export const LAST_RUN_FILE = "last-run.json";
export const PREFLIGHT_FILE = "preflight.json";
export const PAUSE_FILE = "paused.json";

async function readJson<T>(path: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
        return null; // missing or unreadable: the same as nothing recorded
    }
}

async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

export interface LimitedUntil {
    /** ISO time the limit resets. */
    readonly until: string;
    readonly text: string;
}

/** The limit record while it still applies at `now`; one that has passed (or cannot be read) is no limit. */
export async function readLimitedUntil(dir: string, now: Date): Promise<LimitedUntil | null> {
    const v = await readJson<Partial<LimitedUntil>>(join(dir, LIMITED_FILE));
    if (!v || typeof v.until !== "string" || Number.isNaN(Date.parse(v.until))) return null;
    return Date.parse(v.until) > now.getTime() ? { until: v.until, text: typeof v.text === "string" ? v.text : "" } : null;
}

export async function writeLimitedUntil(dir: string, value: LimitedUntil): Promise<void> {
    await writeJson(dir, LIMITED_FILE, value);
}

export async function clearLimitedUntil(dir: string): Promise<void> {
    await rm(join(dir, LIMITED_FILE), { force: true });
}

export interface LastRun {
    readonly started: string;
    readonly ended: string;
    readonly tickets: readonly { readonly key: string; readonly state: string; readonly detail?: string }[];
    /** TAI-777: tickets the pickup rule left alone because a person is working them, with why. Absent when none. */
    readonly skipped?: readonly { readonly key: string; readonly reason: string }[];
    /** Why the run ended: "cap reached", "usage limit ...", "no more ready tickets", a stop, or why it did not run. */
    readonly stopReason: string;
}

export async function readLastRun(dir: string): Promise<LastRun | null> {
    return readJson<LastRun>(join(dir, LAST_RUN_FILE));
}

export async function writeLastRun(dir: string, value: LastRun): Promise<void> {
    await writeJson(dir, LAST_RUN_FILE, value);
}

export interface PreflightNote {
    readonly message: string;
    /** ISO time the message was first seen. */
    readonly since: string;
}

export async function readPreflightNote(dir: string): Promise<PreflightNote | null> {
    return readJson<PreflightNote>(join(dir, PREFLIGHT_FILE));
}

/**
 * Records a failed preflight. Returns true when it is NEW (a different message than the last one, or none before), so the caller logs
 * it; the same message again is kept with its first-seen time and returns false.
 */
export async function noteFailedPreflight(dir: string, message: string, now: Date): Promise<boolean> {
    const last = await readPreflightNote(dir);
    if (last?.message === message) return false;
    await writeJson(dir, PREFLIGHT_FILE, { message, since: now.toISOString() } satisfies PreflightNote);
    return true;
}

/** A passing preflight clears the note, so the same failure later is logged again. */
export async function clearPreflightNote(dir: string): Promise<void> {
    await rm(join(dir, PREFLIGHT_FILE), { force: true });
}

/** TAI-772: a pause set by `tai service pause`. A file on disk, so it survives a reboot, with no expiry: only `resume` removes it. */
export interface Pause {
    /** ISO time the pause was set, or a note that it could not be read. */
    readonly since: string;
    /** True when the file is there but cannot be read: it still counts as a pause (see `readPause`). */
    readonly unreadable?: boolean;
}

const UNREADABLE_SINCE = "unknown (the pause file exists but could not be read)";

/**
 * The pause in `dir`, or null when there is none. A file that EXISTS but cannot be read or parsed (a write cut short, a bad edit, a
 * permission) counts as a pause, with `unreadable` set: the pause is a safety switch for a run that builds and merges, so a damaged one
 * must fail closed. Only `resume` (or a fresh `pause`) clears it.
 */
export async function readPause(dir: string): Promise<Pause | null> {
    return readPauseFile(join(dir, PAUSE_FILE));
}

async function readPauseFile(path: string): Promise<Pause | null> {
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : { since: UNREADABLE_SINCE, unreadable: true };
    }
    try {
        const v = JSON.parse(text) as Partial<Pause> | null;
        if (v && typeof v.since === "string" && !Number.isNaN(Date.parse(v.since))) return { since: v.since };
    } catch {
        // falls through: unreadable
    }
    return { since: UNREADABLE_SINCE, unreadable: true };
}

/** Sets the pause, written to a temporary file and renamed so a crash cannot leave half a file. One already set keeps its own first time; an unreadable one is rewritten. Returns true when it was new. */
export async function writePause(dir: string, now: Date): Promise<boolean> {
    const existing = await readPause(dir);
    if (existing && !existing.unreadable) return false;
    await mkdir(dir, { recursive: true });
    const target = join(dir, PAUSE_FILE);
    const temp = `${target}.${process.pid}.tmp`;
    // A damaged file is replaced by the rename alone, so the pause is never absent. A folder cannot be renamed over, so it is removed first: only in that odd case is there a moment with no pause.
    if (existing && (await stat(target).then((st) => st.isDirectory(), () => false))) await rm(target, { force: true, recursive: true });
    try {
        await writeFile(temp, `${JSON.stringify({ since: now.toISOString() } satisfies Pause, null, 2)}\n`);
        await rename(temp, target);
    } catch (e) {
        await rm(temp, { force: true }).catch(() => undefined); // no stray temporary file when the write or rename fails
        throw e;
    }
    return true;
}

/** Removes the pause. Returns true when there was one. */
export async function clearPause(dir: string): Promise<boolean> {
    const was = await readPause(dir);
    // recursive: a pause path that is a directory (it counts as a pause) is cleared rather than failing resume with EISDIR
    await rm(join(dir, PAUSE_FILE), { force: true, recursive: true });
    return was !== null;
}

/** What a run in progress checks between tickets (`do-dev-tasks stopfile=<path>`): why it should stop, or null while there is no pause. A damaged file stops it too. */
export async function pauseStopReason(path: string): Promise<string | null> {
    const pause = await readPauseFile(path);
    return pause ? `paused by \`tai service pause\` (since ${pause.since})` : null;
}

/** TAI-772: why a run should stop between tickets (a pause in any of its stop files), or null. */
export async function stopRequestedBy(files: readonly string[]): Promise<string | null> {
    for (const f of files) {
        const why = await pauseStopReason(f);
        if (why) return why;
    }
    return null;
}

/** What a usage-limit wait polls each step: an interrupt, or a pause in any stop file (so a pause ends the wait). */
export function interruptedOrPaused(interrupted: () => boolean, stopFiles: readonly string[] | undefined): () => Promise<boolean> {
    return async () => interrupted() || (stopFiles !== undefined && (await stopRequestedBy(stopFiles)) !== null);
}
