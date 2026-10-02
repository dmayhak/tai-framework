import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DependencyRelation, Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, type HumanRef, type StorageBackend } from "../storage/interface.js";
import {
    toCommitSha,
    toPullRequestId,
    toRepoId,
    type CommitStatus,
    type GitHost,
    type PullRequestRef,
    type PullRequestState,
    type RepoId,
} from "../git/interface.js";
import { findReadyWork, findReadyPRWork } from "./ready.js";
import { writeWorkStatus } from "../workspace/status.js";
import { writeLivingDocSnapshot } from "../workspace/living-doc-staleness.js";

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
            // Brief §5.3 rev 27: a fresh ticket lands in Backlog, not To Do -- promote past
            // it explicitly, same as a persona with the authority would (TAI-292).
            await backend.workTracker.transition(story.key, Status.ToDo);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(result.ready.some((i) => i.key === story.key));
        });
    });

    test("TAI-192: a genuinely undecomposed Epic (zero children) is surfaced", async () => {
        await withBackend(async (backend, taiRoot) => {
            const epic = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: "epic",
                summary: "Fresh epic, nothing under it yet",
                persona: Persona.Pm,
            });
            // Brief §5.3 rev 27: promote past the Backlog creation default (TAI-292).
            await backend.workTracker.transition(epic.key, Status.ToDo);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(result.ready.some((i) => i.key === epic.key));
        });
    });

    test("TAI-192: an Epic that's already been decomposed (has at least one child) is NOT surfaced", async () => {
        await withBackend(async (backend, taiRoot) => {
            const epic = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: "epic",
                summary: "Already-decomposed epic",
                persona: Persona.Pm,
            });
            await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "One of its stories",
                parentKey: epic.key,
            });

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(!result.ready.some((i) => i.key === epic.key), "already-decomposed Epic should be dropped from Ready Work");
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
            // Brief §5.3 rev 27: promote both past the Backlog creation default so this test
            // exercises the precedence gate specifically, not the (separate) open-status gate.
            await backend.workTracker.transition(arch.key, Status.ToDo);
            await backend.workTracker.transition(dev.key, Status.ToDo);

            const before = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(!before.ready.some((i) => i.key === dev.key), "Dev should be blocked by ArchitectureDesign");
            assert.ok(before.ready.some((i) => i.key === arch.key), "ArchitectureDesign has no blocker of its own");

            await backend.workTracker.transition(arch.key, Status.Done);

            const after = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(after.ready.some((i) => i.key === dev.key), "Dev should unblock once ArchitectureDesign is Done");
        });
    });

    describe("blockedBy — real Jira DependsOn links (TAI-266, TAI-243 ADR)", () => {
        test("a ready item with an open DependsOn blocker is flagged, but NOT excluded from ready", async () => {
            await withBackend(async (backend, taiRoot) => {
                const blocker = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "The real blocker, still open",
                });
                const dependent = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Depends on the blocker via a real cross-ticket link",
                });
                // Brief §5.3 rev 27: promote past the Backlog creation default (TAI-292).
                await backend.workTracker.transition(dependent.key, Status.ToDo);
                await backend.workTracker.createLink(dependent.key, DependencyRelation.DependsOn, blocker.key);

                const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
                assert.ok(result.ready.some((i) => i.key === dependent.key), "ADR decision #4: soft flag, never excluded");
                assert.deepEqual(result.blockedBy.get(dependent.key), [blocker.key]);
                assert.equal(result.blockedBy.get(blocker.key), undefined, "the blocker itself has no blocker of its own");
            });
        });

        test("a stale DependsOn link to an already-Done ticket does not flag the dependent", async () => {
            await withBackend(async (backend, taiRoot) => {
                const blocker = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Resolved blocker",
                });
                await backend.workTracker.transition(blocker.key, Status.Done);
                const dependent = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Depends on an already-resolved ticket",
                });
                await backend.workTracker.createLink(dependent.key, DependencyRelation.DependsOn, blocker.key);

                const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
                assert.equal(result.blockedBy.get(dependent.key), undefined, "a resolved blocker link is stale, not a real block");
            });
        });

        test("mixed links -- one open, one already-Done -- flags only the genuinely-open blocker", async () => {
            await withBackend(async (backend, taiRoot) => {
                const openBlocker = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Still open",
                });
                const resolvedBlocker = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Already resolved",
                });
                await backend.workTracker.transition(resolvedBlocker.key, Status.Done);
                const dependent = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Depends on both",
                });
                // Brief §5.3 rev 27: promote past the Backlog creation default (TAI-292).
                await backend.workTracker.transition(dependent.key, Status.ToDo);
                await backend.workTracker.createLink(dependent.key, DependencyRelation.DependsOn, openBlocker.key);
                await backend.workTracker.createLink(dependent.key, DependencyRelation.DependsOn, resolvedBlocker.key);

                const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
                assert.deepEqual(result.blockedBy.get(dependent.key), [openBlocker.key]);
            });
        });

        test("a stale DependsOn link to a Canceled ticket does not flag the dependent", async () => {
            await withBackend(async (backend, taiRoot) => {
                const blocker = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Canceled blocker",
                });
                await backend.workTracker.transition(blocker.key, Status.Canceled);
                const dependent = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Depends on a canceled ticket",
                });
                await backend.workTracker.createLink(dependent.key, DependencyRelation.DependsOn, blocker.key);

                const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
                assert.equal(result.blockedBy.get(dependent.key), undefined);
            });
        });

        test("ADR decision #3: an In Progress item with an open DependsOn blocker is flagged too", async () => {
            await withBackend(async (backend, taiRoot) => {
                const blocker = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Blocks an in-progress item",
                });
                const inProgress = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Already started, but a blocker reopened",
                    persona: Persona.Developer,
                    assignee: CURRENT_USER,
                });
                await backend.workTracker.transition(inProgress.key, Status.InProgress);
                await backend.workTracker.createLink(inProgress.key, DependencyRelation.DependsOn, blocker.key);

                const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
                assert.ok(result.inProgress.some((c) => c.issue.key === inProgress.key));
                assert.deepEqual(result.blockedBy.get(inProgress.key), [blocker.key]);
            });
        });
    });

    describe("terminal-ancestor exclusion (TAI-267, TAI-247 ADR decision #2)", () => {
        // The parent is transitioned to Done BEFORE its child even exists -- this is the
        // ADR's own point: decision #2 exists independently of TAI-266's downward cascade
        // (decision #1) precisely because it also catches staleness that PREDATES the
        // cascade (exactly TAI-133's real shape) or bypasses it entirely, not just
        // staleness the cascade itself would have already cleaned up.

        test("a subtask under an already-Done parent is excluded from ready outright, not just flagged", async () => {
            await withBackend(async (backend, taiRoot) => {
                const story = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Closed before this child ever existed",
                });
                await backend.workTracker.transition(story.key, Status.Done);
                const dev = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: SubtaskType.Dev,
                    summary: "Stale child, same shape as TAI-133",
                    persona: Persona.Developer,
                    parentKey: story.key,
                });

                const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
                assert.ok(!result.ready.some((i) => i.key === dev.key), "must be excluded, not merely flagged");
            });
        });

        test("a subtask under an already-Canceled parent is also excluded", async () => {
            await withBackend(async (backend, taiRoot) => {
                const story = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Canceled before this child ever existed",
                });
                await backend.workTracker.transition(story.key, Status.Canceled);
                const dev = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: SubtaskType.Dev,
                    summary: "Stale child under a canceled parent",
                    persona: Persona.Developer,
                    parentKey: story.key,
                });

                const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
                assert.ok(!result.ready.some((i) => i.key === dev.key));
            });
        });

        test("a subtask whose GRANDPARENT (Epic) is already Done is excluded, even with an open immediate parent", async () => {
            await withBackend(async (backend, taiRoot) => {
                const epic = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: "epic",
                    summary: "Closed epic",
                });
                await backend.workTracker.transition(epic.key, Status.Done);
                const story = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Still nominally open, but its Epic is Done",
                    parentKey: epic.key,
                });
                const dev = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: SubtaskType.Dev,
                    summary: "Two hops from the terminal ancestor",
                    persona: Persona.Developer,
                    parentKey: story.key,
                });

                const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
                assert.ok(!result.ready.some((i) => i.key === dev.key), "the two-hop grandparent check must catch this");
                // The Story itself, one hop from the terminal Epic, is also excluded.
                assert.ok(!result.ready.some((i) => i.key === story.key));
            });
        });

        test("an In Progress item under an already-terminal parent is excluded from inProgress too", async () => {
            await withBackend(async (backend, taiRoot) => {
                const story = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Closed parent, in-progress child",
                });
                await backend.workTracker.transition(story.key, Status.Done);
                const dev = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: SubtaskType.Dev,
                    summary: "Stale in-progress child",
                    persona: Persona.Developer,
                    parentKey: story.key,
                    assignee: CURRENT_USER,
                });
                await backend.workTracker.transition(dev.key, Status.InProgress);

                const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
                assert.ok(!result.inProgress.some((c) => c.issue.key === dev.key));
            });
        });

        test("a candidate under a genuinely open parent is NOT excluded", async () => {
            await withBackend(async (backend, taiRoot) => {
                const story = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Still open",
                });
                const dev = await backend.workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: SubtaskType.Dev,
                    summary: "Perfectly good child",
                    persona: Persona.Developer,
                    parentKey: story.key,
                });
                // Brief §5.3 rev 27: promote past the Backlog creation default (TAI-292).
                await backend.workTracker.transition(dev.key, Status.ToDo);

                const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
                assert.ok(result.ready.some((i) => i.key === dev.key));
            });
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
            // Brief §5.3 rev 27: promote past the Backlog creation default (TAI-292).
            await backend.workTracker.transition(dev.key, Status.ToDo);

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
            // Brief §5.3 rev 27: promote past the Backlog creation default (TAI-292).
            await backend.workTracker.transition(dev.key, Status.ToDo);

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

