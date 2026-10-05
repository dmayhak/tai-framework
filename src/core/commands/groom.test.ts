import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DependencyRelation, Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, type HumanRef, type WorkTracker } from "../storage/interface.js";
import { reportUnreadableIssue, takeUnreadableIssues } from "../storage/unreadable-issues.js";
import { findGroomingWork, mapWithLimit, renderGroomingBriefing, staleBacklogDaysFromEnv, type GroomingDeps } from "./groom.js";

const ME: HumanRef = { id: toHumanId("a@b.c"), displayName: "A", email: "a@b.c" };

async function withTracker(fn: (wt: WorkTracker) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-groom-"));
    try {
        await fn(createFilesystemBackend(dir, ME).workTracker);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
const deps = (wt: WorkTracker, over: Partial<GroomingDeps> = {}): GroomingDeps => ({ workTracker: wt, projectKey: "TAI", ...over });
const mk = (wt: WorkTracker, over: Record<string, unknown>) =>
    wt.createIssue({ projectKey: "TAI", persona: Persona.Pm, summary: "s", ...over } as never);
const keys = (issues: readonly { key: string }[]) => issues.map((i) => i.key).sort();

describe("findGroomingWork (TAI-395, ADR page 48463873)", () => {
    it("(a) lists an epic with no children, in any open status, and not one that has a child", async () => {
        await withTracker(async (wt) => {
            const bare = await mk(wt, { issueType: "epic" });
            const full = await mk(wt, { issueType: "epic" });
            const done = await mk(wt, { issueType: StoryType.Story, parentKey: full.key });
            await wt.transition(done.key, Status.Done);
            const bareToDo = await mk(wt, { issueType: "epic" });
            await wt.transition(bareToDo.key, Status.ToDo);
            const result = await findGroomingWork(deps(wt));
            assert.deepEqual(keys(result.childlessEpics), keys([bare, bareToDo]));
        });
    });

    it("(b) lists a Backlog Kickoff under an epic with its epic, its OPEN blockers and its flag", async () => {
        await withTracker(async (wt) => {
            const epic = await mk(wt, { issueType: "epic" });
            const kickoff = await mk(wt, { issueType: StoryType.Kickoff, parentKey: epic.key });
            const open = await mk(wt, { issueType: StoryType.Kickoff, parentKey: epic.key });
            // (a Kickoff's own Done runs the review gate; the finished blocker can be any ticket)
            const done = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
            await wt.transition(done.key, Status.Done);
            await wt.createLink(kickoff.key, DependencyRelation.DependsOn, open.key);
            await wt.createLink(kickoff.key, DependencyRelation.DependsOn, done.key);
            await wt.updateIssue(kickoff.key, { flagged: true });
            const result = await findGroomingWork(deps(wt));
            const row = result.backlogKickoffs.find((r) => r.issue.key === kickoff.key)!;
            assert.equal(row.epic?.key, epic.key);
            assert.deepEqual(row.openBlockers, [open.key]);
            assert.equal(row.flagged, true);
        });
    });

    it("(c) promotion candidates are Backlog tickets with at least one depends-on blocker and ALL of them Done or Canceled", async () => {
        await withTracker(async (wt) => {
            const epic = await mk(wt, { issueType: "epic" });
            const doneBlocker = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
            await wt.transition(doneBlocker.key, Status.Done);
            const openBlocker = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
            const ready = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
            const waiting = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
            const noLinks = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
            await wt.createLink(ready.key, DependencyRelation.DependsOn, doneBlocker.key);
            await wt.createLink(waiting.key, DependencyRelation.DependsOn, doneBlocker.key);
            await wt.createLink(waiting.key, DependencyRelation.DependsOn, openBlocker.key);
            const result = await findGroomingWork(deps(wt));
            assert.deepEqual(keys(result.promotionCandidates), [ready.key]);
            assert.ok(!keys(result.promotionCandidates).includes(noLinks.key));
        });
    });

    it("(d) lists flagged tickets in EVERY open status, not Done", async () => {
        await withTracker(async (wt) => {
            const epic = await mk(wt, { issueType: "epic" });
            const flagged: string[] = [];
            for (const status of [Status.Backlog, Status.ToDo]) {
                const t = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
                if (status !== Status.Backlog) await wt.transition(t.key, status);
                await wt.updateIssue(t.key, { flagged: true });
                flagged.push(t.key);
            }
            const gone = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
            await wt.updateIssue(gone.key, { flagged: true });
            await wt.transition(gone.key, Status.Done);
            const unflagged = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
            const result = await findGroomingWork(deps(wt));
            assert.deepEqual(keys(result.flagged), [...flagged].sort());
            assert.ok(!keys(result.flagged).includes(unflagged.key));
        });
    });

    it("(e) lists a To Do / In Progress epic whose children are all still Backlog, not one with a scheduled child or no children", async () => {
        await withTracker(async (wt) => {
            const idle = await mk(wt, { issueType: "epic" });
            await mk(wt, { issueType: StoryType.Story, parentKey: idle.key });
            const busy = await mk(wt, { issueType: "epic" });
            const scheduled = await mk(wt, { issueType: StoryType.Story, parentKey: busy.key });
            await wt.transition(scheduled.key, Status.ToDo);
            const childless = await mk(wt, { issueType: "epic" });
            for (const e of [idle, busy, childless]) await wt.transition(e.key, Status.ToDo);
            const backlogEpic = await mk(wt, { issueType: "epic" });
            await mk(wt, { issueType: StoryType.Story, parentKey: backlogEpic.key });
            const result = await findGroomingWork(deps(wt));
            assert.deepEqual(keys(result.idleEpics), [idle.key]);
        });
    });

    it("(f) lists Backlog tickets untouched longer than the threshold (default 60 days) with how long, and not recent ones", async () => {
        await withTracker(async (wt) => {
            const epic = await mk(wt, { issueType: "epic" });
            const t = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
            const later = new Date(Date.now() + 61 * 86_400_000);
            const stale = await findGroomingWork(deps(wt, { now: later }));
            assert.ok(stale.stale.some((s) => s.issue.key === t.key && s.idleDays >= 61));
            assert.equal(stale.staleThresholdDays, 60);
            const soon = await findGroomingWork(deps(wt, { now: new Date(Date.now() + 30 * 86_400_000) }));
            assert.ok(!soon.stale.some((s) => s.issue.key === t.key));
            const tight = await findGroomingWork(deps(wt, { now: new Date(Date.now() + 30 * 86_400_000), staleBacklogDays: 10 }));
            assert.ok(tight.stale.some((s) => s.issue.key === t.key));
        });
    });

    it("(g) reports the tickets the reads skipped as unreadable (unmapped Jira type)", async () => {
        await withTracker(async (wt) => {
            takeUnreadableIssues();
            const reporting = Object.assign(Object.create(wt), {
                search: async (f: Parameters<WorkTracker["search"]>[0]) => {
                    reportUnreadableIssue({ key: "TAIT-2", typeName: "Task" }, () => {});
                    return wt.search(f);
                },
            }) as WorkTracker;
            const result = await findGroomingWork(deps(reporting));
            assert.deepEqual(result.unreadable, [{ key: "TAIT-2", typeName: "Task" }]);
            assert.deepEqual(takeUnreadableIssues(), [], "the briefing drained the collector");
        });
    });

    it("(h) lists unassigned Backlog/To Do tickets that have a persona, with the ranked list, capped, and not assigned or persona-less ones", async () => {
        await withTracker(async (wt) => {
            const epic = await mk(wt, { issueType: "epic" });
            const needs = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
            await mk(wt, { issueType: StoryType.Story, parentKey: epic.key, assignee: ME });
            const noPersona = await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
            await wt.updateIssue(noPersona.key, { persona: null });
            const asked: string[] = [];
            const result = await findGroomingWork(
                deps(wt, {
                    needsAssigneeList: async (issue) => {
                        asked.push(issue.key);
                        return `Needs an assignee: ${issue.key} — list`;
                    },
                })
            );
            assert.deepEqual(result.needsAssignee.map((n) => n.issue.key), [needs.key]);
            assert.deepEqual(asked, [needs.key]);
            assert.match(result.needsAssignee[0]!.list, /Needs an assignee/);
            assert.equal(result.needsAssigneeOverflow, 0);
        });
    });

    it("(h) caps the ranked lists and says how many more there are", async () => {
        await withTracker(async (wt) => {
            const epic = await mk(wt, { issueType: "epic" });
            for (let i = 0; i < 18; i++) await mk(wt, { issueType: StoryType.Story, parentKey: epic.key });
            const result = await findGroomingWork(deps(wt, { needsAssigneeList: async (i) => `list ${i.key}` }));
            assert.equal(result.needsAssignee.length, 15);
            assert.equal(result.needsAssigneeOverflow, 3);
        });
    });

    it("(h) shows the NEWEST unassigned tickets first, so the overflow is the older ones", async () => {
        await withTracker(async (wt) => {
            const epic = await mk(wt, { issueType: "epic" });
            const made: string[] = [];
            for (let i = 0; i < 17; i++) made.push((await mk(wt, { issueType: StoryType.Story, parentKey: epic.key })).key);
            const result = await findGroomingWork(deps(wt, { needsAssigneeList: async (i) => `list ${i.key}` }));
            assert.equal(result.needsAssignee[0]!.issue.key, made[made.length - 1], "newest first");
            assert.ok(!result.needsAssignee.some((n) => n.issue.key === made[0]), "the oldest is in the overflow");
            assert.equal(result.needsAssigneeOverflow, 2);
        });
    });

    it("reads the blockers of many Backlog tickets with BOUNDED concurrency, not one at a time and not all at once", async () => {
        await withTracker(async (wt) => {
            const epic = await mk(wt, { issueType: "epic" });
            const stories: string[] = [];
            for (let i = 0; i < 14; i++) stories.push((await mk(wt, { issueType: StoryType.Story, parentKey: epic.key })).key);
            let inFlight = 0;
            let peak = 0;
            const slow = Object.assign(Object.create(wt), {
                getLinkedIssues: async (...args: Parameters<WorkTracker["getLinkedIssues"]>) => {
                    inFlight++;
                    peak = Math.max(peak, inFlight);
                    await new Promise((r) => setTimeout(r, 15));
                    inFlight--;
                    return wt.getLinkedIssues(...args);
                },
            }) as WorkTracker;
            const result = await findGroomingWork(deps(slow));
            assert.ok(peak > 1, `reads should overlap (peak ${peak})`);
            assert.ok(peak <= 5, `concurrency stays bounded (peak ${peak})`);
            assert.deepEqual(result.promotionCandidates, [], "the results do not change");
            assert.equal(stories.length, 14);
        });
    });

    it("an epic key narrows every section to that epic's children, their subtasks and the epic itself", async () => {
        await withTracker(async (wt) => {
            const mine = await mk(wt, { issueType: "epic" });
            const other = await mk(wt, { issueType: "epic" });
            const myStory = await mk(wt, { issueType: StoryType.Story, parentKey: mine.key });
            await wt.updateIssue(myStory.key, { flagged: true });
            const mySub = await mk(wt, { issueType: SubtaskType.Dev, parentKey: myStory.key });
            await wt.updateIssue(mySub.key, { flagged: true });
            const otherStory = await mk(wt, { issueType: StoryType.Story, parentKey: other.key });
            await wt.updateIssue(otherStory.key, { flagged: true });
            const all = await findGroomingWork(deps(wt));
            assert.deepEqual(keys(all.flagged), keys([myStory, mySub, otherStory]));
            const scoped = await findGroomingWork(deps(wt, { epicKey: mine.key }));
            assert.deepEqual(keys(scoped.flagged), keys([myStory, mySub]));
            assert.equal(scoped.scope, mine.key);
            assert.deepEqual(keys(scoped.childlessEpics), [], "the scoped epic has children; the other epic is out of scope");
        });
    });
});

describe("staleBacklogDaysFromEnv (ADR decision 9)", () => {
    it("reads TAI_STALE_BACKLOG_DAYS, falling back to 60 for anything unusable", () => {
        assert.equal(staleBacklogDaysFromEnv({ TAI_STALE_BACKLOG_DAYS: "14" }), 14);
        assert.equal(staleBacklogDaysFromEnv({}), 60);
        assert.equal(staleBacklogDaysFromEnv({ TAI_STALE_BACKLOG_DAYS: "soon" }), 60);
        assert.equal(staleBacklogDaysFromEnv({ TAI_STALE_BACKLOG_DAYS: "0" }), 60);
    });
});

describe("renderGroomingBriefing (TAI-395)", () => {
    const empty = {
        scope: null,
        childlessEpics: [],
        backlogKickoffs: [],
        promotionCandidates: [],
        flagged: [],
        idleEpics: [],
        stale: [],
        unreadable: [],
        needsAssignee: [],
        needsAssigneeOverflow: 0,
        staleThresholdDays: 60,
    };

    it("numbers the eight sections 1-8 and says None. for an empty one, so Perry knows each was checked", () => {
        const out = renderGroomingBriefing(empty);
        for (let n = 1; n <= 8; n++) assert.match(out, new RegExp(`^## ${n}\\. `, "m"), `section ${n}`);
        assert.equal((out.match(/^None\.$/gm) ?? []).length, 8);
    });

    it("states the scope and the stale threshold, and ends with the propose-then-confirm reminder", () => {
        const out = renderGroomingBriefing({ ...empty, scope: "TAI-8" as never, staleThresholdDays: 14 });
        assert.match(out, /Scope: epic TAI-8/);
        assert.match(out, /untouched for more than 14 days/);
        assert.match(out, /propose.*batch.*confirm/is);
    });

    it("renders a row per ticket with its key, type, status and the section-specific detail", () => {
        const issue = { key: "TAI-5", issueType: "story", status: "Backlog", summary: "Do a thing", priority: "High", labels: [], comments: [] } as never;
        const out = renderGroomingBriefing({
            ...empty,
            promotionCandidates: [issue],
            backlogKickoffs: [{ issue, epic: { key: "TAI-1", status: "Backlog" } as never, openBlockers: ["TAI-3" as never], flagged: true }],
            stale: [{ issue, idleDays: 90 }],
            unreadable: [{ key: "TAIT-2", typeName: "Task" }],
            needsAssignee: [{ issue, list: "Needs an assignee: TAI-5 — best first:\n  1. Ann" }],
            needsAssigneeOverflow: 2,
        });
        assert.match(out, /\*\*TAI-5\*\* \[story\] Do a thing/);
        assert.match(out, /blocked by TAI-3/);
        assert.match(out, /🚩/);
        assert.match(out, /idle 90 days/);
        assert.match(out, /TAIT-2 \("Task"\)/);
        assert.match(out, /1\. Ann/);
        assert.match(out, /and 2 older tickets.*issue suggest/s);
    });

    it("shows the per-list footer (assign command, interactive instruction) ONCE under section 8, not under every ticket", () => {
        const issue = (key: string) => ({ key, issueType: "story", status: "Backlog", summary: "s", labels: [], comments: [] }) as never;
        const list = (key: string) =>
            [`Needs an assignee: ${key} — candidates for PM, best first:`, "  1. Ann (ann@x.com) — no signal · 1 open ticket", "  2. Leave unassigned", `To assign: issue assign ${key} <EMAIL>.`, "Interactive session: offer this list to the human, including \"Leave unassigned\", with your question tool, then run issue assign for the pick; otherwise leave the ticket unassigned."].join("\n");
        const out = renderGroomingBriefing({
            ...empty,
            needsAssignee: [
                { issue: issue("TAI-5"), list: list("TAI-5") },
                { issue: issue("TAI-6"), list: list("TAI-6") },
            ],
        });
        assert.equal((out.match(/Interactive session: offer this list/g) ?? []).length, 0, "no per-ticket interactive footer");
        assert.equal((out.match(/Offer each list to the human/g) ?? []).length, 1, "one section-level instruction");
        assert.equal((out.match(/^\s*To assign: issue assign/gm) ?? []).length, 0);
        assert.match(out, /1\. Ann \(ann@x\.com\)/);
        assert.match(out, /To assign any of these: `issue assign <KEY> <EMAIL>`/);
        assert.match(out, /Leave unassigned/);
    });
});

describe("mapWithLimit (TAI-395 review)", () => {
    it("keeps the input order, runs at most `limit` at once, and handles an empty list", async () => {
        let inFlight = 0;
        let peak = 0;
        const out = await mapWithLimit([5, 1, 4, 2, 3, 6], 2, async (n) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, n));
            inFlight--;
            return n * 10;
        });
        assert.deepEqual(out, [50, 10, 40, 20, 30, 60]);
        assert.equal(peak, 2);
        assert.deepEqual(await mapWithLimit([], 3, async (n: number) => n), []);
    });

    it("propagates a failure instead of swallowing it", async () => {
        await assert.rejects(() => mapWithLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error("boom"); return n; }), /boom/);
    });
});
