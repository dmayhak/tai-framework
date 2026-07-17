import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Status, StoryType } from "../schema/story-schema.js";
import { toIssueKey, type Issue, type IssueFilter, type WorkTracker } from "../storage/interface.js";
import { readCachedIssue } from "./issue-cache.js";
import { bulkSync, readSyncCheckpoint } from "./sync.js";

function issue(key: string, updatedAt: string): Issue {
    return {
        key: toIssueKey(key),
        projectKey: "TAI",
        issueType: StoryType.Story,
        summary: key,
        status: Status.InProgress,
        assignee: null,
        persona: null,
        labels: [],
        createdAt: updatedAt,
        updatedAt,
        comments: [],
    };
}

class FakeWorkTracker implements Partial<WorkTracker> {
    lastFilter: IssueFilter | undefined;
    constructor(private results: Issue[]) {}
    async search(filter: IssueFilter): Promise<readonly Issue[]> {
        this.lastFilter = filter;
        return this.results;
    }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-sync-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("bulkSync", () => {
    it("searches with no updatedSince on the first sync (no checkpoint yet)", async () => {
        await withTempDir(async (dir) => {
            const tracker = new FakeWorkTracker([]);
            await bulkSync(tracker as unknown as WorkTracker, dir, "TAI");
            assert.equal(tracker.lastFilter?.updatedSince, undefined);
            assert.equal(tracker.lastFilter?.projectKey, "TAI");
        });
    });

    it("caches every returned issue", async () => {
        await withTempDir(async (dir) => {
            const tracker = new FakeWorkTracker([issue("TAI-1", "2026-01-01T00:00:00Z"), issue("TAI-2", "2026-01-02T00:00:00Z")]);
            const results = await bulkSync(tracker as unknown as WorkTracker, dir, "TAI");
            assert.equal(results.length, 2);
            assert.ok(await readCachedIssue(dir, "TAI", "TAI-1"));
            assert.ok(await readCachedIssue(dir, "TAI", "TAI-2"));
        });
    });

    it("checkpoints on the MAX updatedAt in the batch, not arrival order", async () => {
        await withTempDir(async (dir) => {
            // Deliberately out of order -- TAI-2 has the later updatedAt despite coming first.
            const tracker = new FakeWorkTracker([issue("TAI-2", "2026-01-05T00:00:00Z"), issue("TAI-1", "2026-01-01T00:00:00Z")]);
            await bulkSync(tracker as unknown as WorkTracker, dir, "TAI");
            const checkpoint = await readSyncCheckpoint(dir, "TAI");
            assert.equal(checkpoint?.lastSyncAt, "2026-01-05T00:00:00Z");
        });
    });

    it("passes the existing checkpoint as updatedSince on a subsequent sync", async () => {
        await withTempDir(async (dir) => {
            const first = new FakeWorkTracker([issue("TAI-1", "2026-01-01T00:00:00Z")]);
            await bulkSync(first as unknown as WorkTracker, dir, "TAI");

            const second = new FakeWorkTracker([]);
            await bulkSync(second as unknown as WorkTracker, dir, "TAI");
            assert.equal(second.lastFilter?.updatedSince, "2026-01-01T00:00:00Z");
        });
    });

    it("leaves the checkpoint untouched when the batch is empty", async () => {
        await withTempDir(async (dir) => {
            const first = new FakeWorkTracker([issue("TAI-1", "2026-01-01T00:00:00Z")]);
            await bulkSync(first as unknown as WorkTracker, dir, "TAI");

            const empty = new FakeWorkTracker([]);
            await bulkSync(empty as unknown as WorkTracker, dir, "TAI");
            const checkpoint = await readSyncCheckpoint(dir, "TAI");
            assert.equal(checkpoint?.lastSyncAt, "2026-01-01T00:00:00Z");
        });
    });
});
