import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DependencyRelation, Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, type HumanRef, type WorkTracker } from "../storage/interface.js";
import { findDevTasks, renderDevTasksReport, workDevTasks, type DevTask, type FoundDevTasks, type RunDevTasksDeps } from "./do-dev-tasks.js";
import { buildDevPrompt } from "./headless-claude.js";

const ME: HumanRef = { id: toHumanId("a@b.c"), displayName: "A", email: "a@b.c" };
const OTHER: HumanRef = { id: toHumanId("x@y.z"), displayName: "X", email: "x@y.z" };

async function withTracker(fn: (wt: WorkTracker) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-dev-tasks-"));
    try {
        await fn(createFilesystemBackend(dir, ME).workTracker);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}
const mk = (wt: WorkTracker, over: Record<string, unknown>) =>
    wt.createIssue({ projectKey: "TAI", persona: Persona.Developer, summary: "s", ...over } as never);
const find = (wt: WorkTracker, human: HumanRef | null = ME) => findDevTasks({ workTracker: wt, projectKey: "TAI", currentHuman: human });

describe("findDevTasks (TAI-633)", () => {
    it("lists my In Progress and To Do Dev subtasks on Stories and Bugs, and no one else's or other types", async () => {
        await withTracker(async (wt) => {
            const story = await mk(wt, { issueType: StoryType.Story });
            const bug = await mk(wt, { issueType: StoryType.Bug });
            const a = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story.key, assignee: ME });
            const b = await mk(wt, { issueType: SubtaskType.Dev, parentKey: bug.key, assignee: ME });
            const story3 = await mk(wt, { issueType: StoryType.Story });
            const theirs = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story3.key, assignee: OTHER });
            const story2 = await mk(wt, { issueType: StoryType.Story });
            const done = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story2.key, assignee: ME });
            await wt.transition(a.key, Status.ToDo);
            await wt.transition(b.key, Status.InProgress);
            await wt.transition(theirs.key, Status.ToDo);
            await wt.transition(done.key, Status.Done);
            const { tasks, skipped } = await find(wt);
            assert.deepEqual(tasks.map((t) => t.issue.key).sort(), [a.key, b.key].sort());
            assert.deepEqual(skipped, []);
        });
    });

    it("skips a To Do subtask that precedence holds, naming the blocker", async () => {
        await withTracker(async (wt) => {
            const story = await mk(wt, { issueType: StoryType.Story });
            const design = await mk(wt, { issueType: SubtaskType.ArchitectureDesign, parentKey: story.key, persona: Persona.Architect });
            const dev = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story.key, assignee: ME });
            await wt.transition(dev.key, Status.ToDo);
            const { tasks, skipped } = await find(wt);
            assert.equal(tasks.length, 0);
            assert.equal(skipped[0]?.issue.key, dev.key);
            assert.match(skipped[0]!.reason, new RegExp(`precedence holds it until ${design.key}`));
        });
    });

    it("skips a ticket whose Story has an open DependsOn blocker, and starts it once the blocker is Done", async () => {
        await withTracker(async (wt) => {
            const blocker = await mk(wt, { issueType: StoryType.Story });
            const story = await mk(wt, { issueType: StoryType.Story });
            await wt.createLink(story.key, DependencyRelation.DependsOn, blocker.key);
            const dev = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story.key, assignee: ME });
            await wt.transition(dev.key, Status.ToDo);
            assert.match((await find(wt)).skipped[0]!.reason, new RegExp(`${blocker.key} must finish first`));
            await wt.transition(blocker.key, Status.Done);
            assert.equal((await find(wt)).tasks.length, 1);
        });
    });

    it("refuses to guess who I am", async () => {
        await withTracker(async (wt) => {
            await assert.rejects(find(wt, null), /No user is configured/);
        });
    });
});

const runDevTasks = async (tasks: readonly DevTask[], d: RunDevTasksDeps) =>
    (await workDevTasks(async () => ({ tasks, skipped: [] }), d)).results;

function task(key: string): DevTask {
    const issue = { key, summary: `s ${key}`, issueType: SubtaskType.Dev, status: Status.ToDo } as never;
    return { issue, parent: { key: "TAI-1" } as never };
}

