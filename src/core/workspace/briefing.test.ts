import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DependencyRelation, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { toIssueKey, toPageId, type DocStore, type Issue, type IssueLink, type Page, type PageId, type RemoteLink, type WorkTracker } from "../storage/interface.js";
import { BRIEFING_BUDGET, briefingBudgetFromEnv, generateBriefing } from "./briefing.js";

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
        private readonly linkedPages: Map<string, readonly PageId[]>,
        private readonly linkedIssues: Map<string, readonly IssueLink[]> = new Map(),
        private readonly remoteLinks: Map<string, readonly RemoteLink[]> = new Map()
    ) {}
    async getRemoteLinks(key: string): Promise<readonly RemoteLink[]> {
        return this.remoteLinks.get(key) ?? [];
    }
    async getIssue(key: string): Promise<Issue | null> {
        return this.issues.get(key) ?? null;
    }
    async getLinkedPages(key: string): Promise<readonly PageId[]> {
        return this.linkedPages.get(key) ?? [];
    }
    async getLinkedIssues(key: string, relation?: DependencyRelation, direction?: "outgoing" | "incoming"): Promise<readonly IssueLink[]> {
        // FakeWorkTracker only stores outgoing links per key (mirrors how the real
        // backends are exercised here) — incoming isn't used by generateBriefing.
        if (direction === "incoming") return [];
        const links = this.linkedIssues.get(key) ?? [];
        return relation ? links.filter((l) => l.relation === relation) : links;
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
            const { markdown } = await generateBriefing(tracker, docStore, dir, "TAI", toIssueKey("TAI-1"));
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
            const { markdown } = await generateBriefing(tracker, docStore, dir, "TAI", toIssueKey("TAI-1"));

            assert.match(markdown, /Subtask: TAI-1/);
            assert.match(markdown, /Parent: TAI-100 — The Story/);
            assert.match(markdown, /Subtask Doc/);
            assert.match(markdown, /subtask doc content/);
            assert.match(markdown, /Parent ADR/);
            assert.match(markdown, /parent adr content/);
        });
    });

    it("includes tickets linked to the subtask, with full parity and a relation label", async () => {
        await withTempDir(async (dir) => {
            const subtask = issue();
            const relatesTo = issue({ key: toIssueKey("TAI-200"), issueType: StoryType.Story, summary: "Related work", description: "Related content." });
            const issues = new Map([
                ["TAI-1", subtask],
                ["TAI-200", relatesTo],
            ]);
            const linkedIssues = new Map<string, readonly IssueLink[]>([
                ["TAI-1", [{ relation: DependencyRelation.RelatesTo, key: toIssueKey("TAI-200") }]],
            ]);

            const tracker = new FakeWorkTracker(issues, new Map(), linkedIssues) as unknown as WorkTracker;
            const docStore = new FakeDocStore(new Map()) as unknown as DocStore;
            const { markdown } = await generateBriefing(tracker, docStore, dir, "TAI", toIssueKey("TAI-1"));

            assert.match(markdown, /## Linked Tickets/);
            assert.match(markdown, /### Relates to: TAI-200 — Related work/);
            assert.match(markdown, /Related content\./);
        });
    });

    it("labels a DependsOn-linked ticket distinctly from RelatesTo", async () => {
        await withTempDir(async (dir) => {
            const subtask = issue();
            const dependsOn = issue({ key: toIssueKey("TAI-201"), issueType: StoryType.Story, summary: "Blocking work" });
            const issues = new Map([
                ["TAI-1", subtask],
                ["TAI-201", dependsOn],
            ]);
            const linkedIssues = new Map<string, readonly IssueLink[]>([
                ["TAI-1", [{ relation: DependencyRelation.DependsOn, key: toIssueKey("TAI-201") }]],
            ]);

            const tracker = new FakeWorkTracker(issues, new Map(), linkedIssues) as unknown as WorkTracker;
            const docStore = new FakeDocStore(new Map()) as unknown as DocStore;
            const { markdown } = await generateBriefing(tracker, docStore, dir, "TAI", toIssueKey("TAI-1"));

            assert.match(markdown, /### Depends on: TAI-201 — Blocking work/);
        });
    });

    it("renders a ticket linked via both relations once, with both labels", async () => {
        await withTempDir(async (dir) => {
            const subtask = issue();
            const both = issue({ key: toIssueKey("TAI-202"), issueType: StoryType.Story, summary: "Both relations" });
            const issues = new Map([
                ["TAI-1", subtask],
                ["TAI-202", both],
            ]);
            const linkedIssues = new Map<string, readonly IssueLink[]>([
                [
                    "TAI-1",
                    [
                        { relation: DependencyRelation.RelatesTo, key: toIssueKey("TAI-202") },
                        { relation: DependencyRelation.DependsOn, key: toIssueKey("TAI-202") },
                    ],
                ],
            ]);

            const tracker = new FakeWorkTracker(issues, new Map(), linkedIssues) as unknown as WorkTracker;
            const docStore = new FakeDocStore(new Map()) as unknown as DocStore;
            const { markdown } = await generateBriefing(tracker, docStore, dir, "TAI", toIssueKey("TAI-1"));

            assert.match(markdown, /### Depends on, Relates to: TAI-202 — Both relations/);
            assert.equal(markdown.match(/TAI-202/g)?.length, 1);
        });
    });

    it("reads linked tickets from both the subtask AND the immediate parent, unioned", async () => {
        await withTempDir(async (dir) => {
            const parent = issue({ key: toIssueKey("TAI-100"), issueType: StoryType.Story, summary: "The Story" });
            const subtask = issue({ parentKey: toIssueKey("TAI-100") });
            const viaSubtask = issue({ key: toIssueKey("TAI-300"), issueType: StoryType.Story, summary: "Via subtask" });
            const viaParent = issue({ key: toIssueKey("TAI-301"), issueType: StoryType.Story, summary: "Via parent" });
            const issues = new Map([
                ["TAI-1", subtask],
                ["TAI-100", parent],
                ["TAI-300", viaSubtask],
                ["TAI-301", viaParent],
            ]);
            const linkedIssues = new Map<string, readonly IssueLink[]>([
                ["TAI-1", [{ relation: DependencyRelation.RelatesTo, key: toIssueKey("TAI-300") }]],
                ["TAI-100", [{ relation: DependencyRelation.RelatesTo, key: toIssueKey("TAI-301") }]],
            ]);

            const tracker = new FakeWorkTracker(issues, new Map(), linkedIssues) as unknown as WorkTracker;
            const docStore = new FakeDocStore(new Map()) as unknown as DocStore;
            const { markdown } = await generateBriefing(tracker, docStore, dir, "TAI", toIssueKey("TAI-1"));

            assert.match(markdown, /Via subtask/);
            assert.match(markdown, /Via parent/);
        });
    });

    it("excludes the subtask and parent themselves from Linked Tickets even if returned as links", async () => {
        await withTempDir(async (dir) => {
            const parent = issue({ key: toIssueKey("TAI-100"), issueType: StoryType.Story, summary: "The Story" });
            const subtask = issue({ parentKey: toIssueKey("TAI-100") });
            const issues = new Map([
                ["TAI-1", subtask],
                ["TAI-100", parent],
            ]);
            const linkedIssues = new Map<string, readonly IssueLink[]>([
                ["TAI-1", [{ relation: DependencyRelation.RelatesTo, key: toIssueKey("TAI-100") }]],
                ["TAI-100", [{ relation: DependencyRelation.RelatesTo, key: toIssueKey("TAI-1") }]],
            ]);

            const tracker = new FakeWorkTracker(issues, new Map(), linkedIssues) as unknown as WorkTracker;
            const docStore = new FakeDocStore(new Map()) as unknown as DocStore;
            const { markdown } = await generateBriefing(tracker, docStore, dir, "TAI", toIssueKey("TAI-1"));

            assert.doesNotMatch(markdown, /## Linked Tickets/);
        });
    });

    it("unions a linked ticket's own linked Confluence pages into Linked Confluence pages", async () => {
        await withTempDir(async (dir) => {
            const subtask = issue();
            const linked = issue({ key: toIssueKey("TAI-400"), issueType: StoryType.Spike, summary: "A Spike with its own ADR" });
            const issues = new Map([
                ["TAI-1", subtask],
                ["TAI-400", linked],
            ]);
            const linkedIssues = new Map<string, readonly IssueLink[]>([
                ["TAI-1", [{ relation: DependencyRelation.RelatesTo, key: toIssueKey("TAI-400") }]],
            ]);
            const linkedPages = new Map<string, readonly PageId[]>([["TAI-400", [toPageId("9")]]]);
            const pages = new Map([["9", page("9", "TAI-400 — ADR", "adr content from the linked ticket")]]);

            const tracker = new FakeWorkTracker(issues, linkedPages, linkedIssues) as unknown as WorkTracker;
            const docStore = new FakeDocStore(pages) as unknown as DocStore;
            const { markdown } = await generateBriefing(tracker, docStore, dir, "TAI", toIssueKey("TAI-1"));

            assert.match(markdown, /## Linked Confluence pages/);
            assert.match(markdown, /adr content from the linked ticket/);
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

describe("generateBriefing change notes (TAI-285 ADR)", () => {
    const docStore = new FakeDocStore(new Map()) as unknown as DocStore;

    it("no change notes on the very first briefing -- nothing to have changed from", async () => {
        await withTempDir(async (dir) => {
            const tracker = new FakeWorkTracker(new Map([["TAI-1", issue()]]), new Map()) as unknown as WorkTracker;
            const { changeNotes } = await generateBriefing(tracker, docStore, dir, "TAI", toIssueKey("TAI-1"));
            assert.deepEqual(changeNotes, []);
        });
    });

    it("no change notes when nothing actually changed between two briefings", async () => {
        await withTempDir(async (dir) => {
            await generateBriefing(
                new FakeWorkTracker(new Map([["TAI-1", issue()]]), new Map()) as unknown as WorkTracker,
                docStore,
                dir,
                "TAI",
                toIssueKey("TAI-1")
            );
            const { changeNotes } = await generateBriefing(
                new FakeWorkTracker(new Map([["TAI-1", issue()]]), new Map()) as unknown as WorkTracker,
                docStore,
                dir,
                "TAI",
                toIssueKey("TAI-1")
            );
            assert.deepEqual(changeNotes, []);
        });
    });

    it("a summary/description-only change is reported as 'content'", async () => {
        await withTempDir(async (dir) => {
            await generateBriefing(
                new FakeWorkTracker(new Map([["TAI-1", issue()]]), new Map()) as unknown as WorkTracker,
                docStore,
                dir,
                "TAI",
                toIssueKey("TAI-1")
            );
            const changed = issue({ description: "New requirement content.", updatedAt: "2026-02-01T00:00:00Z" });
            const { changeNotes } = await generateBriefing(
                new FakeWorkTracker(new Map([["TAI-1", changed]]), new Map()) as unknown as WorkTracker,
                docStore,
                dir,
                "TAI",
                toIssueKey("TAI-1")
            );
            assert.deepEqual(changeNotes, [{ key: toIssueKey("TAI-1"), severity: "content", fields: ["description"] }]);
        });
    });

    it("a status change is reported as 'structural'", async () => {
        await withTempDir(async (dir) => {
            await generateBriefing(
                new FakeWorkTracker(new Map([["TAI-1", issue()]]), new Map()) as unknown as WorkTracker,
                docStore,
                dir,
                "TAI",
                toIssueKey("TAI-1")
            );
            const changed = issue({ status: Status.InReview, updatedAt: "2026-02-01T00:00:00Z" });
            const { changeNotes } = await generateBriefing(
                new FakeWorkTracker(new Map([["TAI-1", changed]]), new Map()) as unknown as WorkTracker,
                docStore,
                dir,
                "TAI",
                toIssueKey("TAI-1")
            );
            assert.deepEqual(changeNotes, [{ key: toIssueKey("TAI-1"), severity: "structural", fields: ["status"] }]);
        });
    });

    it("tracks the subtask and parent independently, both can carry their own change note", async () => {
        await withTempDir(async (dir) => {
            const parent = issue({ key: toIssueKey("TAI-100"), issueType: StoryType.Story, summary: "The Story" });
            const subtask = issue({ parentKey: toIssueKey("TAI-100") });
            await generateBriefing(
                new FakeWorkTracker(
                    new Map([
                        ["TAI-1", subtask],
                        ["TAI-100", parent],
                    ]),
                    new Map()
                ) as unknown as WorkTracker,
                docStore,
                dir,
                "TAI",
                toIssueKey("TAI-1")
            );

            const changedSubtask = { ...subtask, description: "Changed.", updatedAt: "2026-02-01T00:00:00Z" };
            const changedParent = { ...parent, status: Status.InReview, updatedAt: "2026-02-01T00:00:00Z" };
            const { changeNotes } = await generateBriefing(
                new FakeWorkTracker(
                    new Map([
                        ["TAI-1", changedSubtask],
                        ["TAI-100", changedParent],
                    ]),
                    new Map()
                ) as unknown as WorkTracker,
                docStore,
                dir,
                "TAI",
                toIssueKey("TAI-1")
            );

            assert.equal(changeNotes.length, 2);
            assert.deepEqual(
                changeNotes.find((n) => n.key === toIssueKey("TAI-1")),
                { key: toIssueKey("TAI-1"), severity: "content", fields: ["description"] }
            );
            assert.deepEqual(
                changeNotes.find((n) => n.key === toIssueKey("TAI-100")),
                { key: toIssueKey("TAI-100"), severity: "structural", fields: ["status"] }
            );
        });
    });

    it("a LINKED ticket's content changing does NOT produce a change note -- scope is subtask+parent only (decision 4)", async () => {
        await withTempDir(async (dir) => {
            const subtask = issue();
            const linked = issue({ key: toIssueKey("TAI-200"), issueType: StoryType.Story, summary: "Linked" });
            const linkedIssues = new Map<string, readonly IssueLink[]>([
                ["TAI-1", [{ relation: DependencyRelation.RelatesTo, key: toIssueKey("TAI-200") }]],
            ]);
            await generateBriefing(
                new FakeWorkTracker(
                    new Map([
                        ["TAI-1", subtask],
                        ["TAI-200", linked],
                    ]),
                    new Map(),
                    linkedIssues
                ) as unknown as WorkTracker,
                docStore,
                dir,
                "TAI",
                toIssueKey("TAI-1")
            );

            const changedLinked = { ...linked, description: "Now has different content.", updatedAt: "2026-02-01T00:00:00Z" };
            const { changeNotes } = await generateBriefing(
                new FakeWorkTracker(
                    new Map([
                        ["TAI-1", subtask],
                        ["TAI-200", changedLinked],
                    ]),
                    new Map(),
                    linkedIssues
                ) as unknown as WorkTracker,
                docStore,
                dir,
                "TAI",
                toIssueKey("TAI-1")
            );

            assert.deepEqual(changeNotes, []);
        });
    });

    it("a relationship (link) change on the subtask is reported as 'structural', even with no Issue field changed at all (decision 3b)", async () => {
        await withTempDir(async (dir) => {
            const subtask = issue();
            const targetA = issue({ key: toIssueKey("TAI-200"), issueType: StoryType.Story, summary: "A" });
            const targetB = issue({ key: toIssueKey("TAI-201"), issueType: StoryType.Story, summary: "B" });

            await generateBriefing(
                new FakeWorkTracker(
                    new Map([
                        ["TAI-1", subtask],
                        ["TAI-200", targetA],
                    ]),
                    new Map(),
                    new Map([["TAI-1", [{ relation: DependencyRelation.RelatesTo, key: toIssueKey("TAI-200") }]]])
                ) as unknown as WorkTracker,
                docStore,
                dir,
                "TAI",
                toIssueKey("TAI-1")
            );

            // Same subtask, byte-identical -- only its outgoing RelatesTo link changed.
            const { changeNotes } = await generateBriefing(
                new FakeWorkTracker(
                    new Map([
                        ["TAI-1", subtask],
                        ["TAI-200", targetA],
                        ["TAI-201", targetB],
                    ]),
                    new Map(),
                    new Map([["TAI-1", [{ relation: DependencyRelation.RelatesTo, key: toIssueKey("TAI-201") }]]])
                ) as unknown as WorkTracker,
                docStore,
                dir,
                "TAI",
                toIssueKey("TAI-1")
            );

            assert.deepEqual(changeNotes, [{ key: toIssueKey("TAI-1"), severity: "structural", fields: ["relationship"] }]);
        });
    });
});

describe("generateBriefing: remote links and budget (TAI-464)", () => {
    it("reads the remote links of the subtask and the parent, not of a linked ticket", async () => {
        await withTempDir(async (dir) => {
            const parent = issue({ key: toIssueKey("TAI-1"), issueType: StoryType.Story });
            const subtask = issue({ key: toIssueKey("TAI-2"), parentKey: parent.key });
            const linked = issue({ key: toIssueKey("TAI-9") });
            const tracker = new FakeWorkTracker(
                new Map([
                    [parent.key, parent],
                    [subtask.key, subtask],
                    [linked.key, linked],
                ]),
                new Map(),
                new Map([[subtask.key, [{ key: linked.key, relation: DependencyRelation.RelatesTo }]]]),
                new Map([
                    [subtask.key, [{ url: "https://example.com/pr/7", title: "PR 7" }]],
                    [parent.key, [{ url: "https://example.com/spec", title: "Spec" }]],
                    [linked.key, [{ url: "https://example.com/other", title: "Other" }]],
                ])
            ) as unknown as WorkTracker;
            const docStore = new FakeDocStore(new Map()) as unknown as DocStore;
            const { markdown } = await generateBriefing(tracker, docStore, dir, "TAI", subtask.key);
            assert.ok(markdown.includes("- PR 7 — https://example.com/pr/7"), markdown);
            assert.ok(markdown.includes("- Spec — https://example.com/spec"));
            assert.ok(!markdown.includes("https://example.com/other"));
        });
    });

    it("passes the budget through to the rendered file", async () => {
        await withTempDir(async (dir) => {
            const subtask = issue({ key: toIssueKey("TAI-2") });
            const tracker = new FakeWorkTracker(new Map([[subtask.key, subtask]]), new Map([[subtask.key, [toPageId("5")]]])) as unknown as WorkTracker;
            const docStore = new FakeDocStore(new Map([["5", page("5", "Long", "x".repeat(20_000))]])) as unknown as DocStore;
            const { markdown } = await generateBriefing(tracker, docStore, dir, "TAI", subtask.key, { budget: 5_000 });
            assert.ok(markdown.length <= 5_000);
            assert.ok(markdown.includes("Read the rest with `page get id=5`"));
        });
    });

    it("reads TAI_BRIEFING_BUDGET, falling back to the default on anything unusable", () => {
        assert.equal(briefingBudgetFromEnv({ TAI_BRIEFING_BUDGET: "20000" }), 20_000);
        assert.equal(briefingBudgetFromEnv({}), BRIEFING_BUDGET);
        assert.equal(briefingBudgetFromEnv({ TAI_BRIEFING_BUDGET: "lots" }), BRIEFING_BUDGET);
        assert.equal(briefingBudgetFromEnv({ TAI_BRIEFING_BUDGET: "-5" }), BRIEFING_BUDGET);
    });
});