// ---------- TAI-196/200: In Progress / Ready Work split ----------
//
// Already-started work (Status.InProgress/InReview) moves to its own `inProgress` list,
// sourced from the same live Jira search as `ready` — separate from the old, purely-local
// `rollupStatus` "Already in flight" section this replaces.

describe("findReadyWork in-progress split", () => {
    test("an In-Progress subtask is NOT in ready, but IS in inProgress", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "Story" });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Already started",
                persona: Persona.Developer,
                parentKey: story.key,
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(dev.key, Status.InProgress);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(!result.ready.some((i) => i.key === dev.key), "should not appear in ready once started");
            assert.ok(result.inProgress.some((c) => c.issue.key === dev.key), "should appear in inProgress");
        });
    });

    test("an In-Review subtask also counts as in-progress, not ready", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "Story" });
            const kickoff = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Kickoff,
                summary: "In review",
                parentKey: story.key,
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(kickoff.key, Status.InReview);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(!result.ready.some((i) => i.key === kickoff.key));
            assert.ok(result.inProgress.some((c) => c.issue.key === kickoff.key));
        });
    });

    test("a story-level ticket already In Progress moves to inProgress too, not just subtasks", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story",
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(story.key, Status.InProgress);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(!result.ready.some((i) => i.key === story.key));
            assert.ok(result.inProgress.some((c) => c.issue.key === story.key));
        });
    });

    test("an already-In-Progress subtask skips precedence re-checking entirely (still surfaced even if a sibling blocker isn't Done)", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story needing architecture first",
            });
            await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.ArchitectureDesign,
                summary: "Design it — deliberately left NOT Done",
                persona: Persona.Architect,
                parentKey: story.key,
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Somehow already started despite the precedence gate",
                persona: Persona.Developer,
                parentKey: story.key,
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(dev.key, Status.InProgress);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(result.inProgress.some((c) => c.issue.key === dev.key), "already-started work is never silently dropped");
        });
    });

    test("hasLocalHistory is true when this machine has a status.json for the item", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "Story" });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Has local history",
                persona: Persona.Developer,
                parentKey: story.key,
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(dev.key, Status.InProgress);
            await writeWorkStatus(taiRoot, "TAI", {
                subtaskKey: dev.key,
                currentStep: "writing tests",
                state: "in-progress",
                updatedAt: "x",
            });

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            const candidate = result.inProgress.find((c) => c.issue.key === dev.key);
            assert.equal(candidate?.hasLocalHistory, true);
        });
    });

    test("hasLocalHistory is false when there's no local record — started elsewhere", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "Story" });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "No local history",
                persona: Persona.Developer,
                parentKey: story.key,
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(dev.key, Status.InProgress);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            const candidate = result.inProgress.find((c) => c.issue.key === dev.key);
            assert.equal(candidate?.hasLocalHistory, false);
        });
    });

    test("an undecomposed Epic is unaffected by the split — Epic status doesn't route it to inProgress", async () => {
        await withBackend(async (backend, taiRoot) => {
            const epic = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: "epic",
                summary: "Fresh epic",
                persona: Persona.Pm,
            });
            // Brief §5.3 rev 27: promote past the Backlog creation default (TAI-292).
            await backend.workTracker.transition(epic.key, Status.ToDo);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(result.ready.some((i) => i.key === epic.key));
            assert.ok(!result.inProgress.some((c) => c.issue.key === epic.key));
        });
    });
});

