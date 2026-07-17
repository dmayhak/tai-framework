import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Status, StoryType } from "../schema/story-schema.js";
import { toIssueKey, type Issue, type WorkTracker } from "../storage/interface.js";
import { cacheIssue, readCachedIssue, refreshIssue } from "./issue-cache.js";

function issue(overrides: Partial<Issue> = {}): Issue {
    return {
        key: toIssueKey("TAI-1"),
        projectKey: "TAI",
        issueType: StoryType.Story,
        summary: "A story",
        status: Status.InProgress,
        assignee: null,
        persona: null,
        labels: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        comments: [],
        ...overrides,
    };
}

class FakeWorkTracker implements Partial<WorkTracker> {
    calls = 0;
    constructor(private result: Issue | null) {}
    async getIssue(): Promise<Issue | null> {
        this.calls++;
        return this.result;
    }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-issue-cache-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("refreshIssue / readCachedIssue / cacheIssue", () => {
    it("caches nothing and returns null when the issue doesn't exist", async () => {
        await withTempDir(async (dir) => {
            const tracker = new FakeWorkTracker(null) as unknown as WorkTracker;
            const result = await refreshIssue(tracker, dir, "TAI", toIssueKey("TAI-1"));
            assert.equal(result, null);
            assert.equal(await readCachedIssue(dir, "TAI", "TAI-1"), null);
        });
    });

    it("writes a fresh cache entry on first refresh", async () => {
        await withTempDir(async (dir) => {
            const tracker = new FakeWorkTracker(issue()) as unknown as WorkTracker;
            const result = await refreshIssue(tracker, dir, "TAI", toIssueKey("TAI-1"));
            assert.equal(result?.key, "TAI-1");
            const cached = await readCachedIssue(dir, "TAI", "TAI-1");
            assert.deepEqual(cached, issue());
        });
    });

    it("cacheIssue skips the disk write when updatedAt is unchanged (writes are compare-then-write)", async () => {
        await withTempDir(async (dir) => {
            await cacheIssue(dir, "TAI", issue());
            const before = await readCachedIssue(dir, "TAI", "TAI-1");
            // A different summary but the SAME updatedAt should not overwrite the cache --
            // proves the compare is on updatedAt specifically, not a deep-equals.
            await cacheIssue(dir, "TAI", issue({ summary: "Different summary now" }));
            const after = await readCachedIssue(dir, "TAI", "TAI-1");
            assert.equal(before?.summary, after?.summary);
            assert.equal(after?.summary, "A story");
        });
    });

    it("cacheIssue DOES write when updatedAt changed", async () => {
        await withTempDir(async (dir) => {
            await cacheIssue(dir, "TAI", issue());
            await cacheIssue(dir, "TAI", issue({ summary: "Updated", updatedAt: "2026-02-01T00:00:00Z" }));
            const after = await readCachedIssue(dir, "TAI", "TAI-1");
            assert.equal(after?.summary, "Updated");
        });
    });
});
