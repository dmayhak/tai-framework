import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Status, StoryType } from "../schema/story-schema.js";
import { StorageConnectivityError, toHumanId, toIssueKey, type HumanRef, type Issue, type WorkTracker } from "../storage/interface.js";
import { cacheIssue, classifyIssueChange, combineFieldChange, combineSeverity, readCachedIssue, refreshIssue } from "./issue-cache.js";

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
            assert.deepEqual(result, { issue: null, change: { severity: "none", fields: [] } });
            assert.equal(await readCachedIssue(dir, "TAI", "TAI-1"), null);
        });
    });

    it("writes a fresh cache entry on first refresh, severity 'none' -- nothing to have changed from", async () => {
        await withTempDir(async (dir) => {
            const tracker = new FakeWorkTracker(issue()) as unknown as WorkTracker;
            const result = await refreshIssue(tracker, dir, "TAI", toIssueKey("TAI-1"));
            assert.equal(result.issue?.key, "TAI-1");
            assert.deepEqual(result.change, { severity: "none", fields: [] });
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
            const change = await cacheIssue(dir, "TAI", issue({ summary: "Different summary now" }));
            const after = await readCachedIssue(dir, "TAI", "TAI-1");
            assert.deepEqual(change, { severity: "none", fields: [] });
            assert.equal(before?.summary, after?.summary);
            assert.equal(after?.summary, "A story");
        });
    });

    it("cacheIssue DOES write when updatedAt changed", async () => {
        await withTempDir(async (dir) => {
            await cacheIssue(dir, "TAI", issue());
            const change = await cacheIssue(dir, "TAI", issue({ summary: "Updated", updatedAt: "2026-02-01T00:00:00Z" }));
            const after = await readCachedIssue(dir, "TAI", "TAI-1");
            assert.equal(after?.summary, "Updated");
            assert.deepEqual(change, { severity: "content", fields: ["summary"] });
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
                assert.deepEqual(result, { issue: issue(), change: { severity: "none", fields: [] } });
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
                assert.deepEqual(result, { issue: null, change: { severity: "none", fields: [] } });
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
    it("classifies as 'none', no fields, when nothing tracked differs", () => {
        assert.deepEqual(classifyIssueChange(issue(), issue({ labels: ["x"] })), { severity: "none", fields: [] });
    });

    it("classifies a summary-only change as 'content', naming 'summary'", () => {
        assert.deepEqual(classifyIssueChange(issue(), issue({ summary: "New summary" })), {
            severity: "content",
            fields: ["summary"],
        });
    });

    it("classifies a description-only change as 'content', naming 'description'", () => {
        assert.deepEqual(classifyIssueChange(issue({ description: "old" }), issue({ description: "new" })), {
            severity: "content",
            fields: ["description"],
        });
    });

    it("names BOTH content fields when summary and description both changed", () => {
        assert.deepEqual(classifyIssueChange(issue({ description: "old" }), issue({ summary: "New", description: "new" })), {
            severity: "content",
            fields: ["summary", "description"],
        });
    });

    it("classifies a status change as 'structural', naming 'status'", () => {
        assert.deepEqual(classifyIssueChange(issue({ status: Status.ToDo }), issue({ status: Status.InProgress })), {
            severity: "structural",
            fields: ["status"],
        });
    });

    it("classifies a priority change as 'structural', naming 'priority'", () => {
        assert.deepEqual(classifyIssueChange(issue({ priority: "Low" }), issue({ priority: "High" })), {
            severity: "structural",
            fields: ["priority"],
        });
    });

    it("classifies an issueType change as 'structural', naming 'issueType'", () => {
        assert.deepEqual(classifyIssueChange(issue({ issueType: StoryType.Story }), issue({ issueType: StoryType.Bug })), {
            severity: "structural",
            fields: ["issueType"],
        });
    });

    it("classifies an assignee change (by id) as 'structural', naming 'assignee'", () => {
        assert.deepEqual(classifyIssueChange(issue({ assignee: HUMAN_A }), issue({ assignee: HUMAN_B })), {
            severity: "structural",
            fields: ["assignee"],
        });
    });

    it("does not treat an assignee with the same id but a different displayName as changed", () => {
        const sameHumanRenamed: HumanRef = { id: HUMAN_A.id, displayName: "A Renamed" };
        assert.deepEqual(classifyIssueChange(issue({ assignee: HUMAN_A }), issue({ assignee: sameHumanRenamed })), {
            severity: "none",
            fields: [],
        });
    });

    it("classifies unassigned -> assigned (and back) as 'structural'", () => {
        assert.equal(classifyIssueChange(issue({ assignee: null }), issue({ assignee: HUMAN_A })).severity, "structural");
        assert.equal(classifyIssueChange(issue({ assignee: HUMAN_A }), issue({ assignee: null })).severity, "structural");
    });

    it("a structural change wins even when a content field ALSO changed, and names ONLY the structural field(s)", () => {
        // classifyIssueChange short-circuits on structural fields -- content isn't
        // separately reported once severity is already "structural" (matches the
        // BriefingChangeNote's own single-severity-per-issue shape).
        assert.deepEqual(
            classifyIssueChange(issue({ summary: "old", status: Status.ToDo }), issue({ summary: "new", status: Status.InProgress })),
            { severity: "structural", fields: ["status"] }
        );
    });

    it("names multiple structural fields together", () => {
        assert.deepEqual(
            classifyIssueChange(
                issue({ status: Status.ToDo, priority: "Low" }),
                issue({ status: Status.InProgress, priority: "High" })
            ),
            { severity: "structural", fields: ["status", "priority"] }
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

describe("combineFieldChange", () => {
    it("picks the more severe severity and unions the fields", () => {
        const a = { severity: "content" as const, fields: ["summary"] };
        const b = { severity: "structural" as const, fields: ["status"] };
        assert.deepEqual(combineFieldChange(a, b), { severity: "structural", fields: ["summary", "status"] });
    });

    it("deduplicates a field named on both sides", () => {
        const a = { severity: "structural" as const, fields: ["status"] };
        const b = { severity: "structural" as const, fields: ["status", "assignee"] };
        assert.deepEqual(combineFieldChange(a, b), { severity: "structural", fields: ["status", "assignee"] });
    });

    it("returns 'none'/[] when both sides are 'none'", () => {
        const none = { severity: "none" as const, fields: [] };
        assert.deepEqual(combineFieldChange(none, none), { severity: "none", fields: [] });
    });
});
