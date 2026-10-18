import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { toCommitSha, toRepoId, type CommitStatus, type CreateCommitStatusInput } from "./interface.js";
import {
    CHECK_STATUS_KEY,
    checkCommandFromEnv,
    checkEnvironment,
    checkPrecondition,
    checkStatusInput,
    mergeBlockersWithCheck,
    missingCheckBlocker,
    performLocalCheck,
    readWorkingTree,
    renderLocalCheckOutcome,
    type CheckRun,
    type LocalCheckDeps,
    renderCheckResult,
    runCheckCommand,
} from "./local-check.js";

const HEAD = "abc123def4567890abc123def4567890abc123de";

describe("a recorded local check (TAI-534)", () => {
    it("reads the check command from TAI_CHECK_COMMAND, and has none when it is unset or blank", () => {
        assert.equal(checkCommandFromEnv({ TAI_CHECK_COMMAND: "  npm test  " }), "npm test");
        assert.equal(checkCommandFromEnv({ TAI_CHECK_COMMAND: "   " }), null);
        assert.equal(checkCommandFromEnv({}), null);
    });

    it("runs only when the working tree is at the PR's head, at either hash length", () => {
        assert.equal(checkPrecondition({ headSha: HEAD, prCommit: "abc123def456", prBranch: "TAI-1-x", porcelain: "" }), null);
        const wrong = checkPrecondition({ headSha: HEAD, prCommit: "ffff00001111", prBranch: "TAI-1-x", porcelain: "" })!;
        assert.match(wrong, /^Not run: this working tree is at abc123def456, and the PR's head is ffff00001111\./);
        assert.match(wrong, /Check out TAI-1-x at its latest commit/);
    });

    it("runs only from a clean working tree", () => {
        const dirty = checkPrecondition({ headSha: HEAD, prCommit: "abc123def456", prBranch: "TAI-1-x", porcelain: " M src/a.ts\n?? notes.txt\n" })!;
        assert.match(dirty, /^Not run: the working tree has 2 uncommitted changes/);
        assert.match(checkPrecondition({ headSha: HEAD, prCommit: "abc123def456", prBranch: "TAI-1-x", porcelain: " M src/a.ts" })!, /1 uncommitted change,/);
    });

    it("runs the command through the shell and reports a pass", async () => {
        const run = await runCheckCommand("echo one && echo two", process.cwd());
        assert.equal(run.passed, true);
        assert.equal(run.exitCode, 0);
        assert.match(run.outputTail, /one\ntwo/);
    });

    it("reports a failure with its exit code and the end of its output, stderr included", async () => {
        const run = await runCheckCommand("echo before; echo broken 1>&2; exit 3", process.cwd());
        assert.equal(run.passed, false);
        assert.equal(run.exitCode, 3);
        assert.match(run.outputTail, /before/);
        assert.match(run.outputTail, /broken/);
    });

    it("the recorded status names who ran it and where, the command, and the outcome", () => {
        const passed = checkStatusInput({ command: "npm test", passed: true, exitCode: 0, seconds: 31, outputTail: "" }, "Del", "workstation", "https://example.test/pr/7");
        assert.deepEqual(passed, {
            key: CHECK_STATUS_KEY,
            name: "TAI check, run locally by Del on workstation",
            state: "successful",
            url: "https://example.test/pr/7",
            description: "passed in 31s: npm test",
        });
        const failed = checkStatusInput({ command: "npm test", passed: false, exitCode: 1, seconds: 4, outputTail: "x" }, "Del", "workstation", "https://example.test/pr/7");
        assert.equal(failed.state, "failed");
        assert.equal(failed.description, "FAILED (exit 1) after 4s: npm test");
    });

    it("keeps a long command inside the description limit", () => {
        const long = checkStatusInput({ command: "x".repeat(600), passed: true, exitCode: 0, seconds: 1, outputTail: "" }, "Del", "host", "https://example.test");
        assert.ok(long.description!.length <= 240);
        assert.ok(long.description!.endsWith("…"));
    });

    it("prints the output's end only for a failure, and says the result is for one commit", () => {
        const ok = renderCheckResult({ command: "npm test", passed: true, exitCode: 0, seconds: 31, outputTail: "all good" }, "abc123def456", "7");
        assert.match(ok, /^# Check passed for PR 7/);
        assert.match(ok, /It counts for this commit only: run it again after any push/);
        assert.doesNotMatch(ok, /all good/);
        const bad = renderCheckResult({ command: "npm test", passed: false, exitCode: 2, seconds: 3, outputTail: "1 failing" }, "abc123def456", "7");
        assert.match(bad, /^# Check FAILED for PR 7/);
        assert.match(bad, /failed \(exit 2\) in 3s/);
        assert.match(bad, /1 failing/);
    });
});

describe("the merge gate's missing-check blocker (TAI-534)", () => {
    const passed: CommitStatus = { key: CHECK_STATUS_KEY, name: "TAI check", state: "successful" };

    it("blocks when the project has a check command and the commit has no status at all", () => {
        const blocker = missingCheckBlocker("npm test", [], "abc123def456")!;
        assert.match(blocker, /^No check result is recorded for the current commit \(abc123def456\)\. Run `git-pr check <REPO> \[PR-ID\]`/);
    });

    it("does not block once any status exists: a failed one is the CI rule's, which cannot be overridden", () => {
        assert.equal(missingCheckBlocker("npm test", [passed], "abc123def456"), null);
        assert.equal(missingCheckBlocker("npm test", [{ ...passed, state: "failed" }], "abc123def456"), null);
    });

    it("never blocks a project that has configured no check command", () => {
        assert.equal(missingCheckBlocker(null, [], "abc123def456"), null);
    });
});

describe("readWorkingTree (TAI-534)", () => {
    it("reports HEAD and uncommitted changes, leaving out the project's own .tai directory", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-local-check-"));
        try {
            const git = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
            git("init", "-q", "-b", "master");
            git("config", "user.email", "t@example.com");
            git("config", "user.name", "T");
            await writeFile(path.join(dir, "a.txt"), "a");
            git("add", ".");
            git("commit", "-q", "-m", "one");

            await mkdir(path.join(dir, ".tai"));
            await writeFile(path.join(dir, ".tai", "state.json"), "{}");
            const clean = await readWorkingTree(dir, ".tai");
            assert.equal(clean.headSha, git("rev-parse", "HEAD").trim());
            assert.equal(clean.porcelain.trim(), "");

            await writeFile(path.join(dir, "a.txt"), "changed");
            assert.match((await readWorkingTree(dir, ".tai")).porcelain, /a\.txt/);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("the check command's environment (TAI-534)", () => {
    it("drops TAI's own settings and keeps everything else", () => {
        const env = checkEnvironment({ PATH: "/bin", HOME: "/h", TAI_JIRA_API_TOKEN: "t", TAI_TEST_JIRA_SITE_URL: "u", BITBUCKET_API_TOKEN: "b", GITHUB_TOKEN: "g", GH_TOKEN: "g", GITHUB_ACTIONS: "true", TAILSCALE: "x", MY_BITBUCKET_X: "y" });
        assert.deepEqual(env, { PATH: "/bin", HOME: "/h", GITHUB_ACTIONS: "true", TAILSCALE: "x", MY_BITBUCKET_X: "y" });
    });

    it("the command really runs without them", async () => {
        const run = await runCheckCommand('test -z "$TAI_JIRA_API_TOKEN$BITBUCKET_API_TOKEN" && test -n "$PATH"', process.cwd(), checkEnvironment({ ...process.env, TAI_JIRA_API_TOKEN: "secret", BITBUCKET_API_TOKEN: "secret" }));
        assert.equal(run.passed, true);
    });
});

describe("performLocalCheck: the whole check, in order (TAI-534)", () => {
    const PASS: CheckRun = { command: "npm test", passed: true, exitCode: 0, seconds: 3, outputTail: "" };
    const FAIL: CheckRun = { command: "npm test", passed: false, exitCode: 1, seconds: 3, outputTail: "1 failing" };
    const CLEAN = { headSha: HEAD, porcelain: "" };

    function harness(over: { trees?: { headSha: string; porcelain: string }[]; run?: CheckRun; userFails?: boolean; postFails?: boolean } = {}) {
        const events: string[] = [];
        const posted: { commit: string; input: CreateCommitStatusInput }[] = [];
        const trees = [...(over.trees ?? [CLEAN, CLEAN])];
        const deps: LocalCheckDeps = {
            gitHost: {
                getCurrentUser: async () => {
                    events.push("user");
                    if (over.userFails) throw new Error("401");
                    return { id: "a1", displayName: "Del" } as Awaited<ReturnType<LocalCheckDeps["gitHost"]["getCurrentUser"]>>;
                },
                createCommitStatus: async (_repo, commit, input) => {
                    events.push("post");
                    if (over.postFails) throw new Error("503 from the host");
                    posted.push({ commit, input });
                    return { key: input.key, name: input.name, state: input.state, url: input.url } as CommitStatus;
                },
            },
            repo: toRepoId("ws/repo"),
            pullRequest: { sourceCommit: toCommitSha(HEAD.slice(0, 12)), sourceBranch: "feature", url: "https://example/pr/1" },
            command: "npm test",
            readTree: async () => {
                events.push("tree");
                return trees.shift() ?? CLEAN;
            },
            run: async () => {
                events.push("run");
                return over.run ?? PASS;
            },
            machine: "box",
        };
        return { deps, events, posted };
    }

    it("looks up the user, checks the tree, runs, checks the tree again, then records on the full hash", async () => {
        const h = harness();
        const outcome = await performLocalCheck(h.deps);
        assert.deepEqual(h.events, ["user", "tree", "run", "tree", "post"]);
        assert.equal(outcome.kind, "recorded");
        assert.equal(h.posted[0]?.commit, HEAD);
        assert.equal(h.posted[0]?.input.state, "successful");
        assert.match(renderLocalCheckOutcome(outcome, "7"), /Recorded on the commit as a status/);
    });

    it("a credentials problem stops it before the command runs", async () => {
        const h = harness({ userFails: true });
        await assert.rejects(performLocalCheck(h.deps), /401/);
        assert.deepEqual(h.events, ["user"]);
    });

    it("a dirty tree or the wrong commit refuses and runs nothing", async () => {
        const dirty = harness({ trees: [{ headSha: HEAD, porcelain: " M src/a.ts" }] });
        assert.equal((await performLocalCheck(dirty.deps)).kind, "refused");
        assert.deepEqual(dirty.events, ["user", "tree"]);

        const elsewhere = harness({ trees: [{ headSha: "f".repeat(40), porcelain: "" }] });
        assert.equal((await performLocalCheck(elsewhere.deps)).kind, "refused");
        assert.deepEqual(elsewhere.events, ["user", "tree"]);
    });

    it("records nothing when the command changed tracked files", async () => {
        const h = harness({ trees: [CLEAN, { headSha: HEAD, porcelain: " M src/a.ts" }] });
        const outcome = await performLocalCheck(h.deps);
        assert.equal(outcome.kind, "notRecorded");
        assert.equal(h.posted.length, 0);
        const text = renderLocalCheckOutcome(outcome, "7");
        assert.match(text, /NOT recorded/);
        assert.match(text, /working tree changed while the check ran/);
        assert.doesNotMatch(text, /Recorded on the commit as a status/);
    });

    it("records nothing when HEAD moved while the command ran", async () => {
        const h = harness({ trees: [CLEAN, { headSha: "e".repeat(40), porcelain: "" }] });
        const outcome = await performLocalCheck(h.deps);
        assert.equal(outcome.kind, "notRecorded");
        assert.equal(h.posted.length, 0);
        assert.match(renderLocalCheckOutcome(outcome, "7"), /HEAD moved from abc123def456 to eeeeeeeeeeee/);
    });

    it("a failing run is recorded as failed", async () => {
        const h = harness({ run: FAIL });
        const outcome = await performLocalCheck(h.deps);
        assert.equal(outcome.kind, "recorded");
        assert.equal(h.posted[0]?.input.state, "failed");
    });

    it("a failing run whose result cannot be posted still shows its output", async () => {
        const h = harness({ run: FAIL, postFails: true });
        const outcome = await performLocalCheck(h.deps);
        assert.equal(outcome.kind, "notRecorded");
        const text = renderLocalCheckOutcome(outcome, "7");
        assert.match(text, /FAILED/);
        assert.match(text, /503 from the host/);
        assert.match(text, /1 failing/);
    });
});

describe("git-pr merge: the gate's blockers with a missing check (TAI-534)", () => {
    const base = { gateBlockers: [] as string[], checkCommand: "npm test", statuses: [] as CommitStatus[], commit: "abc123def456", force: false };
    const ok = { key: CHECK_STATUS_KEY, name: "TAI check", state: "successful", url: "u" } as CommitStatus;

    it("a missing check result refuses the merge; force passes it and keeps it in the list for the override comment", () => {
        const refused = mergeBlockersWithCheck(base);
        assert.equal(refused.proceed, false);
        assert.match(refused.blockers[0] ?? "", /No check result is recorded/);

        const forced = mergeBlockersWithCheck({ ...base, force: true });
        assert.equal(forced.proceed, true);
        assert.equal(forced.blockers.length, 1);
    });

    it("comes after the gate's own blockers", () => {
        const both = mergeBlockersWithCheck({ ...base, gateBlockers: ["No approval."] });
        assert.deepEqual([both.blockers[0], both.blockers.length], ["No approval.", 2]);
    });

    it("nothing blocks with a result recorded, or with no check command", () => {
        assert.deepEqual(mergeBlockersWithCheck({ ...base, statuses: [ok] }), { blockers: [], proceed: true });
        assert.deepEqual(mergeBlockersWithCheck({ ...base, checkCommand: null }), { blockers: [], proceed: true });
    });
});
