import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, type HumanRef, type StorageBackend } from "../storage/interface.js";
import { findReadyWork } from "./ready.js";

const CURRENT_USER: HumanRef = { id: toHumanId("del@example.com"), displayName: "Del", email: "del@example.com" };

async function withBackend(fn: (backend: StorageBackend, taiRoot: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-ready-command-"));
    try {
        await fn(createFilesystemBackend(dir, CURRENT_USER), dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("findReadyWork", () => {
    test("a story-level ticket is trivially ready once open, regardless of subtasks", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Top-level story",
                persona: Persona.Pm,
            });

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(result.ready.some((i) => i.key === story.key));
        });
    });

    test("a subtask blocked by an unfinished precedence sibling is excluded, then included once the blocker is Done", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story needing architecture first",
            });
            const arch = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.ArchitectureDesign,
                summary: "Design it",
                persona: Persona.Architect,
                parentKey: story.key,
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Build it",
                persona: Persona.Developer,
                parentKey: story.key,
            });

            const before = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(!before.ready.some((i) => i.key === dev.key), "Dev should be blocked by ArchitectureDesign");
            assert.ok(before.ready.some((i) => i.key === arch.key), "ArchitectureDesign has no blocker of its own");

            await backend.workTracker.transition(arch.key, Status.Done);

            const after = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(after.ready.some((i) => i.key === dev.key), "Dev should unblock once ArchitectureDesign is Done");
        });
    });

    test("a subtask with no applicable precedence rule (a root) is ready immediately", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Simple story",
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Just build it, nothing gates Dev here",
                persona: Persona.Developer,
                parentKey: story.key,
            });

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(result.ready.some((i) => i.key === dev.key));
        });
    });

    test("persona filter narrows the candidate set", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story",
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Dev work",
                persona: Persona.Developer,
                parentKey: story.key,
            });
            await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.CodeReview,
                summary: "Review work",
                persona: Persona.CodeReviewer,
                parentKey: story.key,
            });

            const result = await findReadyWork(
                { workTracker: backend.workTracker, taiRoot, projectKey: "TAI" },
                Persona.Developer
            );
            assert.deepEqual(
                result.ready.map((i) => i.key),
                [dev.key]
            );
        });
    });

    test("a Done subtask is excluded from ready work", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story",
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Already done",
                persona: Persona.Developer,
                parentKey: story.key,
            });
            await backend.workTracker.transition(dev.key, Status.Done);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(!result.ready.some((i) => i.key === dev.key));
        });
    });
});