// ---------- readyToTest / readyToMerge / readyToReview (rev 52, TAI-159 ADR) ----------
//
// CodeReview is retired going forward — the anchor is now an In-Progress `Dev` subtask
// (stays open until its PR merges, story-schema.ts) correlated against the PR's own live
// approval/CI state, not a Done CodeReview subtask's Jira status.

const REVIEWER_A: HumanRef = { id: toHumanId("a@x.test"), displayName: "A", email: "a@x.test" };
const REVIEWER_B: HumanRef = { id: toHumanId("b@x.test"), displayName: "B", email: "b@x.test" };

function prFixture(overrides: Partial<PullRequestRef>): PullRequestRef {
    return {
        id: toPullRequestId("10"),
        repo: toRepoId("dmayhak/tai-framework"),
        title: "x",
        state: "open",
        sourceBranch: "feature",
        destinationBranch: "master",
        author: { id: toHumanId("x"), displayName: "x" },
        reviewers: [],
        sourceCommit: toCommitSha("abc123"),
        url: "https://bitbucket.org/dmayhak/tai-framework/pull-requests/1",
        createdAt: "x",
        updatedAt: "x",
        ...overrides,
    };
}

/** A fake exposing only what `findReadyWork`'s PR-awareness path actually needs.
 *  `openCallCount` (TAI-293's review, PR #82) pins that `computePRSections` fetches each
 *  repo's OPEN-PR list only once (shared between `findDevLinkedOpenPRs`/
 *  `findStoryLinkedOpenPRs` via `fetchOpenPRsByRepo`), not once per find-function -- kept
 *  separate from `state: "merged"` calls (`syncMergedIssues`'s own, unrelated fetch) so the
 *  count isolates exactly what this fix changed. */
class FakeGitHost implements Pick<GitHost, "listPullRequests" | "getCommitStatuses"> {
    openCallCount = 0;

    constructor(
        private readonly prsByRepo: ReadonlyMap<RepoId, readonly PullRequestRef[]>,
        private readonly statuses: readonly CommitStatus[] = [{ key: "build", name: "build", state: "successful" }]
    ) {}

    async listPullRequests(repo: RepoId, state?: PullRequestState): Promise<readonly PullRequestRef[]> {
        if (state === "open") this.openCallCount++;
        const prs = this.prsByRepo.get(repo) ?? [];
        return state ? prs.filter((pr) => pr.state === state) : prs;
    }

    async getCommitStatuses(): Promise<readonly CommitStatus[]> {
        return this.statuses;
    }
}

async function inProgressDev(backend: StorageBackend, summary: string): Promise<{ key: import("../storage/interface.js").IssueKey }> {
    const story = await backend.workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "Story" });
    const dev = await backend.workTracker.createIssue({
        projectKey: "TAI",
        issueType: SubtaskType.Dev,
        summary,
        persona: Persona.Developer,
        parentKey: story.key,
        assignee: CURRENT_USER,
    });
    await backend.workTracker.transition(dev.key, Status.InProgress);
    return dev;
}

/** TAI-293: an In-Progress governance-content Bug (no Dev subtask, no parent) -- the
 *  PM/Architect-authored PR case, mirroring `inProgressDev` above. */
async function inProgressBug(backend: StorageBackend, summary: string): Promise<{ key: import("../storage/interface.js").IssueKey }> {
    const bug = await backend.workTracker.createIssue({
        projectKey: "TAI",
        issueType: StoryType.Bug,
        summary,
        persona: Persona.Pm,
        assignee: CURRENT_USER,
    });
    await backend.workTracker.transition(bug.key, Status.InProgress);
    return bug;
}

/** TAI-314/315/316: an In-Progress test-tier subtask (IntegrationTest by default) with
 *  its own PR -- mirrors `inProgressDev` above, but persona `tester` and `issueType`
 *  parameterized so the same helper covers all three test tiers. */
async function inProgressTestTier(
    backend: StorageBackend,
    summary: string,
    issueType: SubtaskType = SubtaskType.IntegrationTest
): Promise<{ key: import("../storage/interface.js").IssueKey }> {
    const story = await backend.workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "Story" });
    const testTier = await backend.workTracker.createIssue({
        projectKey: "TAI",
        issueType,
        summary,
        persona: Persona.Tester,
        parentKey: story.key,
        assignee: CURRENT_USER,
    });
    await backend.workTracker.transition(testTier.key, Status.InProgress);
    return testTier;
}

