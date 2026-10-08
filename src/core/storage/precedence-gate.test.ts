import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import type { Issue, IssueKey } from "./interface.js";
import { openPrerequisites, precedenceGateApplies, precedenceGateReason, precedenceOverrideComment } from "./precedence-gate.js";

let n = 0;
function subtask(issueType: SubtaskType, status: Status): Issue {
    n += 1;
    return { key: `T-${n}` as IssueKey, issueType, status, parentKey: "T-0" as IssueKey } as Issue;
}
const story = { issueType: StoryType.Story } as const;
const keys = (issues: readonly Issue[]) => issues.map((i) => i.key);

describe("precedenceGateApplies", () => {
    it("applies when a subtask is being started", () => {
        assert.equal(precedenceGateApplies(subtask(SubtaskType.Dev, Status.ToDo), Status.InProgress), true);
        assert.equal(precedenceGateApplies(subtask(SubtaskType.Dev, Status.Backlog), Status.InReview), true);
    });

    it("does not apply to resuming, to other targets, or to a ticket that is not a subtask", () => {
        assert.equal(precedenceGateApplies(subtask(SubtaskType.Dev, Status.InProgress), Status.InReview), false);
        assert.equal(precedenceGateApplies(subtask(SubtaskType.Dev, Status.ToDo), Status.Done), false);
        assert.equal(precedenceGateApplies(subtask(SubtaskType.Dev, Status.Backlog), Status.ToDo), false);
        assert.equal(
            precedenceGateApplies({ issueType: StoryType.Story, status: Status.ToDo, parentKey: "E-1" as IssueKey }, Status.InProgress),
            false
        );
    });
});

describe("openPrerequisites", () => {
    it("names the open sibling upstream of the subtask being started", () => {
        const design = subtask(SubtaskType.ArchitectureDesign, Status.InProgress);
        const dev = subtask(SubtaskType.Dev, Status.ToDo);
        assert.deepEqual(keys(openPrerequisites(dev, story, [design, dev])), [design.key]);
    });

    it("is empty once every upstream sibling is Done or Canceled", () => {
        const design = subtask(SubtaskType.ArchitectureDesign, Status.Done);
        const database = subtask(SubtaskType.Database, Status.Canceled);
        const dev = subtask(SubtaskType.Dev, Status.ToDo);
        assert.deepEqual(openPrerequisites(dev, story, [design, database, dev]), []);
    });

    it("reaches a prerequisite through a subtask that does not exist (TAI-463)", () => {
        const dev = subtask(SubtaskType.Dev, Status.InProgress);
        const deploy = subtask(SubtaskType.Deploy, Status.ToDo);
        assert.deepEqual(keys(openPrerequisites(deploy, story, [dev, deploy])), [dev.key]);
    });

    it("lets a test tier or UAT start once Dev has started, since Dev stays open until its PR merges", () => {
        const dev = subtask(SubtaskType.Dev, Status.InProgress);
        for (const type of [SubtaskType.IntegrationTest, SubtaskType.SystemTest, SubtaskType.E2ETest, SubtaskType.Uat]) {
            const tier = subtask(type, Status.ToDo);
            assert.deepEqual(openPrerequisites(tier, story, [dev, tier]), [], type);
        }
    });

    it("still refuses a test tier while Dev has not started, and a later tier while an earlier one is open", () => {
        const dev = subtask(SubtaskType.Dev, Status.ToDo);
        const integration = subtask(SubtaskType.IntegrationTest, Status.ToDo);
        assert.deepEqual(keys(openPrerequisites(integration, story, [dev, integration])), [dev.key]);

        const started = subtask(SubtaskType.Dev, Status.InProgress);
        const system = subtask(SubtaskType.SystemTest, Status.ToDo);
        assert.deepEqual(keys(openPrerequisites(system, story, [started, integration, system])), [integration.key]);
    });

    it("Dev having started does not open Deploy", () => {
        const dev = subtask(SubtaskType.Dev, Status.InProgress);
        const deploy = subtask(SubtaskType.Deploy, Status.ToDo);
        assert.deepEqual(keys(openPrerequisites(deploy, story, [dev, deploy])), [dev.key]);
    });

    it("has nothing to say under a parent that is not a story-level ticket", () => {
        const dev = subtask(SubtaskType.Dev, Status.ToDo);
        const design = subtask(SubtaskType.ArchitectureDesign, Status.ToDo);
        assert.deepEqual(openPrerequisites(dev, { issueType: "epic" }, [design, dev]), []);
    });
});

describe("gate messages", () => {
    const design = subtask(SubtaskType.ArchitectureDesign, Status.ToDo);

    it("the rejection names the blocker and the override", () => {
        const reason = precedenceGateReason("T-9" as IssueKey, Status.InProgress, [design]);
        assert.ok(reason.includes(design.key));
        assert.ok(reason.includes('issue transition T-9 "In Progress" force=true'));
    });

    it("the override comment names what was bypassed and ends with its own closing line", () => {
        const comment = precedenceOverrideComment(Status.InProgress, [design]);
        assert.ok(comment.startsWith("Precedence override:"));
        assert.ok(comment.includes(design.key));
        assert.ok(comment.endsWith("\n\nRecorded by TAI."));
    });
});
