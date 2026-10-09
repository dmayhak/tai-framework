import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { toIssueKey, type Issue } from "../storage/interface.js";
import { emptyPersonaShell, type PersonaConfig } from "./config.js";
import { canComplete, canCreate, canPerformGitAction, canWorkOn, grantNote } from "./permission-gate.js";

function issue(overrides: Partial<Issue>): Issue {
    return {
        key: toIssueKey("TAI-1"),
        projectKey: "TAI",
        issueType: SubtaskType.Dev,
        summary: "s",
        status: Status.ToDo,
        assignee: null,
        persona: null,
        labels: [],
        createdAt: "x",
        updatedAt: "x",
        comments: [],
        ...overrides,
    };
}

function devConfig(overrides: Partial<PersonaConfig> = {}): PersonaConfig {
    const shell = emptyPersonaShell("developer", "Dario");
    return {
        ...shell,
        permissions: {
            ...shell.permissions,
            create: [{ kind: "subtask", subtaskType: SubtaskType.Dev }],
            workOn: [{ kind: "subtask", subtaskType: SubtaskType.Dev }],
            complete: [{ kind: "subtask", subtaskType: SubtaskType.Dev }],
        },
        ...overrides,
    };
}

describe("canCreate", () => {
    it("allows a granted issue type", () => {
        assert.equal(canCreate(devConfig(), SubtaskType.Dev), true);
    });

    it("denies an ungranted issue type", () => {
        assert.equal(canCreate(devConfig(), SubtaskType.CodeReview), false);
    });

    it("denies everything for a disabled persona", () => {
        assert.equal(canCreate(devConfig({ enabled: false }), SubtaskType.Dev), false);
    });

    it("supports story-level and epic targets too", () => {
        const pmLike = devConfig({
            permissions: {
                ...devConfig().permissions,
                create: [
                    { kind: "issue", issueType: StoryType.Story },
                    { kind: "issue", issueType: "epic" },
                ],
            },
        });
        assert.equal(canCreate(pmLike, StoryType.Story), true);
        assert.equal(canCreate(pmLike, "epic"), true);
        assert.equal(canCreate(pmLike, StoryType.Bug), false);
    });
});

describe("canWorkOn", () => {
    it("allows a granted issue type", () => {
        assert.equal(canWorkOn(devConfig(), issue({ issueType: SubtaskType.Dev })), true);
    });

    it("denies an ungranted issue type", () => {
        assert.equal(canWorkOn(devConfig(), issue({ issueType: SubtaskType.Uat })), false);
    });

    it("denies for a disabled persona even if otherwise granted", () => {
        assert.equal(canWorkOn(devConfig({ enabled: false }), issue({ issueType: SubtaskType.Dev })), false);
    });
});

describe("canComplete", () => {
    it("allows a granted issue type", () => {
        assert.equal(canComplete(devConfig(), issue({ issueType: SubtaskType.Dev })), true);
    });

    it("denies an ungranted issue type (e.g. Tester on UAT, human stakeholder must sign off)", () => {
        const testerLike = devConfig({
            permissions: {
                ...devConfig().permissions,
                complete: [
                    { kind: "subtask", subtaskType: SubtaskType.IntegrationTest },
                    // UAT deliberately absent
                ],
            },
        });
        assert.equal(canComplete(testerLike, issue({ issueType: SubtaskType.Uat })), false);
        assert.equal(canComplete(testerLike, issue({ issueType: SubtaskType.IntegrationTest })), true);
    });
});

describe("canPerformGitAction", () => {
    it("allows a granted action", () => {
        const dev = devConfig({
            permissions: { ...devConfig().permissions, gitHost: ["createPullRequest"] },
        });
        assert.equal(canPerformGitAction(dev, "createPullRequest"), true);
    });

    it("denies an ungranted action", () => {
        assert.equal(canPerformGitAction(devConfig(), "mergePullRequest"), false);
    });

    it("denies for a disabled persona even if otherwise granted", () => {
        const disabled = devConfig({
            enabled: false,
            permissions: { ...devConfig().permissions, gitHost: ["createPullRequest"] },
        });
        assert.equal(canPerformGitAction(disabled, "createPullRequest"), false);
    });
});

describe("grantNote (TAI-478)", () => {
    it("is null when the persona's grant covers the action", () => {
        assert.equal(grantNote(devConfig(), "create", SubtaskType.Dev), null);
        assert.equal(grantNote(devConfig(), "complete", SubtaskType.Dev), null);
    });

    it("names the persona, the action, the type and its doc when the grant does not cover a create", () => {
        const note = grantNote(devConfig(), "create", StoryType.Story)!;
        assert.match(note, /^Note: .*developer.* has no `create` grant for "story" \(personas\/developer\.md\)\. The command went ahead\./);
        assert.match(note, /knows in context that the ticket is needed/);
    });

    it("words a complete outside the grants as something to check, naming human-gated items and Epics", () => {
        const note = grantNote(devConfig(), "complete", SubtaskType.Uat)!;
        assert.match(note, /has no `complete` grant for "uat"/);
        assert.match(note, /closed only when the human says so/);
    });
});