describe("findReadyWork readyToTest / readyToMerge", () => {
    const repo = toRepoId("dmayhak/tai-framework");

    test("empty when gitHost/repos aren't supplied — never a partial guess", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            await backend.workTracker.createRemoteLink(dev.key, prFixture({}).url, "PR");

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.deepEqual(result.readyToTest, []);
            assert.deepEqual(result.readyToMerge, []);
        });
    });

    test("an In-Progress Dev subtask with a linked, approved, green PR is surfaced in both lists", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.equal(result.readyToTest.length, 1);
            assert.equal(result.readyToTest[0]?.devSubtaskKey, dev.key);
            assert.equal(result.readyToMerge.length, 1);
            assert.equal(result.readyToMerge[0]?.issueKey, dev.key);
        });
    });

    test("readyToTest has NO approval requirement — testing runs in parallel with review, not gated behind it (human-confirmed, TAI-160)", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [] }); // no reviews cast at all yet
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                requiredApprovals: 1,
            });

            assert.equal(result.readyToTest.length, 1, "an unreviewed PR is still ready to test");
            assert.deepEqual(result.readyToMerge, [], "but not ready to merge without approval");
        });
    });

    test("requiredApprovals > 1: one approval doesn't meet the readyToMerge threshold for two (readyToTest is unaffected either way)", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                requiredApprovals: 2,
            });

            assert.equal(result.readyToTest.length, 1);
            assert.deepEqual(result.readyToMerge, [], "one approval doesn't meet a required count of 2");
        });
    });

    test("requiredApprovals > 1: two approvals meet the readyToMerge threshold", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({
                reviewers: [
                    { human: REVIEWER_A, status: "approved" },
                    { human: REVIEWER_B, status: "approved" },
                ],
            });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                requiredApprovals: 2,
            });

            assert.equal(result.readyToMerge.length, 1);
        });
    });

    test("red CI excludes the PR from readyToMerge even though it's approved (readyToTest is unaffected — never checked CI, pre- or post-rev-52)", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]), [
                { key: "build", name: "build", state: "failed" },
            ]);
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.equal(result.readyToTest.length, 1);
            assert.deepEqual(result.readyToMerge, []);
        });
    });

    test("an In-Progress Dev subtask with no remote link is not surfaced", async () => {
        await withBackend(async (backend, taiRoot) => {
            await inProgressDev(backend, "Dev, never linked to a PR");

            const gitHost = new FakeGitHost(new Map([[repo, [prFixture({})]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.deepEqual(result.readyToTest, []);
        });
    });

    test("a linked PR that's already merged (no longer open) is not surfaced", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({});
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            // The PR is merged now — listPullRequests(repo, "open") no longer returns it.
            const gitHost = new FakeGitHost(new Map([[repo, []]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.deepEqual(result.readyToTest, []);
        });
    });

    test("a Dev subtask that's Done (already merged, rev 52) is not surfaced even with an approved linked PR", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");
            await backend.workTracker.transition(dev.key, Status.Done);

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.deepEqual(result.readyToTest, [], "only In-Progress Dev subtasks are candidates");
        });
    });
});

