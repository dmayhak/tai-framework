/**
 * TAI Framework — the working-tree guard for "Do all dev tasks" (TAI-633).
 *
 * Each ticket's run starts from a clean tree on the default branch, so one ticket's leftovers can never end up in the
 * next one's commit.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readWorkingTree } from "../git/local-check.js";

const execFileAsync = promisify(execFile);

/** Preparing the branch failed for a reason that is not the ticket's: the run stops instead of failing each ticket in turn. */
export class PrepareStopError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PrepareStopError";
    }
}

/** The working tree has uncommitted changes. Not a fault of the ticket about to start, so it is not reported against it. */
export class DirtyTreeError extends PrepareStopError {
    constructor(readonly porcelain: string, because = "") {
        super(`${because}The working tree has uncommitted changes, so a new run cannot start on a clean branch:\n${porcelain}`);
        this.name = "DirtyTreeError";
    }
}

/** The default branch name from `origin/HEAD`, or `main` when the clone does not record one. */
async function defaultBranch(cwd: string): Promise<string> {
    try {
        const ref = (await execFileAsync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd })).stdout.trim();
        return ref.replace(/^origin\//, "") || "main";
    } catch {
        return "main";
    }
}

/** Throws a `DirtyTreeError` unless the working tree is clean. */
export async function assertCleanTree(cwd: string, taiRoot: string): Promise<void> {
    const { porcelain } = await readWorkingTree(cwd, taiRoot);
    if (porcelain.trim() !== "") {
        throw new DirtyTreeError(porcelain);
    }
}

/**
 * TAI-706: the branch a ticket whose run was cut off mid-build continues on, or null. It is the checked-out branch when that is the
 * ticket's Story branch (`<STORY>-slug`, brief §6), whether the run left uncommitted work or only local commits: either way the next
 * build carries on from there, not from the default branch.
 */
export async function cutOffBranch(cwd: string, storyKey: string): Promise<string | null> {
    let branch: string;
    try {
        branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
    } catch {
        return null;
    }
    return branch !== "HEAD" && (branch === storyKey || branch.startsWith(`${storyKey}-`)) ? branch : null;
}

/** The branch a build continues on: the cut-off Story branch when the ticket was paused on a limit, else null (a fresh build). Both build paths use this one rule. */
export async function resumeBranchFor(cwd: string, storyKey: string, pausedOnLimit: boolean): Promise<string | null> {
    return pausedOnLimit ? cutOffBranch(cwd, storyKey) : null;
}

/** Where the checkout stands, "<branch>@<short commit>", or undefined when git cannot say. Recorded in a pause note, compared by the next run. */
export async function checkoutPosition(cwd: string): Promise<string | undefined> {
    try {
        const branch = (await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
        const head = (await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd })).stdout.trim();
        return branch && head ? `${branch}@${head}` : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Starts a ticket: continues on its own branch when THIS ticket was paused on a usage limit (`pausedOnLimit`, read from its own
 * hand-off) and that branch is checked out, otherwise from a clean default branch. A dirty tree that no pause explains, such as a
 * sibling ticket's failed run on the Story's branch, still stops the run.
 */
export async function prepareForTicket(cwd: string, taiRoot: string, storyKey: string, pausedOnLimit: boolean): Promise<void> {
    if (pausedOnLimit && (await cutOffBranch(cwd, storyKey)) !== null) return;
    try {
        await prepareCleanDefaultBranch(cwd, taiRoot);
    } catch (err) {
        // The ticket's note says its run continues, but the cut-off came before its branch existed, so the uncommitted work is on another branch: say so.
        if (pausedOnLimit && err instanceof DirtyTreeError) {
            throw new DirtyTreeError(err.porcelain, `This ticket was paused on a usage limit, but its Story branch (${storyKey}-...) is not checked out, so its cut-off work cannot be continued from here: commit, stash or discard what is in the tree, then run it again. `);
        }
        throw err;
    }
}

/** Throws unless the tree is clean; then checks out the default branch and brings it up to date. */
export async function prepareCleanDefaultBranch(cwd: string, taiRoot: string): Promise<void> {
    await assertCleanTree(cwd, taiRoot);
    const branch = await defaultBranch(cwd);
    try {
        await execFileAsync("git", ["checkout", branch], { cwd });
        await execFileAsync("git", ["pull", "--ff-only"], { cwd });
    } catch (err) {
        const detail = (err as { stderr?: string }).stderr?.trim() || (err instanceof Error ? err.message : String(err));
        throw new PrepareStopError(`Could not bring ${branch} up to date, so no run can start: ${detail}`);
    }
}
