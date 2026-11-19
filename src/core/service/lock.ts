/**
 * TAI Framework — the one-run-at-a-time lock of the unattended Dev service (Epic TAI-763, Story TAI-770).
 *
 * One lock file in the service's state directory holds the process id and start time of the run that owns it. A second start finds
 * it and does nothing. A lock whose process is gone is taken over, so a run that was killed does not block every later tick.
 * The clock and the "is this process alive" check are injected, so the rules are tested without a real second process.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
    /** Whether a process with this id is still running. */
    readonly isAlive: (pid: number) => boolean;
}

export type LockResult =
    | { readonly acquired: true; readonly tookOver: LockInfo | null; readonly release: () => Promise<void> }
    | { readonly acquired: false; readonly held: LockInfo };

/** What a second start prints: it exits 0 (so the timer unit is not marked failed) and says who holds the lock. */
export function alreadyRunningMessage(held: LockInfo): string {
    return `A run is already going (started ${held.startedAt}, pid ${held.pid}); nothing started.`;
}

function parseLock(text: string): LockInfo | null {
    try {
        const v = JSON.parse(text) as Partial<LockInfo>;
        return typeof v.pid === "number" && Number.isInteger(v.pid) && typeof v.startedAt === "string" ? { pid: v.pid, startedAt: v.startedAt } : null;
    } catch {
        return null;
    }
}

/** The lock file's contents: whether it exists, and what it says when it parses. */
async function readLock(path: string): Promise<{ readonly exists: boolean; readonly info: LockInfo | null }> {
    try {
        return { exists: true, info: parseLock(await readFile(path, "utf8")) };
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, info: null };
        throw e;
    }
}

/**
 * Takes the lock in `stateDir`, or says who holds it. An unreadable lock file, or one whose process is gone, is taken over
 * (`tookOver` carries what it said, for the log). The file is created exclusively, so two starts at the same moment cannot both win.
 */
export async function acquireLock(stateDir: string, deps: LockDeps): Promise<LockResult> {
    await mkdir(stateDir, { recursive: true });
    const path = join(stateDir, LOCK_FILE);
    const mine: LockInfo = { pid: deps.pid, startedAt: deps.now().toISOString() };
    let tookOver: LockInfo | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await writeFile(path, JSON.stringify(mine), { flag: "wx" });
            return {
                acquired: true,
                tookOver,
                release: async () => {
                    // Only our own lock is removed: after a take-over by another run the file is theirs.
                    const now = await readLock(path);
                    if (now.info?.pid === deps.pid && now.info.startedAt === mine.startedAt) await unlink(path).catch(() => undefined);
                },
            };
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        const current = await readLock(path);
        if (current.info && deps.isAlive(current.info.pid)) return { acquired: false, held: current.info };
        // Gone or unreadable: remove it and try again. If another start removes and takes it first, the next exclusive write loses and reads theirs.
        if (current.info) tookOver = current.info;
        await unlink(path).catch(() => undefined);
    }
    const final = await readLock(path);
    if (final.info) return { acquired: false, held: final.info };
    throw new Error(`Could not take the run lock at ${path}.`);
}

/** The real "is it alive" check: signal 0 tests for the process without sending anything. EPERM means it exists but is another user's. */
export function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}