describe("findReadyWork readyToMerge — governance-content PRs (TAI-293)", () => {
    const repo = toRepoId("dmayhak/tai-framework");

    test("an In-Progress Bug with a linked, approved, green PR surfaces in readyToMerge but NOT readyToTest", async () => {
        await withBackend(async (backend, taiRoot) => {
            const bug = await inProgressBug(backend, "Governance content");
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(bug.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.deepEqual(result.readyToTest, [], "no meaningful test tier for docs-only governance content");
            assert.equal(result.readyToMerge.length, 1);
            assert.equal(result.readyToMerge[0]?.issueKey, bug.key);
        });
    });

    test("a Dev subtask's PR and a governance-content Bug's PR both surface in readyToMerge, each with the correct issueKey", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const devPr = prFixture({ id: toPullRequestId("10"), reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, devPr.url, "PR");

            const bug = await inProgressBug(backend, "Governance content");
            const bugPr = prFixture({
                id: toPullRequestId("11"),
                url: "https://bitbucket.org/dmayhak/tai-framework/pull-requests/11",
                reviewers: [{ human: REVIEWER_A, status: "approved" }],
            });
            await backend.workTracker.createRemoteLink(bug.key, bugPr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [devPr, bugPr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.equal(result.readyToTest.length, 1, "only the Dev subtask's PR is a test candidate");
            assert.equal(result.readyToTest[0]?.devSubtaskKey, dev.key);
            const mergeKeys = result.readyToMerge.map((c) => c.issueKey).sort();
            assert.deepEqual(mergeKeys, [bug.key, dev.key].sort());
        });
    });

    test("a Bug not yet approved is not surfaced in readyToMerge, same approval-count gate as a Dev subtask", async () => {
        await withBackend(async (backend, taiRoot) => {
            const bug = await inProgressBug(backend, "Governance content");
            const pr = prFixture({ reviewers: [] });
            await backend.workTracker.createRemoteLink(bug.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.deepEqual(result.readyToMerge, []);
        });
    });

    test("computePRSections fetches each repo's open-PR list only once, shared between the Dev and governance-content searches (PR #82 review)", async () => {
        await withBackend(async (backend, taiRoot) => {
            const bug = await inProgressBug(backend, "Governance content");
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(bug.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            // findReadyPRWork also runs syncTestTiersToToDo first, which fetches OPEN PRs
            // independently for its own, unrelated purpose (pre-existing, untouched by this
            // fix) -- so the count to pin here is 2 (syncTestTiersToToDo's own + ONE shared
            // fetch inside computePRSections), not 3, which is what it would have been before
            // this fix (syncTestTiersToToDo's own + TWO separate fetches inside
            // computePRSections, one per find-function).
            await findReadyPRWork({ workTracker: backend.workTracker, projectKey: "TAI", gitHost, repos: [repo] });
            assert.equal(gitHost.openCallCount, 2);
        });
    });

    test("an In-Progress Epic/Spike with a linked, approved, green PR also surfaces in readyToMerge", async () => {
        await withBackend(async (backend, taiRoot) => {
            const epic = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: "epic",
                summary: "Epic",
                assignee: CURRENT_USER,
            });
            const transitioned = await backend.workTracker.transition(epic.key, Status.InProgress);
            assert.ok(transitioned.ok, `expected transition to succeed: ${JSON.stringify(transitioned)}`);
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(epic.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.equal(result.readyToMerge.length, 1);
            assert.equal(result.readyToMerge[0]?.issueKey, epic.key);
        });
    });
});

describe("findReadyWork readyToMerge — test-tier PRs (TAI-314/315/316)", () => {
    const repo = toRepoId("dmayhak/tai-framework");

    test("an In-Progress IntegrationTest subtask with a linked, approved, green PR surfaces in readyToMerge but NOT readyToTest", async () => {
        await withBackend(async (backend, taiRoot) => {
            const testTier = await inProgressTestTier(backend, "Cascade conformance coverage");
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(testTier.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.deepEqual(result.readyToTest, [], "testing your own test-tier PR is meaningless");
            assert.equal(result.readyToMerge.length, 1);
            assert.equal(result.readyToMerge[0]?.issueKey, testTier.key);
        });
    });

    test("SystemTest and E2ETest subtasks are recognized the same way as IntegrationTest", async () => {
        await withBackend(async (backend, taiRoot) => {
            const systemTest = await inProgressTestTier(backend, "System test", SubtaskType.SystemTest);
            const systemPr = prFixture({ id: toPullRequestId("20"), reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(systemTest.key, systemPr.url, "PR");

            const e2eTest = await inProgressTestTier(backend, "E2E test", SubtaskType.E2ETest);
            const e2ePr = prFixture({
                id: toPullRequestId("21"),
                url: "https://bitbucket.org/dmayhak/tai-framework/pull-requests/21",
                reviewers: [{ human: REVIEWER_A, status: "approved" }],
            });
            await backend.workTracker.createRemoteLink(e2eTest.key, e2ePr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [systemPr, e2ePr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            const mergeKeys = result.readyToMerge.map((c) => c.issueKey).sort();
            assert.deepEqual(mergeKeys, [e2eTest.key, systemTest.key].sort());
        });
    });

    test("a Dev subtask's PR and a test-tier subtask's PR both surface in readyToMerge, each with the correct issueKey", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const devPr = prFixture({ id: toPullRequestId("30"), reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, devPr.url, "PR");

            const testTier = await inProgressTestTier(backend, "Integration test");
            const testPr = prFixture({
                id: toPullRequestId("31"),
                url: "https://bitbucket.org/dmayhak/tai-framework/pull-requests/31",
                reviewers: [{ human: REVIEWER_A, status: "approved" }],
            });
            await backend.workTracker.createRemoteLink(testTier.key, testPr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [devPr, testPr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.equal(result.readyToTest.length, 1, "only the Dev subtask's PR is a test candidate");
            assert.equal(result.readyToTest[0]?.devSubtaskKey, dev.key);
            const mergeKeys = result.readyToMerge.map((c) => c.issueKey).sort();
            assert.deepEqual(mergeKeys, [dev.key, testTier.key].sort());
        });
    });

    test("a test-tier subtask not yet approved is not surfaced in readyToMerge, same approval-count gate as everything else", async () => {
        await withBackend(async (backend, taiRoot) => {
            const testTier = await inProgressTestTier(backend, "Integration test");
            const pr = prFixture({ reviewers: [] });
            await backend.workTracker.createRemoteLink(testTier.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.deepEqual(result.readyToMerge, []);
        });
    });
});

describe("findReadyWork readyToReview", () => {
    const repo = toRepoId("dmayhak/tai-framework");

    test("empty when gitHost/repos/currentHuman/prReviewers aren't all supplied", async () => {
        await withBackend(async (backend, taiRoot) => {
            const pr = prFixture({});
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                // currentHuman/prReviewers omitted
            });
            assert.deepEqual(result.readyToReview, []);
        });
    });

    test("an open PR is surfaced when the current human is an eligible reviewer with no decision yet", async () => {
        await withBackend(async (backend, taiRoot) => {
            const pr = prFixture({});
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                currentHuman: REVIEWER_A,
                prReviewers: [REVIEWER_A],
            });
            assert.equal(result.readyToReview.length, 1);
            assert.equal(result.readyToReview[0]?.pullRequest.url, pr.url);
        });
    });

    test("not surfaced when the current human isn't on the PR Reviewers roster", async () => {
        await withBackend(async (backend, taiRoot) => {
            const pr = prFixture({});
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                currentHuman: REVIEWER_A,
                prReviewers: [REVIEWER_B], // A is not on the roster
            });
            assert.deepEqual(result.readyToReview, []);
        });
    });

    test("a PR the current human already approved is not surfaced again", async () => {
        await withBackend(async (backend, taiRoot) => {
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                currentHuman: REVIEWER_A,
                prReviewers: [REVIEWER_A],
            });
            assert.deepEqual(result.readyToReview, []);
        });
    });

    test("a PR the current human is assigned as reviewer on but hasn't voted (pending) IS surfaced", async () => {
        await withBackend(async (backend, taiRoot) => {
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "pending" }] });
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                currentHuman: REVIEWER_A,
                prReviewers: [REVIEWER_A],
            });
            assert.equal(result.readyToReview.length, 1);
        });
    });
});

