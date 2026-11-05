import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";

import { DependencyRelation, Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, type HumanRef, type WorkTracker } from "../storage/interface.js";
import { DirtyTreeError, PrepareStopError, checkoutPosition, cutOffBranch, prepareCleanDefaultBranch, prepareForTicket } from "./dev-tasks-git.js";
import { pausedAwareHandoff, pausedHandoff, UsageLimitLatch, wasPausedOnLimit, type UsageLimit } from "./usage-limit.js";
import { findDevTasks, findOpenPullRequest, listOpenPullRequests, renderDevTasksReport, titleNamesKey, workDevTasks, type DevTask, type DevTaskOutcome, type DevTaskResult, type FoundDevTasks, type RunDevTasksDeps } from "./do-dev-tasks.js";
import { noPrReason, onlyRefusal, parseDevTasksArgs, resolveYolo } from "./do-dev-tasks.js";
import { buildDevPrompt, cliCommand, devRunTimeoutMs, redactSecrets, runHeadlessClaude, stopActiveRuns, stopActiveRunsHard } from "./headless-claude.js";

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

    it("skips a flagged ticket, To Do or In Progress, and still works an unflagged one in the same list (TAI-735)", async () => {
        await withTracker(async (wt) => {
            const dev = async () => mk(wt, { issueType: SubtaskType.Dev, parentKey: (await mk(wt, { issueType: StoryType.Story })).key, assignee: ME });
            const flaggedTodo = await dev();
            const flaggedStarted = await dev();
            const plain = await dev();
            await wt.transition(flaggedTodo.key, Status.ToDo);
            await wt.transition(flaggedStarted.key, Status.InProgress);
            await wt.transition(plain.key, Status.ToDo);
            await wt.updateIssue(flaggedTodo.key, { flagged: true });
            await wt.updateIssue(flaggedStarted.key, { flagged: true });
            const { tasks, skipped } = await find(wt);
            assert.deepEqual(tasks.map((t) => t.issue.key), [plain.key]);
            assert.deepEqual(skipped.map((x) => x.issue.key).sort(), [flaggedTodo.key, flaggedStarted.key].sort());
            for (const x of skipped) assert.match(x.reason, /flagged/);
            assert.match(renderDevTasksReport({ tasks, skipped }, null, { yolo: true }), new RegExp(`${flaggedTodo.key}[^\\n]*flagged`));
            // Clearing the flag puts it back.
            await wt.updateIssue(flaggedTodo.key, { flagged: false });
            assert.deepEqual((await find(wt)).tasks.map((t) => t.issue.key).sort(), [flaggedTodo.key, plain.key].sort());
        });
    });

    it("refuses only=<KEY> on a flagged ticket before anything starts, saying it is flagged (TAI-735)", async () => {
        await withTracker(async (wt) => {
            const story = await mk(wt, { issueType: StoryType.Story });
            const dev = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story.key, assignee: ME });
            await wt.transition(dev.key, Status.ToDo);
            await wt.updateIssue(dev.key, { flagged: true });
            const found = await findDevTasks({ workTracker: wt, projectKey: "TAI", currentHuman: ME, only: dev.key });
            assert.deepEqual(found.tasks, []);
            assert.match((await onlyRefusal(found, dev.key, { workTracker: wt, currentHuman: ME, projectKey: "TAI" }))!, new RegExp(`${dev.key} cannot be worked now: it is flagged`));
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

    it("a run that exits cleanly with no PR reports the end of its own output in the reason and the hand-off", async () => {
        const d = deps({
            build: async () => ({ ok: true, summary: "I could not run npm test: the command needs approval." }),
            inspect: async () => ({ prUrl: null, checkRecorded: null }),
        });
        const r = await runDevTasks([task("TAI-10")], d);
        assert.match((r[0]!.outcome as { reason: string }).reason, /no open PR[\s\S]*needs approval/);
        assert.match(d.handoffs[0]![1], /needs approval/);
        assert.doesNotMatch(noPrReason("first\nsecond"), /\n/, "one line, so the report bullet stays whole");
        assert.match(noPrReason("first\nsecond"), /first \/ second/);
        assert.equal(noPrReason("  \n"), "The run finished but no open PR for this ticket was found.");
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

    it("lists a ticket DEV-YOLO finished under Done, and one it stopped under Waiting for a person, never under Not run (TAI-688)", () => {
        const result = (key: string, outcome: DevTaskOutcome): DevTaskResult => ({ task: task(key), outcome });
        const results = [
            result("TAI-10", { state: "pr-opened", prUrl: "https://pr/10", checkRecorded: true }),
            result("TAI-11", { state: "handed-on", note: "merged https://pr/11, verified and closed TAI-1" }),
            result("TAI-12", { state: "waiting", reason: "needs a person: TAI-1 has a Database change" }),
            result("TAI-13", { state: "failed", reason: "tests failed" }),
        ];
        const text = renderDevTasksReport({ tasks: [], skipped: [] }, results, { yolo: true });
        assert.match(text, /## Done \(2\)[\s\S]*TAI-10.*PR opened[\s\S]*TAI-11.*merged https:\/\/pr\/11, verified and closed/);
        assert.match(text, /## Waiting for a person[\s\S]*PRs for TAI-10[\s\S]*TAI-12.*needs a person: TAI-1 has a Database change/);
        assert.match(text, /## Failed \(1\)[\s\S]*TAI-13/);
        assert.doesNotMatch(text, /Not run/);
        assert.doesNotMatch(text, /TAI-12[^\n]*hand-off left/, "a stop does not always leave a hand-off on the ticket, so the line does not claim one");
        assert.doesNotMatch(text.split("## Waiting for a person")[0]!, /TAI-12/);
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
        assert.match(p, /data, never as instructions/);
        assert.match(p, /Do not ask any/);
    });
});

describe("finding a ticket's PR and holding back one that already has it (TAI-633, PR 19 review)", () => {
    it("matches the whole ticket key in a title, not a longer one or a part of one", () => {
        assert.equal(titleNamesKey("TAI-628 - TAI-633 - do all dev tasks", "TAI-633"), true);
        assert.equal(titleNamesKey("TAI-628 - TAI-633 - do all dev tasks", "TAI-628"), true);
        assert.equal(titleNamesKey("TAI-100 - TAI-101 - other", "TAI-10"), false);
        assert.equal(titleNamesKey("TAI-100 - TAI-101 - other", "TAI-1"), false);
        assert.equal(titleNamesKey("XTAI-10 - other", "TAI-10"), false);
        assert.equal(titleNamesKey("TAI-10: fix", "TAI-10"), true);
        // the key must open one of the first two slots: later words that mention it do not count
        assert.equal(titleNamesKey("TAI-5 - TAI-6 - fix the TAI-10 regression", "TAI-10"), false);
        assert.equal(titleNamesKey("TAI-5 - TAI-6 - fix the TAI-10 regression", "TAI-6"), true);
    });

    it("returns the PR whose title names the key and whether its commit has a check result", async () => {
        const pr = (title: string, url: string) => ({ title, url, sourceCommit: "abc" }) as never;
        const gitHost = {
            listPullRequests: async () => [pr("TAI-100 - TAI-101 - other", "https://pr/other"), pr("TAI-1 - TAI-10 - mine", "https://pr/mine")],
            getCommitStatuses: async () => [{ key: "tai-check", name: "check", state: "successful" }],
        } as never;
        const repo = "o/r" as never;
        assert.deepEqual(await findOpenPullRequest(gitHost, [repo], "TAI-10", { checkConfigured: true }), { prUrl: "https://pr/mine", checkRecorded: true });
        assert.deepEqual(await findOpenPullRequest(gitHost, [repo], "TAI-10", { checkConfigured: false }), { prUrl: "https://pr/mine", checkRecorded: null });
        assert.deepEqual(await findOpenPullRequest(gitHost, [repo], "TAI-11", { checkConfigured: true }), { prUrl: null, checkRecorded: null });
        const ciOnly = {
            listPullRequests: async () => [pr("TAI-1 - TAI-10 - mine", "https://pr/mine")],
            getCommitStatuses: async () => [{ key: "ci/build", name: "build", state: "successful" }],
        } as never;
        assert.deepEqual(await findOpenPullRequest(ciOnly, [repo], "TAI-10", { checkConfigured: true }), { prUrl: "https://pr/mine", checkRecorded: false }, "another tool's status is not TAI's check");
    });

    it("skips an In Progress ticket whose PR is already open, so the command is safe to run twice", async () => {
        await withTracker(async (wt) => {
            const story = await mk(wt, { issueType: StoryType.Story });
            const dev = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story.key, assignee: ME });
            await wt.transition(dev.key, Status.InProgress);
            const { tasks, skipped } = await findDevTasks({
                workTracker: wt,
                projectKey: "TAI",
                currentHuman: ME,
                openPullRequests: async () => () => "https://pr/1",
            });
            assert.equal(tasks.length, 0);
            assert.match(skipped[0]!.reason, /open PR.*does not pick up a PR sent back for changes.*https:\/\/pr\/1/);
        });
    });

    it("also skips a To Do ticket whose PR was opened by hand, so a second PR is not built", async () => {
        await withTracker(async (wt) => {
            const story = await mk(wt, { issueType: StoryType.Story });
            const dev = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story.key, assignee: ME });
            await wt.transition(dev.key, Status.ToDo);
            const { tasks, skipped } = await findDevTasks({ workTracker: wt, projectKey: "TAI", currentHuman: ME, openPullRequests: async () => () => "https://pr/2" });
            assert.equal(tasks.length, 0);
            assert.match(skipped[0]!.reason, /https:\/\/pr\/2/);
        });
    });
});

describe("devRunTimeoutMs (TAI-633, PR 19 review)", () => {
    it("defaults to 45 minutes, reads a number, and refuses anything else", () => {
        assert.equal(devRunTimeoutMs({}), 45 * 60_000);
        assert.equal(devRunTimeoutMs({ TAI_DEV_RUN_TIMEOUT_MIN: "" }), 45 * 60_000);
        assert.equal(devRunTimeoutMs({ TAI_DEV_RUN_TIMEOUT_MIN: "10" }), 600_000);
        for (const bad of ["45m", "0", "-5", "abc"]) {
            assert.throws(() => devRunTimeoutMs({ TAI_DEV_RUN_TIMEOUT_MIN: bad }), /positive number of minutes/);
        }
    });
});

describe("one listing per look, a dirty tree, and the process layer (TAI-633, PR 19 review)", () => {
    it("lists the open PRs once and matches many keys from that list", async () => {
        let lists = 0;
        const pr = (title: string) => ({ title, url: `https://pr/${title}`, sourceCommit: "c" }) as never;
        const gitHost = { listPullRequests: async () => (lists++, [pr("TAI-1 - TAI-10 - a"), pr("TAI-2 - TAI-20 - b")]), getCommitStatuses: async () => [] } as never;
        const listed = await listOpenPullRequests(gitHost, ["o/r" as never]);
        for (const key of ["TAI-10", "TAI-20", "TAI-30"]) await findOpenPullRequest(gitHost, ["o/r" as never], key, { checkConfigured: false, listed });
        assert.equal(lists, 1);
    });

    it("stops on a dirty tree, blames the ticket that ran before and not the one about to start", async () => {
        const d = deps({
            prepare: async (t) => {
                d.calls.push(`prepare ${t.issue.key}`);
                if (t.issue.key === "TAI-11") throw new DirtyTreeError(" M src/x.ts");
            },
        });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11"), task("TAI-12")], skipped: [] }), d);
        assert.deepEqual(results.map((r) => r.outcome.state), ["pr-opened", "stopped"]);
        assert.ok(!d.calls.includes("prepare TAI-12"), "the run stops; later tickets are not started");
        assert.deepEqual(d.handoffs.map(([k]) => k), ["TAI-10"]);
        assert.match(d.handoffs[0]![1], /left uncommitted changes/);
        const text = renderDevTasksReport({ tasks: [], skipped: [] }, results, { yolo: false });
        assert.match(text, /## Stopped[\s\S]*Before TAI-11/);
    });

    it("keeps the earlier failure reason when the same ticket's run also left the tree dirty", async () => {
        const d = deps({
            build: async (t) => (t.issue.key === "TAI-10" ? { ok: false, summary: "tests failed" } : { ok: true, summary: "" }),
            prepare: async (t) => {
                if (t.issue.key === "TAI-11") throw new DirtyTreeError(" M src/x.ts");
            },
        });
        await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11")], skipped: [] }), d);
        const last = d.handoffs.filter(([k]) => k === "TAI-10").pop()!;
        assert.match(last[1], /tests failed[\s\S]*also left uncommitted changes/);
    });

    it("a dirty tree after a ticket that opened its PR leaves that ticket's own hand-off alone", async () => {
        const d = deps({
            prepare: async (t) => {
                if (t.issue.key === "TAI-11") throw new DirtyTreeError(" M src/x.ts");
            },
        });
        await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11")], skipped: [] }), d);
        assert.equal(d.handoffs.length, 1);
        assert.match(d.handoffs[0]![1], /^Note: /);
        assert.doesNotMatch(d.handoffs[0]![1], /^Handoff:/);
    });

    it("a dirty tree after a ticket whose own run handed on leaves that hand-off alone too", async () => {
        const d = deps({
            yolo: true,
            yoloRun: async () => ({ state: "handed-on", note: "stopped at review round 4" }),
            prepare: async (t) => {
                if (t.issue.key === "TAI-11") throw new DirtyTreeError(" M src/x.ts");
            },
        });
        await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11")], skipped: [] }), d);
        assert.equal(d.handoffs.length, 1);
        assert.match(d.handoffs[0]![1], /^Note: /);
    });

    it("uses the look it is given for the first ticket and looks again after", async () => {
        let looks = 0;
        const first = { tasks: [task("TAI-10")], skipped: [] };
        const d = deps({});
        await workDevTasks(async () => (looks++, { tasks: [], skipped: [] }), d, first);
        assert.equal(looks, 1, "one look after the one ticket, none before it");
    });

    it("a ticket worked this run is not listed again under Skipped", () => {
        const t = task("TAI-10");
        const found = { tasks: [], skipped: [{ issue: t.issue, reason: "it has an open PR, so this command leaves it to review, merge or rework by a person (it does not pick up a PR sent back for changes): https://pr/1" }] };
        const text = renderDevTasksReport(found, [{ task: t, outcome: { state: "pr-opened", prUrl: "https://pr/1", checkRecorded: true } }], { yolo: false });
        assert.match(text, /## Done \(1\)/);
        assert.match(text, /## Skipped \(0\)/);
    });

    it("DEV-YOLO on with no full run builds nothing and does not touch the checkout", async () => {
        const d = deps({ yolo: true });
        await workDevTasks(async () => ({ tasks: [task("TAI-10")], skipped: [] }), d);
        assert.ok(!d.calls.some((c) => c.startsWith("prepare")), "no prepare");
    });

    it("a PR opened without a check result is listed on its own, not under Done", () => {
        const a = task("TAI-10");
        const b = task("TAI-11");
        const text = renderDevTasksReport({ tasks: [], skipped: [] }, [
            { task: a, outcome: { state: "pr-opened", prUrl: "https://pr/1", checkRecorded: true } },
            { task: b, outcome: { state: "pr-opened", prUrl: "https://pr/2", checkRecorded: false } },
        ], { yolo: false });
        assert.match(text, /## Done \(1\)/);
        assert.match(text, /## PR opened, no check result \(1\)[\s\S]*TAI-11/);
        assert.match(text, /Review, approval and merge of the PRs for TAI-10, TAI-11/);
    });

    it("an interrupt stops the loop before the next ticket is looked up or prepared", async () => {
        let stop = false;
        const d = deps({ interrupted: () => stop, build: async (t) => (d.calls.push(`build ${t.issue.key}`), (stop = true), { ok: false, summary: "killed by SIGTERM" }) });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11")], skipped: [] }), d);
        assert.equal(results.length, 1);
        assert.ok(!d.calls.includes("prepare TAI-11"), "nothing new is prepared");
        let looks = 0;
        stop = true;
        await workDevTasks(async () => (looks++, { tasks: [], skipped: [] }), d, { tasks: [task("TAI-12")], skipped: [] });
        assert.equal(looks, 0, "no new look on the way out");
    });

    it("a branch that will not update stops the run without blaming any ticket", async () => {
        const d = deps({ prepare: async () => Promise.reject(new PrepareStopError("Could not bring main up to date: offline")) });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11")], skipped: [] }), d);
        assert.deepEqual(results.map((r) => r.outcome.state), ["stopped"]);
        assert.deepEqual(d.handoffs, []);
    });

    it("a dirty tree before the first ticket stops the run with no hand-off at all", async () => {
        const d = deps({ prepare: async () => Promise.reject(new DirtyTreeError(" M a")) });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10")], skipped: [] }), d);
        assert.equal(results[0]!.outcome.state, "stopped");
        assert.deepEqual(d.handoffs, []);
    });

    it("the dry run says when it could not leave out tickets that already have a PR", () => {
        assert.match(renderDevTasksReport({ tasks: [], skipped: [] }, null, { yolo: false, openPullRequestsChecked: false }), /already has an open PR could not be left out/);
        assert.doesNotMatch(renderDevTasksReport({ tasks: [], skipped: [] }, null, { yolo: false, openPullRequestsChecked: true }), /could not be left out/);
    });

    it("prepareCleanDefaultBranch refuses a dirty tree and returns to the default branch when clean", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-devgit-"));
        try {
            const origin = path.join(dir, "origin.git");
            execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
            const work = path.join(dir, "work");
            execFileSync("git", ["clone", "-q", origin, work]);
            const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: work, stdio: "pipe" });
            await writeFile(path.join(work, "a.txt"), "1");
            g("add", "."); g("commit", "-q", "-m", "one"); g("push", "-q", "origin", "HEAD:main"); g("fetch", "-q");
            g("checkout", "-q", "-b", "TAI-1-feature");
            await writeFile(path.join(work, "a.txt"), "2");
            await assert.rejects(prepareCleanDefaultBranch(work, ".tai"), DirtyTreeError);
            g("checkout", "--", "a.txt");
            g("branch", "-q", "--set-upstream-to=origin/main", "main");
            await prepareCleanDefaultBranch(work, ".tai");
            assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: work }).toString().trim(), "main");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    async function fakeClaude(script: string): Promise<{ bin: string; cleanup: () => Promise<void> }> {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-fakeclaude-"));
        const bin = path.join(dir, "claude");
        await writeFile(bin, `#!/bin/sh\n${script}\n`);
        await chmod(bin, 0o755);
        return { bin, cleanup: () => rm(dir, { recursive: true, force: true }) };
    }

    it("runHeadlessClaude reports success, a non-zero exit, and a binary that will not start", async () => {
        const ok = await fakeClaude("echo built; exit 0");
        const bad = await fakeClaude("echo broke; exit 3");
        try {
            const opts = { cwd: tmpdir(), timeoutMs: 20_000 };
            assert.deepEqual(await runHeadlessClaude("p", { ...opts, bin: ok.bin }), { ok: true, summary: "built" });
            const failed = await runHeadlessClaude("p", { ...opts, bin: bad.bin });
            assert.equal(failed.ok, false);
            assert.match(failed.summary, /exited with code 3[\s\S]*broke/);
            const missing = await runHeadlessClaude("p", { ...opts, bin: path.join(tmpdir(), "no-such-claude") });
            assert.equal(missing.ok, false);
            assert.match(missing.summary, /could not start/);
        } finally {
            await ok.cleanup();
            await bad.cleanup();
        }
    });

    it("runHeadlessClaude names the timeout when the run honours the stop, and does not signal the group again", async () => {
        const polite = await fakeClaude("echo started\nsleep 30 &\nwait");
        try {
            const r = await runHeadlessClaude("p", { cwd: tmpdir(), bin: polite.bin, timeoutMs: 300, killGraceMs: 5_000 });
            assert.equal(r.ok, false);
            assert.match(r.summary, /was stopped after/);
        } finally {
            await polite.cleanup();
        }
    });

    it("stopActiveRuns stops a run in flight, so an interrupt does not leave it working", async () => {
        const slow = await fakeClaude("echo started\nsleep 30 &\nwait");
        try {
            const t0 = Date.now();
            const running = runHeadlessClaude("p", { cwd: tmpdir(), bin: slow.bin, timeoutMs: 60_000 });
            await new Promise((r) => setTimeout(r, 400));
            assert.equal(stopActiveRuns(), 1);
            const r = await running;
            assert.equal(r.ok, false);
            assert.ok(Date.now() - t0 < 10_000);
            assert.equal(stopActiveRuns(), 0, "nothing left in flight");
        } finally {
            await slow.cleanup();
        }
    });

    it("runHeadlessClaude names the signal when the run is killed by one", async () => {
        const killed = await fakeClaude("kill -9 $$");
        try {
            const r = await runHeadlessClaude("p", { cwd: tmpdir(), bin: killed.bin, timeoutMs: 20_000 });
            assert.equal(r.ok, false);
            assert.match(r.summary, /killed by SIGKILL/);
        } finally {
            await killed.cleanup();
        }
    });

    it("stopActiveRunsHard kills a run that ignores the stop, so Ctrl-C leaves nothing working", async () => {
        const stubborn = await fakeClaude("trap '' TERM\necho started\nsleep 30 &\nwait");
        try {
            const t0 = Date.now();
            const running = runHeadlessClaude("p", { cwd: tmpdir(), bin: stubborn.bin, timeoutMs: 60_000, pipeGraceMs: 60_000 });
            await new Promise((r) => setTimeout(r, 400));
            assert.equal(await stopActiveRunsHard(300), 1);
            const r = await running;
            assert.equal(r.ok, false);
            assert.ok(Date.now() - t0 < 10_000);
        } finally {
            await stubborn.cleanup();
        }
    });

    it("runHeadlessClaude stops a stray the run left behind even when the pipes close at once", async () => {
        const pidFile = path.join(tmpdir(), `tai-stray-${process.pid}-${Date.now()}`);
        const stray = await fakeClaude(`(sleep 30 >/dev/null 2>&1 </dev/null & echo $! > ${pidFile})\necho done\nexit 0`);
        try {
            const r = await runHeadlessClaude("p", { cwd: tmpdir(), bin: stray.bin, timeoutMs: 60_000 });
            assert.equal(r.ok, true);
            await new Promise((x) => setTimeout(x, 500));
            const pid = Number((await readFile(pidFile, "utf8")).trim());
            assert.throws(() => process.kill(pid, 0), "the stray is gone");
        } finally {
            await stray.cleanup();
            await rm(pidFile, { force: true });
        }
    });

    it("cliCommand leaves a plain path bare, so an allow rule matches it, and quotes one with a space", () => {
        assert.equal(cliCommand("/home/del/.tai-framework"), "npx --prefix /home/del/.tai-framework tsx /home/del/.tai-framework/src/hosts/cli.ts");
        assert.equal(cliCommand("/home/my user/tai"), "npx --prefix '/home/my user/tai' tsx '/home/my user/tai/src/hosts/cli.ts'");
        assert.match(cliCommand("/x/it's"), /'\/x\/it'\\''s'/);
    });

    it("parseDevTasksArgs accepts dryrun=true, yolo=true and yolo=false, or nothing, and refuses anything else (TAI-693)", () => {
        assert.deepEqual(parseDevTasksArgs([undefined]), { dryRun: false });
        assert.deepEqual(parseDevTasksArgs(["dryrun=true"]), { dryRun: true });
        assert.deepEqual(parseDevTasksArgs(["yolo=true"]), { dryRun: false, yolo: true });
        assert.deepEqual(parseDevTasksArgs(["yolo=false"]), { dryRun: false, yolo: false });
        assert.deepEqual(parseDevTasksArgs(["dryrun=true", "yolo=true"]), { dryRun: true, yolo: true });
        for (const bad of ["dryrun=1", "--dry-run", "dryrun=True", "TAI-1", "yolo=1", "yolo=True", "yolo"]) assert.throws(() => parseDevTasksArgs([bad]), /takes only dryrun=true, yolo=true, yolo=false, only=<DEV-KEY> and wait=<hours>/);
        assert.throws(() => parseDevTasksArgs(["yolo=true", "yolo=false"]), /not both/);
    });

    it("after rules only yolo= is taken, so rules dryrun=true is refused (TAI-700)", () => {
        assert.deepEqual(parseDevTasksArgs([undefined], { rules: true }), { dryRun: false });
        assert.deepEqual(parseDevTasksArgs(["yolo=true"], { rules: true }), { dryRun: false, yolo: true });
        assert.throws(() => parseDevTasksArgs(["dryrun=true"], { rules: true }), /rules takes only yolo=true, yolo=false and only=<DEV-KEY> \(got: dryrun=true\)/);
        assert.throws(() => parseDevTasksArgs(["foo"], { rules: true }), /rules takes only yolo=true, yolo=false and only=<DEV-KEY>/);
    });

    it("resolveYolo: the argument wins in both directions and the setting is read only when there is none (TAI-700, TAI-692 AC-5)", async () => {
        const stored = (value: boolean) => {
            const calls = { n: 0 };
            return { calls, read: async () => (calls.n++, value) };
        };
        const off = stored(false);
        assert.deepEqual(await resolveYolo(true, off.read), { yolo: true, oneRun: true, thisRunOnly: true });
        const on = stored(true);
        assert.deepEqual(await resolveYolo(false, on.read), { yolo: false, oneRun: false, thisRunOnly: true });
        assert.equal(off.calls.n + on.calls.n, 0, "the stored setting is not read when the argument is given");
        const settingOn = stored(true);
        assert.deepEqual(await resolveYolo(undefined, settingOn.read), { yolo: true, oneRun: false, thisRunOnly: false });
        assert.deepEqual(await resolveYolo(undefined, stored(false).read), { yolo: false, oneRun: false, thisRunOnly: false });
        assert.equal(settingOn.calls.n, 1);
    });

    it("the report says when DEV-YOLO is on or off for this run only (TAI-693)", () => {
        const text = (yolo: boolean, only: boolean) => renderDevTasksReport({ tasks: [], skipped: [] }, [], { yolo, ...(only ? { yoloThisRunOnly: true } : {}) });
        assert.match(text(true, true), /DEV-YOLO is on for this run only \(yolo=true\); the stored setting is unchanged\./);
        assert.match(text(false, true), /DEV-YOLO is off for this run only \(yolo=false\)/);
        assert.match(text(true, false), /DEV-YOLO is on\.\n/);
    });

    it("the timeout message states a fractional timeout as configured", async () => {
        const stuck = await fakeClaude("sleep 30");
        try {
            const r = await runHeadlessClaude("p", { cwd: tmpdir(), bin: stuck.bin, timeoutMs: 300, killGraceMs: 100 });
            assert.match(r.summary, /stopped after 0 minutes|stopped after 0\.\d? ?minutes/);
        } finally {
            await stuck.cleanup();
        }
        assert.match(`${Number((90_000 / 60000).toFixed(1))}`, /^1\.5$/);
    });

    it("redactSecrets masks bearer tokens and credential-looking environment values", () => {
        const out = redactSecrets("Authorization: Bearer abcdef123456 and tok-9f8e7d6c5b4a here", { MY_API_TOKEN: "tok-9f8e7d6c5b4a", HOME: "/home/x" });
        assert.equal(out, "Authorization: Bearer *** and *** here");
    });

    it("runHeadlessClaude takes the run's own exit as its result when a child it left behind holds the pipes", async () => {
        const leaves = await fakeClaude("echo done\nsleep 30 &\nexit 0");
        try {
            const t0 = Date.now();
            const r = await runHeadlessClaude("p", { cwd: tmpdir(), bin: leaves.bin, timeoutMs: 60_000, pipeGraceMs: 200 });
            assert.equal(r.ok, true);
            assert.ok(Date.now() - t0 < 10_000, "does not wait out the timeout");
        } finally {
            await leaves.cleanup();
        }
    });

    it("runHeadlessClaude still returns when the run ignores the stop and a child holds the pipes open", async () => {
        const stuck = await fakeClaude("trap '' TERM\necho started\nsleep 30 &\nwait");
        try {
            const t0 = Date.now();
            const r = await runHeadlessClaude("p", { cwd: tmpdir(), bin: stuck.bin, timeoutMs: 300, killGraceMs: 300 });
            assert.equal(r.ok, false);
            assert.match(r.summary, /was stopped after/);
            assert.ok(Date.now() - t0 < 10_000, "the bound holds");
        } finally {
            await stuck.cleanup();
        }
    });
});

describe("do-dev-tasks only=<KEY> (TAI-695)", () => {
    const onlyOf = (wt: WorkTracker, only: string) => findDevTasks({ workTracker: wt, projectKey: "TAI", currentHuman: ME, only: only as never });
    const twoTickets = async (wt: WorkTracker) => {
        const story = await mk(wt, { issueType: StoryType.Story });
        const a = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story.key, assignee: ME });
        const story2 = await mk(wt, { issueType: StoryType.Story });
        const b = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story2.key, assignee: ME });
        await wt.transition(a.key, Status.ToDo);
        await wt.transition(b.key, Status.ToDo);
        return { story, a, b };
    };

    it("parses only=<KEY> alone and with dryrun= and yolo=, and refuses an empty, malformed or second one (AC-4)", () => {
        assert.deepEqual(parseDevTasksArgs(["only=TAI-12"]), { dryRun: false, only: "TAI-12" });
        assert.deepEqual(parseDevTasksArgs(["dryrun=true", "only=TAI-12", "yolo=false"]), { dryRun: true, yolo: false, only: "TAI-12" });
        assert.deepEqual(parseDevTasksArgs(["only=TAI-12", "yolo=true"]), { dryRun: false, yolo: true, only: "TAI-12" });
        assert.throws(() => parseDevTasksArgs(["only="]), /only= takes one ticket key such as TAI-12 \(got: nothing\)/);
        for (const bad of ["only=tai-12", "only=TAI12", "only=TAI-1 TAI-2", "only=12", "only=TAI-1,TAI-2"]) assert.throws(() => parseDevTasksArgs([bad]), /only= takes one ticket key/, bad);
        assert.throws(() => parseDevTasksArgs(["only=TAI-1", "only=TAI-2"]), /only one only=<DEV-KEY>/);
        assert.throws(() => parseDevTasksArgs(["only", "yolo=true"]), /takes only dryrun=true/);
    });

    it("after rules, only= is accepted and changes nothing (AC-1)", () => {
        assert.deepEqual(parseDevTasksArgs(["only=TAI-12", "yolo=true"], { rules: true }), { dryRun: false, yolo: true, only: "TAI-12" });
        assert.throws(() => parseDevTasksArgs(["only=TAI-1", "only=TAI-2"], { rules: true }), /only one only=/);
    });

    it("works that ticket alone and lists every other ticket as not selected (AC-1)", async () => {
        await withTracker(async (wt) => {
            const { a, b } = await twoTickets(wt);
            const found = await onlyOf(wt, b.key);
            assert.deepEqual(found.tasks.map((t) => t.issue.key), [b.key]);
            assert.deepEqual(found.skipped.map((x) => [x.issue.key, x.reason]), [[a.key, `not selected (only=${b.key})`]]);
            assert.equal(await onlyRefusal(found, b.key, { workTracker: wt, currentHuman: ME, projectKey: "TAI" }), null);
        });
    });

    it("names the one ticket in the report and says the rest were not selected, with either yolo value (AC-3)", async () => {
        await withTracker(async (wt) => {
            const { a, b } = await twoTickets(wt);
            const found = await onlyOf(wt, b.key);
            for (const yolo of [true, false]) {
                const out = renderDevTasksReport(found, null, { yolo, yoloThisRunOnly: true, only: b.key });
                assert.match(out, new RegExp(`DEV-YOLO is ${yolo ? "on" : "off"} for this run only`));
                assert.match(out, new RegExp(`Only ${b.key} was selected \\(only=${b.key}\\)`));
                assert.match(out, new RegExp(`## Would work \\(1\\)[\\s\\S]*${b.key}`));
                assert.match(out, new RegExp(`${a.key}[^\\n]*not selected`));
            }
            assert.doesNotMatch(renderDevTasksReport(await find(wt), null, { yolo: false }), /Only .* was selected/);
        });
    });

    it("refuses a key that is not found, not a Dev subtask, not mine, or not To Do or In Progress, saying why (AC-2)", async () => {
        await withTracker(async (wt) => {
            const { story } = await twoTickets(wt);
            const theirsStory = await mk(wt, { issueType: StoryType.Story });
            const theirs = await mk(wt, { issueType: SubtaskType.Dev, parentKey: theirsStory.key, assignee: OTHER });
            await wt.transition(theirs.key, Status.ToDo);
            const doneStory = await mk(wt, { issueType: StoryType.Story });
            const done = await mk(wt, { issueType: SubtaskType.Dev, parentKey: doneStory.key, assignee: ME });
            await wt.transition(done.key, Status.Done);
            const refusal = async (key: string) => onlyRefusal(await onlyOf(wt, key), key as never, { workTracker: wt, currentHuman: ME, projectKey: "TAI" });
            assert.match((await refusal("TAI-999"))!, /TAI-999 was not found/);
            assert.match((await refusal(story.key))!, new RegExp(`${story.key} is a ${StoryType.Story}, not a Dev subtask`));
            assert.match((await refusal(theirs.key))!, new RegExp(`${theirs.key} is not assigned to you`));
            assert.match((await refusal(done.key))!, new RegExp(`${done.key} is Done; only an In Progress or To Do Dev subtask`));
        });
    });

    it("does not call an eligible-looking ticket the search did not return a wrong status (AC-2)", async () => {
        await withTracker(async (wt) => {
            const { a } = await twoTickets(wt);
            const msg = await onlyRefusal({ tasks: [], skipped: [] }, a.key, { workTracker: wt, currentHuman: ME, projectKey: "TAI" });
            assert.match(msg!, new RegExp(`${a.key} is not among your To Do and In Progress Dev subtasks in this project \\(TAI\\)`));
            assert.doesNotMatch(msg!, /only an In Progress or To Do/);
        });
    });

    it("refuses a ticket precedence or a blocker holds, or that already has an open PR, with the reason the list gives (AC-2)", async () => {
        await withTracker(async (wt) => {
            const story = await mk(wt, { issueType: StoryType.Story });
            const design = await mk(wt, { issueType: SubtaskType.ArchitectureDesign, parentKey: story.key, persona: Persona.Architect });
            const held = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story.key, assignee: ME });
            await wt.transition(held.key, Status.ToDo);
            let found = await onlyOf(wt, held.key);
            assert.match((await onlyRefusal(found, held.key, { workTracker: wt, currentHuman: ME, projectKey: "TAI" }))!, new RegExp(`${held.key} cannot be worked now: precedence holds it until ${design.key}`));

            const blocker = await mk(wt, { issueType: StoryType.Story });
            const story2 = await mk(wt, { issueType: StoryType.Story });
            await wt.createLink(story2.key, DependencyRelation.DependsOn, blocker.key);
            const blocked = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story2.key, assignee: ME });
            await wt.transition(blocked.key, Status.ToDo);
            found = await onlyOf(wt, blocked.key);
            assert.match((await onlyRefusal(found, blocked.key, { workTracker: wt, currentHuman: ME, projectKey: "TAI" }))!, new RegExp(`${blocker.key} must finish first`));

            const story3 = await mk(wt, { issueType: StoryType.Story });
            const hasPr = await mk(wt, { issueType: SubtaskType.Dev, parentKey: story3.key, assignee: ME });
            await wt.transition(hasPr.key, Status.InProgress);
            found = await findDevTasks({ workTracker: wt, projectKey: "TAI", currentHuman: ME, only: hasPr.key, openPullRequests: async () => () => "https://pr/9" });
            assert.match((await onlyRefusal(found, hasPr.key, { workTracker: wt, currentHuman: ME, projectKey: "TAI" }))!, /cannot be worked now: it has an open PR.*https:\/\/pr\/9/);
        });
    });

    it("a run with only= attempts that ticket and no other, across the looks after it (AC-1)", async () => {
        await withTracker(async (wt) => {
            const { a, b } = await twoTickets(wt);
            const d = deps();
            const { results } = await workDevTasks(() => onlyOf(wt, b.key), d);
            assert.deepEqual(results.map((r) => r.task.issue.key), [b.key]);
            assert.ok(!d.calls.join("\n").includes(a.key));
        });
    });
});

