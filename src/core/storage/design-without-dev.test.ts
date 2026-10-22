import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { findDesignWithoutDev, isDevDismissal } from "./design-without-dev.js";
import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import type { Issue, IssueFilter, IssueKey } from "./interface.js";

const issue = (key: string, issueType: string, status: Status, parentKey?: string, comments: string[] = []): Issue =>
    ({
        key: key as IssueKey,
        issueType,
        status,
        parentKey: parentKey as IssueKey | undefined,
        summary: key,
        comments: comments.map((body, i) => ({ id: String(i), body })),
    }) as unknown as Issue;

function tracker(issues: readonly Issue[]) {
    return {
        search: async (f: IssueFilter) =>
            issues.filter(
                (i) =>
                    (!f.issueTypes || f.issueTypes.includes(i.issueType as never)) &&
                    (!f.statuses || f.statuses.includes(i.status)) &&
                    (!f.parentKey || i.parentKey === f.parentKey)
            ),
    };
}

describe("findDesignWithoutDev (TAI-602)", () => {
    it("flags a Done Database subtask whose open Story has no Dev", async () => {
        const t = tracker([issue("P-1", StoryType.Story, Status.InProgress), issue("P-2", SubtaskType.Database, Status.Done, "P-1")]);
        const found = await findDesignWithoutDev(t, "P");
        assert.deepEqual(found.map((f) => [f.design.key, f.story.key]), [["P-2", "P-1"]]);
    });

    it("flags a Done ArchitectureDesign subtask too", async () => {
        const t = tracker([issue("P-1", StoryType.Story, Status.InProgress), issue("P-2", SubtaskType.ArchitectureDesign, Status.Done, "P-1")]);
        assert.equal((await findDesignWithoutDev(t, "P")).length, 1);
    });

    it("does not flag a design subtask that is not Done", async () => {
        const t = tracker([issue("P-1", StoryType.Story, Status.InProgress), issue("P-2", SubtaskType.Database, Status.InProgress, "P-1")]);
        assert.deepEqual(await findDesignWithoutDev(t, "P"), []);
    });

    it("does not flag when a Dev exists under the Story, even a Backlog one", async () => {
        const t = tracker([
            issue("P-1", StoryType.Story, Status.InProgress),
            issue("P-2", SubtaskType.Database, Status.Done, "P-1"),
            issue("P-3", SubtaskType.Dev, Status.Backlog, "P-1"),
        ]);
        assert.deepEqual(await findDesignWithoutDev(t, "P"), []);
    });

    it("a canceled Dev does not count", async () => {
        const t = tracker([
            issue("P-1", StoryType.Story, Status.InProgress),
            issue("P-2", SubtaskType.Database, Status.Done, "P-1"),
            issue("P-3", SubtaskType.Dev, Status.Canceled, "P-1"),
        ]);
        assert.equal((await findDesignWithoutDev(t, "P")).length, 1);
    });

    it("does not flag when a sibling Story under the same Epic has a Dev", async () => {
        const t = tracker([
            issue("P-1", "epic", Status.InProgress),
            issue("P-2", StoryType.Story, Status.InProgress, "P-1"),
            issue("P-3", StoryType.Story, Status.InProgress, "P-1"),
            issue("P-4", SubtaskType.Database, Status.Done, "P-2"),
            issue("P-5", SubtaskType.Dev, Status.ToDo, "P-3"),
        ]);
        assert.deepEqual(await findDesignWithoutDev(t, "P"), []);
    });

    it("flags when the Epic has Stories but none has a Dev", async () => {
        const t = tracker([
            issue("P-1", "epic", Status.InProgress),
            issue("P-2", StoryType.Story, Status.InProgress, "P-1"),
            issue("P-3", StoryType.Story, Status.InProgress, "P-1"),
            issue("P-4", SubtaskType.Database, Status.Done, "P-2"),
        ]);
        assert.equal((await findDesignWithoutDev(t, "P")).length, 1);
    });

    it("skips a design subtask whose Story is already Done or Canceled", async () => {
        const t = tracker([
            issue("P-1", StoryType.Story, Status.Done),
            issue("P-2", SubtaskType.Database, Status.Done, "P-1"),
            issue("P-3", StoryType.Story, Status.Canceled),
            issue("P-4", SubtaskType.Database, Status.Done, "P-3"),
        ]);
        assert.deepEqual(await findDesignWithoutDev(t, "P"), []);
    });

    it("flags a Done UxDesign subtask too", async () => {
        const t = tracker([issue("P-1", StoryType.Story, Status.InProgress), issue("P-2", SubtaskType.UxDesign, Status.Done, "P-1")]);
        assert.equal((await findDesignWithoutDev(t, "P")).length, 1);
    });

    it("skips a design subtask carrying a 'No Dev needed:' comment, the dismissal", async () => {
        const t = tracker([
            issue("P-1", StoryType.Story, Status.InProgress),
            issue("P-2", SubtaskType.ArchitectureDesign, Status.Done, "P-1", ["Handoff: done", "No Dev needed: decision-only ADR"]),
        ]);
        assert.deepEqual(await findDesignWithoutDev(t, "P"), []);
    });

    it("a dismissal on one design subtask leaves another on the same Story listed", async () => {
        const t = tracker([
            issue("P-1", StoryType.Story, Status.InProgress),
            issue("P-2", SubtaskType.ArchitectureDesign, Status.Done, "P-1", ["No Dev needed: decision only"]),
            issue("P-3", SubtaskType.Database, Status.Done, "P-1"),
        ]);
        assert.deepEqual((await findDesignWithoutDev(t, "P")).map((f) => f.design.key), ["P-3"]);
    });

    it("reads no per-subtask parent: one open-Stories search, however many design subtasks", async () => {
        const issues = [issue("P-1", StoryType.Story, Status.InProgress)];
        for (let n = 0; n < 5; n++) issues.push(issue(`P-1${n}`, SubtaskType.Database, Status.Done, "P-1"));
        const base = tracker(issues);
        let searches = 0;
        const t = { search: async (f: IssueFilter) => (searches++, base.search(f)) };
        await findDesignWithoutDev(t, "P");
        assert.equal(searches, 3, "designs, open Stories, Devs");
    });
});

describe("isDevDismissal (TAI-605)", () => {
    const c = (body: string) => [{ id: "1", body }] as never;

    it("matches on the first line only, in any case", () => {
        assert.ok(isDevDismissal(c("No Dev needed: decision-only")));
        assert.ok(isDevDismissal(c("  no dev needed:x")));
        assert.ok(!isDevDismissal(c("Handoff: no Dev needed: later")));
        assert.ok(!isDevDismissal(c("First line\nNo Dev needed: yes")));
        assert.ok(!isDevDismissal(c("No Dev needed")));
    });
});