describe("findReadyWork out-of-band merge sync (rev 52, TAI-159 ADR)", () => {
    const repo = toRepoId("dmayhak/tai-framework");

    test("an In-Progress Dev subtask whose linked PR is now merged (not via git-pr merge) is synced to Done", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ state: "merged" });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            const synced = await backend.workTracker.getIssue(dev.key);
            assert.equal(synced?.status, Status.Done);
        });
    });

    test("TAI-293: an In-Progress governance-content Bug whose linked PR is now merged out-of-band is synced to Done too", async () => {
        await withBackend(async (backend, taiRoot) => {
            const bug = await inProgressBug(backend, "Governance content");
            const pr = prFixture({ state: "merged" });
            await backend.workTracker.createRemoteLink(bug.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            const synced = await backend.workTracker.getIssue(bug.key);
            assert.equal(synced?.status, Status.Done);
        });
    });

    test("TAI-314/315/316: an In-Progress test-tier subtask whose linked PR is now merged out-of-band is synced to Done too", async () => {
        await withBackend(async (backend, taiRoot) => {
            const testTier = await inProgressTestTier(backend, "Integration test");
            const pr = prFixture({ state: "merged" });
            await backend.workTracker.createRemoteLink(testTier.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            const synced = await backend.workTracker.getIssue(testTier.key);
            assert.equal(synced?.status, Status.Done);
        });
    });

    test("a just-synced Dev subtask doesn't spuriously appear in readyToTest/readyToMerge from the same refresh", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ state: "merged", reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.deepEqual(result.readyToTest, []);
            assert.deepEqual(result.readyToMerge, []);
        });
    });

    test("an In-Progress Dev subtask with no remote link is left untouched", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev, never linked");
            const gitHost = new FakeGitHost(new Map([[repo, []]]));
            await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI", gitHost, repos: [repo] });

            const untouched = await backend.workTracker.getIssue(dev.key);
            assert.equal(untouched?.status, Status.InProgress);
        });
    });

    test("an In-Progress Dev subtask whose linked PR is still open is left untouched", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ state: "open" });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI", gitHost, repos: [repo] });

            const untouched = await backend.workTracker.getIssue(dev.key);
            assert.equal(untouched?.status, Status.InProgress);
        });
    });

    test("skipped entirely when gitHost/repos aren't supplied", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ state: "merged" });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });

            const untouched = await backend.workTracker.getIssue(dev.key);
            assert.equal(untouched?.status, Status.InProgress);
        });
    });
});

describe("findReadyWork Test-tier To Do sync (TAI-194)", () => {
    const repo = toRepoId("dmayhak/tai-framework");

    /** An In-Progress Dev subtask, plus a same-parent Test-tier sibling sitting in
     *  Backlog -- the fixture every test in this block starts from. */
    async function devWithBacklogTestTier(
        backend: StorageBackend,
        testTierType: SubtaskType = SubtaskType.IntegrationTest
    ): Promise<{ devKey: import("../storage/interface.js").IssueKey; testKey: import("../storage/interface.js").IssueKey }> {
        const story = await backend.workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "Story" });
        const dev = await backend.workTracker.createIssue({
            projectKey: "TAI",
            issueType: SubtaskType.Dev,
            summary: "Dev",
            persona: Persona.Developer,
            parentKey: story.key,
            assignee: CURRENT_USER,
        });
        await backend.workTracker.transition(dev.key, Status.InProgress);

        const testTier = await backend.workTracker.createIssue({
            projectKey: "TAI",
            issueType: testTierType,
            summary: "Test tier",
            persona: Persona.Tester,
            parentKey: story.key,
        });
        await backend.workTracker.transition(testTier.key, Status.Backlog);

        return { devKey: dev.key, testKey: testTier.key };
    }

    test("a Backlog Test-tier sibling moves to To Do once Dev's PR is open and linked", async () => {
        await withBackend(async (backend, taiRoot) => {
            const { devKey, testKey } = await devWithBacklogTestTier(backend);
            const pr = prFixture({ state: "open" });
            await backend.workTracker.createRemoteLink(devKey, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI", gitHost, repos: [repo] });

            const synced = await backend.workTracker.getIssue(testKey);
            assert.equal(synced?.status, Status.ToDo);
        });
    });

    test("every present test tier syncs, not just the first", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "Story" });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Dev",
                persona: Persona.Developer,
                parentKey: story.key,
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(dev.key, Status.InProgress);
            const integration = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.IntegrationTest,
                summary: "Integration",
                persona: Persona.Tester,
                parentKey: story.key,
            });
            await backend.workTracker.transition(integration.key, Status.Backlog);
            const system = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.SystemTest,
                summary: "System",
                persona: Persona.Tester,
                parentKey: story.key,
            });
            await backend.workTracker.transition(system.key, Status.Backlog);

            const pr = prFixture({ state: "open" });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI", gitHost, repos: [repo] });

            assert.equal((await backend.workTracker.getIssue(integration.key))?.status, Status.ToDo);
            assert.equal((await backend.workTracker.getIssue(system.key))?.status, Status.ToDo);
        });
    });

    test("a Test-tier sibling already past Backlog (e.g. In Progress) is left untouched", async () => {
        await withBackend(async (backend, taiRoot) => {
            const { devKey, testKey } = await devWithBacklogTestTier(backend);
            // Needs an assignee first -- brief §5.5's assignment gate blocks entering
            // In Progress otherwise, which would leave it in Backlog and defeat the point
            // of this test.
            await backend.workTracker.assignIssue(testKey, CURRENT_USER);
            const inProgress = await backend.workTracker.transition(testKey, Status.InProgress);
            assert.equal(inProgress.ok, true, "test setup: the In Progress transition itself must succeed");
            const pr = prFixture({ state: "open" });
            await backend.workTracker.createRemoteLink(devKey, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI", gitHost, repos: [repo] });

            const untouched = await backend.workTracker.getIssue(testKey);
            assert.equal(untouched?.status, Status.InProgress);
        });
    });

    test("no open PR linked yet: the Test-tier sibling stays in Backlog", async () => {
        await withBackend(async (backend, taiRoot) => {
            const { testKey } = await devWithBacklogTestTier(backend);
            const gitHost = new FakeGitHost(new Map([[repo, []]]));
            await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI", gitHost, repos: [repo] });

            const untouched = await backend.workTracker.getIssue(testKey);
            assert.equal(untouched?.status, Status.Backlog);
        });
    });

    test("skipped entirely when gitHost/repos aren't supplied", async () => {
        await withBackend(async (backend, taiRoot) => {
            const { devKey, testKey } = await devWithBacklogTestTier(backend);
            const pr = prFixture({ state: "open" });
            await backend.workTracker.createRemoteLink(devKey, pr.url, "PR");

            await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });

            const untouched = await backend.workTracker.getIssue(testKey);
            assert.equal(untouched?.status, Status.Backlog);
        });
    });
});

