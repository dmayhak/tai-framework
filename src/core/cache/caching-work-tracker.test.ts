import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Status, StoryType } from "../schema/story-schema.js";
import {
    toIssueKey,
    type Comment,
    type CreateIssueInput,
    type HumanRef,
    type Issue,
    type IssueKey,
    type IssuePatch,
    type MutationResult,
    type WorkTracker,
} from "../storage/interface.js";
import { readCachedIssue } from "./issue-cache.js";
import { CachingWorkTracker } from "./caching-work-tracker.js";

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

/** A minimal scriptable fake -- each mutation method returns whatever this test wired up,
 *  recording every call so a test can prove pass-through methods delegate untouched. */
class FakeWorkTracker implements Partial<WorkTracker> {
    readonly calls: string[] = [];
    constructor(
        private readonly updateIssueResult: Issue | Error = issue(),
        private readonly transitionResult: MutationResult = { ok: true, issue: issue() },
        private readonly assignIssueResult: MutationResult = { ok: true, issue: issue() }
    ) {}

    async updateIssue(key: IssueKey, _patch: IssuePatch): Promise<Issue> {
        this.calls.push(`updateIssue(${key})`);
        if (this.updateIssueResult instanceof Error) throw this.updateIssueResult;
        return this.updateIssueResult;
    }
    async transition(key: IssueKey): Promise<MutationResult> {
        this.calls.push(`transition(${key})`);
        return this.transitionResult;
    }
    async assignIssue(key: IssueKey): Promise<MutationResult> {
        this.calls.push(`assignIssue(${key})`);
        return this.assignIssueResult;
    }
    async getIssue(): Promise<Issue | null> {
        this.calls.push("getIssue");
        return null;
    }
    async createIssue(_input: CreateIssueInput): Promise<Issue> {
        this.calls.push("createIssue");
        throw new Error("not used in these tests");
    }
    async resolveHuman(): Promise<HumanRef | null> {
        this.calls.push("resolveHuman");
        return null;
    }
    async addComment(): Promise<Comment> {
        this.calls.push("addComment");
        throw new Error("not used in these tests");
    }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-caching-work-tracker-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("CachingWorkTracker", () => {
    it("updateIssue: caches the returned issue", async () => {
        await withTempDir(async (dir) => {
            const inner = new FakeWorkTracker(issue({ summary: "Updated" }));
            const caching = new CachingWorkTracker(inner as unknown as WorkTracker, dir, "TAI");
            const result = await caching.updateIssue(toIssueKey("TAI-1"), {});
            assert.equal(result.summary, "Updated");
            assert.equal((await readCachedIssue(dir, "TAI", "TAI-1"))?.summary, "Updated");
        });
    });

    it("transition: caches the primary issue on success", async () => {
        await withTempDir(async (dir) => {
            const inner = new FakeWorkTracker(undefined, { ok: true, issue: issue({ status: Status.Done }) });
            const caching = new CachingWorkTracker(inner as unknown as WorkTracker, dir, "TAI");
            await caching.transition(toIssueKey("TAI-1"), Status.Done);
            assert.equal((await readCachedIssue(dir, "TAI", "TAI-1"))?.status, Status.Done);
        });
    });

    it("transition: also caches every cascade-affected issue (TAI-304/311 ADR)", async () => {
        await withTempDir(async (dir) => {
            const parent = issue({ key: toIssueKey("TAI-0"), status: Status.InProgress });
            const child = issue({ key: toIssueKey("TAI-2"), status: Status.Canceled });
            const inner = new FakeWorkTracker(undefined, {
                ok: true,
                issue: issue({ status: Status.Done }),
                affectedIssues: [parent, child],
            });
            const caching = new CachingWorkTracker(inner as unknown as WorkTracker, dir, "TAI");
            await caching.transition(toIssueKey("TAI-1"), Status.Done);
            assert.equal((await readCachedIssue(dir, "TAI", "TAI-1"))?.status, Status.Done);
            assert.equal((await readCachedIssue(dir, "TAI", "TAI-0"))?.status, Status.InProgress);
            assert.equal((await readCachedIssue(dir, "TAI", "TAI-2"))?.status, Status.Canceled);
        });
    });

    it("transition: caches nothing on rejection", async () => {
        await withTempDir(async (dir) => {
            const inner = new FakeWorkTracker(undefined, { ok: false, reason: "denied" });
            const caching = new CachingWorkTracker(inner as unknown as WorkTracker, dir, "TAI");
            const result = await caching.transition(toIssueKey("TAI-1"), Status.Done);
            assert.equal(result.ok, false);
            assert.equal(await readCachedIssue(dir, "TAI", "TAI-1"), null);
        });
    });

    it("assignIssue: caches the returned issue on success, nothing on rejection", async () => {
        await withTempDir(async (dir) => {
            const inner = new FakeWorkTracker(undefined, undefined, { ok: true, issue: issue({ summary: "Assigned" }) });
            const caching = new CachingWorkTracker(inner as unknown as WorkTracker, dir, "TAI");
            await caching.assignIssue(toIssueKey("TAI-1"), null);
            assert.equal((await readCachedIssue(dir, "TAI", "TAI-1"))?.summary, "Assigned");
        });
    });

    it("passes every other method straight through to the inner tracker", async () => {
        await withTempDir(async (dir) => {
            const inner = new FakeWorkTracker();
            const caching = new CachingWorkTracker(inner as unknown as WorkTracker, dir, "TAI");
            await caching.getIssue(toIssueKey("TAI-1"));
            await caching.resolveHuman("a@x.test");
            assert.deepEqual(inner.calls, ["getIssue", "resolveHuman"]);
        });
    });
});