function deps(over: Partial<RunDevTasksDeps> = {}): RunDevTasksDeps & { calls: string[]; handoffs: [string, string][] } {
    const calls: string[] = [];
    const handoffs: [string, string][] = [];
    return {
        yolo: false,
        prepare: async (t) => void calls.push(`prepare ${t.issue.key}`),
        build: async (t) => (calls.push(`build ${t.issue.key}`), { ok: true, summary: "" }),
        inspect: async (t) => ({ prUrl: `https://pr/${t.issue.key}`, checkRecorded: true }),
        handoff: async (k, b) => void handoffs.push([k, b]),
        calls,
        handoffs,
        ...over,
    };
}

describe("runDevTasks (TAI-633)", () => {
    it("builds each ticket in order and reports the PR and the check", async () => {
        const d = deps();
        const results = await runDevTasks([task("TAI-10"), task("TAI-11")], d);
        assert.deepEqual(d.calls, ["prepare TAI-10", "build TAI-10", "prepare TAI-11", "build TAI-11"]);
        assert.deepEqual(results.map((r) => r.outcome.state), ["pr-opened", "pr-opened"]);
        assert.deepEqual(d.handoffs, []);
    });

    it("one ticket failing leaves a hand-off on it and does not stop the others", async () => {
        const d = deps({
            build: async (t) => (t.issue.key === "TAI-10" ? { ok: false, summary: "tests failed" } : { ok: true, summary: "" }),
        });
        const results = await runDevTasks([task("TAI-10"), task("TAI-11")], d);
        assert.deepEqual(results.map((r) => r.outcome.state), ["failed", "pr-opened"]);
        assert.equal(d.handoffs.length, 1);
        assert.equal(d.handoffs[0]![0], "TAI-10");
        assert.match(d.handoffs[0]![1], /^Handoff: .*tests failed/s);
    });

    it("fails a ticket whose run left no open PR, and one whose tree is not clean", async () => {
        const noPr = await runDevTasks([task("TAI-10")], deps({ inspect: async () => ({ prUrl: null, checkRecorded: null }) }));
        assert.match((noPr[0]!.outcome as { reason: string }).reason, /no open PR/);
        const d = deps({ prepare: async () => Promise.reject(new Error("uncommitted changes")) });
        const dirty = await runDevTasks([task("TAI-10")], d);
        assert.equal(dirty[0]!.outcome.state, "failed");
        assert.deepEqual(d.calls, []);
    });

    it("still reports a failure when the hand-off cannot be posted", async () => {
        const d = deps({ build: async () => ({ ok: false, summary: "boom" }), handoff: async () => Promise.reject(new Error("jira down")) });
        const r = await runDevTasks([task("TAI-10")], d);
        assert.match((r[0]!.outcome as { reason: string }).reason, /boom.*jira down/s);
    });

    it("with dev-yolo on hands each ticket to the full run and builds nothing itself", async () => {
        const d = deps({ yolo: true, yoloRun: async (t) => ({ state: "handed-on", note: `full run for ${t.issue.key}` }) });
        const r = await runDevTasks([task("TAI-10")], d);
        assert.equal(r[0]!.outcome.state, "handed-on");
        assert.deepEqual(d.calls, ["prepare TAI-10"]);
    });

    it("with dev-yolo on and no full run installed, builds nothing and says why", async () => {
        const d = deps({ yolo: true });
        const r = await runDevTasks([task("TAI-10")], d);
        assert.equal(r[0]!.outcome.state, "waiting");
        assert.match((r[0]!.outcome as { reason: string }).reason, /TAI-634/);
        assert.ok(!d.calls.some((c) => c.startsWith("build")));
    });
});

