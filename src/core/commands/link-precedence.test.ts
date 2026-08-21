import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DependencyRelation, Persona, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, toIssueKey, type HumanRef, type StorageBackend } from "../storage/interface.js";
import { materializePrecedenceLinks, materializeStoryDependencies } from "./link-precedence.js";

const CURRENT_USER: HumanRef = { id: toHumanId("del@example.com"), displayName: "Del", email: "del@example.com" };

async function withBackend(fn: (backend: StorageBackend) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-link-precedence-command-"));
    try {
        await fn(createFilesystemBackend(dir, CURRENT_USER));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("materializePrecedenceLinks", () => {
    test("creates a Blocks link for each applicable precedence edge", async () => {
        await withBackend(async (backend) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story",
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Dev",
                persona: Persona.Developer,
                parentKey: story.key,
            });
            const codeReview = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.CodeReview,
                summary: "CodeReview",
                persona: Persona.CodeReviewer,
                parentKey: story.key,
            });
            const integrationTest = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.IntegrationTest,
                summary: "IntegrationTest",
                persona: Persona.Tester,
                parentKey: story.key,
            });

            const { results, warning } = await materializePrecedenceLinks(backend.workTracker, story.key);

            assert.equal(warning, null);
            assert.ok(results.every((r) => r.created));
            assert.ok(
                results.some((r) => r.beforeKey === dev.key && r.afterKey === codeReview.key),
                "CodeReview should depend on Dev"
            );
            assert.ok(
                results.some((r) => r.beforeKey === codeReview.key && r.afterKey === integrationTest.key),
                "IntegrationTest should depend on CodeReview"
            );

            const codeReviewDeps = await backend.workTracker.getLinkedIssues(
                codeReview.key,
                DependencyRelation.DependsOn,
                "outgoing"
            );
            assert.ok(codeReviewDeps.some((l) => l.key === dev.key));
        });
    });

    test("is idempotent — a second call skips edges that already have a link", async () => {
        await withBackend(async (backend) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story",
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Dev",
                persona: Persona.Developer,
                parentKey: story.key,
            });
            const codeReview = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.CodeReview,
                summary: "CodeReview",
                persona: Persona.CodeReviewer,
                parentKey: story.key,
            });

            const first = await materializePrecedenceLinks(backend.workTracker, story.key);
            assert.ok(first.results.every((r) => r.created));

            const second = await materializePrecedenceLinks(backend.workTracker, story.key);
            assert.ok(second.results.every((r) => !r.created));

            const deps = await backend.workTracker.getLinkedIssues(codeReview.key, DependencyRelation.DependsOn, "outgoing");
            assert.deepEqual(
                deps.filter((l) => l.key === dev.key).length,
                1,
                "the link must not be duplicated"
            );
        });
    });

    test("no applicable edges (fewer than two gated subtask types present) returns an empty result", async () => {
        await withBackend(async (backend) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story",
            });
            await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Dev, nothing else present",
                persona: Persona.Developer,
                parentKey: story.key,
            });

            const { results, warning } = await materializePrecedenceLinks(backend.workTracker, story.key);
            assert.deepEqual(results, []);
            assert.equal(warning, null);
        });
    });

    test("throws when the target key is not a Story-level ticket", async () => {
        await withBackend(async (backend) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story",
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Dev",
                persona: Persona.Developer,
                parentKey: story.key,
            });

            await assert.rejects(() => materializePrecedenceLinks(backend.workTracker, dev.key));
        });
    });

    test("throws when the key doesn't exist", async () => {
        await withBackend(async (backend) => {
            await assert.rejects(() => materializePrecedenceLinks(backend.workTracker, toIssueKey("TAI-99999")));
        });
    });

    test("retries when search() is still converging, and stops once two consecutive polls agree (TAI-118)", async () => {
        await withBackend(async (backend) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story",
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Dev",
                persona: Persona.Developer,
                parentKey: story.key,
            });
            const codeReview = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.CodeReview,
                summary: "CodeReview",
                persona: Persona.CodeReviewer,
                parentKey: story.key,
            });

            // Simulates the real Jira lag: poll 1 only sees `dev` (undercounted), poll 2
            // sees both (correct), poll 3 agrees with poll 2 — convergence is only
            // *confirmed* once two consecutive polls agree, so this takes 3 calls: poll 2
            // being different from poll 1 still counts as "unstable," poll 3 matching
            // poll 2 is what actually stops the loop.
            let call = 0;
            const flaky = {
                ...backend.workTracker,
                search: async (filter: Parameters<typeof backend.workTracker.search>[0]) => {
                    call++;
                    const real = await backend.workTracker.search(filter);
                    return call === 1 ? real.filter((i) => i.key === dev.key) : real;
                },
            };

            const { results, warning } = await materializePrecedenceLinks(flaky, story.key, {
                attempts: 4,
                delayMs: 0,
            });

            assert.equal(warning, null, "should stop retrying once two consecutive polls agree, not exhaust attempts");
            assert.equal(call, 3, "should have stopped once poll 3 confirmed poll 2's count, not exhausted all 4 attempts");
            assert.ok(
                results.some((r) => r.beforeKey === dev.key && r.afterKey === codeReview.key && r.created),
                "the edge should still be created once the retry converges"
            );
        });
    });

    test("returns a warning when search() never stabilizes within the retry budget (TAI-118)", async () => {
        await withBackend(async (backend) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story",
            });
            await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Dev",
                persona: Persona.Developer,
                parentKey: story.key,
            });

            // Every poll reports a different (ever-growing) count -- never converges.
            let call = 0;
            const neverStable = {
                ...backend.workTracker,
                search: async (filter: Parameters<typeof backend.workTracker.search>[0]) => {
                    call++;
                    const real = await backend.workTracker.search(filter);
                    return call % 2 === 1 ? real : [];
                },
            };

            const { warning } = await materializePrecedenceLinks(neverStable, story.key, {
                attempts: 3,
                delayMs: 0,
            });

            assert.match(warning ?? "", /still changing/);
            assert.match(warning ?? "", /re-run link-precedence/);
            assert.equal(call, 3, "should have exhausted the full retry budget before giving up");
        });
    });
});

