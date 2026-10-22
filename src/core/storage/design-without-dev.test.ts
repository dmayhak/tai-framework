import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { findDesignWithoutDev } from "./design-without-dev.js";
import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import type { Issue, IssueFilter, IssueKey } from "./interface.js";

const issue = (key: string, issueType: string, status: Status, parentKey?: string): Issue =>
    ({ key: key as IssueKey, issueType, status, parentKey: parentKey as IssueKey | undefined, summary: key, comments: [] }) as unknown as Issue;

function tracker(issues: readonly Issue[]) {
    return {
        search: async (f: IssueFilter) =>
            issues.filter(
                (i) =>
                    (!f.issueTypes || f.issueTypes.includes(i.issueType as never)) &&
                    (!f.statuses || f.statuses.includes(i.status)) &&
                    (!f.parentKey || i.parentKey === f.parentKey)
            ),
        getIssue: async (key: IssueKey) => issues.find((i) => i.key === key) ?? null,
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
});
