/**
 * TAI Framework — the one-run-at-a-time lock of the unattended Dev service (Epic TAI-763, Story TAI-770).
 *
 * One lock file in the service's state directory holds the process id and start time of the run that owns it. A second start finds
 * it and does nothing. A lock whose process is gone is taken over, so a run that was killed does not block every later tick.
 * The clock and the "is this process alive" check are injected, so the rules are tested without a real second process.
 */

import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const LOCK_FILE = "run.lock";

export interface LockInfo {
    readonly pid: number;
    /** ISO time the owning run started. */
    readonly startedAt: string;
}

export interface LockDeps {
    readonly pid: number;
    readonly now: () => Date;
    /** Whether the run that wrote this lock (this pid, started at this time) is still running; a reused pid is not that run. */
    readonly isAlive: (pid: number, startedAt: string) => boolean | Promise<boolean>;
}

export type LockResult =
    | { readonly acquired: true; readonly tookOver: LockInfo | null; readonly release: () => Promise<void> }
    | { readonly acquired: false; readonly held: LockInfo };

/** What a second start prints: it exits 0 (so the timer unit is not marked failed) and says who holds the lock. */
export function alreadyRunningMessage(held: LockInfo): string {
    return `A run is already going (started ${held.startedAt}${held.pid > 0 ? `, pid ${held.pid}` : ""}); nothing started.`;
}

function parseLock(text: string): LockInfo | null {
    try {
        const v = JSON.parse(text) as Partial<LockInfo>;
        return typeof v.pid === "number" && Number.isInteger(v.pid) && typeof v.startedAt === "string" ? { pid: v.pid, startedAt: v.startedAt } : null;
    } catch {
        return null;
    }
}

/** How long an empty or unreadable lock file is taken to be one that its owner is still writing. */
const WRITING_GRACE_MS = 5000;

/** The lock file's contents: whether it exists, and what it says when it parses. */
async function readLock(path: string): Promise<{ readonly exists: boolean; readonly info: LockInfo | null }> {
    try {
        return { exists: true, info: parseLock(await readFile(path, "utf8")) };
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, info: null };
        throw e;
    }
}

/** Pauses a moment so a start that lost a take-over race reads what the winner wrote. */
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Takes the lock in `stateDir`, or says who holds it. An unreadable lock file, or one whose run is gone, is taken over
 * (`tookOver` carries what it said, for the log). The file is created exclusively, so two starts at the same moment cannot both win.
 * A stale lock is removed only by the start that holds `run.lock.takeover` (also created exclusively), and only after it reads the
 * lock again and finds it unchanged, so a start that read the dead lock early cannot delete the fresh lock of the one that replaced it.
 */
export async function acquireLock(stateDir: string, deps: LockDeps): Promise<LockResult> {
    await mkdir(stateDir, { recursive: true });
    const path = join(stateDir, LOCK_FILE);
    const takeoverPath = `${path}.takeover`;
    const mine: LockInfo = { pid: deps.pid, startedAt: deps.now().toISOString() };
    const isStale = async (info: LockInfo | null): Promise<boolean> => info === null || !(await deps.isAlive(info.pid, info.startedAt));
    let tookOver: LockInfo | null = null;
    const acquired = (): LockResult => ({
        acquired: true,
        tookOver,
        release: async () => {
            // Only our own lock is removed: after a take-over by another run the file is theirs.
            const now = await readLock(path);
            if (now.info?.pid === deps.pid && now.info.startedAt === mine.startedAt) await unlink(path).catch(() => undefined);
        },
    });
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            await writeFile(path, JSON.stringify(mine), { flag: "wx" });
            return acquired();
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        const current = await readLock(path);
        if (current.info && !(await isStale(current.info))) return { acquired: false, held: current.info };
        // `wx` creates the file before its contents are written: a fresh file that does not parse yet is a start in the middle of taking the lock.
        if (current.exists && !current.info) {
            const written = await stat(path).then((s) => s.mtime, () => null);
            const age = written ? deps.now().getTime() - written.getTime() : Infinity;
            if (written && age >= 0 && age < WRITING_GRACE_MS) return { acquired: false, held: { pid: 0, startedAt: written.toISOString() } };
        }
        // Stale or unreadable. Only the holder of the take-over file may remove it.
        try {
            await writeFile(takeoverPath, JSON.stringify(mine), { flag: "wx" });
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            // Another start is taking over; if it died doing so, its file is stale too.
            const other = await readLock(takeoverPath);
            if (await isStale(other.info)) await unlink(takeoverPath).catch(() => undefined);
            else await pause(25);
            continue;
        }
        try {
            const again = await readLock(path);
            const unchanged = again.exists && JSON.stringify(again.info) === JSON.stringify(current.info);
            if (unchanged) {
                if (current.info) tookOver = current.info;
                await unlink(path).catch(() => undefined);
                try {
                    await writeFile(path, JSON.stringify(mine), { flag: "wx" });
                    return acquired();
                } catch (e) {
                    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
                }
            }
        } finally {
            await unlink(takeoverPath).catch(() => undefined);
        }
    }
    const final = await readLock(path);
    if (final.info) return { acquired: false, held: final.info };
    throw new Error(`Could not take the run lock at ${path}.`);
}

/** When a process started, read from `/proc` (Linux); null when it cannot be read. */
async function processStartTime(pid: number): Promise<Date | null> {
    try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        // Field 22 is the start time in clock ticks since boot; the command name (field 2) may hold spaces, so count from its closing bracket.
        const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
        const boot = /^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"));
        if (!boot || !Number.isFinite(ticks)) return null;
        return new Date((Number(boot[1]) + ticks / 100) * 1000);
    } catch {
        return null;
    }
}

/** How much later than the lock's own time a process may have started and still be its owner: none, bar clock rounding. */
const START_SLACK_MS = 5000;

/**
 * The real "is it alive" check: signal 0 tests for the process without sending anything (EPERM means it exists but is another user's).
 * A process that started AFTER the lock was written cannot be the run that wrote it: the pid was reused, so the lock is stale.
 */
export async function processIsAlive(pid: number, startedAt: string): Promise<boolean> {
    try {
        process.kill(pid, 0);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
    }
    const began = await processStartTime(pid);
    return began === null || began.getTime() <= new Date(startedAt).getTime() + START_SLACK_MS;
}
