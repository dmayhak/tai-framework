import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StoryType, SubtaskType, Persona, DependencyRelation, Status } from "../schema/story-schema.js";
import { createFilesystemBackend } from "./filesystem-backend.js";
import { toHumanId, toIssueKey, type HumanRef, type StorageBackend } from "./interface.js";

const CURRENT_USER: HumanRef = { id: toHumanId("del@example.com"), displayName: "Del", email: "del@example.com" };

// Each test gets its own temp dir — never touches the repo's real .tai/.
async function withBackend(fn: (backend: StorageBackend) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-fs-backend-"));
    try {
        await fn(createFilesystemBackend(dir, CURRENT_USER));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("upward cascade: Kickoff exemption and the To Do cascade (TAI-374/387)", () => {
    // Every issue gets an assignee so the In Progress entry gate never interferes with what is under test.
    async function make(backend: StorageBackend, issueType: StoryType | SubtaskType | "epic", summary: string, parentKey?: ReturnType<typeof toIssueKey>) {
        return backend.workTracker.createIssue({
            projectKey: "TAI",
            issueType,
            summary,
            assignee: CURRENT_USER,
            ...(parentKey ? { parentKey } : {}),
        });
    }
    const statusOf = async (b: StorageBackend, key: ReturnType<typeof toIssueKey>) => (await b.workTracker.getIssue(key))?.status;

    test("a Kickoff Story going In Progress leaves its Backlog Epic in Backlog", async () => {
        await withBackend(async (b) => {
            const epic = await make(b, "epic", "e");
            const kickoff = await make(b, StoryType.Kickoff, "k", epic.key);
            await b.workTracker.transition(kickoff.key, Status.InProgress);
            assert.equal(await statusOf(b, kickoff.key), Status.InProgress);
            assert.equal(await statusOf(b, epic.key), Status.Backlog);
        });
    });

    test("a subtask of a Kickoff going In Progress moves the Kickoff, not the Epic", async () => {
        await withBackend(async (b) => {
            const epic = await make(b, "epic", "e");
            const kickoff = await make(b, StoryType.Kickoff, "k", epic.key);
            const research = await make(b, SubtaskType.Research, "r", kickoff.key);
            await b.workTracker.transition(research.key, Status.InProgress);
            assert.equal(await statusOf(b, kickoff.key), Status.InProgress);
            assert.equal(await statusOf(b, epic.key), Status.Backlog);
        });
    });

    test("a normal Story going In Progress still moves its Epic", async () => {
        await withBackend(async (b) => {
            const epic = await make(b, "epic", "e");
            const story = await make(b, StoryType.Story, "s", epic.key);
            await b.workTracker.transition(story.key, Status.InProgress);
            assert.equal(await statusOf(b, epic.key), Status.InProgress);
        });
    });

    test("a subtask reaching To Do schedules its Backlog Story, and that schedules the Backlog Epic", async () => {
        await withBackend(async (b) => {
            const epic = await make(b, "epic", "e");
            const story = await make(b, StoryType.Story, "s", epic.key);
            const dev = await make(b, SubtaskType.Dev, "d", story.key);
            const result = await b.workTracker.transition(dev.key, Status.ToDo);
            assert.equal(result.ok, true);
            assert.equal(await statusOf(b, story.key), Status.ToDo);
            assert.equal(await statusOf(b, epic.key), Status.ToDo);
            if (result.ok) assert.deepEqual((result.affectedIssues ?? []).map((i) => i.key).sort(), [epic.key, story.key].sort());
        });
    });

    test("a subtask of a Kickoff reaching To Do schedules the Kickoff but NOT the Epic", async () => {
        await withBackend(async (b) => {
            const epic = await make(b, "epic", "e");
            const kickoff = await make(b, StoryType.Kickoff, "k", epic.key);
            const research = await make(b, SubtaskType.Research, "r", kickoff.key);
            await b.workTracker.transition(research.key, Status.ToDo);
            assert.equal(await statusOf(b, kickoff.key), Status.ToDo);
            assert.equal(await statusOf(b, epic.key), Status.Backlog);
        });
    });

    test("a Kickoff Story going To Do directly leaves its Backlog Epic in Backlog", async () => {
        await withBackend(async (b) => {
            const epic = await make(b, "epic", "e");
            const kickoff = await make(b, StoryType.Kickoff, "k", epic.key);
            await b.workTracker.transition(kickoff.key, Status.ToDo);
            assert.equal(await statusOf(b, epic.key), Status.Backlog);
        });
    });

    test("the To Do cascade never regresses a parent that is already started or Done", async () => {
        await withBackend(async (b) => {
            const epic = await make(b, "epic", "e");
            const story = await make(b, StoryType.Story, "s", epic.key);
            const dev = await make(b, SubtaskType.Dev, "d", story.key);
            await b.workTracker.transition(story.key, Status.InProgress);
            await b.workTracker.transition(dev.key, Status.ToDo);
            assert.equal(await statusOf(b, story.key), Status.InProgress);
            assert.equal(await statusOf(b, epic.key), Status.InProgress);
        });
    });
});

describe("issue CRUD", () => {
    // REGRESSION (TAI-15 code review): real Jira structurally rejects a parentless subtask;
    // this backend used to accept one silently — a portability trap for code developed and
    // tested here that would only fail once it hit Jira.
    test("rejects a subtask created with no parentKey", async () => {
        await withBackend(async ({ workTracker }) => {
            await assert.rejects(
                () =>
                    workTracker.createIssue({
                        projectKey: "TAI",
                        issueType: SubtaskType.Dev,
                        summary: "Orphaned subtask",
                    }),
                /every subtask has a parent/
            );
        });
    });

    test("accepts a story-level issue with no parentKey (Epics/Stories don't require one)", async () => {
        await withBackend(async ({ workTracker }) => {
            const issue = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Top-level work",
            });
            assert.equal(issue.parentKey, undefined);
        });
    });

    // TAI-226/228: found live (TAI-192 work) -- a second "dev" subtask (TAI-224) got created
    // under a story that already had one (TAI-193, Done) with no guard catching it.
    describe("duplicate-subtask guard (TAI-226/227/228)", () => {
        test("rejects a second subtask of the same type under the same parent, even when the existing one is Done", async () => {
            await withBackend(async ({ workTracker }) => {
                const story = await workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Parent story",
                });
                const first = await workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: SubtaskType.Dev,
                    parentKey: story.key,
                    summary: "First dev subtask",
                });
                await workTracker.transition(first.key, Status.Done);

                await assert.rejects(
                    () =>
                        workTracker.createIssue({
                            projectKey: "TAI",
                            issueType: SubtaskType.Dev,
                            parentKey: story.key,
                            summary: "Accidental duplicate dev subtask",
                        }),
                    new RegExp(`${first.key} \\(Done\\) already exists`)
                );
            });
        });

        test("allows a deliberate redo via allowDuplicate: true", async () => {
            await withBackend(async ({ workTracker }) => {
                const story = await workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Parent story",
                });
                const first = await workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: SubtaskType.Dev,
                    parentKey: story.key,
                    summary: "First dev subtask",
                });
                await workTracker.transition(first.key, Status.Canceled);

                const redo = await workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: SubtaskType.Dev,
                    parentKey: story.key,
                    summary: "Deliberate redo",
                    allowDuplicate: true,
                });
                assert.notEqual(redo.key, first.key);
            });
        });

        test("does not block SpikeTask, which has no fixed default owner and is explicitly ad-hoc/multi-instance", async () => {
            await withBackend(async ({ workTracker }) => {
                const story = await workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: StoryType.Story,
                    summary: "Parent story",
                });
                await workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: SubtaskType.SpikeTask,
                    parentKey: story.key,
                    persona: Persona.Developer,
                    summary: "First spike task",
                });
                const second = await workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: SubtaskType.SpikeTask,
                    parentKey: story.key,
                    persona: Persona.Architect,
                    summary: "Second, unrelated spike task",
                });
                assert.equal(second.issueType, SubtaskType.SpikeTask);
            });
        });
    });

    test("create, get, and update round-trip", async () => {
        await withBackend(async ({ workTracker }) => {
            const created = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Build the thing",
            });
            assert.equal(created.key, "TAI-1");
            // Brief §5.3 rev 27: `Backlog`, not `To Do`, is the default landing status.
            assert.equal(created.status, Status.Backlog);
            assert.equal(created.assignee, null);
            assert.equal(created.persona, null);
            assert.deepEqual(created.labels, []);
            assert.deepEqual(created.comments, []);

            const fetched = await workTracker.getIssue(created.key);
            assert.deepEqual(fetched, created);

            const updated = await workTracker.updateIssue(created.key, {
                summary: "Build the better thing",
                persona: Persona.Developer,
                description: "some detail",
            });
            assert.equal(updated.summary, "Build the better thing");
            assert.equal(updated.persona, Persona.Developer);
            assert.equal(updated.description, "some detail");

            // tri-state: null clears an optional field
            const cleared = await workTracker.updateIssue(created.key, { description: null });
            assert.equal(cleared.description, undefined);
        });
    });

    // TAI-372/379: same behavior as the Jira backend (conformance.ts covers it in TAI-380).
    describe("updateIssue: parent= and labels=", () => {
        test("labels replace the whole list, and [] clears", async () => {
            await withBackend(async ({ workTracker }) => {
                const s = await workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "s", labels: ["x"] });
                assert.deepEqual((await workTracker.updateIssue(s.key, { labels: ["a", "b"] })).labels, ["a", "b"]);
                assert.deepEqual((await workTracker.updateIssue(s.key, { labels: [] })).labels, []);
            });
        });

        test("rejects a label containing a space, like Jira does, and changes nothing", async () => {
            await withBackend(async ({ workTracker }) => {
                const s = await workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "s", labels: ["keep"] });
                await assert.rejects(() => workTracker.updateIssue(s.key, { labels: ["has space"] }), /spaces/);
                assert.deepEqual((await workTracker.getIssue(s.key))?.labels, ["keep"]);
            });
        });

        test("rejects an empty label instead of storing it (Jira would drop it)", async () => {
            await withBackend(async ({ workTracker }) => {
                const s = await workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "s", labels: ["keep"] });
                await assert.rejects(() => workTracker.updateIssue(s.key, { labels: ["a", ""] }), /empty/i);
                assert.deepEqual((await workTracker.getIssue(s.key))?.labels, ["keep"]);
            });
        });

        test("re-parents a Story under another Epic", async () => {
            await withBackend(async ({ workTracker }) => {
                const e1 = await workTracker.createIssue({ projectKey: "TAI", issueType: "epic", summary: "e1" });
                const e2 = await workTracker.createIssue({ projectKey: "TAI", issueType: "epic", summary: "e2" });
                const s = await workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "s", parentKey: e1.key });
                const moved = await workTracker.updateIssue(s.key, { parentKey: e2.key });
                assert.equal(moved.parentKey, e2.key);
                assert.equal((await workTracker.getIssue(s.key))?.parentKey, e2.key);
            });
        });

        test("rejects a subtask re-parent, a non-Epic parent and a missing parent, changing nothing", async () => {
            await withBackend(async ({ workTracker }) => {
                const e = await workTracker.createIssue({ projectKey: "TAI", issueType: "epic", summary: "e" });
                const s = await workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "s", parentKey: e.key });
                const other = await workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "other" });
                const d = await workTracker.createIssue({ projectKey: "TAI", issueType: SubtaskType.Dev, summary: "d", parentKey: s.key });
                await assert.rejects(() => workTracker.updateIssue(d.key, { parentKey: other.key }), /subtask/i);
                await assert.rejects(() => workTracker.updateIssue(s.key, { parentKey: other.key }), /must be an Epic/);
                await assert.rejects(() => workTracker.updateIssue(s.key, { parentKey: toIssueKey("TAI-404") }), /not found/i);
                assert.equal((await workTracker.getIssue(d.key))?.parentKey, s.key);
                assert.equal((await workTracker.getIssue(s.key))?.parentKey, e.key);
            });
        });
    });

    test("getIssue returns null for a missing key", async () => {
        await withBackend(async ({ workTracker }) => {
            assert.equal(await workTracker.getIssue(toIssueKey("TAI-999")), null);
        });
    });

    test("sequential unique key generation across many creates", async () => {
        await withBackend(async ({ workTracker }) => {
            const keys: string[] = [];
            for (let i = 0; i < 5; i++) {
                // SpikeTask (no fixed default owner) is exempt from the duplicate-subtask
                // guard -- this test is purely about key sequencing, not subtask semantics.
                const issue = await workTracker.createIssue({
                    projectKey: "TAI",
                    issueType: SubtaskType.SpikeTask,
                    parentKey: toIssueKey("TAI-0"),
                    summary: `Task ${i}`,
                });
                keys.push(issue.key);
            }
            assert.deepEqual(keys, ["TAI-1", "TAI-2", "TAI-3", "TAI-4", "TAI-5"]);
        });
    });
});

