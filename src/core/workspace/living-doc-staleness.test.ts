import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Status, StoryType } from "../schema/story-schema.js";
import { toIssueKey, type Issue } from "../storage/interface.js";
import {
    computeEpicSummary,
    diffLivingDocSnapshot,
    readLivingDocSnapshot,
    writeLivingDocSnapshot,
    type EpicSummary,
    type LivingDocSnapshot,
} from "./living-doc-staleness.js";

function issue(overrides: Partial<Issue> = {}): Issue {
    return {
        key: toIssueKey("TAI-1"),
        projectKey: "TAI",
        issueType: "epic",
        summary: "An epic",
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

function child(status: Status): Issue {
    return issue({ issueType: StoryType.Story, status, key: toIssueKey(`TAI-child-${Math.random()}`) });
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-living-doc-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("computeEpicSummary", () => {
    it("tallies Done and Canceled children as done, other statuses as not done", () => {
        const epic = issue({ key: toIssueKey("TAI-6"), status: Status.InProgress });
        const children = [child(Status.Done), child(Status.Canceled), child(Status.InProgress), child(Status.ToDo)];

        const summary = computeEpicSummary(epic, children);

        assert.deepEqual(summary, { epicKey: toIssueKey("TAI-6"), status: Status.InProgress, childTotal: 4, childDone: 2 });
    });

    it("zero children is a valid summary, not an error", () => {
        const epic = issue({ key: toIssueKey("TAI-6") });
        assert.deepEqual(computeEpicSummary(epic, []), {
            epicKey: toIssueKey("TAI-6"),
            status: Status.InProgress,
            childTotal: 0,
            childDone: 0,
        });
    });
});

describe("diffLivingDocSnapshot", () => {
    const base: EpicSummary = { epicKey: toIssueKey("TAI-6"), status: Status.InProgress, childTotal: 3, childDone: 1 };

    it("no prior snapshot at all yields no findings -- absence isn't a staleness signal", () => {
        assert.deepEqual(diffLivingDocSnapshot([base], null), []);
    });

    it("nothing changed since the snapshot yields no findings", () => {
        const snapshot: LivingDocSnapshot = { generatedAt: "2026-01-01T00:00:00Z", epics: [base] };
        assert.deepEqual(diffLivingDocSnapshot([base], snapshot), []);
    });

    it("a status change is flagged with the old and new status", () => {
        const snapshot: LivingDocSnapshot = { generatedAt: "2026-01-01T00:00:00Z", epics: [base] };
        const current: EpicSummary = { ...base, status: Status.Done };

        assert.deepEqual(diffLivingDocSnapshot([current], snapshot), [
            { epicKey: base.epicKey, reason: "status: In Progress → Done" },
        ]);
    });

    it("a child-tally change is flagged even when status itself didn't move", () => {
        const snapshot: LivingDocSnapshot = { generatedAt: "2026-01-01T00:00:00Z", epics: [base] };
        const current: EpicSummary = { ...base, childDone: 3 };

        assert.deepEqual(diffLivingDocSnapshot([current], snapshot), [
            { epicKey: base.epicKey, reason: "1/3 → 3/3 stories done" },
        ]);
    });

    it("an Epic missing from the snapshot entirely is flagged as not yet on the page", () => {
        const snapshot: LivingDocSnapshot = { generatedAt: "2026-01-01T00:00:00Z", epics: [] };
        assert.deepEqual(diffLivingDocSnapshot([base], snapshot), [{ epicKey: base.epicKey, reason: "not yet on the page" }]);
    });

    it("only the Epics that actually moved are returned, not the whole set", () => {
        const unchanged: EpicSummary = { epicKey: toIssueKey("TAI-7"), status: Status.ToDo, childTotal: 0, childDone: 0 };
        const snapshot: LivingDocSnapshot = { generatedAt: "2026-01-01T00:00:00Z", epics: [base, unchanged] };
        const currentChanged: EpicSummary = { ...base, status: Status.Done };

        assert.deepEqual(diffLivingDocSnapshot([currentChanged, unchanged], snapshot), [
            { epicKey: base.epicKey, reason: "status: In Progress → Done" },
        ]);
    });
});

describe("writeLivingDocSnapshot / readLivingDocSnapshot", () => {
    it("round-trips a snapshot", async () => {
        await withTempDir(async (dir) => {
            const epics: readonly EpicSummary[] = [{ epicKey: toIssueKey("TAI-6"), status: Status.InProgress, childTotal: 2, childDone: 1 }];
            await writeLivingDocSnapshot(dir, "TAI", "project-home", epics);

            const read = await readLivingDocSnapshot(dir, "TAI", "project-home");
            assert.ok(read);
            assert.deepEqual(read.epics, epics);
        });
    });

    it("returns null when nothing has ever been snapshotted", async () => {
        await withTempDir(async (dir) => {
            assert.equal(await readLivingDocSnapshot(dir, "TAI", "project-home"), null);
        });
    });

    it("different output types under the same project don't collide", async () => {
        await withTempDir(async (dir) => {
            await writeLivingDocSnapshot(dir, "TAI", "project-home", [
                { epicKey: toIssueKey("TAI-6"), status: Status.InProgress, childTotal: 1, childDone: 0 },
            ]);
            assert.equal(await readLivingDocSnapshot(dir, "TAI", "architecture-overview"), null);
        });
    });
});
