import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommitStatus } from "./interface.js";
import {
    CHECK_STATUS_KEY,
    checkCommandFromEnv,
    checkPrecondition,
    checkStatusInput,
    missingCheckBlocker,
    readWorkingTree,
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