describe("transitions and assignment", () => {
    test("transition is permissive and returns ok:true (v1 filesystem backend)", async () => {
        await withBackend(async ({ workTracker }) => {
            const issue = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Spike,
                summary: "Investigate",
            });
            const result = await workTracker.transition(issue.key, Status.Canceled);
            assert.equal(result.ok, true);
            if (result.ok) assert.equal(result.issue.status, Status.Canceled);

            const fetched = await workTracker.getIssue(issue.key);
            assert.equal(fetched?.status, Status.Canceled);
        });
    });

    // Brief §5.5 (rev 19): no unassigned work in progress. Regression — this backend used
    // to be unconditionally permissive, which diverged from the Jira backend's gate. Caught
    // by the conformance suite (TAI-15).
    test("blocks In Progress / In Review without an Assignee", async () => {
        await withBackend(async ({ workTracker }) => {
            const issue = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                parentKey: toIssueKey("TAI-0"),
                summary: "Needs an owner",
            });
            const inProgress = await workTracker.transition(issue.key, Status.InProgress);
            assert.equal(inProgress.ok, false);
            const inReview = await workTracker.transition(issue.key, Status.InReview);
            assert.equal(inReview.ok, false);
        });
    });

    test("allows In Progress / In Review once assigned; terminal states never need one", async () => {
        await withBackend(async ({ workTracker }) => {
            const issue = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                parentKey: toIssueKey("TAI-0"),
                summary: "Needs an owner",
            });
            const unassignedDone = await workTracker.transition(issue.key, Status.Done);
            assert.equal(unassignedDone.ok, true, "terminal states are exempt from the gate");

            await workTracker.assignIssue(issue.key, CURRENT_USER);
            const started = await workTracker.transition(issue.key, Status.InProgress);
            assert.equal(started.ok, true);
        });
    });

    test("getAvailableTransitions returns every Status", async () => {
        await withBackend(async ({ workTracker }) => {
            const issue = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Kickoff,
                summary: "Kick it off",
            });
            const transitions = await workTracker.getAvailableTransitions(issue.key);
            assert.deepEqual([...transitions].sort(), Object.values(Status).sort());
        });
    });

    test("assignIssue sets and clears the native assignee", async () => {
        await withBackend(async ({ workTracker }) => {
            const issue = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                parentKey: toIssueKey("TAI-0"),
                summary: "Implement",
            });
            const assigned = await workTracker.assignIssue(issue.key, CURRENT_USER);
            assert.equal(assigned.ok, true);
            if (assigned.ok) assert.deepEqual(assigned.issue.assignee, CURRENT_USER);

            const unassigned = await workTracker.assignIssue(issue.key, null);
            if (unassigned.ok) assert.equal(unassigned.issue.assignee, null);
        });
    });
});

