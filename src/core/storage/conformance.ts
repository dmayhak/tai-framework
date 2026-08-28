/**
 * TAI Framework — Backend conformance suite (TAI-15)
 *
 * Brief §3.2 claims "TypeScript interfaces enforce that every backend implements it
 * identically" — but types enforce SHAPE, not BEHAVIOR. Two backends can both satisfy
 * `StorageBackend` and still disagree about what `transition()` does on a rejection, whether
 * `getIssue` on a missing key returns `null` or throws, or how a tri-state `IssuePatch`
 * clears a field. This file is the one shared spec that actually checks behavior, run
 * against every backend via `defineStorageConformance()`.
 *
 * It found real divergences before this comment was written: the filesystem backend's
 * `transition()` didn't enforce brief §5.5's assignment gate the way the Jira backend does
 * (fixed, filesystem-backend.ts), and `DocStore.getLinkedIssues(page)` is answerable on one
 * backend but not the other by the underlying systems' own nature (documented below as a
 * capability, not silently skipped, per this ticket's acceptance criteria).
 *
 * Where behavior legitimately differs, the difference is an explicit `StorageCapabilities`
 * flag that the test branches on — never a silent skip. A skip only exists where a question
 * is entirely inapplicable to a backend (e.g. "does the SERVER reject a bad accountId" has
 * no meaningful non-Jira analogue beyond what `validatesAssignee` already covers).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { Persona, Status, StoryType, SubtaskType, DependencyRelation } from "../schema/story-schema.js";
import {
    type StorageBackend,
    type IssueKey,
    type PageId,
    type HumanRef,
    StorageConnectivityError,
} from "./interface.js";

// ---------- Capabilities: where behavior legitimately differs ----------

export interface StorageCapabilities {
    /**
     * Does the backend reject a transition to an arbitrary status with no direct path?
     *
     * The filesystem backend is permissive by design (every Status reachable from every
     * Status — no fake validator to simulate). Jira COULD be strict here too, if a project's
     * workflow scheme defines real transition paths — but the live TAI/TAIT projects use
     * Jira's shared default workflow, which deliberately allows every transition from every
     * status (confirmed live: `getAvailableTransitions` on a fresh To Do issue already lists
     * all five statuses). That is not an oversight — brief §3.3 is explicit that Jira's own
     * workflow is NOT how TAI enforces checkpoints ("TAI's own plugin layer is the enforcer
     * of checkpoints... native Jira validators... serve only as optional defense-in-depth").
     * So `false` on Jira here doesn't mean "the backend can't be strict," it means "this
     * deployment correctly leaves that job to TAI's own logic (§3.3/§3.4), not to Jira."
     */
    readonly strictWorkflow: boolean;

    /**
     * Does the backend validate an assignee against a real directory of humans (a bogus id
     * is rejected)? Jira: yes (accountId must exist). The filesystem backend accepts any
     * HumanRef — there is no external directory to validate against.
     */
    readonly validatesAssignee: boolean;

    /**
     * Can `DocStore.getLinkedIssues(page)` actually answer "which issues reference this
     * page"? The filesystem backend can (it owns a local link index). The Jira/Confluence
     * backend cannot: Jira owns the issue->page remote link and exposes no reverse index —
     * it throws, and that throw is asserted here, not swallowed.
     */
    readonly answersPageToIssueLinks: boolean;

    /**
     * Does clearing `description` (via `IssuePatch.description: null`) read back as `""`
     * rather than `undefined`? Found by running this suite against live Jira: Jira's own
     * storage does not distinguish "no description" from "empty description" through this
     * write path — the filesystem backend has no such limitation and genuinely clears to
     * `undefined`. `false` here means the backend can represent true absence; `true` means
     * "cleared" and "explicitly emptied" collapse to the same thing on read.
     */
    readonly clearedDescriptionIsEmptyString: boolean;
}

// ---------- Harness: what each backend supplies to run the shared suite ----------

export interface ConformanceHarness {
    readonly backend: StorageBackend;
    readonly projectKey: string;
    readonly spaceKey: string;
    readonly capabilities: StorageCapabilities;
    /** A human the backend will actually accept as an assignee (Jira: a real accountId). */
    readonly validAssignee: HumanRef;
    /** A human the backend SHOULD reject when `validatesAssignee` is true. */
    readonly invalidAssignee: HumanRef;
    /**
     * Dispose of a fixture issue the way this backend requires. Never assume delete is
     * possible: Jira Cloud's Free plan cannot delete issues at all (confirmed live while
     * provisioning TAIT, TAI-17) — the Jira harness cancels + labels instead, per brief
     * §5.3's Canceled status. The filesystem harness can genuinely delete (or rely on its
     * tmp-dir teardown) since there's no external system to keep clean.
     */
    disposeIssue(key: IssueKey): Promise<void>;
    /** Same idea for pages — Confluence page delete DOES work, so the Jira harness can use it. */
    disposePage(id: PageId): Promise<void>;
}

export interface DefineConformanceOptions {
    /** Pass a reason string to skip the whole suite (e.g. missing live-backend credentials);
     *  `false`/omitted runs it. Node still registers the nested tests either way — only
     *  execution is skipped — so this never risks calling `setup()` when creds are absent. */
    readonly skip?: string | false;
}

