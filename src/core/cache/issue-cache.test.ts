import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Status, StoryType } from "../schema/story-schema.js";
import { StorageConnectivityError, toHumanId, toIssueKey, type HumanRef, type Issue, type WorkTracker } from "../storage/interface.js";
import { cacheIssue, classifyIssueChange, combineSeverity, readCachedIssue, refreshIssue } from "./issue-cache.js";

const HUMAN_A: HumanRef = { id: toHumanId("a@x.test"), displayName: "A" };
const HUMAN_B: HumanRef = { id: toHumanId("b@x.test"), displayName: "B" };

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
            assert.deepEqual(result, { issue: null, severity: "none" });
            assert.equal(await readCachedIssue(dir, "TAI", "TAI-1"), null);
        });
    });

    it("writes a fresh cache entry on first refresh, severity 'none' -- nothing to have changed from", async () => {
        await withTempDir(async (dir) => {
            const tracker = new FakeWorkTracker(issue()) as unknown as WorkTracker;
            const result = await refreshIssue(tracker, dir, "TAI", toIssueKey("TAI-1"));
            assert.equal(result.issue?.key, "TAI-1");
            assert.equal(result.severity, "none");
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
            const severity = await cacheIssue(dir, "TAI", issue({ summary: "Different summary now" }));
            const after = await readCachedIssue(dir, "TAI", "TAI-1");
            assert.equal(severity, "none");
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

    // PR #9 code review: offline (StorageConnectivityError) used to propagate as a hard
    // crash instead of degrading to whatever's already cached (brief §3.6).
    describe("degrades to the cached copy on StorageConnectivityError", () => {
        it("returns the cached issue instead of throwing when one exists", async () => {
            await withTempDir(async (dir) => {
                await cacheIssue(dir, "TAI", issue());
                const offlineTracker = {
                    async getIssue(): Promise<Issue | null> {
                        throw new StorageConnectivityError("network unreachable");
                    },
                } as unknown as WorkTracker;

                const result = await refreshIssue(offlineTracker, dir, "TAI", toIssueKey("TAI-1"));
                assert.deepEqual(result, { issue: issue(), severity: "none" });
            });
        });

        it("returns null, not a throw, when offline with nothing cached yet", async () => {
            await withTempDir(async (dir) => {
                const offlineTracker = {
                    async getIssue(): Promise<Issue | null> {
                        throw new StorageConnectivityError("network unreachable");
                    },
                } as unknown as WorkTracker;

                const result = await refreshIssue(offlineTracker, dir, "TAI", toIssueKey("TAI-1"));
                assert.deepEqual(result, { issue: null, severity: "none" });
            });
        });

        it("still propagates a non-connectivity error rather than masking it as offline", async () => {
            await withTempDir(async (dir) => {
                const brokenTracker = {
                    async getIssue(): Promise<Issue | null> {
                        throw new Error("something else entirely");
                    },
                } as unknown as WorkTracker;

                await assert.rejects(
                    () => refreshIssue(brokenTracker, dir, "TAI", toIssueKey("TAI-1")),
                    /something else entirely/
                );
            });
        });
    });
});

describe("classifyIssueChange (TAI-285 ADR)", () => {
    it("classifies as 'none' when nothing tracked differs", () => {
        assert.equal(classifyIssueChange(issue(), issue({ labels: ["x"] })), "none");
    });

    it("classifies a summary-only change as 'content'", () => {
        assert.equal(classifyIssueChange(issue(), issue({ summary: "New summary" })), "content");
    });

    it("classifies a description-only change as 'content'", () => {
        assert.equal(classifyIssueChange(issue({ description: "old" }), issue({ description: "new" })), "content");
    });

    it("classifies a status change as 'structural'", () => {
        assert.equal(classifyIssueChange(issue({ status: Status.ToDo }), issue({ status: Status.InProgress })), "structural");
    });

    it("classifies a priority change as 'structural'", () => {
        assert.equal(classifyIssueChange(issue({ priority: "Low" }), issue({ priority: "High" })), "structural");
    });

    it("classifies an issueType change as 'structural'", () => {
        assert.equal(classifyIssueChange(issue({ issueType: StoryType.Story }), issue({ issueType: StoryType.Bug })), "structural");
    });

    it("classifies an assignee change (by id) as 'structural'", () => {
        assert.equal(classifyIssueChange(issue({ assignee: HUMAN_A }), issue({ assignee: HUMAN_B })), "structural");
    });

    it("does not treat an assignee with the same id but a different displayName as changed", () => {
        const sameHumanRenamed: HumanRef = { id: HUMAN_A.id, displayName: "A Renamed" };
        assert.equal(classifyIssueChange(issue({ assignee: HUMAN_A }), issue({ assignee: sameHumanRenamed })), "none");
    });

    it("classifies unassigned -> assigned (and back) as 'structural'", () => {
        assert.equal(classifyIssueChange(issue({ assignee: null }), issue({ assignee: HUMAN_A })), "structural");
        assert.equal(classifyIssueChange(issue({ assignee: HUMAN_A }), issue({ assignee: null })), "structural");
    });

    it("a structural change wins even when a content field ALSO changed", () => {
        assert.equal(
            classifyIssueChange(issue({ summary: "old", status: Status.ToDo }), issue({ summary: "new", status: Status.InProgress })),
            "structural"
        );
    });
});

describe("combineSeverity", () => {
    it("picks the more severe of two signals, in either argument order", () => {
        assert.equal(combineSeverity("none", "content"), "content");
        assert.equal(combineSeverity("content", "none"), "content");
        assert.equal(combineSeverity("content", "structural"), "structural");
        assert.equal(combineSeverity("structural", "content"), "structural");
        assert.equal(combineSeverity("none", "none"), "none");
        assert.equal(combineSeverity("structural", "structural"), "structural");
    });
});