describe("findReadyWork priority sort/inheritance (TAI-195)", () => {
    test("Ready Work sorts Highest-priority tickets to the top, regardless of creation order", async () => {
        await withBackend(async (backend, taiRoot) => {
            const low = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Low priority",
                priority: "Low",
            });
            const highest = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Highest priority",
                priority: "Highest",
            });
            const medium = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Medium priority",
                priority: "Medium",
            });
            // Brief §5.3 rev 27: promote each past the Backlog creation default (TAI-292).
            await backend.workTracker.transition(low.key, Status.ToDo);
            await backend.workTracker.transition(highest.key, Status.ToDo);
            await backend.workTracker.transition(medium.key, Status.ToDo);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            const order = result.ready.map((i) => i.key);
            assert.deepEqual(order, [highest.key, medium.key, low.key]);
        });
    });

    test("unset priority sorts last, after every ranked priority", async () => {
        await withBackend(async (backend, taiRoot) => {
            const unset = await backend.workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "No priority" });
            const lowest = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Lowest priority",
                priority: "Lowest",
            });
            // Brief §5.3 rev 27: promote each past the Backlog creation default (TAI-292).
            await backend.workTracker.transition(unset.key, Status.ToDo);
            await backend.workTracker.transition(lowest.key, Status.ToDo);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            const order = result.ready.map((i) => i.key);
            assert.deepEqual(order, [lowest.key, unset.key]);
        });
    });

    test("a subtask with no priority of its own inherits its parent's for both sort and display", async () => {
        await withBackend(async (backend, taiRoot) => {
            const bug = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Bug,
                summary: "Urgent bug",
                priority: "Highest",
            });
            const triage = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Triage,
                summary: "Triage it",
                persona: Persona.Tester,
                parentKey: bug.key,
            });
            const lowPriorityStory = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Unrelated low-priority story",
                priority: "Low",
            });
            // Brief §5.3 rev 27: promote each past the Backlog creation default (TAI-292).
            await backend.workTracker.transition(bug.key, Status.ToDo);
            await backend.workTracker.transition(triage.key, Status.ToDo);
            await backend.workTracker.transition(lowPriorityStory.key, Status.ToDo);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            const order = result.ready.map((i) => i.key);
            const triageResult = result.ready.find((i) => i.key === triage.key);
            assert.equal(triageResult?.priority, "Highest", "Triage should display the inherited Highest priority");
            // The Bug itself (also Highest, story-level, trivially ready) legitimately
            // appears too -- just checking relative order here, not the full list.
            assert.ok(
                order.indexOf(triage.key) < order.indexOf(lowPriorityStory.key),
                "the inherited-Highest subtask should sort ahead of the Low-priority story"
            );
        });
    });

    test("a subtask's own priority (if ever set) wins over the parent's", async () => {
        await withBackend(async (backend, taiRoot) => {
            const bug = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Bug,
                summary: "Highest bug",
                priority: "Highest",
            });
            const triage = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Triage,
                summary: "Explicitly downgraded triage",
                persona: Persona.Tester,
                parentKey: bug.key,
                priority: "Lowest",
            });
            // Brief §5.3 rev 27: promote each past the Backlog creation default (TAI-292).
            await backend.workTracker.transition(bug.key, Status.ToDo);
            await backend.workTracker.transition(triage.key, Status.ToDo);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.equal(result.ready.find((i) => i.key === triage.key)?.priority, "Lowest");
        });
    });

    test("an unrecognized priority value sorts alongside unset, not guessed at", async () => {
        await withBackend(async (backend, taiRoot) => {
            const custom = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Custom priority scheme",
                priority: "P0",
            });
            const lowest = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Lowest",
                priority: "Lowest",
            });
            // Brief §5.3 rev 27: promote each past the Backlog creation default (TAI-292).
            await backend.workTracker.transition(custom.key, Status.ToDo);
            await backend.workTracker.transition(lowest.key, Status.ToDo);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            const order = result.ready.map((i) => i.key);
            assert.deepEqual(order, [lowest.key, custom.key]);
        });
    });

    // TAI-195/199 (extended 2026-08-26, human-confirmed): In Progress gets the same
    // priority sort/inheritance treatment as Ready Work -- gap found live while resolving a
    // merge conflict on this same ticket.
    test("In Progress ALSO sorts Highest-priority tickets to the top", async () => {
        await withBackend(async (backend, taiRoot) => {
            const low = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Low priority, in progress",
                priority: "Low",
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(low.key, Status.InProgress);
            const highest = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Highest priority, in progress",
                priority: "Highest",
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(highest.key, Status.InProgress);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.deepEqual(
                result.inProgress.map((c) => c.issue.key),
                [highest.key, low.key]
            );
        });
    });

    test("an in-progress subtask with no priority of its own inherits its parent's, same as Ready Work", async () => {
        await withBackend(async (backend, taiRoot) => {
            const bug = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Bug,
                summary: "Urgent bug",
                priority: "Highest",
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Already started, no priority of its own",
                persona: Persona.Developer,
                parentKey: bug.key,
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(dev.key, Status.InProgress);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            const candidate = result.inProgress.find((c) => c.issue.key === dev.key);
            assert.equal(candidate?.issue.priority, "Highest");
        });
    });
});

// ---------- findReadyPRWork (TAI-211/212) ----------
//
// Lighter, PR-review-mode-only sibling of findReadyWork — same readyToReview/readyToMerge
// computation (shared internally via computePRSections), but no general Jira-wide `ready`
// query, no readyToTest, no inFlight rollup, and no `taiRoot` dependency at all.

