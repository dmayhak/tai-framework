import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Persona, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, toIssueKey, type HumanRef, type StorageBackend } from "../storage/interface.js";
import { NoOwningPersonaError, prepareWorkTurn } from "./work.js";
import { PersonaPermissionError } from "../persona/scoped-work-tracker.js";

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
        });
    });
});
