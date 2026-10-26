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
        throw new Error(`The working tree has uncommitted changes, so a new run cannot start on a clean branch:\n${porcelain}`);
    }
    const branch = await defaultBranch(cwd);
    await execFileAsync("git", ["checkout", branch], { cwd });
    await execFileAsync("git", ["pull", "--ff-only"], { cwd });
}