describe("pausing on a usage limit (TAI-706)", () => {
    const NOW = new Date(2026, 10, 4, 10, 0, 0);
    const reset2h = new Date(NOW.getTime() + 2 * 3_600_000);

    /** Deps whose build ends on the limit for the keys in `hits` (as many times as `hits[key]` says), the way the CLI's build does. */
    function limitDeps(hits: Record<string, number>, over: Partial<RunDevTasksDeps> = {}, limit: UsageLimit = { text: "5-hour limit reached", resetsAt: reset2h }) {
        const latch = new UsageLimitLatch();
        const posted: [string, string][] = [];
        const sleeps: number[] = [];
        const said: string[] = [];
        const d = deps({
            limitLatch: latch,
            now: () => NOW,
            sleep: async (ms) => void sleeps.push(ms),
            say: (line) => void said.push(line),
            build: async (t) => {
                d.calls.push(`build ${t.issue.key}`);
                if ((hits[t.issue.key] ?? 0) > 0) {
                    hits[t.issue.key]!--;
                    latch.hit(limit, "build run");
                    return { ok: false, summary: "the run exited with code 1", limit } as never;
                }
                return { ok: true, summary: "" };
            },
            handoff: pausedAwareHandoff(latch, async (k, b) => void posted.push([k, b])),
            ...over,
        });
        return { d, posted, sleeps, said, latch };
    }

    it("a pause after a PR or a merge keeps what the run had already done, in the outcome and the report", async () => {
        const latch = new UsageLimitLatch();
        const d = deps({
            limitLatch: latch, yolo: true,
            yoloRun: async () => (latch.hit({ text: "limit" }, "verification run"), { state: "handed-on", note: "merged PR 7; verification not run" }),
        });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10")], skipped: [] }), d);
        const o = results[0]!.outcome as { state: string; before?: string };
        assert.equal(o.state, "paused");
        assert.equal(o.before, "merged PR 7; verification not run");
        assert.match(renderDevTasksReport({ tasks: [], skipped: [] }, results, { yolo: true }), /Before the pause it had done: merged PR 7; verification not run\./);
    });

    it("a pause note that could not be posted still lets the retry after a wait continue the ticket, and the report says so", async () => {
        const latch = new UsageLimitLatch();
        const remembered: string[] = [];
        let hit = true;
        const d = deps({
            limitLatch: latch, waitHours: 6, now: () => new Date(2026, 10, 4, 10), sleep: async () => undefined,
            rememberPause: (k) => void remembered.push(k),
            handoff: async () => { throw new Error("jira down"); },
            build: async (t) => {
                d.calls.push(`build ${t.issue.key}`);
                if (hit) { hit = false; latch.hit({ text: "limit", resetsAt: new Date(2026, 10, 4, 12) }, "build run"); return { ok: false, summary: "x" }; }
                return { ok: true, summary: "" };
            },
        });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10")], skipped: [] }), d);
        assert.deepEqual(remembered, ["TAI-10"]);
        assert.deepEqual(d.calls.filter((c) => c.startsWith("build")), ["build TAI-10", "build TAI-10"], "tried again in the same run");
        assert.equal(results[0]!.outcome.state, "pr-opened");
        // Without a wait, the pause is reported with the note failure.
        const latch2 = new UsageLimitLatch();
        const d2 = deps({ limitLatch: latch2, handoff: async () => { throw new Error("jira down"); }, build: async () => (latch2.hit({ text: "limit" }, "build run"), { ok: false, summary: "x" }) });
        const second = await workDevTasks(async () => ({ tasks: [task("TAI-10")], skipped: [] }), d2);
        assert.equal((second.results[0]!.outcome as { noteNotPosted?: boolean }).noteNotPosted, true);
        assert.match(renderDevTasksReport({ tasks: [], skipped: [] }, second.results, { yolo: false }), /The pause note could not be posted to the ticket\./);
    });

    it("works a ticket paused on a limit before the others, so its cut-off work is not stopped on by a sibling's dirty-tree check", async () => {
        const d = deps({ pausedOnLimit: async (t) => t.issue.key === "TAI-12" });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11"), task("TAI-12")], skipped: [] }), d);
        assert.deepEqual(d.calls.filter((c) => c.startsWith("prepare")), ["prepare TAI-12", "prepare TAI-10", "prepare TAI-11"]);
        assert.equal(results.length, 3);
    });

    it("reads each ticket's pause once for the run, not again on every pick", async () => {
        const reads: string[] = [];
        const d = deps({ pausedOnLimit: async (t) => (reads.push(t.issue.key), false) });
        await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11"), task("TAI-12")], skipped: [] }), d);
        assert.equal(new Set(reads).size, reads.length, "no ticket read twice");
    });

    it("keeps the usual order when no ticket was paused, or when the pause cannot be read", async () => {
        const none = deps({ pausedOnLimit: async () => false });
        await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11")], skipped: [] }), none);
        assert.deepEqual(none.calls.filter((c) => c.startsWith("prepare")), ["prepare TAI-10", "prepare TAI-11"]);
        const broken = deps({ pausedOnLimit: async () => { throw new Error("jira down"); } });
        await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11")], skipped: [] }), broken);
        assert.deepEqual(broken.calls.filter((c) => c.startsWith("prepare")), ["prepare TAI-10", "prepare TAI-11"]);
    });

    it("a limit hit ends the batch at once: the ticket is paused, not failed, and no further ticket is started", async () => {
        const { d, posted } = limitDeps({ "TAI-10": 1 });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11")], skipped: [] }), d);
        assert.deepEqual(results.map((r) => r.outcome.state), ["paused"]);
        assert.deepEqual(d.calls, ["prepare TAI-10", "build TAI-10"], "TAI-11 is never prepared or built");
        // The only note is the neutral one: no failure hand-off.
        assert.equal(posted.length, 1);
        assert.match(posted[0]![1], /^Handoff: DEV-YOLO paused on a usage limit/);
        assert.match(posted[0]![1], /while this ticket's build run was running/);
        assert.doesNotMatch(posted[0]![1], /"Do all dev tasks" stopped on this ticket/);
    });

    it("an unattended run that ended on the limit is paused even though it reported its own stop", async () => {
        const { d, posted, latch } = limitDeps({});
        const yoloD: RunDevTasksDeps = {
            ...d,
            yolo: true,
            yoloRun: async (t) => {
                latch.hit({ text: "You've hit your limit · resets 3pm" }, "review run");
                await d.handoff(t.issue.key, "Handoff: DEV-YOLO run. The build run did not finish.\n\nStopped: something else");
                return { state: "waiting", reason: "something else" };
            },
        };
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11")], skipped: [] }), yoloD);
        assert.deepEqual(results.map((r) => r.outcome.state), ["paused"]);
        assert.equal((results[0]!.outcome as { stage: string }).stage, "review run");
        assert.match(posted[0]![1], /paused on a usage limit/);
        assert.doesNotMatch(posted[0]![1], /something else/);
    });

    it("with no wait=, the run stops and says why it did not wait", async () => {
        const { d, sleeps } = limitDeps({ "TAI-10": 1 });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10")], skipped: [] }), d);
        assert.deepEqual(sleeps, []);
        assert.equal((results[0]!.outcome as { notWaited?: string }).notWaited, "no wait= was given");
    });

    it("with wait=<hours> and a reset within it, sleeps until the reset and carries on with the same ticket after a fresh look", async () => {
        const { d, sleeps, said } = limitDeps({ "TAI-10": 1 }, { waitHours: 6 });
        let looks = 0;
        const { results } = await workDevTasks(async () => (looks++, { tasks: [task("TAI-10"), task("TAI-11")], skipped: [] }), d);
        assert.deepEqual(sleeps, [2 * 3_600_000 + 60_000]);
        assert.match(said[0]!, /Waiting 121 minutes for the reset, then carrying on with TAI-10/);
        assert.deepEqual(results.map((r) => [r.task.issue.key, r.outcome.state]), [["TAI-10", "pr-opened"], ["TAI-11", "pr-opened"]], "the paused entry is replaced by how the ticket ended");
        assert.deepEqual(d.calls.filter((c) => c.startsWith("build")), ["build TAI-10", "build TAI-10", "build TAI-11"]);
        assert.ok(looks >= 3, "a fresh look after the wait");
    });

    it("with a reset beyond the cap, stops as it does with no wait=", async () => {
        const weekly: UsageLimit = { text: "Weekly limit reached ∙ resets Nov 7, 10am", resetsAt: new Date(NOW.getTime() + 72 * 3_600_000) };
        const { d, sleeps } = limitDeps({ "TAI-10": 1 }, { waitHours: 6 }, weekly);
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11")], skipped: [] }), d);
        assert.deepEqual(sleeps, []);
        assert.deepEqual(results.map((r) => r.outcome.state), ["paused"]);
        assert.match((results[0]!.outcome as { notWaited?: string }).notWaited ?? "", /further off than wait=6 hours/);
    });

    it("a limit that keeps coming back after the reset is not waited for for ever", async () => {
        const { d, sleeps } = limitDeps({ "TAI-10": 99 }, { waitHours: 6 });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10")], skipped: [] }), d);
        assert.equal(sleeps.length, 3);
        assert.deepEqual(results.map((r) => r.outcome.state), ["paused"]);
        assert.match((results[0]!.outcome as { notWaited?: string }).notWaited ?? "", /hit again after 3 waits/);
    });

    it("a failure that is not a limit is still a failure, and the batch goes on", async () => {
        const d = deps({ limitLatch: new UsageLimitLatch(), build: async (t) => (t.issue.key === "TAI-10" ? { ok: false, summary: "Rate limit reached" } : { ok: true, summary: "" }) });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11")], skipped: [] }), d);
        assert.deepEqual(results.map((r) => r.outcome.state), ["failed", "pr-opened"]);
    });

    it("the report has a Paused section naming the ticket, where it stopped and the reset time, and lists it nowhere else", () => {
        const resetsAt = new Date("2026-11-04T22:00:00Z");
        const result: DevTaskResult = { task: task("TAI-10"), outcome: { state: "paused", limit: { text: "5-hour limit reached ∙ resets 3pm", resetsAt }, stage: "review run", notWaited: "no wait= was given" } };
        const text = renderDevTasksReport({ tasks: [], skipped: [] }, [result], { yolo: true });
        assert.match(text, /## Paused \(1\)\n\n- \*\*TAI-10\*\* s TAI-10: the usage limit was reached during its review run \("5-hour limit reached ∙ resets 3pm"; resets 2026-11-04T22:00:00\.000Z\)\. The run did not wait: no wait= was given\. No further ticket was started/);
        assert.match(text, /## Failed \(0\)\n\nNone\./);
        const unknown = renderDevTasksReport({ tasks: [], skipped: [] }, [{ task: task("TAI-10"), outcome: { state: "paused", limit: { text: "limit reached" }, stage: "build run" } }], { yolo: false });
        assert.match(unknown, /reset time not known/);
        assert.doesNotMatch(renderDevTasksReport({ tasks: [], skipped: [] }, [], { yolo: false }), /## Paused/);
    });

    it("wait= is read by the arguments, and a mistyped or empty value is refused", () => {
        assert.deepEqual(parseDevTasksArgs(["yolo=true", "wait=6"]), { dryRun: false, yolo: true, waitHours: 6 });
        assert.deepEqual(parseDevTasksArgs(["wait=0.5"]), { dryRun: false, waitHours: 0.5 });
        for (const bad of ["wait=", "wait=0", "wait=-2", "wait=soon", "wait=6h", "wait=999"]) assert.throws(() => parseDevTasksArgs([bad]), /wait= takes a number of hours/, bad);
        assert.throws(() => parseDevTasksArgs(["wait=2", "wait=3"]), /only one wait=<hours>/);
        assert.throws(() => parseDevTasksArgs(["wait=2"], { rules: true }), /rules takes only/);
    });

    describe("a ticket cut off mid-build continues on its own branch", () => {
        async function repo() {
            const dir = await mkdtemp(path.join(tmpdir(), "tai-resume-"));
            const origin = path.join(dir, "origin.git");
            execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
            const work = path.join(dir, "work");
            execFileSync("git", ["clone", "-q", origin, work]);
            const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: work, stdio: "pipe" });
            await writeFile(path.join(work, "a.txt"), "1");
            g("add", "."); g("commit", "-q", "-m", "one"); g("push", "-q", "origin", "HEAD:main"); g("fetch", "-q");
            g("branch", "-q", "--set-upstream-to=origin/main", "main");
            return { dir, work, g, head: () => execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: work }).toString().trim() };
        }

        it("keeps its uncommitted work and does not trip the dirty-tree stop", async () => {
            const r = await repo();
            try {
                r.g("checkout", "-q", "-b", "TAI-1-feature");
                await writeFile(path.join(r.work, "a.txt"), "cut off half way");
                assert.equal(await cutOffBranch(r.work, "TAI-1"), "TAI-1-feature");
                await prepareForTicket(r.work, ".tai", "TAI-1", true);
                assert.equal(r.head(), "TAI-1-feature", "still on the ticket's branch");
                assert.equal(await readFile(path.join(r.work, "a.txt"), "utf8"), "cut off half way", "its work is kept");
            } finally {
                await rm(r.dir, { recursive: true, force: true });
            }
        });

        it("describes where the checkout stands, and the description changes with a commit or a branch switch", async () => {
            const r = await repo();
            try {
                r.g("checkout", "-q", "-b", "TAI-1-feature");
                const before = await checkoutPosition(r.work);
                assert.match(before ?? "", /^TAI-1-feature@[0-9a-f]{4,}$/);
                await writeFile(path.join(r.work, "a.txt"), "changed");
                r.g("commit", "-q", "-am", "more");
                assert.notEqual(await checkoutPosition(r.work), before);
                assert.equal(await checkoutPosition(path.join(r.dir, "nowhere")), undefined);
            } finally {
                await rm(r.dir, { recursive: true, force: true });
            }
        });

        it("still stops on a dirty tree that is not this ticket's branch", async () => {
            const r = await repo();
            try {
                r.g("checkout", "-q", "-b", "TAI-2-other");
                await writeFile(path.join(r.work, "a.txt"), "someone else's");
                assert.equal(await cutOffBranch(r.work, "TAI-1"), null);
                await assert.rejects(prepareForTicket(r.work, ".tai", "TAI-1", true), DirtyTreeError);
                r.g("checkout", "-q", "--", "a.txt");
                r.g("checkout", "-q", "main");
                await writeFile(path.join(r.work, "a.txt"), "dirty default branch");
                // A pause cut off before the Story branch existed: the stop says why a paused ticket is not continued.
                await assert.rejects(prepareForTicket(r.work, ".tai", "TAI-1", true), (err: unknown) => err instanceof DirtyTreeError && /paused on a usage limit[\s\S]*not checked out/.test(err.message));
                await assert.rejects(prepareForTicket(r.work, ".tai", "TAI-1", false), (err: unknown) => err instanceof DirtyTreeError && !/paused on a usage limit/.test(err.message));
            } finally {
                await rm(r.dir, { recursive: true, force: true });
            }
        });

        it("still stops on dirty work on the Story's branch when this ticket was not paused (a sibling's failed run)", async () => {
            const r = await repo();
            try {
                r.g("checkout", "-q", "-b", "TAI-1-feature");
                await writeFile(path.join(r.work, "a.txt"), "a sibling ticket's half-done work");
                await assert.rejects(prepareForTicket(r.work, ".tai", "TAI-1", false), DirtyTreeError);
                assert.equal(await readFile(path.join(r.work, "a.txt"), "utf8"), "a sibling ticket's half-done work", "nothing was touched");
            } finally {
                await rm(r.dir, { recursive: true, force: true });
            }
        });

        it("starts from the default branch as before when this ticket was not paused", async () => {
            const r = await repo();
            try {
                r.g("checkout", "-q", "-b", "TAI-1-feature");
                await prepareForTicket(r.work, ".tai", "TAI-1", false);
                assert.equal(r.head(), "main");
            } finally {
                await rm(r.dir, { recursive: true, force: true });
            }
        });

        it("continues from commits a cut-off run made locally, with a clean tree, not from the default branch", async () => {
            const r = await repo();
            try {
                r.g("checkout", "-q", "-b", "TAI-1-feature");
                await writeFile(path.join(r.work, "b.txt"), "committed before the limit hit");
                r.g("add", "."); r.g("commit", "-q", "-m", "work in progress");
                const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: r.work }).toString().trim();
                assert.equal(await cutOffBranch(r.work, "TAI-1"), "TAI-1-feature");
                await prepareForTicket(r.work, ".tai", "TAI-1", true);
                assert.equal(r.head(), "TAI-1-feature");
                assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: r.work }).toString().trim(), before, "its commits are kept");
            } finally {
                await rm(r.dir, { recursive: true, force: true });
            }
        });

        it("the build prompt tells the run to keep the work, not start over, and not open a second PR", () => {
            const resumed = buildDevPrompt("TAI-10", "tai", "TAI-1-feature");
            assert.match(resumed, /CONTINUED[\s\S]*TAI-1-feature[\s\S]*do not stash, reset, discard or re-create the branch[\s\S]*do not open a second one/);
            assert.doesNotMatch(buildDevPrompt("TAI-10", "tai"), /CONTINUED/);
            assert.doesNotMatch(buildDevPrompt("TAI-10", "tai", null), /CONTINUED/);
        });
    });

    describe("only a pause that says the run continues the ticket lifts the dirty-tree stop", () => {
        const tracker = (...bodies: string[]) => ({ getIssue: async () => ({ comments: bodies.map((body) => ({ body })) }) });
        const buildPause = pausedHandoff({ text: "5-hour limit reached" }, "build run");
        const reviewPause = pausedHandoff({ text: "5-hour limit reached" }, "review run");

        it("is true when the newest hand-off is a build-stage pause", async () => {
            assert.equal(await wasPausedOnLimit(tracker(buildPause + "\n\nPosted via the TAI CLI as Dev.") as never, "TAI-10" as never), true);
        });

        it("reads the newest by the comment's own time, not by the order the host returned them in", async () => {
            const t = { getIssue: async () => ({ comments: [{ body: buildPause, createdAt: "2026-11-04T12:00:00Z" }, { body: "Handoff: DEV-YOLO run. The build run did not finish.", createdAt: "2026-11-04T09:00:00Z" }] }) };
            assert.equal(await wasPausedOnLimit(t as never, "TAI-10" as never), true, "the pause is newer even though it is listed first");
            const u = { getIssue: async () => ({ comments: [{ body: "Handoff: DEV-YOLO run. The build run did not finish.", createdAt: "2026-11-04T13:00:00Z" }, { body: buildPause, createdAt: "2026-11-04T12:00:00Z" }] }) };
            assert.equal(await wasPausedOnLimit(u as never, "TAI-10" as never), false, "a newer failure hand-off replaced it even though it is listed first");
        });

        it("orders by the instant, not the text, when the offsets differ", async () => {
            // 13:00-0700 is 20:00Z, later than 15:00Z even though "13:00" sorts before "15:00" as text.
            const t = { getIssue: async () => ({ comments: [{ body: buildPause, createdAt: "2026-11-04T13:00:00.000-0700" }, { body: "Handoff: DEV-YOLO run. The build run did not finish.", createdAt: "2026-11-04T15:00:00.000+0000" }] }) };
            assert.equal(await wasPausedOnLimit(t as never, "TAI-10" as never), true);
        });

        it("is false for a failure hand-off, a later-stage pause, no hand-off, or a pause that a newer hand-off replaced", async () => {
            assert.equal(await wasPausedOnLimit(tracker("Handoff: \"Do all dev tasks\" stopped on this ticket. tests failed") as never, "TAI-10" as never), false);
            assert.equal(await wasPausedOnLimit(tracker(reviewPause) as never, "TAI-10" as never), false);
            assert.equal(await wasPausedOnLimit(tracker("a plain comment") as never, "TAI-10" as never), false);
            assert.equal(await wasPausedOnLimit({ getIssue: async () => null } as never, "TAI-10" as never), false);
            assert.equal(await wasPausedOnLimit(tracker(buildPause, "Handoff: DEV-YOLO run. The build run did not finish.") as never, "TAI-10" as never), false);
        });
    });

    it("a pause after the PR is open says the ticket is not continued by the next run, in the note and in the report", () => {
        const note = pausedHandoff({ text: "x" }, "review run");
        assert.match(note, /PR is already open, so "Do all dev tasks" skips this ticket/);
        assert.doesNotMatch(note, /continues this ticket/);
        assert.match(pausedHandoff({ text: "x" }, "build run"), /The run continues this ticket on its branch/);
        const result = (stage: string): DevTaskResult => ({ task: task("TAI-10"), outcome: { state: "paused", limit: { text: "x" }, stage } });
        assert.match(renderDevTasksReport({ tasks: [], skipped: [] }, [result("fix run")], { yolo: true }), /PR is already open, so a later run skips this ticket: continue it with \/tai-work/);
        assert.match(renderDevTasksReport({ tasks: [], skipped: [] }, [result("build run")], { yolo: true }), /Run "Do all dev tasks" again after the reset: it continues this ticket/);
    });

    it("does not sleep after a later-stage pause when no other ticket is left to carry on with", async () => {
        const latch = new UsageLimitLatch();
        const sleeps: number[] = [];
        const d = deps({
            limitLatch: latch, waitHours: 6, now: () => new Date(2026, 10, 4, 10), sleep: async (ms) => void sleeps.push(ms),
            yolo: true,
            yoloRun: async () => (latch.hit({ text: "limit", resetsAt: new Date(2026, 10, 4, 12) }, "review run"), { state: "waiting", reason: "r" }),
        });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10")], skipped: [] }), d);
        assert.deepEqual(sleeps, []);
        assert.match((results[0]!.outcome as { notWaited?: string }).notWaited ?? "", /no other ticket is left/);
    });

    it("waiting after a later-stage pause carries on with the other tickets and does not retry the ticket whose PR is open", async () => {
        const latch = new UsageLimitLatch();
        const sleeps: number[] = [];
        const said: string[] = [];
        let hit = true;
        const d = deps({
            limitLatch: latch, waitHours: 6, now: () => new Date(2026, 10, 4, 10), sleep: async (ms) => void sleeps.push(ms), say: (l) => void said.push(l),
            yolo: true,
            yoloRun: async (t) => {
                d.calls.push(`yolo ${t.issue.key}`);
                if (t.issue.key === "TAI-10" && hit) {
                    hit = false;
                    latch.hit({ text: "limit", resetsAt: new Date(2026, 10, 4, 12) }, "review run");
                }
                return { state: "waiting", reason: "r" };
            },
        });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10"), task("TAI-11")], skipped: [] }), d);
        assert.equal(sleeps.length, 1);
        assert.match(said[0]!, /carrying on with the other tickets \(TAI-10 has an open PR/);
        assert.deepEqual(d.calls.filter((c) => c.startsWith("yolo")), ["yolo TAI-10", "yolo TAI-11"]);
        // The paused ticket stays in the report (a later run will not pick it up), and it says the run carried on without it.
        assert.deepEqual(results.map((r) => [r.task.issue.key, r.outcome.state]), [["TAI-10", "paused"], ["TAI-11", "waiting"]]);
        assert.match(renderDevTasksReport({ tasks: [], skipped: [] }, results, { yolo: true }), /## Paused \(1\)[\s\S]*review run[\s\S]*The run waited for the reset and carried on with the other tickets\.[\s\S]*continue it with \/tai-work/);
        assert.doesNotMatch(renderDevTasksReport({ tasks: [], skipped: [] }, results, { yolo: true }), /No further ticket was started/);
    });

    it("an interrupt during the wait keeps the paused ticket in the report", async () => {
        const latch = new UsageLimitLatch();
        let interrupted = false;
        const d = deps({
            limitLatch: latch, waitHours: 6, now: () => new Date(2026, 10, 4, 10), interrupted: () => interrupted,
            sleep: async () => void (interrupted = true),
            build: async () => (latch.hit({ text: "limit", resetsAt: new Date(2026, 10, 4, 12) }, "build run"), { ok: false, summary: "x" }),
        });
        const { results } = await workDevTasks(async () => ({ tasks: [task("TAI-10")], skipped: [] }), d);
        assert.deepEqual(results.map((r) => r.outcome.state), ["paused"]);
        assert.equal((results[0]!.outcome as { notWaited?: string }).notWaited, "the run was interrupted during the wait");
        assert.match(renderDevTasksReport({ tasks: [], skipped: [] }, results, { yolo: false }), /## Paused \(1\)[\s\S]*interrupted during the wait/);
    });
});
