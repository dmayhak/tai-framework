import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status, StoryType, SubtaskType, DependencyRelation } from "../schema/story-schema.js";
import {
    toIssueKey,
    type AttachmentRef,
    type Comment,
    type CreateIssueInput,
    type HumanRef,
    type Issue,
    type IssueFilter,
    type IssueKey,
    type IssueLink,
    type IssuePatch,
    type MutationResult,
    type PageId,
    type RemoteLink,
    type WorkTracker,
} from "../storage/interface.js";
import { emptyPersonaShell, type PersonaConfig } from "./config.js";
import { PersonaPermissionError, PersonaScopedWorkTracker } from "./scoped-work-tracker.js";

/** A fake inner WorkTracker that records every call it actually receives, so tests can prove
 *  a denied action never reaches it. */
class RecordingWorkTracker implements WorkTracker {
    readonly calls: string[] = [];
    private issues = new Map<string, Issue>();

    seed(issue: Issue): void {
        this.issues.set(issue.key, issue);
    }

    async createIssue(input: CreateIssueInput): Promise<Issue> {
        this.calls.push("createIssue");
        const issue: Issue = {
            key: toIssueKey("TAI-NEW"),
            projectKey: input.projectKey,
            issueType: input.issueType,
            summary: input.summary,
            status: Status.ToDo,
            assignee: input.assignee ?? null,
            persona: input.persona ?? null,
            labels: input.labels ?? [],
            createdAt: "x",
            updatedAt: "x",
            comments: [],
        };
        this.issues.set(issue.key, issue);
        return issue;
    }

    async getIssue(key: IssueKey): Promise<Issue | null> {
        this.calls.push("getIssue");
        return this.issues.get(key) ?? null;
    }

    async updateIssue(key: IssueKey, patch: IssuePatch): Promise<Issue> {
        this.calls.push("updateIssue");
        const current = this.issues.get(key);
        if (!current) throw new Error(`no such issue: ${key}`);
        const updated = { ...current, ...patch } as Issue;
        this.issues.set(key, updated);
        return updated;
    }

    async transition(key: IssueKey, target: Status): Promise<MutationResult> {
        this.calls.push("transition");
        const current = this.issues.get(key)!;
        const updated = { ...current, status: target };
        this.issues.set(key, updated);
        return { ok: true, issue: updated };
    }

    async getAvailableTransitions(): Promise<readonly Status[]> {
        this.calls.push("getAvailableTransitions");
        return [Status.ToDo, Status.InProgress, Status.Done];
    }

