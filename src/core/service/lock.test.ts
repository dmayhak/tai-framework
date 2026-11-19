import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLock, alreadyRunningMessage, LOCK_FILE, processIsAlive } from "./lock.js";

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tai-lock-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const at = (iso: string) => () => new Date(iso);

describe("acquireLock (TAI-770 AC-1)", () => {
    it("takes a free lock and records the pid and start time", async () => {
        const got = await acquireLock(dir, { pid: 100, now: at("2026-11-18T10:00:00Z"), isAlive: () => false });
        assert.equal(got.acquired, true);
        const text = JSON.parse(await readFile(join(dir, LOCK_FILE), "utf8"));
        assert.deepEqual(text, { pid: 100, startedAt: "2026-11-18T10:00:00.000Z" });
    });

    it("a second start while the owner is alive does not get the lock, and says who holds it", async () => {
        await acquireLock(dir, { pid: 100, now: at("2026-11-18T10:00:00Z"), isAlive: () => true });
        const second = await acquireLock(dir, { pid: 200, now: at("2026-11-18T10:05:00Z"), isAlive: (pid) => pid === 100 });
        assert.equal(second.acquired, false);
        if (second.acquired) return;
        assert.deepEqual(second.held, { pid: 100, startedAt: "2026-11-18T10:00:00.000Z" });
        assert.equal(alreadyRunningMessage(second.held), "A run is already going (started 2026-11-18T10:00:00.000Z, pid 100); nothing started.");
    });

    it("takes over a lock whose process is gone, and reports what it said", async () => {
        await acquireLock(dir, { pid: 100, now: at("2026-11-18T10:00:00Z"), isAlive: () => true });
        const next = await acquireLock(dir, { pid: 200, now: at("2026-11-18T11:00:00Z"), isAlive: () => false });
        assert.equal(next.acquired, true);
        if (!next.acquired) return;
        assert.equal(next.tookOver?.pid, 100);
        assert.equal(JSON.parse(await readFile(join(dir, LOCK_FILE), "utf8")).pid, 200);
    });

    it("takes over a lock file that cannot be read", async () => {
        await writeFile(join(dir, LOCK_FILE), "not json");
        const got = await acquireLock(dir, { pid: 300, now: at("2026-11-18T12:00:00Z"), isAlive: () => true });
        assert.equal(got.acquired, true);
    });

    it("release removes its own lock, so the next start can take it", async () => {
        const first = await acquireLock(dir, { pid: 100, now: at("2026-11-18T10:00:00Z"), isAlive: () => true });
        assert.ok(first.acquired);
        if (first.acquired) await first.release();
        const next = await acquireLock(dir, { pid: 200, now: at("2026-11-18T10:30:00Z"), isAlive: () => true });
        assert.equal(next.acquired, true);
    });

    it("release leaves a lock another run took over alone", async () => {
        const first = await acquireLock(dir, { pid: 100, now: at("2026-11-18T10:00:00Z"), isAlive: () => true });
        const takeover = await acquireLock(dir, { pid: 200, now: at("2026-11-18T11:00:00Z"), isAlive: (pid) => pid !== 100 });
        assert.ok(first.acquired && takeover.acquired);
        if (first.acquired) await first.release();
        assert.equal(JSON.parse(await readFile(join(dir, LOCK_FILE), "utf8")).pid, 200);
    });
});

describe("processIsAlive", () => {
    it("is true for this process and false for a pid that cannot exist", async () => {
        assert.equal(await processIsAlive(process.pid, new Date().toISOString()), true);
        assert.equal(await processIsAlive(2 ** 22 + 12345, new Date().toISOString()), false);
    });

    it("is false when the process started after the lock was written: the pid was reused", async () => {
        if (process.platform !== "linux") return;
        assert.equal(await processIsAlive(process.pid, "2000-01-01T00:00:00.000Z"), false);
    });
});

describe("acquireLock: several starts at once over one dead lock", () => {
    it("lets exactly one of them take it", async () => {
        await acquireLock(dir, { pid: 100, now: at("2026-11-18T10:00:00Z"), isAlive: () => true });
        const alive = new Set<number>();
        const start = (pid: number) =>
            acquireLock(dir, {
                pid,
                now: at("2026-11-18T11:00:00Z"),
                isAlive: (p) => alive.has(p),
            });
        const results = await Promise.all([200, 201, 202, 203, 204].map(async (pid) => {
            const r = await start(pid);
            if (r.acquired) alive.add(pid);
            return r;
        }));
        assert.equal(results.filter((r) => r.acquired).length, 1);
    });
});

describe("acquireLock: a lock file still being written", () => {
    it("holds against an empty lock file that was just created, and takes over one that has sat empty", async () => {
        await writeFile(join(dir, LOCK_FILE), "");
        const fresh = await acquireLock(dir, { pid: 200, now: () => new Date(), isAlive: () => false });
        assert.equal(fresh.acquired, false);
        const later = await acquireLock(dir, { pid: 200, now: () => new Date(Date.now() + 60_000), isAlive: () => false });
        assert.equal(later.acquired, true);
    });
});