describe("findReadyPRWork", () => {
    const repo = toRepoId("dmayhak/tai-framework");

    test("result only ever has readyToReview and readyToMerge — no ready/readyToTest/inFlight fields", async () => {
        await withBackend(async (backend) => {
            const result = await findReadyPRWork({ workTracker: backend.workTracker, projectKey: "TAI" });
            assert.deepEqual(Object.keys(result).sort(), ["readyToMerge", "readyToReview"]);
        });
    });

    test("readyToReview: an open PR is surfaced when the current human is an eligible reviewer with no decision yet", async () => {
        await withBackend(async (backend) => {
            const pr = prFixture({});
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyPRWork({
                workTracker: backend.workTracker,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                currentHuman: REVIEWER_A,
                prReviewers: [REVIEWER_A],
            });
            assert.equal(result.readyToReview.length, 1);
            assert.equal(result.readyToReview[0]?.pullRequest.url, pr.url);
        });
    });

    test("readyToReview: empty when gitHost/repos/currentHuman/prReviewers aren't all supplied", async () => {
        await withBackend(async (backend) => {
            const pr = prFixture({});
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyPRWork({
                workTracker: backend.workTracker,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                // currentHuman/prReviewers omitted
            });
            assert.deepEqual(result.readyToReview, []);
        });
    });

    test("readyToMerge: an In-Progress Dev subtask with a linked, approved, green PR is surfaced", async () => {
        await withBackend(async (backend) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyPRWork({
                workTracker: backend.workTracker,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.equal(result.readyToMerge.length, 1);
            assert.equal(result.readyToMerge[0]?.issueKey, dev.key);
        });
    });

    test("readyToMerge: not surfaced without enough approvals, even though it would still be readyToTest under findReadyWork", async () => {
        await withBackend(async (backend) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyPRWork({
                workTracker: backend.workTracker,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                requiredApprovals: 1,
            });

            assert.deepEqual(result.readyToMerge, []);
        });
    });

    test("out-of-band merge sync still runs first — a Dev subtask whose linked PR merged elsewhere is synced to Done, not left dangling", async () => {
        await withBackend(async (backend) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ state: "merged" });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            await findReadyPRWork({ workTracker: backend.workTracker, projectKey: "TAI", gitHost, repos: [repo] });

            const synced = await backend.workTracker.getIssue(dev.key);
            assert.equal(synced?.status, Status.Done);
        });
    });
});

describe("findReadyWork staleLivingDocs (TAI-302/319)", () => {
    test("empty with no snapshot ever taken -- absence isn't a staleness signal", async () => {
        await withBackend(async (backend, taiRoot) => {
            const epic = await backend.workTracker.createIssue({ projectKey: "TAI", issueType: "epic", summary: "An epic" });
            await backend.workTracker.transition(epic.key, Status.ToDo);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.deepEqual(result.staleLivingDocs, []);
        });
    });

    test("empty when nothing has moved since the last snapshot", async () => {
        await withBackend(async (backend, taiRoot) => {
            const epic = await backend.workTracker.createIssue({ projectKey: "TAI", issueType: "epic", summary: "An epic" });
            await writeLivingDocSnapshot(taiRoot, "TAI", "project-home", [
                { epicKey: epic.key, status: epic.status, childTotal: 0, childDone: 0 },
            ]);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.deepEqual(result.staleLivingDocs, []);
        });
    });

    test("flags an Epic whose status moved since the snapshot", async () => {
        await withBackend(async (backend, taiRoot) => {
            const epic = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: "epic",
                summary: "An epic",
                assignee: CURRENT_USER,
            });
            await writeLivingDocSnapshot(taiRoot, "TAI", "project-home", [
                { epicKey: epic.key, status: Status.ToDo, childTotal: 0, childDone: 0 },
            ]);
            await backend.workTracker.transition(epic.key, Status.ToDo);
            await backend.workTracker.transition(epic.key, Status.InProgress);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.deepEqual(result.staleLivingDocs, [{ epicKey: epic.key, reason: "status: To Do → In Progress" }]);
        });
    });

    test("flags an Epic whose child completion tally moved since the snapshot, even with the Epic's own status unchanged", async () => {
        await withBackend(async (backend, taiRoot) => {
            const epic = await backend.workTracker.createIssue({ projectKey: "TAI", issueType: "epic", summary: "An epic" });
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "A story under it",
                parentKey: epic.key,
            });
            await writeLivingDocSnapshot(taiRoot, "TAI", "project-home", [
                { epicKey: epic.key, status: epic.status, childTotal: 1, childDone: 0 },
            ]);
            // Straight to Done, not via To Do: since TAI-374/387 a Story reaching To Do also schedules a
            // Backlog Epic, which would change the Epic's own status and defeat what this test checks
            // (the tally moving while the Epic's status stays put).
            await backend.workTracker.transition(story.key, Status.Done);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.deepEqual(result.staleLivingDocs, [{ epicKey: epic.key, reason: "0/1 → 1/1 stories done" }]);
        });
    });

    test("a child that merely moves between open statuses (no completion change) does NOT flag the Epic", async () => {
        await withBackend(async (backend, taiRoot) => {
            const epic = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: "epic",
                summary: "An epic",
                assignee: CURRENT_USER,
            });
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "A story under it",
                parentKey: epic.key,
                assignee: CURRENT_USER,
            });
            // Settle the story's first "work started" transition BEFORE snapshotting -- this
            // is what the upward parent-cascade (TAI-220/221/222) promotes the Epic on, and
            // that cascade only fires once (idempotently skipped once the parent's already
            // past ToDo/Backlog) -- so the snapshot below captures the Epic's real
            // post-cascade status, and the second story transition after it genuinely has no
            // further effect on the Epic to detect.
            await backend.workTracker.transition(story.key, Status.ToDo);
            await backend.workTracker.transition(story.key, Status.InProgress);
            const settledEpic = await backend.workTracker.getIssue(epic.key);

            await writeLivingDocSnapshot(taiRoot, "TAI", "project-home", [
                { epicKey: epic.key, status: settledEpic!.status, childTotal: 1, childDone: 0 },
            ]);
            await backend.workTracker.transition(story.key, Status.InReview);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.deepEqual(result.staleLivingDocs, []);
        });
    });
});
