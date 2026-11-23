/**
 * TAI Framework — what the unattended Dev service keeps in its state directory between ticks (Epic TAI-763, Story TAI-770).
 *
 * Three small JSON files: `limited-until.json` (the account's usage limit, so ticks skip until it resets, because the limit record of
 * `do-dev-tasks` lives in memory for one run only), `last-run.json` (what the last run did, for `tai service status`), and
 * `preflight.json` (the last failed-preflight message, so the same failure is logged once and again only when it changes).
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    /** ISO time the pause was set. */
    readonly since: string;
}

export async function readPause(dir: string): Promise<Pause | null> {
    const v = await readJson<Partial<Pause>>(join(dir, PAUSE_FILE));
    return v && typeof v.since === "string" ? { since: v.since } : null;
}

/** Sets the pause. One already set keeps its own first time, so pausing twice does not move it. Returns true when it was new. */
export async function writePause(dir: string, now: Date): Promise<boolean> {
    if (await readPause(dir)) return false;
    await writeJson(dir, PAUSE_FILE, { since: now.toISOString() } satisfies Pause);
    return true;
}

/** Removes the pause. Returns true when there was one. */
export async function clearPause(dir: string): Promise<boolean> {
    const was = await readPause(dir);
    await rm(join(dir, PAUSE_FILE), { force: true });
    return was !== null;
}

/** What a run in progress checks between tickets (`do-dev-tasks stopfile=<path>`): why it should stop, or null while there is no pause. */
export async function pauseStopReason(path: string): Promise<string | null> {
    const v = await readJson<Partial<Pause>>(path);
    return v && typeof v.since === "string" ? `paused by \`tai service pause\` (since ${v.since})` : null;
}