// TAI-220/221/222: a Subtask starting real work should cascade its parent Story (and that
// Story's own Epic, if any) to In Progress -- a real write, not just the existing read-time
// Epic derivation in ready.ts.
describe("parent-status cascade gate", () => {
    test("cascades Subtask -> Story -> Epic in one transition call", async () => {
        await withBackend(async ({ workTracker }) => {
            const epic = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: "epic",
                summary: "Epic",
            });
            const story = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                parentKey: epic.key,
                summary: "Story",
            });
            const dev = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                parentKey: story.key,
                summary: "Dev",
            });
            // The cascade recurses through the FULL transition() -- including the assignment
            // gate -- for each ancestor, so each one needs its own assignee to actually move.
            await workTracker.assignIssue(epic.key, CURRENT_USER);
            await workTracker.assignIssue(story.key, CURRENT_USER);
            await workTracker.assignIssue(dev.key, CURRENT_USER);

            const result = await workTracker.transition(dev.key, Status.InProgress);
            assert.equal(result.ok, true, "the child's own transition must still succeed");

            const fetchedStory = await workTracker.getIssue(story.key);
            assert.equal(fetchedStory?.status, Status.InProgress, "the parent Story must cascade");
            const fetchedEpic = await workTracker.getIssue(epic.key);
            assert.equal(fetchedEpic?.status, Status.InProgress, "the Epic must cascade one level further up");
            // TAI-304/311 ADR: affectedIssues carries every OTHER issue the cascade
            // actually mutated, so a caller (CachingWorkTracker) can cache all of them.
            if (result.ok) {
                const affectedKeys = (result.affectedIssues ?? []).map((i) => i.key).sort();
                assert.deepEqual(affectedKeys, [epic.key, story.key].sort(), "both the Story and the Epic must be reported");
            }
        });
    });

    // Jira allows a Story to have no Epic (a legitimate, common shape, not an edge case to
    // guard against) -- the cascade must stop cleanly at the Story with no error, rather than
    // assuming an Epic always exists one level further up.
    test("cascades Subtask -> Story and stops cleanly when the Story has no Epic", async () => {
        await withBackend(async ({ workTracker }) => {
            const story = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Top-level story, no Epic",
            });
            const dev = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                parentKey: story.key,
                summary: "Dev",
            });
            await workTracker.assignIssue(story.key, CURRENT_USER);
            await workTracker.assignIssue(dev.key, CURRENT_USER);

            const result = await workTracker.transition(dev.key, Status.InProgress);
            assert.equal(result.ok, true);

            const fetchedStory = await workTracker.getIssue(story.key);
            assert.equal(fetchedStory?.status, Status.InProgress, "the Story must still cascade");
            assert.equal(fetchedStory?.parentKey, undefined, "confirms this Story genuinely has no Epic");
        });
    });

    test("never regresses a Done or In Review parent backward to In Progress", async () => {
        await withBackend(async ({ workTracker }) => {
            const story = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Already-finished story",
            });
            await workTracker.transition(story.key, Status.Done);

            const dev = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                parentKey: story.key,
                summary: "Unrelated follow-up work",
            });
            await workTracker.assignIssue(dev.key, CURRENT_USER);
            await workTracker.transition(dev.key, Status.InProgress);

            const fetchedStory = await workTracker.getIssue(story.key);
            assert.equal(fetchedStory?.status, Status.Done, "a Done parent must never be moved backward");
        });
    });

    test("is idempotent -- a parent already In Progress is left alone, not re-written", async () => {
        await withBackend(async ({ workTracker }) => {
            const story = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story",
            });
            await workTracker.assignIssue(story.key, CURRENT_USER);
            await workTracker.transition(story.key, Status.InProgress);
            const beforeSecondChild = await workTracker.getIssue(story.key);

            const secondDev = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                parentKey: story.key,
                summary: "Second child starting later",
                allowDuplicate: true,
            });
            await workTracker.assignIssue(secondDev.key, CURRENT_USER);
            await workTracker.transition(secondDev.key, Status.InProgress);

            const afterSecondChild = await workTracker.getIssue(story.key);
            assert.equal(afterSecondChild?.status, Status.InProgress);
            assert.equal(
                afterSecondChild?.updatedAt,
                beforeSecondChild?.updatedAt,
                "an already-In-Progress parent must not be re-written at all"
            );
        });
    });

    test("a rejected parent-cascade transition is best-effort -- the child's own transition still succeeds", async () => {
        await withBackend(async ({ workTracker }) => {
            // The parent Story has no assignee -- its own cascade transition to In Progress
            // will be rejected by the assignment gate. The child is assigned, so ITS
            // transition must still succeed regardless.
            const story = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Unassigned parent story",
            });
            const dev = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                parentKey: story.key,
                summary: "Dev",
            });
            await workTracker.assignIssue(dev.key, CURRENT_USER);

            const result = await workTracker.transition(dev.key, Status.InProgress);
            assert.equal(result.ok, true, "a rejected cascade must never block the child's own transition");

            const fetchedStory = await workTracker.getIssue(story.key);
            assert.equal(fetchedStory?.status, Status.Backlog, "the rejected parent cascade must not have applied");
        });
    });

    test("does not fire for a transition into Done", async () => {
        await withBackend(async ({ workTracker }) => {
            const story = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story",
            });
            const dev = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                parentKey: story.key,
                summary: "Dev",
            });
            await workTracker.transition(dev.key, Status.Done);

            const fetchedStory = await workTracker.getIssue(story.key);
            assert.equal(fetchedStory?.status, Status.Backlog, "Done must never trigger the cascade");
        });
    });
});

