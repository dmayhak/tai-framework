/**
 * TAI Framework — a recorded local check (TAI-534 ADR, Confluence page 55672833)
 *
 * A project with no CI on pull requests has nothing running its test suite before a merge. This
 * runs the project's own check command on the PR's head commit and records the result on that
 * commit as a git-host commit status, where `review-prep` and the merge gate can see it.
 *
 * The result is of the code under review or it is not recorded: the working tree must be clean and
 * at exactly the PR's head. It is self-attested — the status names who ran it and where — and
 * cannot prove the run was honest; it puts the claim on the record for one commit. A new push is a
 * new commit with no result.
 *
 * When a project configures a check command, the merge gate requires a status on the PR's current
 * commit. A failed one can never be forced past (the CI rule); a missing one can, with the stamped
 * override. A project that configures nothing behaves as before.
 */

import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { CommitSha, CommitStatus, CreateCommitStatusInput, GitHost, PullRequestRef, RepoId } from "./interface.js";
import { sameCommitHash } from "./review-findings.js";

const execFileAsync = promisify(execFile);

/** The machine a check ran on, for the status's name. */
export function machineName(): string {
    return os.hostname();
}

/** HEAD's full hash and `git status --porcelain` for `cwd`, without the project's own `.tai` entries (TAI writes there). */
export async function readWorkingTree(cwd: string, taiRoot: string): Promise<{ readonly headSha: string; readonly porcelain: string }> {
    const headSha = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
    const taiRootRel = path.relative(cwd, path.resolve(cwd, taiRoot)).split(path.sep).join("/");
    const porcelain = (await execFileAsync("git", ["status", "--porcelain"], { cwd })).stdout
        .split("\n")
        .filter((line) => !(taiRootRel && (line.slice(3) === taiRootRel || line.slice(3).startsWith(`${taiRootRel}/`))))
        .join("\n");
    return { headSha, porcelain };
}

/** One key, so a re-run for the same commit replaces the earlier result instead of adding another. */
export const CHECK_STATUS_KEY = "tai-check";
/** How much of a failed run's output is printed back. */
export const CHECK_OUTPUT_TAIL = 4_000;
const DESCRIPTION_MAX = 240;

type Env = Readonly<Record<string, string | undefined>>;

/** `TAI_CHECK_COMMAND` from the project's `.env`: the command that verifies a commit, or `null` when none is configured. */
export function checkCommandFromEnv(env: Env = process.env): string | null {
    const command = env["TAI_CHECK_COMMAND"]?.trim();
    return command ? command : null;
}

/**
 * Why the check may not run here, or `null`. `porcelain` is `git status --porcelain` with the
 * project's own `.tai` entries already removed.
 */
export function checkPrecondition(input: { readonly headSha: string; readonly prCommit: string; readonly prBranch: string; readonly porcelain: string }): string | null {
    if (!sameCommitHash(input.headSha, input.prCommit)) {
        return (
            `Not run: this working tree is at ${input.headSha.slice(0, 12)}, and the PR's head is ${input.prCommit}. ` +
            `A check counts only for the code under review. Check out ${input.prBranch} at its latest commit and run it again.`
        );
    }
    const dirty = input.porcelain.split("\n").filter((l) => l.trim() !== "");
    if (dirty.length > 0) {
        return (
            `Not run: the working tree has ${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"}, so a check here would not be of the PR's commit. ` +
            "Commit, stash or discard them and run it again."
        );
    }
    return null;
}

export interface CheckRun {
    readonly command: string;
    readonly passed: boolean;
    readonly exitCode: number | null;
    readonly seconds: number;
    /** The end of the combined stdout and stderr. */
    readonly outputTail: string;
}

/** Variables TAI itself is configured with. They hold its credentials and point its own tests at live systems. */
const TAI_OWN_ENV = /^(TAI_|BITBUCKET_)/;

/**
 * The environment the check command runs in: the session's, without TAI's own settings. The command
 * runs the PR's code, which has no business reading the Jira and Bitbucket tokens TAI was started
 * with, and a project's test suite must not be switched to live systems by variables that happen to
 * be in TAI's `.env`.
 */
export function checkEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return Object.fromEntries(Object.entries(env).filter(([name]) => !TAI_OWN_ENV.test(name)));
}

