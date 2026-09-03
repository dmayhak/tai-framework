import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DependencyRelation } from "../schema/story-schema.js";
import { toIssueKey, type IssueLink } from "../storage/interface.js";
import { readLinkedKeysSnapshot, snapshotLinkedKeys } from "./links-snapshot.js";

function link(key: string, relation: DependencyRelation = DependencyRelation.RelatesTo): IssueLink {
    return { relation, key: toIssueKey(key) };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-links-snapshot-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("snapshotLinkedKeys / readLinkedKeysSnapshot", () => {
    it("returns false (not changed) on the first-ever snapshot -- nothing to have changed from", async () => {
        await withTempDir(async (dir) => {
            const changed = await snapshotLinkedKeys(dir, "TAI", toIssueKey("TAI-1"), [link("TAI-2")]);
            assert.equal(changed, false);
            assert.deepEqual(await readLinkedKeysSnapshot(dir, "TAI", toIssueKey("TAI-1")), [toIssueKey("TAI-2")]);
        });
    });

    it("returns false when the same links are snapshotted again", async () => {
        await withTempDir(async (dir) => {
            await snapshotLinkedKeys(dir, "TAI", toIssueKey("TAI-1"), [link("TAI-2")]);
            const changed = await snapshotLinkedKeys(dir, "TAI", toIssueKey("TAI-1"), [link("TAI-2")]);
            assert.equal(changed, false);
        });
    });

    it("returns true when a link is added", async () => {
        await withTempDir(async (dir) => {
            await snapshotLinkedKeys(dir, "TAI", toIssueKey("TAI-1"), [link("TAI-2")]);
            const changed = await snapshotLinkedKeys(dir, "TAI", toIssueKey("TAI-1"), [link("TAI-2"), link("TAI-3")]);
            assert.equal(changed, true);
            assert.deepEqual(await readLinkedKeysSnapshot(dir, "TAI", toIssueKey("TAI-1")), [toIssueKey("TAI-2"), toIssueKey("TAI-3")]);
        });
    });

    it("returns true when a link is removed", async () => {
        await withTempDir(async (dir) => {
            await snapshotLinkedKeys(dir, "TAI", toIssueKey("TAI-1"), [link("TAI-2"), link("TAI-3")]);
            const changed = await snapshotLinkedKeys(dir, "TAI", toIssueKey("TAI-1"), [link("TAI-2")]);
            assert.equal(changed, true);
        });
    });

    it("deduplicates the same target key linked via two different relations", async () => {
        await withTempDir(async (dir) => {
            await snapshotLinkedKeys(dir, "TAI", toIssueKey("TAI-1"), [
                link("TAI-2", DependencyRelation.RelatesTo),
                link("TAI-2", DependencyRelation.DependsOn),
            ]);
            assert.deepEqual(await readLinkedKeysSnapshot(dir, "TAI", toIssueKey("TAI-1")), [toIssueKey("TAI-2")]);
        });
    });

    it("is order-independent -- the same set in a different order is not a change", async () => {
        await withTempDir(async (dir) => {
            await snapshotLinkedKeys(dir, "TAI", toIssueKey("TAI-1"), [link("TAI-3"), link("TAI-2")]);
            const changed = await snapshotLinkedKeys(dir, "TAI", toIssueKey("TAI-1"), [link("TAI-2"), link("TAI-3")]);
            assert.equal(changed, false);
        });
    });

    it("readLinkedKeysSnapshot returns null when nothing was ever snapshotted", async () => {
        await withTempDir(async (dir) => {
            assert.equal(await readLinkedKeysSnapshot(dir, "TAI", toIssueKey("TAI-1")), null);
        });
    });

    it("tracks different issues independently", async () => {
        await withTempDir(async (dir) => {
            await snapshotLinkedKeys(dir, "TAI", toIssueKey("TAI-1"), [link("TAI-2")]);
            await snapshotLinkedKeys(dir, "TAI", toIssueKey("TAI-9"), [link("TAI-8")]);
            assert.deepEqual(await readLinkedKeysSnapshot(dir, "TAI", toIssueKey("TAI-1")), [toIssueKey("TAI-2")]);
            assert.deepEqual(await readLinkedKeysSnapshot(dir, "TAI", toIssueKey("TAI-9")), [toIssueKey("TAI-8")]);
        });
    });
});
