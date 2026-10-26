import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";

import { DependencyRelation, Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, type HumanRef, type WorkTracker } from "../storage/interface.js";
import { DirtyTreeError, prepareCleanDefaultBranch } from "./dev-tasks-git.js";
import { findDevTasks, findOpenPullRequest, listOpenPullRequests, renderDevTasksReport, titleNamesKey, workDevTasks, type DevTask, type FoundDevTasks, type RunDevTasksDeps } from "./do-dev-tasks.js";
import { buildDevPrompt, devRunTimeoutMs, runHeadlessClaude } from "./headless-claude.js";

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
            getCommitStatuses: async () => [{ key: "k", name: "check", state: "successful" }],
        } as never;
        const repo = "o/r" as never;
        assert.deepEqual(await findOpenPullRequest(gitHost, [repo], "TAI-10", { checkConfigured: true }), { prUrl: "https://pr/mine", checkRecorded: true });
        assert.deepEqual(await findOpenPullRequest(gitHost, [repo], "TAI-10", { checkConfigured: false }), { prUrl: "https://pr/mine", checkRecorded: null });
        assert.deepEqual(await findOpenPullRequest(gitHost, [repo], "TAI-11", { checkConfigured: true }), { prUrl: null, checkRecorded: null });
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
            assert.match(skipped[0]!.reason, /PR is already open and waiting for review: https:\/\/pr\/1/);
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
            const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
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
            void git;
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