// TAI-41 ADR's "hard" checkpoint kind, TAI-42's own scope: REVIEW_GATES enforcement
// (brief §3.3/§3.9/§5.6), same gate the Jira backend enforces (work-tracker.test.ts) — kept
// identical across backends so this doesn't become another TAI-15-style divergence.
describe("the review gate", () => {
    async function rosterWith(backend: StorageBackend, rows: [role: string, human: string][]) {
        await backend.docStore.createPage({
            spaceKey: "TAI",
            title: "Persona Roster",
            content: [
                "| Persona | Authorized humans |",
                "| --- | --- |",
                ...rows.map(([role, human]) => `| ${role} | ${human} |`),
            ].join("\n"),
        });
    }

    test("blocks Kickoff In Review -> Done when a required reviewer hasn't approved", async () => {
        await withBackend(async (backend) => {
            await rosterWith(backend, [["PM", "Del"]]); // UX Designer deliberately absent
            const issue = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Kickoff,
                summary: "Kick it off",
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(issue.key, Status.InReview);
            await backend.workTracker.addComment(issue.key, "Approved: ready");

            const res = await backend.workTracker.transition(issue.key, Status.Done);
            assert.equal(res.ok, false);
            assert.match(res.ok === false ? res.reason : "", /UX Designer/);
        });
    });

    test("blocks Kickoff In Review -> Done when the commenter isn't in the roster for that persona", async () => {
        await withBackend(async (backend) => {
            await rosterWith(backend, [
                ["PM", "Someone Else"],
                ["UX Designer", "Someone Else"],
            ]);
            const issue = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Kickoff,
                summary: "Kick it off",
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(issue.key, Status.InReview);
            await backend.workTracker.addComment(issue.key, "Approved: ready"); // authored by CURRENT_USER

            const res = await backend.workTracker.transition(issue.key, Status.Done);
            assert.equal(res.ok, false);
        });
    });

    test("allows Kickoff In Review -> Done once both required reviewers approve", async () => {
        await withBackend(async (backend) => {
            // One human can satisfy both required reviewers at once (brief §5.6: a human
            // may appear under multiple personas) — a single Approved: comment suffices.
            await rosterWith(backend, [
                ["PM", "Del"],
                ["UX Designer", "Del"],
            ]);
            const issue = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Kickoff,
                summary: "Kick it off",
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(issue.key, Status.InReview);
            await backend.workTracker.addComment(issue.key, "Approved: ready");

            const res = await backend.workTracker.transition(issue.key, Status.Done);
            assert.equal(res.ok, true);
        });
    });

    /**
     * REGRESSION guard (found in self-review before this ever shipped). This backend is
     * permissive by design — every Status reachable from every Status — so a gate keyed to
     * "current status is In Review" would be trivially bypassable by transitioning straight
     * from To Do to Done. `reviewGateApplies` checks only the target, not the source,
     * specifically to close this off.
     */
    test("still blocks Done when skipping straight from To Do (no strict workflow to rely on)", async () => {
        await withBackend(async (backend) => {
            await rosterWith(backend, [["PM", "Del"]]); // UX Designer deliberately absent
            const issue = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Kickoff,
                summary: "Kick it off",
                assignee: CURRENT_USER,
            });
            const res = await backend.workTracker.transition(issue.key, Status.Done);
            assert.equal(res.ok, false);
        });
    });

    test("does not apply to a Dev subtask — only story-level issues carry a review gate", async () => {
        await withBackend(async (backend) => {
            // No Persona Roster page created at all — if the gate wrongly applied here, this
            // would throw (loadRoster refuses to silently treat a missing roster as empty),
            // not just fail. It must not even try.
            const parent = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Parent",
            });
            const issue = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                parentKey: parent.key,
                summary: "Implement",
                assignee: CURRENT_USER,
            });
            await backend.workTracker.transition(issue.key, Status.InReview);
            const res = await backend.workTracker.transition(issue.key, Status.Done);
            assert.equal(res.ok, true);
        });
    });
});

