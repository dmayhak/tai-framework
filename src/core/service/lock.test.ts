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
    it("is true for this process and false for a pid that cannot exist", () => {
        assert.equal(processIsAlive(process.pid), true);
        assert.equal(processIsAlive(2 ** 22 + 12345), false);
    });
});