describe("workDevTasks looks again after each ticket (TAI-633)", () => {
    async function twoStories(wt: WorkTracker) {
        const first = await mk(wt, { issueType: StoryType.Story });
        const second = await mk(wt, { issueType: StoryType.Story });
        await wt.createLink(second.key, DependencyRelation.DependsOn, first.key);
        const a = await mk(wt, { issueType: SubtaskType.Dev, parentKey: first.key, assignee: ME });
        const b = await mk(wt, { issueType: SubtaskType.Dev, parentKey: second.key, assignee: ME });
        await wt.transition(a.key, Status.ToDo);
        await wt.transition(b.key, Status.ToDo);
        return { first, second, a, b };
    }
    const finder = (wt: WorkTracker) => () => find(wt);

    it("picks up a ticket that one of ours unblocked, which the first look had to skip", async () => {
        await withTracker(async (wt) => {
            const { first, a, b } = await twoStories(wt);
            const start = await find(wt);
            assert.deepEqual(start.tasks.map((t) => t.issue.key), [a.key]);
            assert.equal(start.skipped[0]?.issue.key, b.key);
            const d = deps({
                yolo: true,
                // the full run merges the PR, which finishes the Dev subtask and its Story
                yoloRun: async (t) => {
                    await wt.transition(t.issue.key, Status.Done);
                    if (t.issue.key === a.key) await wt.transition(first.key, Status.Done);
                    return { state: "handed-on", note: `done ${t.issue.key}` };
                },
            });
            const { results, found } = await workDevTasks(finder(wt), d);
            assert.deepEqual(results.map((r) => r.task.issue.key), [a.key, b.key]);
            assert.deepEqual(found.skipped, []);
        });
    });

    it("leaves a ticket skipped, and says it waits on one this run worked, when that one is not finished", async () => {
        await withTracker(async (wt) => {
            const { first, a, b } = await twoStories(wt);
            const { results, found } = await workDevTasks(finder(wt), deps());
            assert.deepEqual(results.map((r) => r.task.issue.key), [a.key]);
            assert.equal(found.skipped[0]?.issue.key, b.key);
            assert.match(renderDevTasksReport(found, results, { yolo: false }), new RegExp(`${b.key}[^\\n]*Waiting on ${first.key}`));
        });
    });

    it("tries a ticket once per run, so a failure is not retried in a loop", async () => {
        const t = task("TAI-10");
        let finds = 0;
        const find2 = async (): Promise<FoundDevTasks> => (finds++, { tasks: [t], skipped: [] });
        const d = deps({ build: async () => ({ ok: false, summary: "no" }) });
        const { results } = await workDevTasks(find2, d);
        assert.equal(results.length, 1);
        assert.equal(d.handoffs.length, 1);
        assert.equal(finds, 2);
    });
});

describe("renderDevTasksReport (TAI-633)", () => {
    it("lists what was done, what failed, what was skipped and what waits for a person", async () => {
        const results = await runDevTasks([task("TAI-10"), task("TAI-11")], deps({ build: async (t) => ({ ok: t.issue.key === "TAI-10", summary: "tests failed" }) }));
        const text = renderDevTasksReport({ tasks: [], skipped: [{ issue: task("TAI-12").issue, reason: "precedence holds it" }] }, results, { yolo: false });
        assert.match(text, /## Done \(1\)[\s\S]*TAI-10.*PR opened, check recorded — https:\/\/pr\/TAI-10/);
        assert.match(text, /## Failed \(1\)[\s\S]*TAI-11.*tests failed/);
        assert.match(text, /## Waiting for a person[\s\S]*TAI-10/);
        assert.match(text, /## Skipped \(1\)[\s\S]*TAI-12.*precedence holds it/);
    });

    it("a dry run lists what it would work and runs nothing", () => {
        const text = renderDevTasksReport({ tasks: [task("TAI-10")], skipped: [] }, null, { yolo: true });
        assert.match(text, /DEV-YOLO is on/);
        assert.match(text, /## Would work \(1\)[\s\S]*TAI-10/);
    });
});

describe("buildDevPrompt", () => {
    it("names the ticket and the CLI, forbids review, merge and force, and asks no questions", () => {
        const p = buildDevPrompt("TAI-10", "CLI");
        assert.match(p, /ticket TAI-10/);
        assert.match(p, /`CLI work TAI-10`/);
        assert.match(p, /Do not review, approve or merge/);
        assert.match(p, /Never use force=true/);
        assert.match(p, /Do not ask any/);
    });
});