describe("resolveHuman", () => {
    test("matches currentUser's own email", async () => {
        await withBackend(async ({ workTracker }) => {
            const human = await workTracker.resolveHuman("del@example.com");
            assert.deepEqual(human, CURRENT_USER);
        });
    });

    test("returns null for any other email", async () => {
        await withBackend(async ({ workTracker }) => {
            const human = await workTracker.resolveHuman("someone-else@example.com");
            assert.equal(human, null);
        });
    });
});

describe("comments and labels", () => {
    test("addComment attributes to currentUser and appends", async () => {
        await withBackend(async ({ workTracker }) => {
            const issue = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Bug,
                summary: "Fix it",
            });
            const comment = await workTracker.addComment(issue.key, "Q: what's the repro?");
            assert.equal(comment.body, "Q: what's the repro?");
            assert.deepEqual(comment.author, CURRENT_USER);

            const fetched = await workTracker.getIssue(issue.key);
            assert.equal(fetched?.comments.length, 1);
            assert.equal(fetched?.comments[0].id, comment.id);
            assert.equal(comment.createdAt, comment.updatedAt);
        });
    });

    test("editComment updates body and updatedAt, leaves createdAt/author/id alone", async () => {
        await withBackend(async ({ workTracker }) => {
            const issue = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Bug,
                summary: "Fix it",
            });
            const original = await workTracker.addComment(issue.key, "Q: what's the repro?");
            const edited = await workTracker.editComment(issue.key, original.id, "Q: what's the exact repro?");

            assert.equal(edited.id, original.id);
            assert.equal(edited.body, "Q: what's the exact repro?");
            assert.equal(edited.createdAt, original.createdAt);
            assert.deepEqual(edited.author, original.author);

            const fetched = await workTracker.getIssue(issue.key);
            assert.equal(fetched?.comments[0].body, "Q: what's the exact repro?");
        });
    });

    test("addLabel is idempotent, removeLabel removes", async () => {
        await withBackend(async ({ workTracker }) => {
            const issue = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Bug,
                summary: "Fix it",
            });
            await workTracker.addLabel(issue.key, "urgent");
            await workTracker.addLabel(issue.key, "urgent"); // duplicate, should no-op
            let fetched = await workTracker.getIssue(issue.key);
            assert.deepEqual(fetched?.labels, ["urgent"]);

            await workTracker.removeLabel(issue.key, "urgent");
            fetched = await workTracker.getIssue(issue.key);
            assert.deepEqual(fetched?.labels, []);
        });
    });
});