describe("materializeStoryDependencies", () => {
    test("creates a Blocks link for a DependsOn dependency, idempotently", async () => {
        await withBackend(async (backend) => {
            const blocker = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Blocker story",
            });
            const dependent = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Dependent story",
            });

            const dependencies = [
                { from: dependent.key, relation: DependencyRelation.DependsOn, to: blocker.key },
            ];

            const first = await materializeStoryDependencies(backend.workTracker, dependencies);
            assert.equal(first.length, 1);
            assert.ok(first[0]!.created);

            const second = await materializeStoryDependencies(backend.workTracker, dependencies);
            assert.ok(!second[0]!.created);

            const deps = await backend.workTracker.getLinkedIssues(
                dependent.key,
                DependencyRelation.DependsOn,
                "outgoing"
            );
            assert.deepEqual(
                deps.filter((l) => l.key === blocker.key).length,
                1,
                "the link must not be duplicated"
            );
        });
    });

    test("creates a Relates link for a RelatesTo dependency, idempotently", async () => {
        await withBackend(async (backend) => {
            const a = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Spike,
                summary: "Spike A",
            });
            const b = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Spike,
                summary: "Spike B",
            });

            const dependencies = [{ from: a.key, relation: DependencyRelation.RelatesTo, to: b.key }];

            await materializeStoryDependencies(backend.workTracker, dependencies);
            const second = await materializeStoryDependencies(backend.workTracker, dependencies);
            assert.ok(!second[0]!.created);

            const related = await backend.workTracker.getLinkedIssues(a.key, DependencyRelation.RelatesTo);
            assert.ok(related.some((l) => l.key === b.key));
        });
    });
});
