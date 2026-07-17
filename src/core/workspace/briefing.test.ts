import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { toIssueKey, toPageId, type DocStore, type Issue, type Page, type PageId, type WorkTracker } from "../storage/interface.js";
import { generateBriefing } from "./briefing.js";

function issue(overrides: Partial<Issue> = {}): Issue {
    return {
        key: toIssueKey("TAI-1"),
        projectKey: "TAI",
        issueType: SubtaskType.Dev,
        summary: "Do the thing",
        description: "Implementation details here.",
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

function page(id: string, title: string, content: string): Page {
    return {
        id: toPageId(id),
        spaceKey: "TA",
        title,
        content,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        comments: [],
    };
}

class FakeWorkTracker implements Partial<WorkTracker> {
    constructor(
        private readonly issues: Map<string, Issue>,
        private readonly linkedPages: Map<string, readonly PageId[]>
    ) {}
    async getIssue(key: string): Promise<Issue | null> {
        return this.issues.get(key) ?? null;
    }
    async getLinkedPages(key: string): Promise<readonly PageId[]> {
        return this.linkedPages.get(key) ?? [];
    }
}

class FakeDocStore implements Partial<DocStore> {
    constructor(private readonly pages: Map<string, Page>) {}
    async getPage(ref: { id: PageId } | { spaceKey: string; title: string }): Promise<Page | null> {
        if (!("id" in ref)) return null;
        return this.pages.get(ref.id) ?? null;
    }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-briefing-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("generateBriefing", () => {
    it("throws when the subtask itself doesn't exist", async () => {
        await withTempDir(async (dir) => {
            const tracker = new FakeWorkTracker(new Map(), new Map()) as unknown as WorkTracker;
            const docStore = new FakeDocStore(new Map()) as unknown as DocStore;
            await assert.rejects(() => generateBriefing(tracker, docStore, dir, "TAI", toIssueKey("TAI-1")));
        });
    });

    it("includes the subtask alone when there's no parent or linked pages", async () => {
        await withTempDir(async (dir) => {
            const tracker = new FakeWorkTracker(new Map([["TAI-1", issue()]]), new Map()) as unknown as WorkTracker;
            const docStore = new FakeDocStore(new Map()) as unknown as DocStore;
            const markdown = await generateBriefing(tracker, docStore, dir, "TAI", toIssueKey("TAI-1"));
            assert.match(markdown, /Subtask: TAI-1 — Do the thing/);
            assert.match(markdown, /Implementation details here\./);
            assert.doesNotMatch(markdown, /Parent:/);
        });
    });

    it("includes the immediate parent and pages linked to EITHER subtask or parent", async () => {
        await withTempDir(async (dir) => {
            const parent = issue({ key: toIssueKey("TAI-100"), issueType: StoryType.Story, summary: "The Story" });
            const subtask = issue({ parentKey: toIssueKey("TAI-100") });
            const issues = new Map([
                ["TAI-1", subtask],
                ["TAI-100", parent],
            ]);
            const linkedPages = new Map<string, readonly PageId[]>([
                ["TAI-1", [toPageId("1")]],
                ["TAI-100", [toPageId("2")]],
            ]);
            const pages = new Map([
                ["1", page("1", "Subtask Doc", "subtask doc content")],
                ["2", page("2", "Parent ADR", "parent adr content")],
            ]);

            const tracker = new FakeWorkTracker(issues, linkedPages) as unknown as WorkTracker;
            const docStore = new FakeDocStore(pages) as unknown as DocStore;
            const markdown = await generateBriefing(tracker, docStore, dir, "TAI", toIssueKey("TAI-1"));

            assert.match(markdown, /Subtask: TAI-1/);
            assert.match(markdown, /Parent: TAI-100 — The Story/);
            assert.match(markdown, /Subtask Doc/);
            assert.match(markdown, /subtask doc content/);
            assert.match(markdown, /Parent ADR/);
            assert.match(markdown, /parent adr content/);
        });
    });

    it("writes briefing.md to the .tai/work/<project>/<subtask>/ path", async () => {
        await withTempDir(async (dir) => {
            const tracker = new FakeWorkTracker(new Map([["TAI-1", issue()]]), new Map()) as unknown as WorkTracker;
            const docStore = new FakeDocStore(new Map()) as unknown as DocStore;
            await generateBriefing(tracker, docStore, dir, "TAI", toIssueKey("TAI-1"));
            const written = await readFile(path.join(dir, "work", "TAI", "TAI-1", "briefing.md"), "utf8");
            assert.match(written, /Do the thing/);
        });
    });
});