/**
 * Run the shared conformance spec against one backend. Call this once per backend from a
 * dedicated `*.conformance.test.ts` file — `describe`/`it` are registered synchronously at
 * import time, which is what lets `node --test` discover them per file.
 */
export function defineStorageConformance(
    label: string,
    setup: () => Promise<ConformanceHarness> | ConformanceHarness,
    options: DefineConformanceOptions = {}
): void {
    describe(`storage conformance: ${label}`, { skip: options.skip ?? false }, () => {
        let h: ConformanceHarness;
        // A subtask ALWAYS has a parent Story/Bug/Kickoff/Spike (brief §5.1) — Jira enforces
        // this structurally and rejects a sub-task-typed issue created with no parent. Every
        // subtask fixture below shares one real parent rather than each test growing its own,
        // both for realism (this is how TAI actually models work) and because most of these
        // tests don't care what the parent is, only that one exists.
        let sharedParentKey: IssueKey;
        const cleanupIssues: IssueKey[] = [];
        const cleanupPages: PageId[] = [];

        before(async () => {
            h = await setup();
            const parent = await h.backend.workTracker.createIssue({
                projectKey: h.projectKey,
                issueType: StoryType.Story,
                summary: "Conformance: shared subtask parent",
            });
            cleanupIssues.push(parent.key);
            sharedParentKey = parent.key;
        });

        after(async () => {
            for (const key of cleanupIssues) await h.disposeIssue(key).catch(() => {});
            for (const id of cleanupPages) await h.disposePage(id).catch(() => {});
        });

        function track<T extends { key: IssueKey }>(issue: T): T {
            cleanupIssues.push(issue.key);
            return issue;
        }
        function trackPage<T extends { id: PageId }>(page: T): T {
            cleanupPages.push(page.id);
            return page;
        }

        // ---------- Issue CRUD ----------

        describe("WorkTracker: issue CRUD", () => {
            it("creates and reads back an issue with the fields set", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        // Unrelated fixtures intentionally reuse one shared Dev-typed parent
                        // (see `sharedParentKey`'s own doc comment) -- not a real redo, just
                        // deliberate reuse, so it opts out of the TAI-226/228 duplicate-subtask
                        // guard explicitly rather than tripping it.
                        allowDuplicate: true,
                        summary: "Conformance: create+get",
                        description: "original description",
                        persona: Persona.Developer,
                    })
                );
                assert.equal(issue.summary, "Conformance: create+get");
                assert.equal(issue.description, "original description");
                assert.equal(issue.persona, Persona.Developer);
                assert.equal(issue.status, Status.ToDo, "new issues start at To Do on every backend");
                assert.deepEqual(issue.comments, []);

                const fetched = await h.backend.workTracker.getIssue(issue.key);
                assert.equal(fetched?.summary, issue.summary);
                assert.equal(fetched?.description, issue.description);
            });

            it("defaults assignee and persona to null when not given", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.SpikeTask, // no default owner (brief §5.2)
                        parentKey: sharedParentKey,
                        summary: "Conformance: defaults",
                    })
                );
                assert.equal(issue.assignee, null);
                assert.equal(issue.persona, null);
            });

            it("returns null for a missing issue, never throws", async () => {
                const missing = await h.backend.workTracker.getIssue(
                    `${h.projectKey}-999999` as IssueKey
                );
                assert.equal(missing, null);
            });

            it("updateIssue tri-state: undefined leaves a field alone, null clears it, a value sets it", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        // Unrelated fixtures intentionally reuse one shared Dev-typed parent
                        // (see `sharedParentKey`'s own doc comment) -- not a real redo, just
                        // deliberate reuse, so it opts out of the TAI-226/228 duplicate-subtask
                        // guard explicitly rather than tripping it.
                        allowDuplicate: true,
                        summary: "Conformance: tri-state",
                        description: "keep me",
                        priority: "High",
                    })
                );

                // undefined (omitted) -> unchanged
                const untouched = await h.backend.workTracker.updateIssue(issue.key, {
                    summary: "Conformance: tri-state (renamed)",
                });
                assert.equal(untouched.description, "keep me", "omitting description must leave it alone");
                assert.equal(untouched.priority, "High", "omitting priority must leave it alone");

                // null -> cleared. What "cleared" reads back as is a genuine capability
                // difference, found by running this against live Jira: Jira's own storage
                // does not distinguish "no description" from "empty description" through this
                // write path — clearing via null reads back as "", not absent. The filesystem
                // backend has no such limitation and genuinely clears to undefined.
                const cleared = await h.backend.workTracker.updateIssue(issue.key, { description: null });
                assert.equal(
                    cleared.description,
                    h.capabilities.clearedDescriptionIsEmptyString ? "" : undefined,
                    "null must clear description (to undefined, or to \"\" where the backend can't represent true absence)"
                );

                // a value -> set
                const reset = await h.backend.workTracker.updateIssue(issue.key, {
                    description: "back again",
                });
                assert.equal(reset.description, "back again");
            });

            it("component is subtask-scoped: set then clear round-trips (brief §4/§5.4)", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        // Unrelated fixtures intentionally reuse one shared Dev-typed parent
                        // (see `sharedParentKey`'s own doc comment) -- not a real redo, just
                        // deliberate reuse, so it opts out of the TAI-226/228 duplicate-subtask
                        // guard explicitly rather than tripping it.
                        allowDuplicate: true,
                        summary: "Conformance: component",
                    })
                );
                const withComponent = await h.backend.workTracker.updateIssue(issue.key, {
                    component: "tai-framework",
                });
                assert.equal(withComponent.component, "tai-framework");
                const cleared = await h.backend.workTracker.updateIssue(issue.key, { component: null });
                assert.equal(cleared.component, undefined);
            });

            // TAI-226/227/228/229: found live (TAI-192 work) -- a second "dev" subtask
            // (TAI-224) got created under a story that already had one (TAI-193, Done) with
            // no guard catching it. Own local parent (not `sharedParentKey`) since this test
            // is specifically about one-per-story-instance semantics, not generic CRUD.
            it("createIssue rejects a duplicate fixed-owner subtask, regardless of the existing sibling's status, unless allowDuplicate is set (ADR: Confluence page 29720577)", async () => {
                const parent = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: duplicate-subtask guard parent",
                    })
                );
                const first = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: parent.key,
                        summary: "Conformance: first dev subtask",
                    })
                );
                // Terminal status must still block -- this is exactly what TAI-193 (Done)
                // failed to prevent for TAI-224.
                await h.backend.workTracker.transition(first.key, Status.Done);

                await assert.rejects(
                    () =>
                        h.backend.workTracker.createIssue({
                            projectKey: h.projectKey,
                            issueType: SubtaskType.Dev,
                            parentKey: parent.key,
                            summary: "Conformance: accidental duplicate",
                        }),
                    new RegExp(`${first.key} \\(Done\\) already exists`)
                );

                const redo = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: parent.key,
                        summary: "Conformance: deliberate redo",
                        allowDuplicate: true,
                    })
                );
                assert.notEqual(redo.key, first.key, "allowDuplicate must let a genuine redo through");

                // SpikeTask has no fixed default owner (SUBTASK_OWNER[SpikeTask] === null) --
                // explicitly exempt from the guard, no allowDuplicate needed.
                await h.backend.workTracker.createIssue({
                    projectKey: h.projectKey,
                    issueType: SubtaskType.SpikeTask,
                    parentKey: parent.key,
                    summary: "Conformance: first spike task",
                });
                const secondSpike = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.SpikeTask,
                        parentKey: parent.key,
                        summary: "Conformance: second spike task",
                    })
                );
                assert.equal(secondSpike.issueType, SubtaskType.SpikeTask);
            });
        });

        // ---------- Transitions & the §5.5 assignment gate ----------

        describe("WorkTracker: transition() and the assignment gate", () => {
            it("blocks In Progress / In Review without an Assignee (brief §5.5, every backend)", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        // Unrelated fixtures intentionally reuse one shared Dev-typed parent
                        // (see `sharedParentKey`'s own doc comment) -- not a real redo, just
                        // deliberate reuse, so it opts out of the TAI-226/228 duplicate-subtask
                        // guard explicitly rather than tripping it.
                        allowDuplicate: true,
                        summary: "Conformance: unassigned gate",
                    })
                );
                const res = await h.backend.workTracker.transition(issue.key, Status.InProgress);
                assert.equal(res.ok, false, "an unassigned issue must not reach In Progress");
            });

            it("allows In Progress once assigned; terminal states never require an owner", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        // Unrelated fixtures intentionally reuse one shared Dev-typed parent
                        // (see `sharedParentKey`'s own doc comment) -- not a real redo, just
                        // deliberate reuse, so it opts out of the TAI-226/228 duplicate-subtask
                        // guard explicitly rather than tripping it.
                        allowDuplicate: true,
                        summary: "Conformance: assigned gate",
                    })
                );
                const doneUnassigned = await h.backend.workTracker.transition(issue.key, Status.Done);
                assert.equal(doneUnassigned.ok, true, "terminal states are exempt from the gate");

                const assign = await h.backend.workTracker.assignIssue(issue.key, h.validAssignee);
                assert.equal(assign.ok, true);
                const started = await h.backend.workTracker.transition(issue.key, Status.InProgress);
                assert.equal(started.ok, true);
            });

            it("workflow strictness — a capability, currently false on both backends", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        // Unrelated fixtures intentionally reuse one shared Dev-typed parent
                        // (see `sharedParentKey`'s own doc comment) -- not a real redo, just
                        // deliberate reuse, so it opts out of the TAI-226/228 duplicate-subtask
                        // guard explicitly rather than tripping it.
                        allowDuplicate: true,
                        summary: "Conformance: workflow strictness",
                    })
                );
                await h.backend.workTracker.assignIssue(issue.key, h.validAssignee);
                const res = await h.backend.workTracker.transition(issue.key, Status.InReview);
                if (h.capabilities.strictWorkflow) {
                    assert.equal(res.ok, false, "this backend's workflow should reject a transition with no direct path");
                } else {
                    assert.equal(
                        res.ok,
                        true,
                        "this backend's workflow allows every transition directly (documented, not a bug — " +
                            "see the capability's own doc comment for why Jira can be `false` too)"
                    );
                }
            });

            it("assignee validation — the other deliberate difference", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        // Unrelated fixtures intentionally reuse one shared Dev-typed parent
                        // (see `sharedParentKey`'s own doc comment) -- not a real redo, just
                        // deliberate reuse, so it opts out of the TAI-226/228 duplicate-subtask
                        // guard explicitly rather than tripping it.
                        allowDuplicate: true,
                        summary: "Conformance: assignee validation",
                    })
                );
                const res = await h.backend.workTracker.assignIssue(issue.key, h.invalidAssignee);
                if (h.capabilities.validatesAssignee) {
                    assert.equal(res.ok, false, "Jira should reject a nonexistent accountId");
                } else {
                    assert.equal(
                        res.ok,
                        true,
                        "filesystem backend has no external directory to validate against — documented, not a bug"
                    );
                }
            });

            it("a connectivity fault throws; a rejection never does (§3.3 vs §3.6)", async () => {
                // Every backend must keep these distinguishable — it's the load-bearing
                // property the whole interface is built to preserve (interface.ts:140-151).
                // We can only force a REJECTION generically here (an unassigned transition);
                // connectivity is exercised per-backend where a fault is actually inducible
                // (see the Jira conformance test file for the network-down case).
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        // Unrelated fixtures intentionally reuse one shared Dev-typed parent
                        // (see `sharedParentKey`'s own doc comment) -- not a real redo, just
                        // deliberate reuse, so it opts out of the TAI-226/228 duplicate-subtask
                        // guard explicitly rather than tripping it.
                        allowDuplicate: true,
                        summary: "Conformance: rejection shape",
                    })
                );
                const res = await h.backend.workTracker.transition(issue.key, Status.InProgress);
                assert.equal(res.ok, false);
                assert.equal(typeof (res.ok === false ? res.reason : ""), "string");
                assert.ok((res.ok === false ? res.reason : "").length > 0, "reason must not be empty");
            });
        });

        // ---------- Parent-status cascade gate (TAI-220/221/222/223) ----------

        describe("WorkTracker: transition() and the parent-status cascade gate", () => {
            it("cascades Subtask -> Story -> Epic in one transition call", async () => {
                const epic = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: "epic",
                        summary: "Conformance: cascade epic",
                    })
                );
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        parentKey: epic.key,
                        summary: "Conformance: cascade story",
                    })
                );
                const dev = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: story.key,
                        summary: "Conformance: cascade dev",
                    })
                );
                // The cascade recurses through the FULL transition() -- including the
                // assignment gate -- for each ancestor, so each one needs its own assignee.
                await h.backend.workTracker.assignIssue(epic.key, h.validAssignee);
                await h.backend.workTracker.assignIssue(story.key, h.validAssignee);
                await h.backend.workTracker.assignIssue(dev.key, h.validAssignee);

                const result = await h.backend.workTracker.transition(dev.key, Status.InProgress);
                assert.equal(result.ok, true, "the child's own transition must still succeed");

                const fetchedStory = await h.backend.workTracker.getIssue(story.key);
                assert.equal(fetchedStory?.status, Status.InProgress, "the parent Story must cascade");
                const fetchedEpic = await h.backend.workTracker.getIssue(epic.key);
                assert.equal(fetchedEpic?.status, Status.InProgress, "the Epic must cascade one level further up");
            });

            // Jira allows a Story to have no Epic (a legitimate, common shape) -- the cascade
            // must stop cleanly at the Story, not assume a further ancestor always exists.
            it("cascades Subtask -> Story and stops cleanly when the Story has no Epic", async () => {
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: cascade top-level story, no epic",
                    })
                );
                const dev = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: story.key,
                        summary: "Conformance: cascade dev, no epic",
                    })
                );
                await h.backend.workTracker.assignIssue(story.key, h.validAssignee);
                await h.backend.workTracker.assignIssue(dev.key, h.validAssignee);

                const result = await h.backend.workTracker.transition(dev.key, Status.InProgress);
                assert.equal(result.ok, true);

                const fetchedStory = await h.backend.workTracker.getIssue(story.key);
                assert.equal(fetchedStory?.status, Status.InProgress, "the Story must still cascade");
                assert.equal(fetchedStory?.parentKey, undefined, "confirms this Story genuinely has no Epic");
            });

            it("never regresses a Done parent backward to In Progress", async () => {
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: already-finished story",
                    })
                );
                await h.backend.workTracker.transition(story.key, Status.Done);

                const dev = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: story.key,
                        summary: "Conformance: unrelated follow-up work",
                    })
                );
                await h.backend.workTracker.assignIssue(dev.key, h.validAssignee);

                const result = await h.backend.workTracker.transition(dev.key, Status.InProgress);
                assert.equal(result.ok, true, "the child's own transition must still succeed");

                const fetchedStory = await h.backend.workTracker.getIssue(story.key);
                assert.equal(fetchedStory?.status, Status.Done, "a Done parent must never be moved backward");
            });

            it("a rejected parent-cascade transition is best-effort -- the child's own transition still succeeds", async () => {
                // The parent Story has no assignee -- its own cascade transition to In
                // Progress will be rejected by the assignment gate. The child is assigned,
                // so ITS transition must still succeed regardless.
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: unassigned parent story",
                    })
                );
                const dev = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: story.key,
                        summary: "Conformance: cascade rejection",
                    })
                );
                await h.backend.workTracker.assignIssue(dev.key, h.validAssignee);

                const result = await h.backend.workTracker.transition(dev.key, Status.InProgress);
                assert.equal(result.ok, true, "a rejected cascade must never block the child's own transition");

                const fetchedStory = await h.backend.workTracker.getIssue(story.key);
                assert.equal(fetchedStory?.status, Status.ToDo, "the rejected parent cascade must not have applied");
            });

            // TAI-275/276 ADR: visibility, not auto-retry -- the same rejected-cascade
            // scenario above must also surface it on the result itself, identically on both
            // backends, not just via console.warn.
            it("surfaces a rejected parent-cascade as a cascadeWarning on the child's own successful result", async () => {
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: unassigned parent story (cascadeWarnings)",
                    })
                );
                const dev = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: story.key,
                        summary: "Conformance: cascade rejection (cascadeWarnings)",
                    })
                );
                await h.backend.workTracker.assignIssue(dev.key, h.validAssignee);

                const result = await h.backend.workTracker.transition(dev.key, Status.InProgress);
                assert.equal(result.ok, true);
                assert.ok(result.ok && result.cascadeWarnings && result.cascadeWarnings.length === 1);
                if (result.ok && result.cascadeWarnings) {
                    assert.equal(result.cascadeWarnings[0]!.key, story.key);
                    assert.ok(result.cascadeWarnings[0]!.reason.length > 0);
                }
            });

            // Found in review (TAI-276 PR): the FIRST version of the fix only checked
            // whether the immediate recursive transition() call itself was rejected --
            // dropping any cascadeWarnings nested INSIDE a recursive call that itself
            // succeeded. Story -> Epic here is exactly that shape: Story's own transition
            // succeeds (it cascades to Epic internally and that fails), so Dev's own
            // transition() must bubble the Epic-level warning up two levels, not just one.
            it("bubbles up a cascadeWarning from a NESTED cascade two levels down (Dev -> Story succeeds, Story -> Epic fails)", async () => {
                const epic = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: "epic",
                        summary: "Conformance: unassigned epic (nested cascadeWarnings)",
                    })
                );
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        parentKey: epic.key,
                        summary: "Conformance: assigned story, unassigned epic (nested cascadeWarnings)",
                    })
                );
                const dev = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: story.key,
                        summary: "Conformance: cascade rejection two levels up (nested cascadeWarnings)",
                    })
                );
                await h.backend.workTracker.assignIssue(story.key, h.validAssignee);
                await h.backend.workTracker.assignIssue(dev.key, h.validAssignee);
                // epic is deliberately left unassigned.

                const result = await h.backend.workTracker.transition(dev.key, Status.InProgress);
                assert.equal(result.ok, true, "the child's own transition must still succeed");

                const fetchedStory = await h.backend.workTracker.getIssue(story.key);
                assert.equal(fetchedStory?.status, Status.InProgress, "the assigned Story must still cascade fine");

                assert.ok(
                    result.ok && result.cascadeWarnings && result.cascadeWarnings.some((w) => w.key === epic.key),
                    "the Epic-level rejection, nested inside the Story's own transition(), must bubble all the way up to Dev's own result"
                );
            });
        });

        // ---------- Downward/terminal cascade gate (TAI-267, TAI-247 ADR) ----------
        // No "rejected child cascade" test here, unlike the upward cascade's own coverage
        // above: Canceled (one of the two targets this cascade fires FROM a child's own
        // transition) is exempt from both the assignment gate and the review gate (terminal
        // states need no owner, and reviewGateApplies only ever fires for a Done target) --
        // there's no real gate in this system that can reject a plain transition-to-Canceled
        // to construct that scenario against. The best-effort try/catch around the cascade
        // still exists for a genuine connectivity fault or a future gate, just not something
        // this conformance harness can currently trigger.
        describe("WorkTracker: transition() and the downward/terminal cascade gate (TAI-267, TAI-247 ADR)", () => {
            it("cascade-cancels an open child when the parent reaches Done", async () => {
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: downward cascade parent",
                    })
                );
                const dev = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: story.key,
                        summary: "Conformance: orphaned-to-be child",
                    })
                );

                const result = await h.backend.workTracker.transition(story.key, Status.Done);
                assert.equal(result.ok, true, "the parent's own transition must still succeed");

                const fetchedDev = await h.backend.workTracker.getIssue(dev.key);
                assert.equal(fetchedDev?.status, Status.Canceled, "the open child must be cascade-canceled");
            });

            it("cascades through multiple levels -- Epic -> Story -> Dev all close in one transition call", async () => {
                const epic = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: "epic",
                        summary: "Conformance: downward cascade epic",
                    })
                );
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        parentKey: epic.key,
                        summary: "Conformance: downward cascade story",
                    })
                );
                const dev = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: story.key,
                        summary: "Conformance: downward cascade grandchild",
                    })
                );

                const result = await h.backend.workTracker.transition(epic.key, Status.Done);
                assert.equal(result.ok, true);

                const fetchedStory = await h.backend.workTracker.getIssue(story.key);
                assert.equal(fetchedStory?.status, Status.Canceled, "the Story (direct child) must cascade-cancel");
                const fetchedDev = await h.backend.workTracker.getIssue(dev.key);
                assert.equal(fetchedDev?.status, Status.Canceled, "the Dev (grandchild) must ALSO cascade-cancel");
            });

            it("a Canceled parent cascades too, not just a Done one (ADR decision #1)", async () => {
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: downward cascade via Canceled",
                    })
                );
                const dev = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: story.key,
                        summary: "Conformance: child of a canceled parent",
                    })
                );

                await h.backend.workTracker.transition(story.key, Status.Canceled);

                const fetchedDev = await h.backend.workTracker.getIssue(dev.key);
                assert.equal(fetchedDev?.status, Status.Canceled);
            });

            it("never touches a child that's already terminal -- Done stays Done, not regressed to Canceled", async () => {
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: downward cascade, one child already finished",
                    })
                );
                const finishedDev = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: story.key,
                        summary: "Conformance: already-Done sibling",
                    })
                );
                await h.backend.workTracker.transition(finishedDev.key, Status.Done);

                await h.backend.workTracker.transition(story.key, Status.Done);

                const fetchedDev = await h.backend.workTracker.getIssue(finishedDev.key);
                assert.equal(fetchedDev?.status, Status.Done, "an already-Done child must never be regressed to Canceled");
            });
        });

        // ---------- Review gate (TAI-41 ADR, TAI-42) ----------

        describe("WorkTracker: transition() and the review gate", () => {
            it("blocks Kickoff In Review -> Done until required reviewers approve, then allows it", async () => {
                // Persona Roster: the harness's own valid-assignee identity, listed under
                // BOTH required reviewers (PM + UX Designer, story-schema.ts REVIEW_GATES) —
                // a human may appear under multiple personas (brief §5.6), and it's the only
                // identity either harness's fixed credentials can act as.
                trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: "Persona Roster",
                        content: [
                            "| Persona | Authorized humans |",
                            "| --- | --- |",
                            `| PM | ${h.validAssignee.displayName} |`,
                            `| UX Designer | ${h.validAssignee.displayName} |`,
                        ].join("\n"),
                    })
                );

                const kickoff = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Kickoff,
                        summary: "Conformance: review gate",
                        assignee: h.validAssignee,
                    })
                );
                await h.backend.workTracker.transition(kickoff.key, Status.InProgress);
                await h.backend.workTracker.transition(kickoff.key, Status.InReview);

                const blocked = await h.backend.workTracker.transition(kickoff.key, Status.Done);
                assert.equal(blocked.ok, false, "no Approved: comments yet — the gate must hold");

                await h.backend.workTracker.addComment(kickoff.key, "Approved: looks good");

                const passed = await h.backend.workTracker.transition(kickoff.key, Status.Done);
                assert.equal(
                    passed.ok,
                    true,
                    "one Approved: comment from a human listed under both required personas satisfies the gate"
                );
            });
        });

        // ---------- Comments & labels ----------

        describe("WorkTracker: comments and labels", () => {
            it("adds and edits a comment", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        // Unrelated fixtures intentionally reuse one shared Dev-typed parent
                        // (see `sharedParentKey`'s own doc comment) -- not a real redo, just
                        // deliberate reuse, so it opts out of the TAI-226/228 duplicate-subtask
                        // guard explicitly rather than tripping it.
                        allowDuplicate: true,
                        summary: "Conformance: comments",
                    })
                );
                const c = await h.backend.workTracker.addComment(issue.key, "Approved: original");
                assert.equal(c.body, "Approved: original");
                // A tiny real delay, not a race against the clock: the filesystem backend has
                // no network latency to naturally separate create from edit, so two calls back
                // to back can otherwise land in the same millisecond and make this assertion
                // flake on fast machines — found by actually running this test.
                await new Promise((r) => setTimeout(r, 5));
                const edited = await h.backend.workTracker.editComment(issue.key, c.id, "Approved: edited");
                assert.equal(edited.body, "Approved: edited");
                assert.notEqual(
                    edited.updatedAt,
                    edited.createdAt,
                    "an edit must change updatedAt — §3.9's marker re-scan depends on this"
                );

                const fetched = await h.backend.workTracker.getIssue(issue.key);
                assert.equal(fetched?.comments.find((x) => x.id === c.id)?.body, "Approved: edited");
            });

            it("adds and removes a label", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        // Unrelated fixtures intentionally reuse one shared Dev-typed parent
                        // (see `sharedParentKey`'s own doc comment) -- not a real redo, just
                        // deliberate reuse, so it opts out of the TAI-226/228 duplicate-subtask
                        // guard explicitly rather than tripping it.
                        allowDuplicate: true,
                        summary: "Conformance: labels",
                    })
                );
                await h.backend.workTracker.addLabel(issue.key, "tai-conformance-fixture");
                const withLabel = await h.backend.workTracker.getIssue(issue.key);
                assert.ok(withLabel?.labels.includes("tai-conformance-fixture"));

                await h.backend.workTracker.removeLabel(issue.key, "tai-conformance-fixture");
                const withoutLabel = await h.backend.workTracker.getIssue(issue.key);
                assert.ok(!withoutLabel?.labels.includes("tai-conformance-fixture"));
            });
        });

        // ---------- Issue links & search ----------

        describe("WorkTracker: links and search", () => {
            it("createLink + getLinkedIssues agree on direction (DependsOn)", async () => {
                const parent = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: link parent",
                    })
                );
                const blocker = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: parent.key,
                        summary: "Conformance: link blocker",
                    })
                );
                const dependent = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.CodeReview,
                        parentKey: parent.key,
                        summary: "Conformance: link dependent",
                    })
                );
                // dependent depends on blocker -> blocker blocks dependent
                await h.backend.workTracker.createLink(dependent.key, DependencyRelation.DependsOn, blocker.key);

                const outgoing = await h.backend.workTracker.getLinkedIssues(
                    dependent.key,
                    DependencyRelation.DependsOn,
                    "outgoing"
                );
                assert.ok(
                    outgoing.some((l) => l.key === blocker.key),
                    "dependent should depend on blocker (outgoing)"
                );

                const incoming = await h.backend.workTracker.getLinkedIssues(
                    blocker.key,
                    DependencyRelation.DependsOn,
                    "incoming"
                );
                assert.ok(
                    incoming.some((l) => l.key === dependent.key),
                    "blocker should see dependent depending on it (incoming)"
                );
            });

            it("search scopes to the project and filters by type/persona/parent", async () => {
                const parent = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: search scope",
                    })
                );
                const match = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: parent.key,
                        persona: Persona.Developer,
                        summary: "Conformance: search match",
                    })
                );
                const nonMatch = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.CodeReview,
                        parentKey: parent.key,
                        persona: Persona.CodeReviewer,
                        summary: "Conformance: search non-match",
                    })
                );

                const results = await h.backend.workTracker.search({
                    projectKey: h.projectKey,
                    parentKey: parent.key,
                    issueTypes: [SubtaskType.Dev],
                    persona: Persona.Developer,
                });

                assert.ok(results.some((i) => i.key === match.key), "search must find the matching issue");
                assert.ok(
                    !results.some((i) => i.key === nonMatch.key),
                    "search must not return the non-matching issue"
                );
            });

            // TAI-192/225: findReadyWork's "only surface an undecomposed Epic" fix (ready.ts)
            // relies on `search({ parentKey: epicKey })` reflecting Epic->Story/Kickoff/Bug/
            // Spike parenting the same way it already does for Subtask->Story — a genuinely
            // different Jira relationship (classic/company-managed Jira projects traditionally
            // answer "which Stories are under this Epic" via a separate "Epic Link" field, not
            // `parent`), so this is asserted directly rather than assumed from the
            // Subtask->Story case above. Live-confirmed against the real TAI project (TAI-5
            // through TAI-9) before writing this: `parent = <epicKey>` JQL does return the
            // Epic's Story-level children on this Jira site's project configuration.
            it("search by parentKey reflects Epic->Story parenting, not just Subtask->Story", async () => {
                const epic = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: "epic",
                        summary: "Conformance: undecomposed epic",
                    })
                );

                const beforeDecomposition = await h.backend.workTracker.search({
                    projectKey: h.projectKey,
                    parentKey: epic.key,
                });
                assert.equal(
                    beforeDecomposition.length,
                    0,
                    "a freshly created Epic with no children yet must search as empty"
                );

                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        parentKey: epic.key,
                        summary: "Conformance: epic's first Story",
                    })
                );

                const afterDecomposition = await h.backend.workTracker.search({
                    projectKey: h.projectKey,
                    parentKey: epic.key,
                });
                assert.ok(
                    afterDecomposition.some((i) => i.key === story.key),
                    "once a Story exists under the Epic, parentKey search must find it"
                );
            });
        });

        // ---------- DocStore ----------

        describe("DocStore: page CRUD, comments, children", () => {
            it("creates and reads back a page's markdown content exactly", async () => {
                const content = [
                    "# Conformance page",
                    "",
                    "Some **bold**, `code`, and a list:",
                    "",
                    "- one",
                    "- two",
                ].join("\n");
                const page = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: page ${Date.now()}`,
                        content,
                    })
                );
                assert.equal(page.content, content, "content must round-trip exactly on every backend");

                const fetched = await h.backend.docStore.getPage({ id: page.id });
                assert.equal(fetched?.content, content);
            });

            it("getPage by (spaceKey, title) finds the same page as by id", async () => {
                const title = `Conformance: by-title ${Date.now()}`;
                const page = trackPage(
                    await h.backend.docStore.createPage({ spaceKey: h.spaceKey, title, content: "x" })
                );
                const byTitle = await h.backend.docStore.getPage({ spaceKey: h.spaceKey, title });
                assert.equal(byTitle?.id, page.id);
            });

            it("returns null for a missing page, never throws", async () => {
                const missing = await h.backend.docStore.getPage({
                    spaceKey: h.spaceKey,
                    title: "Definitely Not A Real Page Title, Conformance Probe",
                });
                assert.equal(missing, null);
            });

            it("updatePage applies a content change", async () => {
                const page = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: update ${Date.now()}`,
                        content: "before",
                    })
                );
                const updated = await h.backend.docStore.updatePage({ id: page.id }, { content: "after" });
                assert.equal(updated.content, "after");
            });

            it("adds and edits a page comment", async () => {
                const page = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: page comment ${Date.now()}`,
                        content: "x",
                    })
                );
                const c = await h.backend.docStore.addComment({ id: page.id }, "Q: original question");
                const edited = await h.backend.docStore.editComment(
                    { id: page.id },
                    c.id,
                    "Q: edited question"
                );
                assert.equal(edited.body, "Q: edited question");
            });

            it("getChildren returns pages parented under this one", async () => {
                const parent = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: parent ${Date.now()}`,
                        content: "x",
                    })
                );
                const child = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: child ${Date.now()}`,
                        content: "x",
                        parentId: parent.id,
                    })
                );
                const children = await h.backend.docStore.getChildren({ id: parent.id });
                assert.ok(children.some((c) => c.id === child.id));
            });

            it("listAttachments returns an empty list for a page with none", async () => {
                const page = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: no attachments ${Date.now()}`,
                        content: "x",
                    })
                );
                const atts = await h.backend.docStore.listAttachments({ id: page.id });
                assert.deepEqual([...atts], []);
            });
        });

        // ---------- Issue <-> Page linking ----------

        describe("Issue <-> Page linking (brief §4)", () => {
            it("WorkTracker.linkPage / getLinkedPages agree", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: issue-page link",
                    })
                );
                const page = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: linked doc ${Date.now()}`,
                        content: "x",
                    })
                );
                await h.backend.workTracker.linkPage(issue.key, page.id);
                const linked = await h.backend.workTracker.getLinkedPages(issue.key);
                assert.ok(linked.includes(page.id));
            });

            it("DocStore.getLinkedIssues(page) — the capability that genuinely differs by backend", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: reverse page link",
                    })
                );
                const page = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: reverse-linked doc ${Date.now()}`,
                        content: "x",
                    })
                );
                await h.backend.workTracker.linkPage(issue.key, page.id);

                if (h.capabilities.answersPageToIssueLinks) {
                    const linked = await h.backend.docStore.getLinkedIssues({ id: page.id });
                    assert.ok(
                        linked.includes(issue.key),
                        "backend claims it can answer this — it must be correct, not just non-throwing"
                    );
                } else {
                    // Jira owns the remote link and exposes no reverse index for it. This MUST
                    // throw, not return [] — an empty array would silently claim "no linked
                    // issues" when the true answer is "cannot be determined from here."
                    await assert.rejects(
                        () => h.backend.docStore.getLinkedIssues({ id: page.id }),
                        /unanswerable|not answerable/i
                    );
                }
            });
        });

        // ---------- Issue <-> generic remote-URL linking (TAI-107/TAI-108) ----------

        describe("WorkTracker.createRemoteLink / getRemoteLinks", () => {
            it("creates a remote link and reads it back", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: remote link",
                    })
                );
                await h.backend.workTracker.createRemoteLink(
                    issue.key,
                    "https://bitbucket.org/example/repo/pull-requests/1",
                    "Example PR"
                );
                const links = await h.backend.workTracker.getRemoteLinks(issue.key);
                assert.ok(
                    links.some(
                        (l) => l.url === "https://bitbucket.org/example/repo/pull-requests/1" && l.title === "Example PR"
                    )
                );
            });

            it("a second call for the same url updates the title in place rather than duplicating", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: remote link upsert",
                    })
                );
                const url = "https://bitbucket.org/example/repo/pull-requests/2";
                await h.backend.workTracker.createRemoteLink(issue.key, url, "Original title");
                await h.backend.workTracker.createRemoteLink(issue.key, url, "Renamed title");

                const links = await h.backend.workTracker.getRemoteLinks(issue.key);
                const matching = links.filter((l) => l.url === url);
                assert.equal(matching.length, 1, "the link must not be duplicated");
                assert.equal(matching[0]?.title, "Renamed title");
            });

            it("getRemoteLinks on an issue with no remote links returns an empty array", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: no remote links",
                    })
                );
                const links = await h.backend.workTracker.getRemoteLinks(issue.key);
                assert.deepEqual([...links], []);
            });

            it("does not return a page link created via linkPage — different concepts, kept separate", async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: remote link vs page link",
                    })
                );
                const page = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: unrelated linked doc ${Date.now()}`,
                        content: "x",
                    })
                );
                await h.backend.workTracker.linkPage(issue.key, page.id);

                const links = await h.backend.workTracker.getRemoteLinks(issue.key);
                assert.deepEqual([...links], []);
            });
        });
    });
}

/** Re-exported so backend-specific test files can assert on it without a second import. */
export { StorageConnectivityError };
