/**
 * TAI Framework — which branch is TAI itself running from? (TAI-522 ADR, decision 4)
 *
 * The CLI and the persona docs run from the install directory at whatever branch it has checked
 * out. When that is not the default branch, a session is following instructions that are not the
 * released ones — on a machine where the install is the development checkout, a PR can even be
 * reviewed by its own changes. Nothing is changed for the user; every persona turn says so in one
 * line. Local git only, no network: "behind origin" is deliberately not detected.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TaiInstallState {
    readonly root: string;
    /** The checked-out branch, or `null` when HEAD is detached. */
    readonly branch: string | null;
    /** Short commit hash of HEAD. */
    readonly commit: string;
    /** From the cached `origin/HEAD`; `null` when the clone never recorded it. */
    readonly defaultBranch: string | null;
}

async function tryGit(args: readonly string[], cwd: string): Promise<string | null> {
    try {
        return (await execFileAsync("git", args as string[], { cwd })).stdout.trim();
    } catch {
        return null;
    }
}

/** `null` when `root` is not a git checkout (an install unpacked from an archive, say). */
export async function describeTaiInstall(root: string): Promise<TaiInstallState | null> {
    const commit = await tryGit(["rev-parse", "--short", "HEAD"], root);
    if (!commit) return null;
    const branch = await tryGit(["symbolic-ref", "--short", "-q", "HEAD"], root);
    const originHead = await tryGit(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], root);
    return { root, branch: branch || null, commit, defaultBranch: originHead ? originHead.replace(/^origin\//, "") : null };
}

const USUAL_DEFAULTS: ReadonlySet<string> = new Set(["main", "master"]);

/** True when the install is on its default branch. With no recorded default, `main` and `master` count. */
export function isOnDefaultBranch(state: TaiInstallState): boolean {
    if (state.branch === null) return false;
    return state.defaultBranch ? state.branch === state.defaultBranch : USUAL_DEFAULTS.has(state.branch);
}

/** One line for the top of a persona turn, or `undefined` when there is nothing to say. */
export function renderInstallWarning(state: TaiInstallState | null): string | undefined {
    if (!state || isOnDefaultBranch(state)) return undefined;
    const where = state.branch ? `branch \`${state.branch}\`` : "a detached HEAD";
    const expected = state.defaultBranch ? ` its default branch \`${state.defaultBranch}\`` : " its default branch";
    return (
        `⚠️ TAI itself is running from ${where} (commit ${state.commit}) of \`${state.root}\`, not${expected}. ` +
        "The persona instructions and CLI behavior in this output come from that branch. Tell the human before relying on them."
    );
}
