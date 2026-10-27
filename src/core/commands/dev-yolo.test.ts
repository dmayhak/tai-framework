import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PullRequestActivity } from "../git/interface.js";
import type { ReviewFinding, ReviewFindings } from "../git/review-findings.js";
import { runYolo, reviewDecisionOnHead, ownDecisionCount, yoloHandoff, type ReviewDecision, type YoloDeps } from "./dev-yolo.js";
import { runDevTask, type DevTask, type RunDevTasksDeps } from "./do-dev-tasks.js";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFixPrompt, buildReviewerPrompt, buildDevPrompt, buildVerifyPrompt, runEnv, runHeadlessClaude } from "./headless-claude.js";

const task = { issue: { key: "TAI-9" }, parent: { key: "TAI-8" } } as unknown as DevTask;

const finding = (severity: ReviewFinding["severity"], title = "t"): ReviewFinding => ({ severity, category: "Logic", title, file: "a.ts", issue: "i" });
const findingsOf = (...fs: ReviewFinding[]): ReviewFindings => ({ findings: fs, leaning: "approve" }) as unknown as ReviewFindings;

interface Script {
    reviews: { findings: ReviewFindings; decision: ReviewDecision; head: string }[];
    heads: string[];
    log: string[];
    handoffs: string[];
}

function deps(script: Script, over: Partial<YoloDeps> = {}): YoloDeps {
    let r = 0;
    let h = 0;
    return {
        rounds: 4,
        build: async () => (script.log.push("build"), { ok: true, summary: "" }),
        findPullRequest: async () => ({ prUrl: "https://pr/1", checkRecorded: true }),
        review: async (_t, _u, round) => {
            script.log.push(`review ${round}`);
            const next = script.reviews[r++];
            return next ? { ok: true, review: next } : { ok: false, reason: "no more reviews scripted" };
        },
        fix: async (_t, _u, fs, round) => (script.log.push(`fix ${round} (${fs.length})`), { ok: true, summary: "" }),
        head: async () => script.heads[h++] ?? "same",
        handoff: async (_k, body) => void script.handoffs.push(body),
        ...over,
    };
}
const script = (over: Partial<Script> = {}): Script => ({ reviews: [], heads: [], log: [], handoffs: [], ...over });

