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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Persona, Status, StoryType, SubtaskType, DependencyRelation } from "../schema/story-schema.js";
import { EMPTY_SETTINGS, mergeSettingsPage, parseSettingsPage, renderSettingsPage, withAdmins, withValue } from "../settings/settings.js";
import { gatherAssigneeEvidence } from "../personas/assignee-evidence.js";
import { ensureFixturePage } from "./fixture-page.js";
import { ensureDocFolder, filePage, folderForDocType } from "./doc-folders.js";
import {
    type StorageBackend,
    type Issue,
    type IssueKey,
    type PageId,
    type HumanRef,
    type WorkTracker,
    StorageConnectivityError,
    isFlagged,
    toHumanId,
} from "./interface.js";
import { refreshIssue } from "../cache/issue-cache.js";
import { refreshPage } from "../cache/page-cache.js";
import { snapshotLinkedKeys } from "../cache/links-snapshot.js";

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

    /**
     * TAI-381: is `search()` only EVENTUALLY consistent with writes? Jira: yes -- measured live, a
     * JQL search can miss an issue for ~2-4s after it is created (while a parent's own `subtasks`
     * field, and fetching by key, are immediate). The filesystem backend reads its own files, so no.
     * Where true, assertions about a plain search finding something just created poll until it is
     * visible (`eventually`) instead of assuming read-your-write; `IssueFilter.readYourWrites` is
     * what gives callers an immediate answer for a Story's subtasks.
     */
    readonly searchIsEventuallyConsistent: boolean;
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
        const restorePages: (() => Promise<void>)[] = [];

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
            for (const restore of restorePages) await restore().catch(() => {});
        });

        function track<T extends { key: IssueKey }>(issue: T): T {
            cleanupIssues.push(issue.key);
            return issue;
        }
        function trackPage<T extends { id: PageId }>(page: T): T {
            cleanupPages.push(page.id);
            return page;
        }

        /** TAI-381: re-runs `read` until `done(value)` holds, but ONLY on a backend whose search is
         *  eventually consistent (otherwise one check, so a real bug there is not hidden by polling). */
        async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string | (() => string)): Promise<T> {
            const budgetMs = h.capabilities.searchIsEventuallyConsistent ? 20000 : 0;
            const deadline = Date.now() + budgetMs;
            for (;;) {
                const value = await read();
                if (done(value)) return value;
                if (Date.now() >= deadline) assert.fail(`${typeof what === "function" ? what() : what} (not visible after ${budgetMs}ms)`);
                await new Promise((r) => setTimeout(r, 750));
            }
        }
        const childKeys = (parent: IssueKey) => async () =>
            (await h.backend.workTracker.search({ projectKey: h.projectKey, parentKey: parent })).map((i) => i.key);

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
                // Brief §5.3 rev 27: `Backlog`, not `To Do`, is the default landing status
                // for a newly created ticket -- confirmed live against both the real Jira
                // backend and this repo's own filesystem-backend.ts (TAI-299, found while
                // running TAI-291's conformance suite against live Jira for the first time
                // since rev 27 was decided -- filesystem-backend.ts had drifted).
                assert.equal(issue.status, Status.Backlog, "new issues start at Backlog on every backend (brief §5.3 rev 27)");
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

                // TAI-304/311 ADR (Confluence page 39518210): affectedIssues carries every
                // OTHER issue the cascade actually mutated -- both backends must report the
                // same shape (both ancestors, matching status), not just one of them.
                if (result.ok) {
                    const affected = result.affectedIssues ?? [];
                    assert.equal(affected.length, 2, "both the Story and the Epic must be reported as affected");
                    const byKey = new Map(affected.map((i) => [i.key, i]));
                    assert.equal(byKey.get(story.key)?.status, Status.InProgress);
                    assert.equal(byKey.get(epic.key)?.status, Status.InProgress);
                }
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
                assert.equal(
                    fetchedStory?.status,
                    Status.Backlog,
                    "the rejected parent cascade must not have applied -- the Story stays at its Backlog creation default (brief §5.3 rev 27)"
                );
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
        // ---------- The subtask precedence gate (TAI-476) ----------

        // The shared predicates (precedence-gate.ts) are unit-tested on their own; this checks that each
        // backend wires them into transition() and behaves identically. The gate reads siblings through
        // search, which lags a create on Jira (TAI-381), so each case first waits for the siblings to be
        // visible.
        describe("WorkTracker: transition() and the subtask precedence gate (TAI-476)", () => {
            async function storyWith(...types: SubtaskType[]) {
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: precedence story",
                        assignee: h.validAssignee,
                    })
                );
                const subtasks = new Map<SubtaskType, Issue>();
                for (const issueType of types) {
                    subtasks.set(
                        issueType,
                        track(
                            await h.backend.workTracker.createIssue({
                                projectKey: h.projectKey,
                                issueType,
                                parentKey: story.key,
                                summary: `Conformance: precedence ${issueType}`,
                                assignee: h.validAssignee,
                            })
                        )
                    );
                }
                await eventually(childKeys(story.key), (found) => found.length === types.length, "the story's subtasks");
                return (type: SubtaskType) => subtasks.get(type)!.key;
            }

            it("refuses to start a subtask while a sibling upstream of it is open, naming the blocker", async () => {
                const key = await storyWith(SubtaskType.ArchitectureDesign, SubtaskType.Dev);
                const result = await h.backend.workTracker.transition(key(SubtaskType.Dev), Status.InProgress);
                assert.equal(result.ok, false);
                if (!result.ok) assert.ok(result.reason.includes(key(SubtaskType.ArchitectureDesign)), result.reason);
                assert.equal((await h.backend.workTracker.getIssue(key(SubtaskType.Dev)))?.status, Status.Backlog);
            });

            it("allows it once the prerequisite is Done", async () => {
                const key = await storyWith(SubtaskType.ArchitectureDesign, SubtaskType.Dev);
                assert.equal((await h.backend.workTracker.transition(key(SubtaskType.ArchitectureDesign), Status.Done)).ok, true);
                await eventually(
                    () => h.backend.workTracker.search({ projectKey: h.projectKey, statuses: [Status.Done] }),
                    (done) => done.some((i) => i.key === key(SubtaskType.ArchitectureDesign)),
                    "the finished prerequisite"
                );
                assert.equal((await h.backend.workTracker.transition(key(SubtaskType.Dev), Status.InProgress)).ok, true);
            });

            it("an override starts it anyway and leaves a comment naming what was bypassed", async () => {
                const key = await storyWith(SubtaskType.ArchitectureDesign, SubtaskType.Dev);
                const result = await h.backend.workTracker.transition(key(SubtaskType.Dev), Status.InProgress, {
                    overridePrecedence: true,
                });
                assert.equal(result.ok, true);
                const dev = await h.backend.workTracker.getIssue(key(SubtaskType.Dev));
                assert.equal(dev?.status, Status.InProgress);
                const comment = dev?.comments.find((c) => c.body.startsWith("Precedence override:"));
                assert.ok(comment, "the bypass must be recorded on the ticket");
                assert.ok(comment.body.includes(key(SubtaskType.ArchitectureDesign)));
            });

            it("an override leaves no comment when nothing was actually bypassed", async () => {
                const key = await storyWith(SubtaskType.Dev);
                const result = await h.backend.workTracker.transition(key(SubtaskType.Dev), Status.InProgress, {
                    overridePrecedence: true,
                });
                assert.equal(result.ok, true);
                assert.deepEqual((await h.backend.workTracker.getIssue(key(SubtaskType.Dev)))?.comments, []);
            });

            it("a test tier may start once Dev has started, but not before", async () => {
                const key = await storyWith(SubtaskType.Dev, SubtaskType.IntegrationTest);
                assert.equal((await h.backend.workTracker.transition(key(SubtaskType.IntegrationTest), Status.InProgress)).ok, false);
                assert.equal((await h.backend.workTracker.transition(key(SubtaskType.Dev), Status.InProgress)).ok, true);
                await eventually(
                    () => h.backend.workTracker.search({ projectKey: h.projectKey, statuses: [Status.InProgress] }),
                    (started) => started.some((i) => i.key === key(SubtaskType.Dev)),
                    "the started Dev subtask"
                );
                assert.equal((await h.backend.workTracker.transition(key(SubtaskType.IntegrationTest), Status.InProgress)).ok, true);
            });
        });

        // ---------- Kickoff exemption and the To Do cascade (TAI-374/387/388) ----------

        // The shared `upwardCascadeTarget` (cascade-gate.ts) is imported by both backends; this checks that each
        // actually wires it in, and that the whole chain behaves identically. Every read is by KEY, never search:
        // Jira's search index lags a few seconds behind a create (TAI-381), but fetching by key is immediate.
        describe("WorkTracker: Kickoff exemption and the To Do cascade (TAI-374/387/388)", () => {
            async function epic(summary: string) {
                const issue = track(await h.backend.workTracker.createIssue({ projectKey: h.projectKey, issueType: "epic", summary }));
                await h.backend.workTracker.assignIssue(issue.key, h.validAssignee);
                return issue;
            }
            async function child(issueType: StoryType | SubtaskType, parentKey: IssueKey, summary: string) {
                const issue = track(
                    await h.backend.workTracker.createIssue({ projectKey: h.projectKey, issueType, parentKey, summary })
                );
                // The In Progress cascade recurses through the FULL transition() (assignment gate included),
                // so every issue in the chain needs an assignee; harmless for the To Do cases.
                await h.backend.workTracker.assignIssue(issue.key, h.validAssignee);
                return issue;
            }
            const statusOf = async (key: IssueKey) => (await h.backend.workTracker.getIssue(key))?.status;

            it("a Kickoff Story going In Progress leaves its Backlog Epic in Backlog", async () => {
                const e = await epic("Conformance: kickoff exemption epic");
                const k = await child(StoryType.Kickoff, e.key, "Conformance: kickoff exemption kickoff");
                const result = await h.backend.workTracker.transition(k.key, Status.InProgress);
                assert.equal(result.ok, true);
                assert.equal(await statusOf(k.key), Status.InProgress);
                assert.equal(await statusOf(e.key), Status.Backlog, "an epic's Kickoff is refinement; the Epic stays Backlog");
            });

            it("a Kickoff SUBTASK starting moves its Kickoff Story but not the Epic", async () => {
                const e = await epic("Conformance: kickoff subtask epic");
                const k = await child(StoryType.Kickoff, e.key, "Conformance: kickoff subtask kickoff");
                const research = await child(SubtaskType.Research, k.key, "Conformance: kickoff subtask research");
                await h.backend.workTracker.transition(research.key, Status.InProgress);
                assert.equal(await statusOf(k.key), Status.InProgress);
                assert.equal(await statusOf(e.key), Status.Backlog);
            });

            for (const [type, label] of [
                [StoryType.Story, "Story"],
                [StoryType.Bug, "Bug"],
                [StoryType.Spike, "Spike"],
            ] as const) {
                it(`a ${label} (not a Kickoff) going In Progress still moves its Backlog Epic`, async () => {
                    const e = await epic(`Conformance: ${label} still cascades epic`);
                    const c = await child(type, e.key, `Conformance: ${label} still cascades child`);
                    await h.backend.workTracker.transition(c.key, Status.InProgress);
                    assert.equal(await statusOf(e.key), Status.InProgress);
                });
            }

            it("a subtask reaching To Do schedules its Backlog Story, and that schedules the Backlog Epic", async () => {
                const e = await epic("Conformance: to-do chain epic");
                const story = await child(StoryType.Story, e.key, "Conformance: to-do chain story");
                const dev = await child(SubtaskType.Dev, story.key, "Conformance: to-do chain dev");
                const result = await h.backend.workTracker.transition(dev.key, Status.ToDo);
                assert.equal(result.ok, true);
                assert.equal(await statusOf(story.key), Status.ToDo, "the Backlog Story is scheduled");
                assert.equal(await statusOf(e.key), Status.ToDo, "and so is its Backlog Epic");
                if (result.ok) {
                    // Same reporting contract as the In Progress cascade: every other issue mutated is listed.
                    assert.deepEqual((result.affectedIssues ?? []).map((i) => i.key).sort(), [story.key, e.key].sort());
                }
            });

            it("a non-Kickoff Story reaching To Do directly schedules its Backlog Epic", async () => {
                const e = await epic("Conformance: story to-do epic");
                const story = await child(StoryType.Story, e.key, "Conformance: story to-do story");
                await h.backend.workTracker.transition(story.key, Status.ToDo);
                assert.equal(await statusOf(e.key), Status.ToDo);
            });

            it("a Kickoff Story never schedules its Epic, whether it is moved directly or through its subtask", async () => {
                const direct = await epic("Conformance: kickoff to-do direct epic");
                const k1 = await child(StoryType.Kickoff, direct.key, "Conformance: kickoff to-do direct");
                await h.backend.workTracker.transition(k1.key, Status.ToDo);
                assert.equal(await statusOf(k1.key), Status.ToDo);
                assert.equal(await statusOf(direct.key), Status.Backlog);

                const viaSubtask = await epic("Conformance: kickoff to-do via subtask epic");
                const k2 = await child(StoryType.Kickoff, viaSubtask.key, "Conformance: kickoff to-do via subtask");
                const research = await child(SubtaskType.Research, k2.key, "Conformance: kickoff to-do research");
                await h.backend.workTracker.transition(research.key, Status.ToDo);
                assert.equal(await statusOf(k2.key), Status.ToDo, "the subtask schedules its Kickoff");
                assert.equal(await statusOf(viaSubtask.key), Status.Backlog, "but the Kickoff stops there");
            });

            it("the To Do cascade never regresses a parent that is already started", async () => {
                const e = await epic("Conformance: no regress epic");
                const story = await child(StoryType.Story, e.key, "Conformance: no regress story");
                const dev = await child(SubtaskType.Dev, story.key, "Conformance: no regress dev");
                await h.backend.workTracker.transition(story.key, Status.InProgress);
                await h.backend.workTracker.transition(dev.key, Status.ToDo);
                assert.equal(await statusOf(story.key), Status.InProgress, "a started Story is left alone");
                assert.equal(await statusOf(e.key), Status.InProgress, "and so is its Epic");
            });

            it("scheduling a second child leaves an already-To Do parent exactly as it is", async () => {
                const e = await epic("Conformance: second child epic");
                const story = await child(StoryType.Story, e.key, "Conformance: second child story");
                const dev = await child(SubtaskType.Dev, story.key, "Conformance: second child dev");
                const second = await child(SubtaskType.SpikeTask, story.key, "Conformance: second child spike");
                await h.backend.workTracker.transition(dev.key, Status.ToDo);
                const result = await h.backend.workTracker.transition(second.key, Status.ToDo);
                assert.equal(result.ok, true);
                assert.equal(await statusOf(story.key), Status.ToDo);
                if (result.ok) assert.deepEqual(result.affectedIssues ?? [], [], "nothing further moved");
            });
        });

        // TAI-561: what `issue create-small` (the light lane, TAI-473) relies on, on every backend. It creates a
        // Story or Bug and a Dev subtask under it, assigns both, moves the SUBTASK to To Do (which schedules the
        // Backlog parent) and then moves the PARENT to To Do again, which must be accepted, not refused as a no-op.
        describe("WorkTracker: the create-then-schedule sequence the light lane uses (TAI-473/561)", () => {
            const statusOf = async (key: IssueKey) => (await h.backend.workTracker.getIssue(key))?.status;

            for (const [type, label] of [
                [StoryType.Story, "Story"],
                [StoryType.Bug, "Bug"],
            ] as const) {
                it(`a ${label} and its Dev subtask: created linked, assigned, both in To Do after the two moves`, async () => {
                    const parent = track(
                        await h.backend.workTracker.createIssue({
                            projectKey: h.projectKey,
                            issueType: type,
                            summary: `Conformance: light lane ${label}`,
                            description: "AC-1: the pair is created and scheduled.",
                            persona: Persona.Pm,
                        })
                    );
                    const dev = track(
                        await h.backend.workTracker.createIssue({
                            projectKey: h.projectKey,
                            issueType: SubtaskType.Dev,
                            summary: `Conformance: light lane ${label}`,
                            persona: Persona.Developer,
                            parentKey: parent.key,
                        })
                    );
                    assert.equal(dev.parentKey, parent.key, "the subtask is linked to its parent");
                    assert.equal(parent.status, Status.Backlog);
                    assert.equal(dev.status, Status.Backlog);

                    assert.equal((await h.backend.workTracker.assignIssue(parent.key, h.validAssignee)).ok, true);
                    assert.equal((await h.backend.workTracker.assignIssue(dev.key, h.validAssignee)).ok, true);

                    // The subtask first: it schedules its Backlog parent as part of the move.
                    const devMove = await h.backend.workTracker.transition(dev.key, Status.ToDo);
                    assert.equal(devMove.ok, true, devMove.ok ? "" : devMove.reason);
                    assert.equal(await statusOf(parent.key), Status.ToDo, "moving the subtask scheduled the parent");

                    // Then the parent again, as create-small does: already To Do, and the move must still be accepted.
                    const parentMove = await h.backend.workTracker.transition(parent.key, Status.ToDo);
                    assert.equal(parentMove.ok, true, parentMove.ok ? "" : parentMove.reason);

                    const readParent = (await h.backend.workTracker.getIssue(parent.key))!;
                    const readDev = (await h.backend.workTracker.getIssue(dev.key))!;
                    assert.equal(readParent.status, Status.ToDo);
                    assert.equal(readDev.status, Status.ToDo);
                    assert.equal(readDev.parentKey, parent.key);
                    assert.equal(readDev.issueType, SubtaskType.Dev);
                    assert.equal(readParent.persona, Persona.Pm);
                    assert.equal(readDev.persona, Persona.Developer);
                    assert.equal(readParent.assignee?.id, h.validAssignee.id, "the parent's assignee reads back");
                    assert.equal(readDev.assignee?.id, h.validAssignee.id, "the subtask's assignee reads back");
                });
            }

            it("under a Backlog Epic the same two moves also schedule the Epic, and neither move is refused", async () => {
                const epic = track(await h.backend.workTracker.createIssue({ projectKey: h.projectKey, issueType: "epic", summary: "Conformance: light lane epic" }));
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: light lane epic story",
                        persona: Persona.Pm,
                        parentKey: epic.key,
                    })
                );
                const dev = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        summary: "Conformance: light lane epic dev",
                        persona: Persona.Developer,
                        parentKey: story.key,
                    })
                );
                assert.equal((await h.backend.workTracker.transition(dev.key, Status.ToDo)).ok, true);
                assert.equal((await h.backend.workTracker.transition(story.key, Status.ToDo)).ok, true);
                assert.equal(await statusOf(story.key), Status.ToDo);
                assert.equal(await statusOf(dev.key), Status.ToDo);
                assert.equal(await statusOf(epic.key), Status.ToDo, "the Backlog Epic is scheduled, which is what create-small's note warns about");
            });
        });

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

                // Epic->Story children are found by search, which lags on Jira (TAI-381: no immediate
                // Epic-children field exists), so let the index catch up before closing the Epic. The
                // Story->Dev hop needs no such wait: it reads the Story's own `subtasks` field.
                await eventually(
                    childKeys(epic.key),
                    (keys) => keys.includes(story.key),
                    "the Story must be searchable under the Epic before the Epic is closed"
                );

                const result = await h.backend.workTracker.transition(epic.key, Status.Done);
                assert.equal(result.ok, true);

                const fetchedStory = await h.backend.workTracker.getIssue(story.key);
                assert.equal(fetchedStory?.status, Status.Canceled, "the Story (direct child) must cascade-cancel");
                const fetchedDev = await h.backend.workTracker.getIssue(dev.key);
                assert.equal(fetchedDev?.status, Status.Canceled, "the Dev (grandchild) must ALSO cascade-cancel");

                // TAI-304/311 ADR (Confluence page 39518210): the downward cascade's own
                // affectedIssues must report BOTH the direct child and the grandchild it
                // cascaded to, on both backends -- the same "successful counterpart to
                // cascadeWarnings" contract as the upward cascade above.
                if (result.ok) {
                    const affected = result.affectedIssues ?? [];
                    assert.equal(affected.length, 2, "both the Story and the Dev must be reported as affected");
                    const byKey = new Map(affected.map((i) => [i.key, i]));
                    assert.equal(byKey.get(story.key)?.status, Status.Canceled);
                    assert.equal(byKey.get(dev.key)?.status, Status.Canceled);
                }
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
                // TAI-497: the page may already exist (an earlier run, or made on purpose); reuse it and put its
                // own content back afterwards rather than failing on the duplicate title.
                const roster = await ensureFixturePage(
                    h.backend.docStore,
                    h.spaceKey,
                    "Persona Roster",
                    [
                        "| Persona | Authorized humans |",
                        "| --- | --- |",
                        `| PM | ${h.validAssignee.displayName} |`,
                        `| UX Designer | ${h.validAssignee.displayName} |`,
                    ].join("\n")
                );
                if (roster.createdId) cleanupPages.push(roster.createdId);
                restorePages.push(roster.restore);

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

                // TAI-480: a page linked to the Kickoff still carries an open question. Approval does
                // not resolve it; only editing the marker out does.
                const prd = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: PRD with an open question ${Date.now()}`,
                        content: "Users sign in with email.\n\nNEEDS CLARIFICATION: do we support single sign-on?",
                    })
                );
                await h.backend.workTracker.linkPage(kickoff.key, prd.id);

                await h.backend.workTracker.addComment(kickoff.key, "Approved: looks good");

                const stillBlocked = await h.backend.workTracker.transition(kickoff.key, Status.Done);
                assert.equal(stillBlocked.ok, false, "approved, but a linked page has an unresolved marker — the gate must hold");
                if (!stillBlocked.ok) {
                    assert.match(stillBlocked.reason, /NEEDS CLARIFICATION/);
                    assert.match(stillBlocked.reason, /single sign-on/);
                }

                await h.backend.docStore.updatePage({ id: prd.id }, { content: "Users sign in with email. Single sign-on is out of scope." });

                const passed = await h.backend.workTracker.transition(kickoff.key, Status.Done);
                assert.equal(
                    passed.ok,
                    true,
                    "approved by a human listed under both required personas, and no marker left in a linked page"
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

        // ---------- update: parent= and labels= (TAI-372/379/380) ----------

        // `reparent-gate.ts`/`label-gate.ts` are shared, so both backends use the same rules and
        // reason text; what this checks is that each backend actually WIRES them in, rejects
        // BEFORE writing anything, and round-trips the accepted cases through a fresh read.
        describe("WorkTracker: updateIssue parent= and labels= (TAI-372/379/380)", () => {
            async function epic(summary: string) {
                return track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: "epic",
                        summary,
                    })
                );
            }
            async function storyUnder(parentKey: IssueKey | undefined, summary: string) {
                return track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        ...(parentKey ? { parentKey } : {}),
                        summary,
                    })
                );
            }

            it("labels REPLACE the whole list, and [] clears it", async () => {
                const story = await storyUnder(undefined, "Conformance: labels replace");
                await h.backend.workTracker.updateIssue(story.key, { labels: ["conf-a", "conf-b"] });
                assert.deepEqual([...((await h.backend.workTracker.getIssue(story.key))?.labels ?? [])].sort(), ["conf-a", "conf-b"]);

                await h.backend.workTracker.updateIssue(story.key, { labels: ["conf-c"] });
                assert.deepEqual((await h.backend.workTracker.getIssue(story.key))?.labels, ["conf-c"]);

                await h.backend.workTracker.updateIssue(story.key, { labels: [] });
                assert.deepEqual((await h.backend.workTracker.getIssue(story.key))?.labels, []);
            });

            it("an update that leaves labels undefined does not touch them", async () => {
                const story = await storyUnder(undefined, "Conformance: labels untouched");
                await h.backend.workTracker.updateIssue(story.key, { labels: ["conf-keep"] });
                await h.backend.workTracker.updateIssue(story.key, { summary: "Conformance: labels untouched (renamed)" });
                assert.deepEqual((await h.backend.workTracker.getIssue(story.key))?.labels, ["conf-keep"]);
            });

            it("rejects a label containing a space, or an empty label, changing nothing", async () => {
                const story = await storyUnder(undefined, "Conformance: bad labels");
                await h.backend.workTracker.updateIssue(story.key, { labels: ["conf-keep"] });
                await assert.rejects(() => h.backend.workTracker.updateIssue(story.key, { labels: ["has space"] }), /spaces/);
                await assert.rejects(() => h.backend.workTracker.updateIssue(story.key, { labels: ["a", ""] }), /empty/i);
                assert.deepEqual((await h.backend.workTracker.getIssue(story.key))?.labels, ["conf-keep"]);
            });

            it("re-parents a Story from one Epic to another", async () => {
                const from = await epic("Conformance: reparent from");
                const to = await epic("Conformance: reparent to");
                const story = await storyUnder(from.key, "Conformance: reparent story");
                assert.equal(story.parentKey, from.key);

                const moved = await h.backend.workTracker.updateIssue(story.key, { parentKey: to.key });
                assert.equal(moved.parentKey, to.key);
                assert.equal((await h.backend.workTracker.getIssue(story.key))?.parentKey, to.key);
            });

            it("rejects re-parenting a subtask, an Epic, a non-Epic parent and a missing parent, changing nothing", async () => {
                const e = await epic("Conformance: reparent guard epic");
                const other = await epic("Conformance: reparent guard other epic");
                const story = await storyUnder(e.key, "Conformance: reparent guard story");
                const notAnEpic = await storyUnder(undefined, "Conformance: reparent guard non-epic");
                const subtask = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: story.key,
                        allowDuplicate: true,
                        summary: "Conformance: reparent guard subtask",
                    })
                );

                await assert.rejects(() => h.backend.workTracker.updateIssue(subtask.key, { parentKey: notAnEpic.key }), /subtask/i);
                await assert.rejects(() => h.backend.workTracker.updateIssue(e.key, { parentKey: other.key }), /Epic has no parent/);
                await assert.rejects(() => h.backend.workTracker.updateIssue(story.key, { parentKey: notAnEpic.key }), /must be an Epic/);
                await assert.rejects(
                    () => h.backend.workTracker.updateIssue(story.key, { parentKey: `${h.projectKey}-999999` as IssueKey }),
                    /not found/i
                );

                assert.equal((await h.backend.workTracker.getIssue(subtask.key))?.parentKey, story.key);
                assert.equal((await h.backend.workTracker.getIssue(story.key))?.parentKey, e.key);
                assert.equal((await h.backend.workTracker.getIssue(e.key))?.parentKey, undefined);
            });

            it("a rejected parent= leaves the REST of the same patch unapplied (no partial update)", async () => {
                const e = await epic("Conformance: atomic epic");
                const story = await storyUnder(e.key, "Conformance: atomic original");
                const notAnEpic = await storyUnder(undefined, "Conformance: atomic non-epic");
                await assert.rejects(() =>
                    h.backend.workTracker.updateIssue(story.key, { summary: "Conformance: atomic CHANGED", parentKey: notAnEpic.key })
                );
                assert.equal((await h.backend.workTracker.getIssue(story.key))?.summary, "Conformance: atomic original");
            });
        });

        describe("WorkTracker: updateIssue flagged= (TAI-390/392)", () => {
            async function story(summary: string) {
                return track(
                    await h.backend.workTracker.createIssue({ projectKey: h.projectKey, issueType: StoryType.Story, summary })
                );
            }
            const read = async (key: IssueKey) => (await h.backend.workTracker.getIssue(key))!;

            it("a new issue is not flagged", async () => {
                const created = await story("Conformance: flagged default");
                assert.equal(isFlagged(created), false);
                assert.equal(isFlagged(await read(created.key)), false);
            });

            it("setting flagged reads back true, clearing it reads back false", async () => {
                const issue = await story("Conformance: flagged set and clear");

                const set = await h.backend.workTracker.updateIssue(issue.key, { flagged: true });
                assert.equal(isFlagged(set), true);
                assert.equal(isFlagged(await read(issue.key)), true);

                const cleared = await h.backend.workTracker.updateIssue(issue.key, { flagged: false });
                assert.equal(isFlagged(cleared), false);
                assert.equal(isFlagged(await read(issue.key)), false);
            });

            it("flagging twice, or clearing an unflagged issue, is harmless", async () => {
                const issue = await story("Conformance: flagged idempotent");
                await h.backend.workTracker.updateIssue(issue.key, { flagged: false });
                assert.equal(isFlagged(await read(issue.key)), false);
                await h.backend.workTracker.updateIssue(issue.key, { flagged: true });
                await h.backend.workTracker.updateIssue(issue.key, { flagged: true });
                assert.equal(isFlagged(await read(issue.key)), true);
            });

            it("an update that leaves flagged undefined does not touch it, flagged or not", async () => {
                const issue = await story("Conformance: flagged untouched");
                await h.backend.workTracker.updateIssue(issue.key, { summary: "Conformance: flagged untouched (1)" });
                assert.equal(isFlagged(await read(issue.key)), false, "an unflagged issue stays unflagged");

                await h.backend.workTracker.updateIssue(issue.key, { flagged: true });
                await h.backend.workTracker.updateIssue(issue.key, { summary: "Conformance: flagged untouched (2)" });
                await h.backend.workTracker.updateIssue(issue.key, { labels: ["conf-flag-keep"] });
                const after = await read(issue.key);
                assert.equal(isFlagged(after), true, "a flagged issue stays flagged through unrelated updates");
                assert.equal(after.summary, "Conformance: flagged untouched (2)");
            });

            it("flagging changes nothing else: status, labels, assignee and summary are as they were", async () => {
                const issue = await story("Conformance: flagged isolation");
                await h.backend.workTracker.updateIssue(issue.key, { labels: ["conf-flag-iso"] });
                const before = await read(issue.key);

                const flagged = await read((await h.backend.workTracker.updateIssue(issue.key, { flagged: true })).key);
                assert.equal(flagged.status, before.status);
                assert.deepEqual(flagged.labels, before.labels);
                assert.equal(flagged.summary, before.summary);
                assert.deepEqual(flagged.assignee, before.assignee);
            });

            it("a status transition does not clear the flag", async () => {
                const issue = await story("Conformance: flagged survives transition");
                await h.backend.workTracker.updateIssue(issue.key, { flagged: true });
                const moved = await h.backend.workTracker.transition(issue.key, Status.ToDo);
                assert.equal(moved.ok, true);
                const after = await read(issue.key);
                assert.equal(after.status, Status.ToDo);
                assert.equal(isFlagged(after), true);
            });

            it("flagged travels with other fields in one patch", async () => {
                const issue = await story("Conformance: flagged combined");
                const updated = await h.backend.workTracker.updateIssue(issue.key, {
                    summary: "Conformance: flagged combined (renamed)",
                    flagged: true,
                });
                assert.equal(updated.summary, "Conformance: flagged combined (renamed)");
                assert.equal(isFlagged(updated), true);
                assert.equal(isFlagged(await read(issue.key)), true);
            });

            it("works on every issue type the board holds: Epic and subtask as well as Story", async () => {
                const epic = track(
                    await h.backend.workTracker.createIssue({ projectKey: h.projectKey, issueType: "epic", summary: "Conformance: flagged epic" })
                );
                const subtask = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        allowDuplicate: true,
                        summary: "Conformance: flagged subtask",
                    })
                );
                for (const key of [epic.key, subtask.key]) {
                    await h.backend.workTracker.updateIssue(key, { flagged: true });
                    assert.equal(isFlagged(await read(key)), true, `${key} flagged`);
                    await h.backend.workTracker.updateIssue(key, { flagged: false });
                    assert.equal(isFlagged(await read(key)), false, `${key} cleared`);
                }
            });

            it("search returns the flag too, so /tai-ready can see it", async () => {
                // Scoped by parent so the new Story is on the first page of a project that holds
                // many (search orders by key); a project-wide search would miss it on a busy board.
                const epic = track(
                    await h.backend.workTracker.createIssue({ projectKey: h.projectKey, issueType: "epic", summary: "Conformance: flagged search epic" })
                );
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        parentKey: epic.key,
                        summary: "Conformance: flagged via search",
                    })
                );
                const children = () => h.backend.workTracker.search({ projectKey: h.projectKey, parentKey: epic.key });
                await h.backend.workTracker.updateIssue(issue.key, { flagged: true });
                const found = await eventually(
                    children,
                    (hits) => hits.some((i) => i.key === issue.key && isFlagged(i)),
                    `${issue.key} not found flagged by search`
                );
                assert.equal(isFlagged(found.find((i) => i.key === issue.key)!), true);

                await h.backend.workTracker.updateIssue(issue.key, { flagged: false });
                const again = await eventually(
                    children,
                    (hits) => hits.some((i) => i.key === issue.key && !isFlagged(i)),
                    `${issue.key} still shows flagged in search`
                );
                assert.equal(isFlagged(again.find((i) => i.key === issue.key)!), false);
            });
        });

        // ---------- component / labels filters and the ranking signals (TAI-416/419/420) ----------

        describe("WorkTracker: component and labels filters, and the assignee-ranking signals (TAI-416/420)", () => {
            // The "candidate" is the harness's real assignable human: the roster knows people by email, so the
            // evidence loader is handed a directory that maps that email to the backend's real identity.
            const CANDIDATE_EMAIL = "conformance-candidate@example.com";
            const withDirectory = (wt: WorkTracker): WorkTracker =>
                Object.assign(Object.create(wt), {
                    resolveHuman: async (email: string) => (email === CANDIDATE_EMAIL ? h.validAssignee : wt.resolveHuman(email)),
                }) as WorkTracker;
            const candidate: HumanRef = { id: toHumanId(CANDIDATE_EMAIL), displayName: "Conformance Candidate", email: CANDIDATE_EMAIL };

            async function subtask(parent: IssueKey, type: SubtaskType, summary: string, extra: { assignee?: HumanRef } = {}) {
                return track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: type,
                        parentKey: parent,
                        allowDuplicate: true,
                        summary,
                        ...extra,
                    })
                );
            }

            it("search filters by component and by labels (every listed label), and the signals read back through the real tracker", async () => {
                const story = track(
                    await h.backend.workTracker.createIssue({ projectKey: h.projectKey, issueType: StoryType.Story, summary: "Conformance: ranking signals story" })
                );
                // open and assigned: same-Story continuity + load + matching component/labels
                const open = await subtask(story.key, SubtaskType.Dev, "Conformance: signals open dev", { assignee: h.validAssignee });
                await h.backend.workTracker.updateIssue(open.key, { component: "tai-framework", labels: ["conf-x", "conf-y"] });
                // Done and assigned: area knowledge (same Component, within the window)
                const done = await subtask(story.key, SubtaskType.Dev, "Conformance: signals done dev", { assignee: h.validAssignee });
                await h.backend.workTracker.updateIssue(done.key, { component: "tai-framework", labels: ["conf-x"] });
                assert.equal((await h.backend.workTracker.transition(done.key, Status.Done)).ok, true, "the fixture must really be Done");
                // unassigned, component only
                const bare = await subtask(story.key, SubtaskType.Dev, "Conformance: signals bare dev");
                await h.backend.workTracker.updateIssue(bare.key, { component: "tai-framework" });

                const under = (extra: Record<string, unknown>) => async () =>
                    (await h.backend.workTracker.search({ projectKey: h.projectKey, parentKey: story.key, ...extra } as never))
                        .map((i) => i.key as string)
                        .sort();
                const keys = (...issues: { key: IssueKey }[]) => issues.map((i) => i.key as string).sort();

                assert.deepEqual(
                    await eventually(under({ component: "tai-framework" }), (k) => k.length === 3, "component filter"),
                    keys(open, done, bare)
                );
                assert.deepEqual(
                    await eventually(under({ labels: ["conf-x"] }), (k) => k.length === 2, "one-label filter"),
                    keys(open, done)
                );
                assert.deepEqual(
                    await eventually(under({ labels: ["conf-x", "conf-y"] }), (k) => k.length === 1, "every-label filter"),
                    keys(open)
                );
                // updatedSince is an instant: a past one keeps these, a future one matches nothing. Found live (TAI-420):
                // Jira silently matched NOTHING for an ISO date-time string, so this proves it on a real backend.
                const dayMs = 86_400_000;
                await eventually(under({ updatedSince: new Date(Date.now() - dayMs).toISOString() }), (k) => k.length === 3, "updatedSince in the past");
                assert.deepEqual(await under({ updatedSince: new Date(Date.now() + dayMs).toISOString() })(), [], "nothing was updated in the future");
                assert.deepEqual(await under({ labels: ["conf-missing"] })(), [], "a label nobody carries matches nothing");
                assert.deepEqual(await under({ component: "no-such-component-xyz" })(), [], "a component nobody carries matches nothing");

                // the evidence loader, end to end against this backend, for a new ticket in the same area
                const target = await subtask(story.key, SubtaskType.IntegrationTest, "Conformance: signals target");
                await h.backend.workTracker.updateIssue(target.key, { component: "tai-framework" });
                const targetNow = (await h.backend.workTracker.getIssue(target.key))!;
                let last: Awaited<ReturnType<typeof gatherAssigneeEvidence>>[number] | undefined;
                const evidence = await eventually(
                    async () => (last = (await gatherAssigneeEvidence(withDirectory(h.backend.workTracker), targetNow, [candidate], { onWarning: () => {} }))[0]!),
                    (e) => e.continuity !== null && e.area !== null && (e.openCount ?? 0) >= 1,
                    () =>
                        `ranking evidence incomplete -- still missing: ${
                            [
                                last?.continuity === null ? "continuity" : null,
                                last?.area === null ? "area knowledge" : null,
                                (last?.openCount ?? 0) < 1 ? "open-ticket load" : null,
                            ]
                                .filter(Boolean)
                                .join(", ") || "nothing (condition changed)"
                        }`
                );
                assert.equal(evidence.continuity?.tier, 1, "assigned to a sibling under the same Story");
                assert.match(evidence.continuity!.reasons[0]!, /^worked on this Story \(/);
                assert.ok(evidence.area!.count >= 1, "closed a Done ticket under the same Component within the window");
                assert.ok((evidence.openCount ?? 0) >= 1, "the open sibling counts as load");
            });

            it("a ticket linked to the target gives tier-2 continuity, read through the real link API", async () => {
                const other = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: linked ticket (assigned)",
                        assignee: h.validAssignee,
                    })
                );
                const target = track(
                    await h.backend.workTracker.createIssue({ projectKey: h.projectKey, issueType: StoryType.Story, summary: "Conformance: link target" })
                );
                await h.backend.workTracker.createLink(target.key, DependencyRelation.RelatesTo, other.key);
                const evidence = await eventually(
                    async () => (await gatherAssigneeEvidence(withDirectory(h.backend.workTracker), target, [candidate], { onWarning: () => {} }))[0]!,
                    (e) => e.continuity !== null,
                    "linked-ticket continuity"
                );
                assert.equal(evidence.continuity?.tier, 2);
                assert.deepEqual(evidence.continuity?.reasons, [`worked on related ticket ${other.key}`]);
            });
        });

        // ---------- default persona on create (TAI-407/409/410) ----------

        describe("WorkTracker: createIssue default persona (TAI-407/409/410)", () => {
            it("a story-level ticket and an Epic with no persona default to PM", async () => {
                const story = track(
                    await h.backend.workTracker.createIssue({ projectKey: h.projectKey, issueType: StoryType.Story, summary: "Conformance: default persona story" })
                );
                const epic = track(
                    await h.backend.workTracker.createIssue({ projectKey: h.projectKey, issueType: "epic", summary: "Conformance: default persona epic" })
                );
                assert.equal(story.persona, Persona.Pm);
                assert.equal(epic.persona, Persona.Pm);
            });

            it("a subtask with no persona defaults to its type's owner", async () => {
                const parent = track(
                    await h.backend.workTracker.createIssue({ projectKey: h.projectKey, issueType: StoryType.Story, summary: "Conformance: default persona parent" })
                );
                for (const [type, owner] of [
                    [SubtaskType.Dev, Persona.Developer],
                    [SubtaskType.IntegrationTest, Persona.Tester],
                    [SubtaskType.ArchitectureDesign, Persona.Architect],
                ] as const) {
                    const sub = track(
                        await h.backend.workTracker.createIssue({
                            projectKey: h.projectKey,
                            issueType: type,
                            parentKey: parent.key,
                            summary: `Conformance: default persona ${type}`,
                        })
                    );
                    assert.equal(sub.persona, owner, type);
                }
            });

            it("an explicit persona always wins over the default", async () => {
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: explicit persona wins",
                        persona: Persona.Architect,
                    })
                );
                assert.equal(story.persona, Persona.Architect);
            });

            it("a SpikeTask with no persona has no default and is created persona-less", async () => {
                const parent = track(
                    await h.backend.workTracker.createIssue({ projectKey: h.projectKey, issueType: StoryType.Story, summary: "Conformance: spike-task parent" })
                );
                const spike = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.SpikeTask,
                        parentKey: parent.key,
                        summary: "Conformance: persona-less spike task",
                    })
                );
                assert.equal(spike.persona ?? null, null);
            });
        });

        // ---------- search past the limit (TAI-398/403) ----------

        describe("WorkTracker: search limit vs exhaustive (TAI-398/403)", () => {
            // A small `limit` stands in for DEFAULT_SEARCH_LIMIT so three children are enough to
            // tell "bounded" from "everything" without creating 50+ live fixtures. Real cursor
            // paging (>100 results) is covered by the stubbed Jira unit test.
            // Both tests only read this fixture, so build it once (lazily) and share it.
            let fixture: ReturnType<typeof buildEpicWithChildren> | undefined;
            const epicWithChildren = () => (fixture ??= buildEpicWithChildren(3));
            async function buildEpicWithChildren(count: number) {
                const epic = track(
                    await h.backend.workTracker.createIssue({ projectKey: h.projectKey, issueType: "epic", summary: "Conformance: limit epic" })
                );
                const keys: string[] = [];
                for (let i = 0; i < count; i++) {
                    const child = track(
                        await h.backend.workTracker.createIssue({
                            projectKey: h.projectKey,
                            issueType: StoryType.Story,
                            parentKey: epic.key,
                            summary: `Conformance: limit child ${i}`,
                        })
                    );
                    keys.push(child.key);
                }
                return { epic, keys };
            }

            it("a bounded search returns at most `limit`; an exhaustive one returns every match", async () => {
                const { epic, keys } = await epicWithChildren();
                const all = () => h.backend.workTracker.search({ projectKey: h.projectKey, parentKey: epic.key, exhaustive: true });
                const found = await eventually(all, (hits) => hits.length >= keys.length, `exhaustive search missing children of ${epic.key}`);
                assert.deepEqual([...found.map((i) => i.key as string)].sort(), [...keys].sort());

                const bounded = await h.backend.workTracker.search({ projectKey: h.projectKey, parentKey: epic.key, limit: 2 });
                assert.equal(bounded.length, 2, "limit still bounds a non-exhaustive search");
            });

            it("exhaustive ignores `limit`, and still honors the other filter fields", async () => {
                const { epic, keys } = await epicWithChildren();
                const filter = { projectKey: h.projectKey, parentKey: epic.key, exhaustive: true, limit: 1 };
                const found = await eventually(
                    () => h.backend.workTracker.search(filter),
                    (hits) => hits.length >= keys.length,
                    `exhaustive+limit search missing children of ${epic.key}`
                );
                assert.equal(found.length, keys.length);

                const none = await h.backend.workTracker.search({ ...filter, statuses: [Status.Done] });
                assert.equal(none.length, 0, "exhaustive does not widen the filter, only the result cap");
            });
        });

        // ---------- read-your-write child lookup (TAI-381) ----------

        describe("WorkTracker: search with readYourWrites (TAI-381)", () => {
            it("returns a subtask created a moment ago IMMEDIATELY, with no polling", async () => {
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: read-your-write parent",
                    })
                );
                const dev = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: story.key,
                        summary: "Conformance: read-your-write child",
                    })
                );
                const found = await h.backend.workTracker.search({
                    projectKey: h.projectKey,
                    parentKey: story.key,
                    readYourWrites: true,
                });
                assert.deepEqual(found.map((i) => i.key), [dev.key]);
            });

            it("still applies the rest of the filter to what it returns", async () => {
                const story = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: read-your-write filter parent",
                    })
                );
                track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: story.key,
                        summary: "Conformance: read-your-write filter child",
                    })
                );
                const none = await h.backend.workTracker.search({
                    projectKey: h.projectKey,
                    parentKey: story.key,
                    issueTypes: [SubtaskType.SpikeTask],
                    readYourWrites: true,
                });
                assert.deepEqual(none, []);
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

            it("removeLink removes what createLink made, and says so when there is nothing to remove", async () => {
                const parent = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: unlink parent",
                    })
                );
                const blocker = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: parent.key,
                        summary: "Conformance: unlink blocker",
                    })
                );
                const dependent = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.CodeReview,
                        parentKey: parent.key,
                        summary: "Conformance: unlink dependent",
                    })
                );
                const wt = h.backend.workTracker;

                await wt.createLink(dependent.key, DependencyRelation.DependsOn, blocker.key);
                await wt.createLink(dependent.key, DependencyRelation.RelatesTo, blocker.key);

                // The reverse of a DependsOn link is not that link.
                assert.equal(await wt.removeLink(blocker.key, DependencyRelation.DependsOn, dependent.key), false);
                assert.ok(
                    (await wt.getLinkedIssues(dependent.key, DependencyRelation.DependsOn, "outgoing")).some(
                        (l) => l.key === blocker.key
                    ),
                    "a non-matching removeLink must change nothing"
                );

                assert.equal(await wt.removeLink(dependent.key, DependencyRelation.DependsOn, blocker.key), true);
                assert.deepEqual(
                    [...(await wt.getLinkedIssues(dependent.key, DependencyRelation.DependsOn, "outgoing"))],
                    [],
                    "the DependsOn link is gone"
                );
                assert.ok(
                    (await wt.getLinkedIssues(dependent.key, DependencyRelation.RelatesTo)).some((l) => l.key === blocker.key),
                    "the RelatesTo link between the same pair is untouched"
                );

                // RelatesTo is symmetric: removing it from the other end works.
                assert.equal(await wt.removeLink(blocker.key, DependencyRelation.RelatesTo, dependent.key), true);
                assert.deepEqual([...(await wt.getLinkedIssues(dependent.key, DependencyRelation.RelatesTo))], []);

                assert.equal(await wt.removeLink(dependent.key, DependencyRelation.DependsOn, blocker.key), false, "already gone");
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

                // Plain search is eventually consistent on Jira (TAI-381): poll until the match is visible, then check
                // the non-match is absent -- that negative assertion stays strict once the index has caught up.
                const results = await eventually(
                    () =>
                        h.backend.workTracker.search({
                            projectKey: h.projectKey,
                            parentKey: parent.key,
                            issueTypes: [SubtaskType.Dev],
                            persona: Persona.Developer,
                        }),
                    (r) => r.some((i) => i.key === match.key),
                    "search must find the matching issue"
                );
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

                // Plain search is eventually consistent on Jira (TAI-381), so poll there.
                await eventually(
                    childKeys(epic.key),
                    (keys) => keys.includes(story.key),
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

            // TAI-643 (Story TAI-627, AC-5): the Settings page is a markdown table plus a bullet list. Saving it must keep
            // what a person added by hand, and a read must give back what was saved, on every backend.
            it("keeps a Settings-shaped page through save and read: table rows, admins, hand notes and unknown rows", async () => {
                const saved = withAdmins(withValue(EMPTY_SETTINGS, "a@example.com", "review-rounds", "3"), ["a@example.com"]);
                const page = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: settings ${Date.now()}`,
                        content: renderSettingsPage(saved),
                    })
                );
                const first = parseSettingsPage((await h.backend.docStore.getPage({ id: page.id }))!.content);
                assert.equal(first.state.values.get("a@example.com")?.get("review-rounds"), "3");
                assert.deepEqual(first.state.admins, ["a@example.com"]);

                // A person edits the page by hand: a note, an unknown row and an extra column.
                const edited = page.content
                    .replace("| --- | --- | --- |", "| --- | --- | --- |\n| b@example.com | future-setting | 1 |")
                    .replace("## Autonomy admins", "Hand note: keep me.\n\n## Autonomy admins");
                await h.backend.docStore.updatePage({ id: page.id }, { content: edited });

                const read = (await h.backend.docStore.getPage({ id: page.id }))!.content;
                const changed = withValue(parseSettingsPage(read).state, "a@example.com", "review-rounds", "5");
                await h.backend.docStore.updatePage({ id: page.id }, { content: mergeSettingsPage(read, changed) });

                const after = (await h.backend.docStore.getPage({ id: page.id }))!.content;
                const { state, unknown } = parseSettingsPage(after);
                assert.equal(state.values.get("a@example.com")?.get("review-rounds"), "5", "the saved change must read back");
                assert.deepEqual(state.admins, ["a@example.com"]);
                assert.deepEqual(unknown, ["future-setting"], "the unknown row must still be on the page");
                assert.match(after, /Hand note: keep me\./);
            });

            // TAI-305: filing a loose page into its doc-type folder (brief §4 rev 11/14)
            // needs a real move, not just a create-with-parent -- confirms updatePage's new
            // parentId patch field actually reparents on both backends.
            it("updatePage with parentId moves the page under a new parent", async () => {
                const originalParent = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: original parent ${Date.now()}`,
                        content: "x",
                    })
                );
                const newParent = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: new parent ${Date.now()}`,
                        content: "x",
                    })
                );
                const page = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: movable page ${Date.now()}`,
                        content: "x",
                        parentId: originalParent.id,
                    })
                );

                const moved = await h.backend.docStore.updatePage({ id: page.id }, { parentId: newParent.id });
                assert.equal(moved.parentId, newParent.id);

                const newParentChildren = await h.backend.docStore.getChildren({ id: newParent.id });
                assert.ok(newParentChildren.some((c) => c.id === page.id), "must appear under the new parent");
                const originalParentChildren = await h.backend.docStore.getChildren({ id: originalParent.id });
                assert.ok(
                    !originalParentChildren.some((c) => c.id === page.id),
                    "must no longer appear under the original parent"
                );
            });

            // TAI-600 (TAI-597): the doc-type folder rule is enforced above DocStore (`doc-folders.ts`) but rests
            // on three backend behaviors, checked here on both: listing a space's root, find-or-create by title
            // without a duplicate, and filing a page by reparenting it. Assertions are by inclusion, since a live
            // space has other pages at its root.
            describe("doc-type folders (TAI-597)", () => {
                /** The folder this test needs, tracked for disposal ONLY when this test created it: on a live
                 *  space the folder may already exist, and deleting a page that was not ours would be wrong. */
                async function folderFor(type: string) {
                    const title = folderForDocType(type)!;
                    const existed = (await h.backend.docStore.getPage({ spaceKey: h.spaceKey, title })) !== null;
                    const folder = (await ensureDocFolder(h.backend.docStore, h.spaceKey, type))!;
                    if (!existed) trackPage(folder);
                    return { folder, existed };
                }

                it("listRootPages lists a page with no parent and not one with a parent", async () => {
                    const loose = trackPage(
                        await h.backend.docStore.createPage({
                            spaceKey: h.spaceKey,
                            title: `Conformance: root page ${Date.now()}`,
                            content: "x",
                        })
                    );
                    const child = trackPage(
                        await h.backend.docStore.createPage({
                            spaceKey: h.spaceKey,
                            title: `Conformance: child of root page ${Date.now()}`,
                            content: "x",
                            parentId: loose.id,
                        })
                    );
                    const roots = await eventually(
                        () => h.backend.docStore.listRootPages(h.spaceKey),
                        (pages) => pages.some((p) => p.id === loose.id),
                        "the new root page in listRootPages"
                    );
                    // A page reports the space's canonical key, which on Confluence is not the alias the harness uses.
                    assert.ok(roots.every((p) => p.spaceKey === loose.spaceKey));
                    assert.ok(!roots.some((p) => p.id === child.id), "a page with a parent is not at the root");
                    const found = roots.find((p) => p.id === loose.id)!;
                    assert.equal(found.title, loose.title);
                });

                it("listRootPages honours its limit", async () => {
                    trackPage(
                        await h.backend.docStore.createPage({
                            spaceKey: h.spaceKey,
                            title: `Conformance: limit page ${Date.now()}`,
                            content: "x",
                        })
                    );
                    const one = await h.backend.docStore.listRootPages(h.spaceKey, 1);
                    assert.equal(one.length, 1);
                });

                it("ensureDocFolder finds the folder on a second call instead of creating a duplicate", async () => {
                    const { folder } = await folderFor("test-plan");
                    assert.equal(folder.title, "Test Plans");
                    const again = await ensureDocFolder(h.backend.docStore, h.spaceKey, "test-plan");
                    assert.equal(again?.id, folder.id);
                    const shared = await ensureDocFolder(h.backend.docStore, h.spaceKey, "uat-plan");
                    assert.equal(shared?.id, folder.id, "two types in one folder share one page");
                    const roots = await h.backend.docStore.listRootPages(h.spaceKey, 250);
                    assert.equal(roots.filter((p) => p.title === "Test Plans").length, 1, "exactly one folder page, at the top of the tree");
                });

                it("filePage moves a loose page under its folder and out of the root", async () => {
                    const loose = trackPage(
                        await h.backend.docStore.createPage({
                            spaceKey: h.spaceKey,
                            title: `Conformance: loose schema notes ${Date.now()}`,
                            content: "x",
                        })
                    );
                    // The folder first, so it is tracked for disposal when this test is what created it.
                    const { folder } = await folderFor("schema-notes");
                    const filed = await filePage(h.backend.docStore, loose.id, "schema-notes");
                    assert.equal(filed.parentId, folder.id);
                    const children = await h.backend.docStore.getChildren({ id: folder.id });
                    assert.ok(children.some((c) => c.id === loose.id), "the page is a child of its folder");
                    const roots = await h.backend.docStore.listRootPages(h.spaceKey, 250);
                    assert.ok(!roots.some((p) => p.id === loose.id), "the page is no longer at the root");
                });
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

        // ---------- Out-of-band change detection (TAI-285 ADR, TAI-291) ----------
        // `refreshIssue`/`cacheIssue` (issue-cache.ts), `refreshPage`/`cachePage`
        // (page-cache.ts), and `snapshotLinkedKeys` (links-snapshot.ts) are themselves
        // backend-agnostic — pure field comparisons plus calls through the very
        // `StorageBackend` methods already exercised elsewhere in this suite. What none of
        // those other tests confirm: whether `updatedAt` — the signal this entire ADR is
        // built on (issue-cache.ts's own doc comment) — actually moves, and only moves,
        // when it should, identically on both backends. A backend that bumped `updatedAt`
        // on every read (false positives) or failed to bump it on a real field change
        // (silently swallowed warnings) would satisfy every other test in this file while
        // breaking the whole mechanism.
        describe("Cache: out-of-band change detection (TAI-285 ADR)", () => {
            let taiRoot: string;

            before(async () => {
                taiRoot = await mkdtemp(path.join(tmpdir(), "tai-conformance-cache-"));
            });

            after(async () => {
                await rm(taiRoot, { recursive: true, force: true }).catch(() => {});
            });

            it('refreshIssue: no prior cache, then no real change, both classify as "none"', async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        allowDuplicate: true,
                        summary: "Conformance: change detection baseline",
                    })
                );
                const first = await refreshIssue(h.backend.workTracker, taiRoot, h.projectKey, issue.key);
                assert.equal(first.change.severity, "none", "first-ever cache write has nothing to compare against");
                assert.deepEqual(first.change.fields, []);

                const second = await refreshIssue(h.backend.workTracker, taiRoot, h.projectKey, issue.key);
                assert.equal(second.change.severity, "none", "nothing changed between the two refreshes");
                assert.deepEqual(second.change.fields, []);
            });

            it('refreshIssue: a content-only edit (summary) classifies as "content", naming the field', async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        allowDuplicate: true,
                        summary: "Conformance: content change (before)",
                    })
                );
                await refreshIssue(h.backend.workTracker, taiRoot, h.projectKey, issue.key);

                // A tiny real delay, not a race against the clock: the filesystem backend has
                // no network latency to naturally separate create from edit, so two calls back
                // to back can otherwise land in the same millisecond and make `updatedAt`
                // compare equal, masking a real change -- found by actually running this test
                // (same pattern as the comment-editing test earlier in this file).
                await new Promise((r) => setTimeout(r, 5));
                await h.backend.workTracker.updateIssue(issue.key, {
                    summary: "Conformance: content change (after)",
                });
                const refreshed = await refreshIssue(h.backend.workTracker, taiRoot, h.projectKey, issue.key);
                assert.equal(refreshed.change.severity, "content");
                assert.ok(refreshed.change.fields.includes("summary"));
            });

            it('refreshIssue: a structural edit (status via transition) classifies as "structural", naming the field', async () => {
                const issue = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: SubtaskType.Dev,
                        parentKey: sharedParentKey,
                        allowDuplicate: true,
                        summary: "Conformance: structural change",
                    })
                );
                await h.backend.workTracker.assignIssue(issue.key, h.validAssignee);
                await refreshIssue(h.backend.workTracker, taiRoot, h.projectKey, issue.key);

                // See the content-only test above for why this delay is needed.
                await new Promise((r) => setTimeout(r, 5));
                const transitioned = await h.backend.workTracker.transition(issue.key, Status.InProgress);
                assert.equal(transitioned.ok, true);

                const refreshed = await refreshIssue(h.backend.workTracker, taiRoot, h.projectKey, issue.key);
                assert.equal(refreshed.change.severity, "structural");
                assert.ok(refreshed.change.fields.includes("status"));
            });

            it('refreshPage: no prior cache, then a content edit classifies as "content", naming the field', async () => {
                const page = trackPage(
                    await h.backend.docStore.createPage({
                        spaceKey: h.spaceKey,
                        title: `Conformance: page change detection ${Date.now()}`,
                        content: "before",
                    })
                );
                const first = await refreshPage(h.backend.docStore, taiRoot, h.projectKey, { id: page.id });
                assert.equal(first.change.severity, "none", "first-ever cache write has nothing to compare against");

                // See the content-only issue test above for why this delay is needed.
                await new Promise((r) => setTimeout(r, 5));
                await h.backend.docStore.updatePage({ id: page.id }, { content: "after" });
                const refreshed = await refreshPage(h.backend.docStore, taiRoot, h.projectKey, { id: page.id });
                assert.equal(refreshed.change.severity, "content");
                assert.ok(refreshed.change.fields.includes("content"));
            });

            it("snapshotLinkedKeys: no prior snapshot is unchanged; an added link is detected; a stable set is not", async () => {
                const from = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: link-snapshot source",
                    })
                );
                const to = track(
                    await h.backend.workTracker.createIssue({
                        projectKey: h.projectKey,
                        issueType: StoryType.Story,
                        summary: "Conformance: link-snapshot target",
                    })
                );

                const beforeLinks = await h.backend.workTracker.getLinkedIssues(from.key, undefined, "outgoing");
                const first = await snapshotLinkedKeys(taiRoot, h.projectKey, from.key, beforeLinks);
                assert.equal(first, false, "no prior snapshot -- nothing to have changed from");

                await h.backend.workTracker.createLink(from.key, DependencyRelation.RelatesTo, to.key);
                const afterLinks = await h.backend.workTracker.getLinkedIssues(from.key, undefined, "outgoing");
                const second = await snapshotLinkedKeys(taiRoot, h.projectKey, from.key, afterLinks);
                assert.equal(second, true, "an added outgoing link must be detected");

                const stableLinks = await h.backend.workTracker.getLinkedIssues(from.key, undefined, "outgoing");
                const third = await snapshotLinkedKeys(taiRoot, h.projectKey, from.key, stableLinks);
                assert.equal(third, false, "an unchanged link set must not be reported as changed");
            });
        });
    });
}

/** Re-exported so backend-specific test files can assert on it without a second import. */
export { StorageConnectivityError };