describe("issue links", () => {
    test("createLink + getLinkedIssues resolve both directions", async () => {
        await withBackend(async ({ workTracker }) => {
            const a = await workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "A" });
            const b = await workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "B" });
            await workTracker.createLink(a.key, DependencyRelation.DependsOn, b.key);

            const outgoing = await workTracker.getLinkedIssues(a.key, DependencyRelation.DependsOn, "outgoing");
            assert.deepEqual([...outgoing], [{ relation: DependencyRelation.DependsOn, key: b.key }]);

            const incoming = await workTracker.getLinkedIssues(b.key, DependencyRelation.DependsOn, "incoming");
            assert.deepEqual([...incoming], [{ relation: DependencyRelation.DependsOn, key: a.key }]);

            // wrong direction from b's perspective finds nothing
            const none = await workTracker.getLinkedIssues(b.key, DependencyRelation.DependsOn, "outgoing");
            assert.deepEqual([...none], []);
        });
    });
});

describe("pages", () => {
    test("createPage, getPage by id and by title, updatePage", async () => {
        await withBackend(async ({ docStore }) => {
            const page = await docStore.createPage({
                spaceKey: "TAI",
                title: "Persona Roster",
                content: "| Persona | Humans |\n|---|---|\n",
            });
            assert.equal(page.id, "TAI-1");

            const byId = await docStore.getPage({ id: page.id });
            assert.deepEqual(byId, page);

            const byTitle = await docStore.getPage({ spaceKey: "TAI", title: "Persona Roster" });
            assert.deepEqual(byTitle, page);

            const missing = await docStore.getPage({ spaceKey: "TAI", title: "Nope" });
            assert.equal(missing, null);

            const updated = await docStore.updatePage({ id: page.id }, { content: "updated body" });
            assert.equal(updated.content, "updated body");
            assert.equal(updated.title, "Persona Roster"); // unchanged
        });
    });

    // TAI-305 (PR #89 review): a cross-space move would silently orphan the page --
    // getChildren scans only the target parent's own space directory, so the page would
    // never be found there despite updatePage reporting success. Covered here (not
    // conformance.ts) since the shared harness only provisions one space per backend.
    test("updatePage rejects a cross-space parentId move", async () => {
        await withBackend(async ({ docStore }) => {
            const otherSpaceParent = await docStore.createPage({
                spaceKey: "OTHER",
                title: "Other space parent",
                content: "x",
            });
            const page = await docStore.createPage({ spaceKey: "TAI", title: "Movable", content: "x" });

            await assert.rejects(
                () => docStore.updatePage({ id: page.id }, { parentId: otherSpaceParent.id }),
                /different spaces/i
            );
        });
    });

    test("getChildren filters by parentId", async () => {
        await withBackend(async ({ docStore }) => {
            const parent = await docStore.createPage({ spaceKey: "TAI", title: "ADRs", content: "index" });
            const child1 = await docStore.createPage({
                spaceKey: "TAI",
                title: "ADR 1",
                content: "...",
                parentId: parent.id,
            });
            await docStore.createPage({ spaceKey: "TAI", title: "Unrelated", content: "..." });

            const children = await docStore.getChildren({ id: parent.id });
            assert.deepEqual(
                children.map((c) => c.id),
                [child1.id]
            );
        });
    });

    test("addComment on a page", async () => {
        await withBackend(async ({ docStore }) => {
            const page = await docStore.createPage({ spaceKey: "TAI", title: "Notes", content: "..." });
            const comment = await docStore.addComment({ id: page.id }, "Approved: looks good");
            assert.equal(comment.body, "Approved: looks good");
            const fetched = await docStore.getPage({ id: page.id });
            assert.equal(fetched?.comments.length, 1);
        });
    });

    test("editComment on a page updates body and updatedAt", async () => {
        await withBackend(async ({ docStore }) => {
            const page = await docStore.createPage({ spaceKey: "TAI", title: "Notes", content: "..." });
            const original = await docStore.addComment({ id: page.id }, "Approved: looks good");
            const edited = await docStore.editComment({ id: page.id }, original.id, "Approved: looks good, ship it");

            assert.equal(edited.id, original.id);
            assert.equal(edited.body, "Approved: looks good, ship it");
            assert.equal(edited.createdAt, original.createdAt);

            const fetched = await docStore.getPage({ id: page.id });
            assert.equal(fetched?.comments[0].body, "Approved: looks good, ship it");
        });
    });
});