/** Runs `command` through the shell in `cwd` and reports how it ended. `env` defaults to `checkEnvironment()`. */
export function runCheckCommand(command: string, cwd: string, env: NodeJS.ProcessEnv = checkEnvironment()): Promise<CheckRun> {
    return new Promise((resolve) => {
        const started = Date.now();
        let tail = "";
        const child = spawn(command, { cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
        const keep = (chunk: Buffer): void => {
            tail = (tail + chunk.toString("utf8")).slice(-CHECK_OUTPUT_TAIL);
        };
        child.stdout.on("data", keep);
        child.stderr.on("data", keep);
        const finish = (exitCode: number | null): void => resolve({ command, passed: exitCode === 0, exitCode, seconds: Math.round((Date.now() - started) / 1000), outputTail: tail.trimEnd() });
        child.on("error", (err) => {
            tail = `${tail}\n${err.message}`.slice(-CHECK_OUTPUT_TAIL);
            finish(null);
        });
        child.on("close", (code) => finish(code));
    });
}

/** The commit status that records `run`: who ran it, where, the command and how it ended. */
export function checkStatusInput(run: CheckRun, who: string, machine: string, url: string): CreateCommitStatusInput {
    const outcome = run.passed ? `passed in ${run.seconds}s` : `FAILED (exit ${run.exitCode ?? "none"}) after ${run.seconds}s`;
    const description = `${outcome}: ${run.command}`;
    return {
        key: CHECK_STATUS_KEY,
        name: `TAI check, run locally by ${who} on ${machine}`,
        state: run.passed ? "successful" : "failed",
        url,
        description: description.length > DESCRIPTION_MAX ? `${description.slice(0, DESCRIPTION_MAX - 1)}…` : description,
    };
}

/** What `git-pr check` prints after recording a result. */
export function renderCheckResult(run: CheckRun, commit: string, prId: string, notRecorded?: string): string {
    const head = `# Check ${run.passed ? "passed" : "FAILED"} for PR ${prId}${notRecorded === undefined ? "" : " -- NOT recorded"}`;
    const recording = notRecorded === undefined ? "Recorded on the commit as a status. It counts for this commit only: run it again after any push." : `**Nothing was recorded on the commit.** ${notRecorded}`;
    const lines = [head, "", `- Commit: ${commit}`, `- Command: \`${run.command}\``, `- Result: ${run.passed ? "passed" : `failed (exit ${run.exitCode ?? "none"})`} in ${run.seconds}s`, "", recording];
    if (!run.passed && run.outputTail !== "") lines.push("", "End of the output:", "", "```", run.outputTail, "```");
    return lines.join("\n");
}

/**
 * The merge-gate blocker for a missing check result, or `null`. Only when the project has a check
 * command and the commit has no status at all: a status that exists and is not successful is the
 * CI rule's business, and that one cannot be overridden.
 */
export function missingCheckBlocker(checkCommand: string | null, statuses: readonly CommitStatus[], commit: string): string | null {
    if (!checkCommand || statuses.length > 0) return null;
    return `No check result is recorded for the current commit (${commit}). Run \`git-pr check <REPO> [PR-ID]\` from a clean checkout of the PR's branch.`;
}

/**
 * What `git-pr merge` does with the gate's blockers and the commit's statuses: the full blocker list
 * (the gate's, then a missing check result) and whether the merge goes ahead. `force` passes any of
 * them; a status that exists and is not successful never reaches here.
 */
export function mergeBlockersWithCheck(input: { readonly gateBlockers: readonly string[]; readonly checkCommand: string | null; readonly statuses: readonly CommitStatus[]; readonly commit: string; readonly force: boolean }): { readonly blockers: readonly string[]; readonly proceed: boolean } {
    const missing = missingCheckBlocker(input.checkCommand, input.statuses, input.commit);
    const blockers = [...input.gateBlockers, ...(missing ? [missing] : [])];
    return { blockers, proceed: blockers.length === 0 || input.force };
}

// ---------- the whole check, in order (testable without a git host or a shell) ----------

export interface LocalCheckDeps {
    readonly gitHost: Pick<GitHost, "getCurrentUser" | "createCommitStatus">;
    readonly repo: RepoId;
    readonly pullRequest: Pick<PullRequestRef, "sourceCommit" | "sourceBranch" | "url">;
    readonly command: string;
    readonly readTree: () => Promise<{ readonly headSha: string; readonly porcelain: string }>;
    readonly run: (command: string) => Promise<CheckRun>;
    readonly machine: string;
}

export type LocalCheckOutcome =
    /** The preconditions were not met; nothing ran. */
    | { readonly kind: "refused"; readonly reason: string }
    /** The command ran and its result is on the commit. */
    | { readonly kind: "recorded"; readonly run: CheckRun; readonly commit: string }
    /** The command ran, but its result was not recorded; `reason` says why. */
    | { readonly kind: "notRecorded"; readonly run: CheckRun; readonly commit: string; readonly reason: string };

/**
 * Runs the check and records it, in the order that keeps the record honest:
 *  1. who is running it (before the command, so a credentials problem costs nothing);
 *  2. the tree is clean and at the PR's head;
 *  3. the command;
 *  4. the tree again — a command that rewrites tracked files (a lint fix, a formatter, codegen), or an
 *     edit made while it ran, means the result is not of the commit, and nothing is recorded;
 *  5. the status, on the full hash that was checked. A failure to post it does not lose the result.
 */
export async function performLocalCheck(deps: LocalCheckDeps): Promise<LocalCheckOutcome> {
    const me = await deps.gitHost.getCurrentUser();
    const before = await deps.readTree();
    const refusal = checkPrecondition({ headSha: before.headSha, prCommit: deps.pullRequest.sourceCommit, prBranch: deps.pullRequest.sourceBranch, porcelain: before.porcelain });
    if (refusal) return { kind: "refused", reason: refusal };

    const run = await deps.run(deps.command);
    const commit = before.headSha;

    const after = await deps.readTree();
    if (after.headSha !== before.headSha) {
        return { kind: "notRecorded", run, commit, reason: `HEAD moved from ${before.headSha.slice(0, 12)} to ${after.headSha.slice(0, 12)} while the check ran, so the result is not of one commit.` };
    }
    if (after.porcelain.split("\n").some((l) => l.trim() !== "")) {
        return { kind: "notRecorded", run, commit, reason: "The working tree changed while the check ran (the command rewrote tracked files, or something was edited), so the result is not of the commit." };
    }
    try {
        await deps.gitHost.createCommitStatus(deps.repo, commit as CommitSha, checkStatusInput(run, me.displayName, deps.machine, deps.pullRequest.url));
    } catch (err) {
        return { kind: "notRecorded", run, commit, reason: `The result could not be posted to the git host: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { kind: "recorded", run, commit };
}

/** What `git-pr check` prints for any outcome. A run that happened is always shown, recorded or not. */
export function renderLocalCheckOutcome(outcome: LocalCheckOutcome, prId: string): string {
    if (outcome.kind === "refused") return outcome.reason;
    return renderCheckResult(outcome.run, outcome.commit.slice(0, 12), prId, outcome.kind === "notRecorded" ? outcome.reason : undefined);
}
