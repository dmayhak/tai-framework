import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DependencyRelation, Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, type HumanRef, type StorageBackend, type WorkTracker } from "../storage/interface.js";
import { gatherAssigneeEvidence } from "./assignee-evidence.js";
import { rankAssignees } from "./assignee-ranking.js";

const person = (name: string): HumanRef => ({ id: toHumanId(`acct-${name}`), displayName: name, email: `${name.toLowerCase()}@example.com` });
const ANN = person("Ann");
const BO = person("Bo");
const CY = person("Cy");
const DI = person("Di");
const DIRECTORY = new Map([ANN, BO, CY, DI].map((h) => [h.email!, h]));
const roster = [ANN, BO, CY, DI].map((h) => ({ id: toHumanId(h.email!), displayName: h.displayName, email: h.email }) as HumanRef);

async function withTracker(fn: (wt: WorkTracker, backend: StorageBackend) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-evidence-"));
    try {
        const backend = createFilesystemBackend(dir, ANN);
        // The filesystem backend only resolves the current user; a real directory resolves everyone.
        const wt = Object.assign(Object.create(backend.workTracker), {
            resolveHuman: async (email: string) => DIRECTORY.get(email) ?? null,
        }) as WorkTracker;
        await fn(wt, backend);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

const mk = (wt: WorkTracker, over: Record<string, unknown>) =>
    wt.createIssue({ projectKey: "TAI", persona: Persona.Developer, summary: "s", ...over } as never);
const ev = (evidence: Awaited<ReturnType<typeof gatherAssigneeEvidence>>, name: string) => evidence.find((e) => e.candidate.displayName === name)!;

describe("gatherAssigneeEvidence (TAI-419 ADR decisions 7-9)", () => {
    it("a sibling subtask under the same Story is tier-1 continuity", async () => {
        await withTracker(async (wt) => {
            const story = await mk(wt, { issueType: StoryType.Story });
            const dev = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story.key, assignee: BO });
            const test = await mk(wt, { issueType: SubtaskType.IntegrationTest, parentKey: story.key });
            const evidence = await gatherAssigneeEvidence(wt, test, roster);
            assert.equal(ev(evidence, "Bo").continuity?.tier, 1);
            assert.deepEqual(ev(evidence, "Bo").continuity?.reasons, [`worked on this Story (${dev.key})`]);
            assert.equal(ev(evidence, "Ann").continuity, null);
        });
    });

    it("a ticket linked to this one is tier-2 continuity", async () => {
        await withTracker(async (wt) => {
            const other = await mk(wt, { issueType: StoryType.Story, assignee: CY });
            const target = await mk(wt, { issueType: StoryType.Story });
            await wt.createLink(target.key, DependencyRelation.RelatesTo, other.key);
            const evidence = await gatherAssigneeEvidence(wt, target, roster);
            assert.equal(ev(evidence, "Cy").continuity?.tier, 2);
            assert.deepEqual(ev(evidence, "Cy").continuity?.reasons, [`worked on related ticket ${other.key}`]);
        });
    });

    it("a ticket one level under the same Epic is tier-3 continuity (also for a subtask, via its Story)", async () => {
        await withTracker(async (wt) => {
            const epic = await mk(wt, { issueType: "epic" });
            const mine = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
            const sibling = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key, assignee: DI });
            const sub = await mk(wt, { issueType: SubtaskType.Dev, parentKey: mine.key });
            for (const issue of [mine, sub]) {
                const evidence = await gatherAssigneeEvidence(wt, issue, roster);
                assert.equal(ev(evidence, "Di").continuity?.tier, 3, issue.key);
                assert.deepEqual(ev(evidence, "Di").continuity?.reasons, [`worked on this Epic (${sibling.key})`]);
            }
        });
    });

    it("for a Bug, the Dev assignee on the Story it relates to 'caused the bug' (tier 1)", async () => {
        await withTracker(async (wt) => {
            const delivered = await mk(wt, { issueType: StoryType.Story });
            await mk(wt, { issueType: SubtaskType.Dev, parentKey: delivered.key, assignee: BO });
            const bug = await mk(wt, { issueType: StoryType.Bug });
            await wt.createLink(bug.key, DependencyRelation.RelatesTo, delivered.key);
            const evidence = await gatherAssigneeEvidence(wt, bug, roster);
            assert.equal(ev(evidence, "Bo").continuity?.tier, 1);
            assert.ok(ev(evidence, "Bo").continuity?.reasons.includes(`caused the bug (delivered in ${delivered.key})`));
        });
    });

    it("a DesignReview marks the ArchitectureDesign assignee as the author of the work under review", async () => {
        await withTracker(async (wt) => {
            const story = await mk(wt, { issueType: StoryType.Story });
            await mk(wt, { issueType: SubtaskType.ArchitectureDesign, parentKey: story.key, assignee: ANN });
            const review = await mk(wt, { issueType: SubtaskType.DesignReview, parentKey: story.key });
            const evidence = await gatherAssigneeEvidence(wt, review, roster);
            assert.equal(ev(evidence, "Ann").authoredWorkUnderReview, true);
            assert.equal(ev(evidence, "Bo").authoredWorkUnderReview, false);
            // ...and the ranking then puts her last, not out.
            const ranked = rankAssignees(evidence);
            assert.equal(ranked[ranked.length - 1]!.candidate.displayName, "Ann");
        });
    });

    it("area knowledge counts Done tickets with the same Component or label within the window", async () => {
        await withTracker(async (wt) => {
            for (let i = 0; i < 2; i++) {
                const t = await mk(wt, { issueType: StoryType.Story, component: "tai-framework", assignee: BO });
                await wt.transition(t.key, Status.Done);
            }
            const l = await mk(wt, { issueType: StoryType.Story, labels: ["backend"], assignee: CY });
            await wt.transition(l.key, Status.Done);
            const target = await mk(wt, { issueType: StoryType.Story, component: "tai-framework", labels: ["backend"] });
            const evidence = await gatherAssigneeEvidence(wt, target, roster);
            assert.equal(ev(evidence, "Bo").area?.count, 2);
            assert.match(ev(evidence, "Bo").area!.reasons[0]!, /closed 2 tickets under component tai-framework in the last 90 days/);
            assert.equal(ev(evidence, "Cy").area?.count, 1);
            assert.match(ev(evidence, "Cy").area!.reasons[0]!, /closed 1 ticket labelled backend in the last 90 days/);
            assert.equal(ev(evidence, "Ann").area, null);
        });
    });

    it("a ticket outside the recency window does not count, and a ticket with no Component or labels has no area signal", async () => {
        await withTracker(async (wt) => {
            const t = await mk(wt, { issueType: StoryType.Story, component: "tai-framework", assignee: BO });
            await wt.transition(t.key, Status.Done);
            const target = await mk(wt, { issueType: StoryType.Story, component: "tai-framework" });
            const farFuture = new Date(Date.now() + 200 * 86_400_000);
            assert.equal(ev(await gatherAssigneeEvidence(wt, target, roster, { now: farFuture }), "Bo").area, null);
            const plain = await mk(wt, { issueType: StoryType.Story });
            assert.equal(ev(await gatherAssigneeEvidence(wt, plain, roster), "Bo").area, null);
        });
    });

    it("the area window honours areaWindowDays", async () => {
        await withTracker(async (wt) => {
            const t = await mk(wt, { issueType: StoryType.Story, component: "c", assignee: BO });
            await wt.transition(t.key, Status.Done);
            const target = await mk(wt, { issueType: StoryType.Story, component: "c" });
            const later = new Date(Date.now() + 20 * 86_400_000);
            assert.equal(ev(await gatherAssigneeEvidence(wt, target, roster, { now: later, areaWindowDays: 30 }), "Bo").area?.count, 1);
            assert.equal(ev(await gatherAssigneeEvidence(wt, target, roster, { now: later, areaWindowDays: 10 }), "Bo").area, null);
        });
    });

    it("load is the open-ticket count per candidate, from one search", async () => {
        await withTracker(async (wt) => {
            await mk(wt, { issueType: StoryType.Story, assignee: BO });
            await mk(wt, { issueType: StoryType.Story, assignee: BO });
            const done = await mk(wt, { issueType: StoryType.Story, assignee: CY });
            await wt.transition(done.key, Status.Done);
            const target = await mk(wt, { issueType: StoryType.Story });
            const evidence = await gatherAssigneeEvidence(wt, target, roster);
            assert.equal(ev(evidence, "Bo").openCount, 2);
            assert.equal(ev(evidence, "Cy").openCount, 0, "a Done ticket is not load");
            assert.equal(ev(evidence, "Ann").openCount, 0);
        });
    });

    it("a candidate with no email, or no Jira user, gets no signals and an unknown open count", async () => {
        await withTracker(async (wt) => {
            const target = await mk(wt, { issueType: StoryType.Story });
            const ghost = { id: toHumanId("ghost"), displayName: "Ghost" } as HumanRef;
            const unknown = { id: toHumanId("nobody@example.com"), displayName: "Nobody", email: "nobody@example.com" } as HumanRef;
            const evidence = await gatherAssigneeEvidence(wt, target, [ghost, unknown]);
            for (const e of evidence) {
                assert.equal(e.continuity, null);
                assert.equal(e.openCount, null);
            }
        });
    });
});