describe("issue<->page links", () => {
    test("linkPage is visible from both WorkTracker and DocStore sides", async () => {
        await withBackend(async ({ workTracker, docStore }) => {
            const issue = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Kickoff,
                summary: "Discovery",
            });
            const page = await docStore.createPage({ spaceKey: "TAI", title: "PRD", content: "..." });

            await workTracker.linkPage(issue.key, page.id);

            const linkedPages = await workTracker.getLinkedPages(issue.key);
            assert.deepEqual([...linkedPages], [page.id]);

            const linkedIssues = await docStore.getLinkedIssues({ id: page.id });
            assert.deepEqual([...linkedIssues], [issue.key]);
        });
    });
});

describe("search", () => {
    test("filters by type, status, persona, assignee, parentKey, updatedSince, limit", async () => {
        await withBackend(async ({ workTracker }) => {
            const parent = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Parent",
            });
            const dev = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Dev work",
                persona: Persona.Developer,
                parentKey: parent.key,
            });
            await workTracker.assignIssue(dev.key, CURRENT_USER);
            const review = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.CodeReview,
                summary: "Review it",
                persona: Persona.CodeReviewer,
                parentKey: parent.key,
            });
            await workTracker.transition(review.key, Status.Done);

            const byType = await workTracker.search({ projectKey: "TAI", issueTypes: [SubtaskType.Dev] });
            assert.deepEqual(
                byType.map((i) => i.key),
                [dev.key]
            );

            const byStatus = await workTracker.search({ projectKey: "TAI", statuses: [Status.Done] });
            assert.deepEqual(
                byStatus.map((i) => i.key),
                [review.key]
            );

            const byPersona = await workTracker.search({ projectKey: "TAI", persona: Persona.Developer });
            assert.deepEqual(
                byPersona.map((i) => i.key),
                [dev.key]
            );

            const byAssignee = await workTracker.search({ projectKey: "TAI", assignee: CURRENT_USER.id });
            assert.deepEqual(
                byAssignee.map((i) => i.key),
                [dev.key]
            );

            const byParent = await workTracker.search({ projectKey: "TAI", parentKey: parent.key });
            assert.equal(byParent.length, 2);

            const future = new Date(Date.now() + 60_000).toISOString();
            const noneUpdatedSince = await workTracker.search({ projectKey: "TAI", updatedSince: future });
            assert.deepEqual(noneUpdatedSince, []);

            const limited = await workTracker.search({ projectKey: "TAI", limit: 1 });
            assert.equal(limited.length, 1);
        });
    });

    test("search on an unknown project returns an empty array, not an error", async () => {
        await withBackend(async ({ workTracker }) => {
            const results = await workTracker.search({ projectKey: "NOPE" });
            assert.deepEqual(results, []);
        });
    });
});

