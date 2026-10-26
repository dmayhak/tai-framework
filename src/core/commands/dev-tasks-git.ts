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
    constructor(readonly porcelain: string) {
        super(`The working tree has uncommitted changes, so a new run cannot start on a clean branch:\n${porcelain}`);
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

/** Throws unless the tree is clean; then checks out the default branch and brings it up to date. */
export async function prepareCleanDefaultBranch(cwd: string, taiRoot: string): Promise<void> {
    const { porcelain } = await readWorkingTree(cwd, taiRoot);
    if (porcelain.trim() !== "") {
        throw new DirtyTreeError(porcelain);
    }
    const branch = await defaultBranch(cwd);
    try {
        await execFileAsync("git", ["checkout", branch], { cwd });
        await execFileAsync("git", ["pull", "--ff-only"], { cwd });
    } catch (err) {
        const detail = (err as { stderr?: string }).stderr?.trim() || (err instanceof Error ? err.message : String(err));
        throw new PrepareStopError(`Could not bring ${branch} up to date, so no run can start: ${detail}`);
    }
}
