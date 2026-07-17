import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readWorkStatus, rollupStatus, writeWorkStatus, type WorkItemStatus } from "./status.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-status-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function status(overrides: Partial<WorkItemStatus> = {}): WorkItemStatus {
    return { subtaskKey: "TAI-1", currentStep: "implementing", state: "in-progress", updatedAt: "2026-01-01T00:00:00Z", ...overrides };
}

describe("writeWorkStatus / readWorkStatus", () => {
    it("round-trips a status entry", async () => {
        await withTempDir(async (dir) => {
            await writeWorkStatus(dir, "TAI", status());
            assert.deepEqual(await readWorkStatus(dir, "TAI", "TAI-1"), status());
        });
    });

    it("returns null for an item with no status yet", async () => {
        await withTempDir(async (dir) => {
            assert.equal(await readWorkStatus(dir, "TAI", "TAI-999"), null);
        });
    });
});

describe("rollupStatus", () => {
    it("returns an empty rollup when .tai/work/ doesn't exist yet", async () => {
        await withTempDir(async (dir) => {
            const rollup = await rollupStatus(dir);
            assert.deepEqual(rollup.items, []);
        });
    });

    it("aggregates across multiple projects and subtasks", async () => {
        await withTempDir(async (dir) => {
            await writeWorkStatus(dir, "TAI", status({ subtaskKey: "TAI-1" }));
            await writeWorkStatus(dir, "TAI", status({ subtaskKey: "TAI-2", state: "done" }));
            await writeWorkStatus(dir, "OTHER", status({ subtaskKey: "OTHER-1", state: "blocked" }));

            const rollup = await rollupStatus(dir);
            const keys = rollup.items.map((i) => i.subtaskKey).sort();
            assert.deepEqual(keys, ["OTHER-1", "TAI-1", "TAI-2"]);
        });
    });

    it("writes the rollup to .tai/status.json", async () => {
        await withTempDir(async (dir) => {
            await writeWorkStatus(dir, "TAI", status());
            await rollupStatus(dir);
            const written = JSON.parse(await readFile(path.join(dir, "status.json"), "utf8"));
            assert.equal(written.items.length, 1);
            assert.ok(written.generatedAt);
        });
    });
});
