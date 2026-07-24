import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Persona, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import {
    StorageConnectivityError,
    toHumanId,
    toIssueKey,
    type Comment,
    type HumanRef,
    type IssueKey,
    type StorageBackend,
    type WorkTracker,
} from "../storage/interface.js";
import { NoOwningPersonaError, prepareWorkTurn } from "./work.js";
import { PersonaPermissionError } from "../persona/scoped-work-tracker.js";
import { ConnectivityQueuedWorkTracker, WriteQueuedError } from "../workspace/connectivity-queue.js";

const CURRENT_USER: HumanRef = { id: toHumanId("del@example.com"), displayName: "Del", email: "del@example.com" };

async function withBackend(fn: (backend: StorageBackend, taiRoot: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-work-command-"));
    try {
        await fn(createFilesystemBackend(dir, CURRENT_USER), dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("prepareWorkTurn", () => {
    test("throws for a nonexistent issue", async () => {
        await withBackend(async (backend, taiRoot) => {
            await assert.rejects(
                () =>
                    prepareWorkTurn(
                        { backend, taiRoot, projectKey: "TAI", spaceKey: "TAI" },
                        toIssueKey("TAI-999")
                    ),
                /no such issue/
            );
        });
    });

    test("throws NoOwningPersonaError when the issue has no persona field set", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Unowned story",
            });
            await assert.rejects(
                () => prepareWorkTurn({ backend, taiRoot, projectKey: "TAI", spaceKey: "TAI" }, story.key),
                NoOwningPersonaError
            );
        });
    });

    test("throws PersonaPermissionError when the owning persona may not work on this issue type", async () => {
        await withBackend(async (backend, taiRoot) => {
            // Dario (Developer) is only granted workOn Subtask:Dev, not story-level Story tickets.
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story with the wrong owner",
                persona: Persona.Developer,
            });
            await assert.rejects(
                () => prepareWorkTurn({ backend, taiRoot, projectKey: "TAI", spaceKey: "TAI" }, story.key),
                PersonaPermissionError
            );
        });
    });

    test("succeeds for a Dev subtask owned by the Developer persona, returning prompt + briefing", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Parent story",
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Implement the thing",
                persona: Persona.Developer,
                parentKey: story.key,
            });

            const turn = await prepareWorkTurn({ backend, taiRoot, projectKey: "TAI", spaceKey: "TAI" }, dev.key);

            assert.equal(turn.personaId, "developer");
            assert.equal(turn.personaDisplayName, "Dario");
            assert.ok(turn.personaPrompt.length > 0, "expected the built-in persona prompt body");
            assert.match(turn.briefingMarkdown, /Implement the thing/);
            assert.match(turn.briefingMarkdown, /Parent story/);
            assert.equal(turn.issue.key, dev.key);
            assert.deepEqual(turn.replayOutcome, { replayed: 0, stillQueued: 0, escalated: [] });
        });
    });

    // PR #9 code review: prepareWorkTurn never called replayPending at all -- a write queued
    // during a prior offline session stayed stranded in journal.md forever.
    test("replays a write queued by a prior offline session before generating the briefing", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Parent story",
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Implement the thing",
                persona: Persona.Developer,
                parentKey: story.key,
            });

            // Simulate a prior offline session: one addComment attempt that fails with a
            // connectivity error, gets queued into journal.md instead of propagating.
            let failNextAddComment = true;
            const flaky: WorkTracker = {
                ...backend.workTracker,
                async addComment(key: IssueKey, body: string): Promise<Comment> {
                    if (failNextAddComment) {
                        failNextAddComment = false;
                        throw new StorageConnectivityError("network unreachable");
                    }
                    return backend.workTracker.addComment(key, body);
                },
            };
            const queuedDuringPriorSession = new ConnectivityQueuedWorkTracker(flaky, taiRoot, "TAI", dev.key);
            await assert.rejects(() => queuedDuringPriorSession.addComment(dev.key, "left offline"), WriteQueuedError);

            // Now back online: prepareWorkTurn should replay it before returning.
            const turn = await prepareWorkTurn({ backend, taiRoot, projectKey: "TAI", spaceKey: "TAI" }, dev.key);

            assert.equal(turn.replayOutcome.replayed, 1);
            assert.equal(turn.replayOutcome.escalated.length, 0);
            const updated = await backend.workTracker.getIssue(dev.key);
            assert.ok(updated?.comments.some((c) => c.body === "left offline"));
        });
    });
});