    async assignIssue(): Promise<MutationResult> {
        this.calls.push("assignIssue");
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

    async editComment(): Promise<Comment> {
        this.calls.push("editComment");
        throw new Error("not used in these tests");
    }

    async addLabel(): Promise<void> {
        this.calls.push("addLabel");
    }

    async removeLabel(): Promise<void> {
        this.calls.push("removeLabel");
    }

    async createLink(): Promise<void> {
        this.calls.push("createLink");
    }

    async removeLink(): Promise<boolean> {
        this.calls.push("removeLink");
        return true;
    }

    async getLinkedIssues(): Promise<readonly IssueLink[]> {
        this.calls.push("getLinkedIssues");
        return [];
    }

    async linkPage(): Promise<void> {
        this.calls.push("linkPage");
    }

    async getLinkedPages(): Promise<readonly PageId[]> {
        this.calls.push("getLinkedPages");
        return [];
    }

    async createRemoteLink(): Promise<void> {
        this.calls.push("createRemoteLink");
    }

    async getRemoteLinks(): Promise<readonly RemoteLink[]> {
        this.calls.push("getRemoteLinks");
        return [];
    }

    async listAttachments(): Promise<readonly AttachmentRef[]> {
        this.calls.push("listAttachments");
        return [];
    }

    async getAttachment(): Promise<Buffer> {
        this.calls.push("getAttachment");
        throw new Error("not used in these tests");
    }

    async search(_filter: IssueFilter): Promise<readonly Issue[]> {
        this.calls.push("search");
        return [...this.issues.values()];
    }
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

function storyIssue(overrides: Partial<Issue> = {}): Issue {
    return {
        key: toIssueKey("TAI-100"),
        projectKey: "TAI",
        issueType: StoryType.Story,
        summary: "A story",
        status: Status.InProgress,
        assignee: null,
        persona: null,
        labels: [],
        createdAt: "x",
        updatedAt: "x",
        comments: [],
        ...overrides,
    };
}

describe("PersonaScopedWorkTracker.createIssue", () => {
    it("rejects an ungranted issue type BEFORE the inner tracker is ever called", async () => {
        const inner = new RecordingWorkTracker();
        const scoped = new PersonaScopedWorkTracker(inner, devConfig());

        await assert.rejects(
            () => scoped.createIssue({ projectKey: "TAI", issueType: SubtaskType.CodeReview, summary: "x" }),
            PersonaPermissionError
        );
        assert.deepEqual(inner.calls, []); // never reached the inner tracker
    });

    it("passes an allowed create straight through unchanged", async () => {
        const inner = new RecordingWorkTracker();
        const scoped = new PersonaScopedWorkTracker(inner, devConfig());

        const issue = await scoped.createIssue({ projectKey: "TAI", issueType: SubtaskType.Dev, summary: "x" });
        assert.equal(issue.issueType, SubtaskType.Dev);
        assert.deepEqual(inner.calls, ["createIssue"]);
    });
});

describe("PersonaScopedWorkTracker.updateIssue", () => {
    it("passes every update straight through: per-field update grants were deleted (TAI-478)", async () => {
        const inner = new RecordingWorkTracker();
        inner.seed(storyIssue());
        const scoped = new PersonaScopedWorkTracker(inner, devConfig());

        const updated = await scoped.updateIssue(toIssueKey("TAI-100"), { description: "changed" });
        assert.equal(updated.description, "changed");
        assert.deepEqual(inner.calls, ["updateIssue"]);
    });
});

describe("PersonaScopedWorkTracker.transition", () => {
    it("returns ok:false for a denied completion, without delegating to the inner transition", async () => {
        const inner = new RecordingWorkTracker();
        inner.seed(storyIssue({ key: toIssueKey("TAI-1"), issueType: SubtaskType.CodeReview }));
        const scoped = new PersonaScopedWorkTracker(inner, devConfig()); // no CodeReview grant

        const result = await scoped.transition(toIssueKey("TAI-1"), Status.Done);
        assert.equal(result.ok, false);
        assert.deepEqual(inner.calls, ["getIssue"]); // never reached inner.transition
    });

    it("delegates a granted completion", async () => {
        const inner = new RecordingWorkTracker();
        inner.seed(storyIssue({ key: toIssueKey("TAI-1"), issueType: SubtaskType.Dev }));
        const scoped = new PersonaScopedWorkTracker(inner, devConfig());

        const result = await scoped.transition(toIssueKey("TAI-1"), Status.Done);
        assert.equal(result.ok, true);
        assert.deepEqual(inner.calls, ["getIssue", "transition"]);
    });

    it("does not check canComplete at all for a non-completing transition", async () => {
        const inner = new RecordingWorkTracker();
        inner.seed(storyIssue({ key: toIssueKey("TAI-1"), issueType: SubtaskType.CodeReview }));
        const scoped = new PersonaScopedWorkTracker(inner, devConfig()); // no CodeReview grant at all

        const result = await scoped.transition(toIssueKey("TAI-1"), Status.InProgress);
        assert.equal(result.ok, true);
        assert.deepEqual(inner.calls, ["transition"]); // no getIssue lookup needed
    });
});

describe("PersonaScopedWorkTracker pass-through methods", () => {
    it("delegates every other WorkTracker method unchanged", async () => {
        const inner = new RecordingWorkTracker();
        const scoped = new PersonaScopedWorkTracker(inner, devConfig());
        const key = toIssueKey("TAI-1");

        await scoped.getAvailableTransitions(key);
        await scoped.resolveHuman("x@example.com");
        await scoped.addLabel(key, "x");
        await scoped.removeLabel(key, "x");
        await scoped.createLink(key, DependencyRelation.RelatesTo, toIssueKey("TAI-2"));
        await scoped.removeLink(key, DependencyRelation.RelatesTo, toIssueKey("TAI-2"));
        await scoped.getLinkedIssues(key);
        await scoped.linkPage(key, "p1" as PageId);
        await scoped.getLinkedPages(key);
        await scoped.listAttachments(key);
        await scoped.search({ projectKey: "TAI" });

        assert.deepEqual(inner.calls, [
            "getAvailableTransitions",
            "resolveHuman",
            "addLabel",
            "removeLabel",
            "createLink",
            "removeLink",
            "getLinkedIssues",
            "linkPage",
            "getLinkedPages",
            "listAttachments",
            "search",
        ]);
    });
});
