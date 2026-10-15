import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, toIssueKey, type HumanRef, type WorkTracker } from "../storage/interface.js";
import { toPullRequestId, toRepoId, type CommitSha, type GitHost, type PullRequestRef } from "../git/interface.js";
import { checkMergeGate } from "../git/merge-gate.js";
import { createSmall, CreateSmallPartialError, type CreateSmallDeps } from "./create-small.js";

const ME: HumanRef = { id: toHumanId("a@b.c"), displayName: "A", email: "a@b.c" };

async function withTracker(fn: (wt: WorkTracker) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-small-"));
    try {
        await fn(createFilesystemBackend(dir, ME).workTracker);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
const deps = (wt: WorkTracker, over: Partial<CreateSmallDeps> = {}): CreateSmallDeps => ({
    workTracker: wt,
    resolveAssignee: async () => ({ assignee: ME }),
    ...over,
});
const DESC = "Fix the typo in the usage text.\n\nAC-1: The usage text reads 'epic'.";

describe("createSmall (TAI-473 light lane)", () => {
    it("creates a Story and its Dev subtask, links them by parent, assigns both and leaves both in To Do", async () => {
        await withTracker(async (wt) => {
            const r = await createSmall(deps(wt), { projectKey: "TAI", type: "story", summary: "Fix typo", description: DESC });
            assert.equal(r.parent.issueType, StoryType.Story);
            assert.equal(r.dev.issueType, SubtaskType.Dev);
            assert.equal(r.dev.parentKey, r.parent.key);
            assert.equal(r.parent.persona, Persona.Pm);
            assert.equal(r.dev.persona, Persona.Developer);
            for (const key of [r.parent.key, r.dev.key]) {
                const read = (await wt.getIssue(key))!;
                assert.equal(read.status, Status.ToDo, `${key} is in To Do`);
                assert.equal(read.assignee?.email, "a@b.c", `${key} is assigned`);
            }
        });
    });

    it("works for a Bug, and the subtask inherits the parent's priority", async () => {
        await withTracker(async (wt) => {
            const r = await createSmall(deps(wt), { projectKey: "TAI", type: "bug", summary: "Wrong label", description: DESC, priority: "High" });
            assert.equal(r.parent.issueType, StoryType.Bug);
            assert.equal(r.dev.priority, "High");
        });
    });

    it("refuses any other type, or a description with no AC-1 line, and creates nothing", async () => {
        await withTracker(async (wt) => {
            await assert.rejects(createSmall(deps(wt), { projectKey: "TAI", type: "spike", summary: "s", description: DESC }), /story or bug/i);
            await assert.rejects(createSmall(deps(wt), { projectKey: "TAI", type: "epic", summary: "s", description: DESC }), /story or bug/i);
            await assert.rejects(createSmall(deps(wt), { projectKey: "TAI", type: "story", summary: "s", description: "no criteria here" }), /AC-1/);
            await assert.rejects(createSmall(deps(wt), { projectKey: "TAI", type: "story", summary: "s" }), /AC-1/);
            assert.equal((await wt.search({ projectKey: "TAI", exhaustive: true })).length, 0);
        });
    });

    it("requires the AC-1 line itself, not a mention of AC-1 inside another criterion", async () => {
        await withTracker(async (wt) => {
            await assert.rejects(
                createSmall(deps(wt), { projectKey: "TAI", type: "story", summary: "s", description: "AC-2: must also satisfy AC-1" }),
                /AC-1/
            );
            const ok = await createSmall(deps(wt), { projectKey: "TAI", type: "story", summary: "s", description: "* AC-1: works\nAC-2: also works" });
            assert.equal(ok.parent.issueType, StoryType.Story);
        });
    });

    it("refuses a parent that is missing or is not an epic, and creates nothing", async () => {
        await withTracker(async (wt) => {
            const story = await wt.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "a story", persona: Persona.Pm });
            const epic = await wt.createIssue({ projectKey: "TAI", issueType: "epic", summary: "an epic", persona: Persona.Pm });
            const before = (await wt.search({ projectKey: "TAI", exhaustive: true })).length;
            await assert.rejects(createSmall(deps(wt), { projectKey: "TAI", type: "story", summary: "s", description: DESC, parentKey: story.key }), /not an epic/);
            await assert.rejects(createSmall(deps(wt), { projectKey: "TAI", type: "story", summary: "s", description: DESC, parentKey: toIssueKey("TAI-9999") }), /no such issue|not found/i);
            assert.equal((await wt.search({ projectKey: "TAI", exhaustive: true })).length, before, "nothing was created");
            const ok = await createSmall(deps(wt), { projectKey: "TAI", type: "story", summary: "s", description: DESC, parentKey: epic.key });
            assert.equal(ok.parent.parentKey, epic.key);
        });
    });

    it("reports the parent that exists when the Dev subtask cannot be created", async () => {
        await withTracker(async (wt) => {
            const failing: WorkTracker = Object.create(wt, {
                createIssue: {
                    value: async (input: Parameters<WorkTracker["createIssue"]>[0]) => {
                        if (input.issueType === SubtaskType.Dev) throw new Error("boom");
                        return wt.createIssue(input);
                    },
                },
            });
            const err = await createSmall(deps(failing), { projectKey: "TAI", type: "story", summary: "s", description: DESC }).catch((e: unknown) => e);
            assert.ok(err instanceof CreateSmallPartialError);
            assert.match(err.message, /TAI-\d+/);
            assert.match(err.message, /boom/);
            assert.match(err.message, /issue create TAI dev/);
            assert.equal(err.parentKey, (await wt.search({ projectKey: "TAI", exhaustive: true }))[0]!.key);
        });
    });

    it("creates unassigned, with a note, when no assignee can be resolved", async () => {
        await withTracker(async (wt) => {
            const r = await createSmall(deps(wt, { resolveAssignee: async () => ({ note: "Created UNASSIGNED: roster unreadable." }) }), {
                projectKey: "TAI",
                type: "story",
                summary: "s",
                description: DESC,
            });
            assert.equal(r.parent.assignee, null);
            assert.ok(r.notes.some((n) => /UNASSIGNED/.test(n)));
        });
    });

    it("is not exempt from the merge gate: its Dev PR still needs a fresh approval, and the tickets carry no exemption label", async () => {
        await withTracker(async (wt) => {
            const r = await createSmall(deps(wt), { projectKey: "TAI", type: "story", summary: "s", description: DESC });
            assert.deepEqual(r.parent.labels, []);
            assert.deepEqual(r.dev.labels, []);
            const pr = { id: toPullRequestId("1"), repo: toRepoId("w/r"), reviewers: [], sourceCommit: "abc" as CommitSha } as unknown as PullRequestRef;
            const gitHost = { listPullRequestActivity: async () => [] } as unknown as Pick<GitHost, "listPullRequestActivity">;
            const verdict = await checkMergeGate({ gitHost, workTracker: wt }, pr, r.dev.key);
            assert.equal(verdict.ok, false);
            assert.match(verdict.blockers.join(" "), /approval/);
        });
    });
});