describe("attachments (stub level)", () => {
    test("listAttachments returns an empty array when none exist", async () => {
        await withBackend(async ({ workTracker, docStore }) => {
            const issue = await workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Bug,
                summary: "Fix it",
            });
            assert.deepEqual(await workTracker.listAttachments(issue.key), []);

            const page = await docStore.createPage({ spaceKey: "TAI", title: "Doc", content: "..." });
            assert.deepEqual(await docStore.listAttachments({ id: page.id }), []);
        });
    });
});

describe("flagged (TAI-390)", () => {
    const make = (b: StorageBackend) =>
        b.workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "s" });

    test("a new issue is not flagged; true sets it, false clears it, undefined leaves it alone", async () => {
        await withBackend(async (b) => {
            const issue = await make(b);
            assert.equal(issue.flagged, undefined);

            const set = await b.workTracker.updateIssue(issue.key, { flagged: true });
            assert.equal(set.flagged, true);
            assert.equal((await b.workTracker.getIssue(issue.key))?.flagged, true);

            const untouched = await b.workTracker.updateIssue(issue.key, { summary: "renamed" });
            assert.equal(untouched.flagged, true, "an update that does not mention flagged must not clear it");

            const cleared = await b.workTracker.updateIssue(issue.key, { flagged: false });
            assert.equal("flagged" in cleared, false, "cleared means absent, same shape the Jira backend reads back");
            assert.equal("flagged" in ((await b.workTracker.getIssue(issue.key)) ?? {}), false);
        });
    });

    test("flagging does not change status, labels or assignee", async () => {
        await withBackend(async (b) => {
            const issue = await make(b);
            const flagged = await b.workTracker.updateIssue(issue.key, { flagged: true });
            assert.equal(flagged.status, issue.status);
            assert.deepEqual(flagged.labels, issue.labels);
            assert.equal(flagged.assignee, issue.assignee);
        });
    });
});