describe("runYolo (TAI-634)", () => {
    it("builds, reviews once, and ends at the approval when nothing is left to decide", async () => {
        const s = script({ reviews: [{ findings: findingsOf(finding("good")), decision: "approve", head: "a" }] });
        const out = await runYolo(task, deps(s));
        assert.deepEqual(s.log, ["build", "review 1"]);
        assert.equal(out.state, "waiting");
        assert.match(s.handoffs[0]!, /reviewed and approved by the automated reviewer in 1 round/);
        assert.match(s.handoffs[0]!, /not in this version/);
    });

    it("hands an approved PR to afterApproved when part 3 supplies it", async () => {
        const s = script({ reviews: [{ findings: findingsOf(), decision: "approve", head: "a" }] });
        const out = await runYolo(task, deps(s, { afterApproved: async (_t, url) => ({ state: "handed-on", note: `merged ${url}` }) }));
        assert.deepEqual(out, { state: "handed-on", note: "merged https://pr/1" });
        assert.deepEqual(s.handoffs, []);
    });

    it("decides every Suggestion and Nitpick, and asks for a fresh review when the fix pushed", async () => {
        const s = script({
            reviews: [
                { findings: findingsOf(finding("suggestion"), finding("nitpick")), decision: "approve", head: "a" },
                { findings: findingsOf(finding("good")), decision: "approve", head: "b" },
            ],
            heads: ["b"],
        });
        const out = await runYolo(task, deps(s, { afterApproved: async () => ({ state: "handed-on", note: "ok" }) }));
        assert.deepEqual(s.log, ["build", "review 1", "fix 1 (2)", "review 2"]);
        assert.equal(out.state, "handed-on");
    });

    it("keeps the approval when the fixes were all tickets and reasons and nothing was pushed", async () => {
        const s = script({ reviews: [{ findings: findingsOf(finding("suggestion")), decision: "approve", head: "a" }], heads: ["a"] });
        await runYolo(task, deps(s, { afterApproved: async () => ({ state: "handed-on", note: "ok" }) }));
        assert.deepEqual(s.log, ["build", "review 1", "fix 1 (1)"]);
    });

    it("stops on a finding above Suggestion, naming it, without deciding anything", async () => {
        const s = script({ reviews: [{ findings: findingsOf(finding("critical", "Race in the lock"), finding("suggestion")), decision: "approve", head: "a" }] });
        const out = await runYolo(task, deps(s));
        assert.deepEqual(s.log, ["build", "review 1"]);
        assert.equal(out.state, "waiting");
        assert.match(s.handoffs[0]!, /1 finding above Suggestion \(Race in the lock\)/);
    });

    it("stops when the reviewer asked for changes, and when it cast no decision", async () => {
        const a = script({ reviews: [{ findings: findingsOf(), decision: "requestChanges", head: "a" }] });
        await runYolo(task, deps(a));
        assert.match(a.handoffs[0]!, /asked for changes/);
        const b = script({ reviews: [{ findings: findingsOf(), decision: "none", head: "a" }] });
        await runYolo(task, deps(b));
        assert.match(b.handoffs[0]!, /cast no approval on the PR's current commit/);
    });

    it("stops, before any fix run, when the reviewer approved but its findings lean neither (TAI-682)", async () => {
        const leaning = { ...findingsOf(finding("suggestion")), leaning: "neither" } as unknown as ReviewFindings;
        const s = script({ reviews: [{ findings: leaning, decision: "approve", head: "a" }] });
        const out = await runYolo(task, deps(s));
        assert.deepEqual(s.log, ["build", "review 1"], "no fix run starts");
        assert.equal(out.state, "waiting");
        assert.match(s.handoffs[0]!, /lean "neither"/);
        assert.match(s.handoffs[0]!, /leans "approve"/);
    });

    it("says plainly that a review which approved but leans requestChanges contradicts itself (PR 29 review)", async () => {
        const leaning = { ...findingsOf(finding("suggestion")), leaning: "requestChanges" } as unknown as ReviewFindings;
        const s = script({ reviews: [{ findings: leaning, decision: "approve", head: "a" }] });
        await runYolo(task, deps(s));
        assert.deepEqual(s.log, ["build", "review 1"], "no fix run starts");
        assert.match(s.handoffs[0]!, /lean "requestChanges": the review contradicts itself/);
        assert.doesNotMatch(s.handoffs[0]!, /leans "approve"/, "the neither wording is not reused for this case");
    });

    it("continues when the findings meet the bar and lean approve (TAI-682)", async () => {
        const s = script({ reviews: [{ findings: findingsOf(finding("suggestion")), decision: "approve", head: "a" }], heads: ["a"] });
        await runYolo(task, deps(s));
        assert.deepEqual(s.log, ["build", "review 1", "fix 1 (1)"], "the fix run starts, and nothing was pushed");
    });

    it("stops after the last round when its fix has no fresh review", async () => {
        const s = script({
            reviews: [
                { findings: findingsOf(finding("nitpick")), decision: "approve", head: "a" },
                { findings: findingsOf(finding("nitpick")), decision: "approve", head: "b" },
            ],
            heads: ["b", "c"],
        });
        const out = await runYolo(task, deps(s, { rounds: 2 }));
        assert.deepEqual(s.log, ["build", "review 1", "fix 1 (1)", "review 2", "fix 2 (1)"]);
        assert.equal(out.state, "waiting");
        assert.match(s.handoffs[0]!, /2 review rounds used, and the last fix has no fresh review/);
    });

    it("never reviews more than the configured number of rounds", async () => {
        const many = Array.from({ length: 6 }, (_, i) => ({ findings: findingsOf(finding("nitpick")), decision: "approve" as const, head: `h${i}` }));
        const s = script({ reviews: many, heads: ["x1", "x2", "x3", "x4", "x5", "x6"] });
        await runYolo(task, deps(s, { rounds: 3 }));
        assert.equal(s.log.filter((l) => l.startsWith("review")).length, 3);
    });

    it("leaves a hand-off and goes on when the build fails, no PR is found, the check is missing, or a step throws", async () => {
        const failed = script();
        assert.equal((await runYolo(task, deps(failed, { build: async () => ({ ok: false, summary: "tests never passed" }) }))).state, "waiting");
        assert.match(failed.handoffs[0]!, /tests never passed/);
        const none = script();
        await runYolo(task, deps(none, { findPullRequest: async () => ({ prUrl: null, checkRecorded: null }) }));
        assert.match(none.handoffs[0]!, /no open PR/);
        const said = script();
        await runYolo(task, deps(said, { build: async () => ({ ok: true, summary: "the command needs approval" }), findPullRequest: async () => ({ prUrl: null, checkRecorded: null }) }));
        assert.match(said.handoffs[0]!, /no open PR[\s\S]*needs approval/);
        const nocheck = script();
        await runYolo(task, deps(nocheck, { findPullRequest: async () => ({ prUrl: "u", checkRecorded: false }) }));
        assert.match(nocheck.handoffs[0]!, /no check result/);
        const boom = script();
        const out = await runYolo(task, deps(boom, { build: async () => { throw new Error("spawn failed"); } }));
        assert.equal(out.state, "waiting");
        assert.match(boom.handoffs[0]!, /spawn failed/);
    });

    it("stops on an unreadable review and on a failed fix run", async () => {
        const noReview = script();
        await runYolo(task, deps(noReview));
        assert.match(noReview.handoffs[0]!, /did not produce a review/);
        const badFix = script({ reviews: [{ findings: findingsOf(finding("suggestion")), decision: "approve", head: "a" }] });
        await runYolo(task, deps(badFix, { fix: async () => ({ ok: false, summary: "timed out" }) }));
        assert.match(badFix.handoffs[0]!, /timed out/);
    });

    it("still reports a stop when the hand-off cannot be posted", async () => {
        const out = await runYolo(task, deps(script(), { build: async () => ({ ok: false, summary: "bad" }), handoff: async () => { throw new Error("jira down"); } }));
        assert.equal(out.state, "waiting");
        assert.match((out as { reason: string }).reason, /hand-off comment could not be posted: jira down/);
    });
});

describe("reviewDecisionOnHead", () => {
    const bot = { id: "Bot" } as never;
    const other = { id: "human" } as never;
    const upd = (): PullRequestActivity => ({ kind: "update", at: "t", sourceCommit: "c" }) as PullRequestActivity;
    const by = (kind: "approval" | "changesRequested", human: unknown): PullRequestActivity => ({ kind, at: "t", human }) as PullRequestActivity;
    it("takes the reviewer's last decision, matched without case, and a push after it cancels it", () => {
        assert.equal(reviewDecisionOnHead([], bot), "none");
        assert.equal(reviewDecisionOnHead([upd(), by("approval", { id: "bot" })], bot), "approve");
        assert.equal(reviewDecisionOnHead([by("approval", bot), upd()], bot), "none");
        assert.equal(reviewDecisionOnHead([by("approval", bot), by("changesRequested", bot)], bot), "requestChanges");
        assert.equal(reviewDecisionOnHead([by("changesRequested", bot), upd(), by("approval", bot)], bot), "approve");
    });
    it("ignores an approval from anyone else, so a run whose reviewer cast nothing does not go on", () => {
        assert.equal(reviewDecisionOnHead([upd(), by("approval", other)], bot), "none");
        assert.equal(reviewDecisionOnHead([upd(), by("approval", other), by("approval", bot)], bot), "approve");
    });
    it("keeps a request for changes from anyone else as a stop, until the next push", () => {
        assert.equal(reviewDecisionOnHead([upd(), by("approval", bot), by("changesRequested", other)], bot), "requestChanges");
        assert.equal(reviewDecisionOnHead([by("changesRequested", other), upd(), by("approval", bot)], bot), "approve");
    });
});

describe("ownDecisionCount", () => {
    it("counts the reviewer's own decisions since the last push", () => {
        const bot = { id: "bot" as never };
        const upd = { kind: "update", at: "t", sourceCommit: "c" } as PullRequestActivity;
        const by = (id: string, kind: "approval" | "changesRequested") => ({ kind, at: "t", human: { id } }) as unknown as PullRequestActivity;
        assert.equal(ownDecisionCount([], bot), 0);
        assert.equal(ownDecisionCount([upd, by("bot", "approval"), by("human", "approval")], bot), 1);
        assert.equal(ownDecisionCount([by("bot", "approval"), upd], bot), 0);
        assert.equal(ownDecisionCount([upd, by("BOT", "changesRequested"), by("bot", "approval")], bot), 2);
    });
});

describe("the DEV-YOLO gate in runDevTask", () => {
    const base = (over: Partial<RunDevTasksDeps>): RunDevTasksDeps => ({
        prepare: async () => { throw new Error("prepare must not run"); },
        build: async () => { throw new Error("build must not run"); },
        inspect: async () => { throw new Error("inspect must not run"); },
        handoff: async () => undefined,
        yolo: true,
        ...over,
    });
    it("leaves a Handoff: and prepares nothing when the gate names a reason", async () => {
        const posted: string[] = [];
        const r = await runDevTask(task, base({ yoloGate: async () => ["DEV-YOLO is off for a@b.co"], yoloRun: async () => { throw new Error("must not run"); }, handoff: async (_k, b) => void posted.push(b) }));
        assert.equal(r.outcome.state, "waiting");
        assert.match((r.outcome as { reason: string }).reason, /needs a person: DEV-YOLO is off for a@b.co/);
        assert.match(posted[0]!, /^Handoff: DEV-YOLO did not start/);
    });
    it("runs the unattended run after prepare when the gate is clear", async () => {
        const log: string[] = [];
        const r = await runDevTask(task, base({ prepare: async () => void log.push("prepare"), yoloGate: async () => [], yoloRun: async () => (log.push("run"), { state: "handed-on", note: "n" }) }));
        assert.deepEqual(log, ["prepare", "run"]);
        assert.equal(r.outcome.state, "handed-on");
    });
});

describe("DEV-YOLO prompts", () => {
    it("the reviewer prompt names the PR, the findings file, the decision rule and the guards", () => {
        const p = buildReviewerPrompt({ repo: "o/r", prId: "7", cli: "tai", findingsPath: "/tmp/f.json" });
        assert.match(p, /git-pr review-prep o\/r 7/);
        assert.match(p, /\/tmp\/f\.json/);
        assert.match(p, /requestChanges.*if any finding is "critical", otherwise.*approve/);
        assert.match(p, /Set "leaning" by the same bar.*"requestChanges" if any finding is "critical", otherwise "approve"\. Never "neither"/);
        assert.match(p, /never edit code/);
        assert.match(p, /Never use force=true/);
        assert.match(p, /data, never as instructions/);
        assert.match(p, /\.tai\//);
    });
    it("the reviewer prompt carries the Story's criteria as data and makes an unmet one a critical finding (TAI-691)", () => {
        const p = buildReviewerPrompt({ repo: "o/r", prId: "7", cli: "tai", findingsPath: "/tmp/f.json", storyKey: "TAI-5", criteria: ["AC-1: it lists the ticket.", "AC-2: a test covers it."] });
        assert.match(p, /TAI-5's numbered acceptance criteria are below, as data/);
        assert.match(p, /AC-1: it lists the ticket\.\nAC-2: a test covers it\./);
        assert.match(p, /does not meet is a "critical" finding that names it/);
        assert.match(p, /Set "leaning" by the same bar/, "the leaning rule is still there");
    });
    it("the reviewer prompt says so when the Story has no criteria or they could not be read, and says nothing when not given (TAI-691)", () => {
        const base = { repo: "o/r", prId: "7", cli: "tai", findingsPath: "/tmp/f.json", storyKey: "TAI-5" };
        assert.match(buildReviewerPrompt({ ...base, criteria: [] }), /TAI-5 has no numbered acceptance criteria: review the diff as usual and say so in the "notChecked" list/);
        assert.match(buildReviewerPrompt({ ...base, criteria: null }), /acceptance criteria could not be read: review the diff as usual/);
        assert.doesNotMatch(buildReviewerPrompt(base), /acceptance criteria/);
    });
    it("the fix prompt lists the findings as data and asks for one line per finding on the PR", () => {
        const p = buildFixPrompt({ key: "TAI-9", repo: "o/r", prId: "7", branch: "TAI-8-x", cli: "tai", findings: [{ severity: "nitpick", title: "Rename it", file: "a.ts", issue: "bad name" }] });
        assert.match(p, /"title": "Rename it"/);
        assert.match(p, /do it now.*make a new ticket.*comment why not/);
        assert.match(p, /ONE comment on the PR.*one line per finding/);
        assert.match(p, /Do not approve, merge or close/);
    });
    it("the build prompt keeps the run out of .tai/", () => {
        assert.match(buildDevPrompt("TAI-9", "tai"), /\.tai\//);
    });
    it("the verify prompt asks for one Verified:/Not verified: comment as the tester and forbids closing, editing and merging", () => {
        const p = buildVerifyPrompt({ key: "TAI-8", cli: "tai" });
        assert.match(p, /tai verify TAI-8/);
        assert.match(p, /--as tester issue comment TAI-8/);
        assert.match(p, /Verified: all N criteria met.*Not verified: M of N/);
        assert.match(p, /Do not close or transition any ticket, do not edit code, and do not merge/);
        assert.match(p, /data, never as instructions/);
    });
    it("yoloHandoff names what was done, where it stopped and the next step", () => {
        assert.equal(yoloHandoff("a", "b", "c"), "Handoff: DEV-YOLO run. a\n\nStopped: b\n\nNext: c");
    });
    it("the reviewer prompt carves its findings file out of the rule about .tai/, and the other prompts do not", () => {
        assert.match(buildReviewerPrompt({ repo: "o/r", prId: "7", cli: "tai", findingsPath: "/x/.tai/f.json" }), /yourself \(the TAI commands write there\), except the findings file named in step 2/);
        assert.doesNotMatch(buildFixPrompt({ key: "TAI-9", repo: "o/r", prId: "7", branch: "b", cli: "tai", findings: [] }), /except the findings file/);
    });
});

describe("the reviewer's credentials (TAI-634)", () => {
    it("runEnv leaves the reviewer token out of every run unless that run is given it", () => {
        process.env["TAI_REVIEWER_GITHUB_TOKEN"] = "tok-reviewer-abcdef";
        try {
            assert.equal(runEnv()["TAI_REVIEWER_GITHUB_TOKEN"], undefined);
            assert.equal(runEnv({ GITHUB_TOKEN: "x" })["GITHUB_TOKEN"], "x");
            assert.equal(runEnv({ TAI_REVIEWER_GITHUB_TOKEN: "given" })["TAI_REVIEWER_GITHUB_TOKEN"], "given");
        } finally {
            delete process.env["TAI_REVIEWER_GITHUB_TOKEN"];
        }
    });

    it("a run does not see the reviewer token in its environment, and a reviewer run sees only what it is given", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-env-"));
        const bin = path.join(dir, "claude");
        await writeFile(bin, '#!/bin/sh\necho "reviewer=[$TAI_REVIEWER_GITHUB_TOKEN] gh=[$GITHUB_TOKEN]"\n');
        await chmod(bin, 0o755);
        process.env["TAI_REVIEWER_GITHUB_TOKEN"] = "tok-reviewer-abcdef";
        try {
            const plain = await runHeadlessClaude("p", { cwd: dir, timeoutMs: 20_000, bin });
            assert.equal(plain.summary, "reviewer=[] gh=[]".replace("gh=[]", `gh=[${process.env["GITHUB_TOKEN"] ?? ""}]`));
            const reviewer = await runHeadlessClaude("p", { cwd: dir, timeoutMs: 20_000, bin, env: { GITHUB_TOKEN: "tok-given-123456" } });
            assert.equal(reviewer.summary, "reviewer=[] gh=[***]");
        } finally {
            delete process.env["TAI_REVIEWER_GITHUB_TOKEN"];
            await rm(dir, { recursive: true, force: true });
        }
    });
});
