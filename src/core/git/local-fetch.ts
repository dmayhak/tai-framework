/**
 * TAI Framework — local default-branch freshness (TAI-282, ADR: Confluence TA space,
 * page 32899073)
 *
 * Keeps the CURRENT repo's (`process.cwd()`'s) local default branch fast-forwarded
 * against `origin` at the two "starting/resuming work" entry points (`cli.ts`'s
 * `work`/`ready` subcommands), debounced via `.tai/last-fetch.json` (brief §7's
 * cache-checkpoint pattern, reused here for git state instead of Jira/Confluence sync).
 *
 * Deliberately resolves the default branch via git's own `origin/HEAD` symref /
 * `ls-remote --symref` rather than `GitHost.getRepository(...).defaultBranch` — a
 * deviation from the ADR's suggested shape, noted in TAI-288's Implementation Notes.
 * This keeps the mechanism fully local-git-only, with no dependency on Bitbucket
 * credentials or `TAI_GIT_REPOS` being configured at all, which is truer to the ADR's
 * own "never a hard requirement" posture (decision 1) than routing through `GitHost`
 * would have been.
 *
 * Never merges, rebases, or force-updates — only a clean fast-forward, or fetch-and-warn
 * (ADR decision 5, mirroring brief §7's "fetch first, warn on conflict, never silently
 * overwrite"). Failures are always non-fatal to the caller (ADR decision 6) — every
 * outcome is a returned value, never a thrown error.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "../cache/paths.js";
import { runRemoteGit } from "./remote-git.js";

const execFileAsync = promisify(execFile);

const DEFAULT_DEBOUNCE_MS = 10 * 60 * 1000;

export type LocalFetchOutcome =
    | { readonly kind: "skipped-debounce" }
    | { readonly kind: "not-a-repo" }
    | { readonly kind: "no-remote" }
    | { readonly kind: "fetch-failed"; readonly message: string }
    | { readonly kind: "fast-forwarded"; readonly branch: string; readonly from: string; readonly to: string }
    | { readonly kind: "up-to-date"; readonly branch: string }
    | { readonly kind: "diverged"; readonly branch: string; readonly reason: string };

interface LastFetchCheckpoint {
    readonly fetchedAt: string;
}

export function lastFetchPath(taiRoot: string): string {
    return path.join(taiRoot, "last-fetch.json");
}

async function git(args: readonly string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync("git", args as string[], { cwd });
    return stdout.trim();
}

/** Runs a git command, collapsing any failure (not a repo, no such ref, command exits
 *  non-zero, …) to `null` rather than throwing — most of this module's checks are
 *  "does this succeed at all," not "what does a failure say." */
async function tryGit(args: readonly string[], cwd: string): Promise<string | null> {
    try {
        return await git(args, cwd);
    } catch {
        return null;
    }
}

/** `tryGit` for a command that reaches the remote: same collapse-to-null, but through `runRemoteGit` so an
 *  unrunnable (empty) `core.sshCommand` gets its one retry (TAI-431/433). */
async function tryRemoteGit(args: readonly string[], cwd: string): Promise<string | null> {
    try {
        return (await runRemoteGit(args, cwd)).trim();
    } catch {
        return null;
    }
}

/** Local-only default-branch resolution — no Bitbucket/GitHost dependency. Tries the
 *  cached `origin/HEAD` symref first (fast, no network); falls back to `ls-remote`
 *  (one network round-trip) when that symref was never set, which is common on a clone
 *  that didn't fetch with `--tags`/full remote setup, or when it names a branch that has no
 *  remote-tracking ref (a clone whose `origin` was repointed at another repo: TAI-594).
 *  Not covered: a default branch renamed upstream whose old `origin/<branch>` ref still exists,
 *  since a plain `git fetch` does not prune it and the symref then looks valid. */
async function resolveDefaultBranch(cwd: string): Promise<string | null> {
    const symref = await tryGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
    if (symref && (await tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/${symref}`], cwd))) {
        return symref.replace(/^origin\//, "");
    }

    const lsRemote = await tryRemoteGit(["ls-remote", "--symref", "origin", "HEAD"], cwd);
    if (!lsRemote) return null;
    const match = lsRemote.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    return match?.[1] ?? null;
}

/**
 * Fetches `origin` for the repo at `cwd` and fast-forwards its local default branch when
 * safe (ADR decision 5). Debounced via `.tai/last-fetch.json` under `taiRoot` (ADR
 * decision 3) — skips entirely, no git calls at all, if the last successful attempt was
 * within `debounceMs` (default 10 minutes) of `now`.
 */
export async function refreshLocalDefaultBranch(
    cwd: string,
    taiRoot: string,
    now: Date = new Date(),
    debounceMs: number = DEFAULT_DEBOUNCE_MS
): Promise<LocalFetchOutcome> {
    const checkpointPath = lastFetchPath(taiRoot);
    const checkpoint = await readJsonFile<LastFetchCheckpoint>(checkpointPath);
    if (checkpoint) {
        const elapsed = now.getTime() - new Date(checkpoint.fetchedAt).getTime();
        if (elapsed >= 0 && elapsed < debounceMs) {
            return { kind: "skipped-debounce" };
        }
    }

    const insideRepo = await tryGit(["rev-parse", "--is-inside-work-tree"], cwd);
    if (insideRepo !== "true") return { kind: "not-a-repo" };

    const hasOrigin = await tryGit(["remote", "get-url", "origin"], cwd);
    if (!hasOrigin) return { kind: "no-remote" };

    try {
        await runRemoteGit(["fetch", "origin"], cwd);
    } catch (err) {
        return { kind: "fetch-failed", message: (err as Error).message };
    }

    // Checkpoint as soon as a fetch actually happens, regardless of what the
    // fast-forward logic below concludes — the debounce tracks "did we ask origin for
    // news," not "did that news turn into a branch update."
    await writeJsonFile(checkpointPath, { fetchedAt: now.toISOString() } satisfies LastFetchCheckpoint);

    const defaultBranch = await resolveDefaultBranch(cwd);
    if (!defaultBranch) return { kind: "fetch-failed", message: "could not resolve origin's default branch" };

    const remoteRef = `origin/${defaultBranch}`;
    const remoteSha = await tryGit(["rev-parse", remoteRef], cwd);
    if (!remoteSha) return { kind: "fetch-failed", message: `${remoteRef} not found after fetch` };

    const localSha = await tryGit(["rev-parse", defaultBranch], cwd);
    if (!localSha) {
        // No local branch by this name yet — nothing to fast-forward, nothing stale either.
        return { kind: "up-to-date", branch: defaultBranch };
    }
    if (localSha === remoteSha) return { kind: "up-to-date", branch: defaultBranch };

    // `merge-base --is-ancestor <local> <remote>` exits 0 (no output) iff local's tip is
    // an ancestor of (or equal to) remote's — i.e. a real, non-divergent fast-forward.
    const isAncestor = await tryGit(["merge-base", "--is-ancestor", defaultBranch, remoteRef], cwd);
    const canFastForward = isAncestor !== null;
    if (!canFastForward) {
        return {
            kind: "diverged",
            branch: defaultBranch,
            reason: "local commits ahead of origin, or true divergence",
        };
    }

    const currentBranch = await tryGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    if (currentBranch === defaultBranch) {
        const statusOut = await tryGit(["status", "--porcelain"], cwd);
        if (statusOut === null) {
            return { kind: "diverged", branch: defaultBranch, reason: "working tree not clean" };
        }
        // Excludes `taiRoot` itself from the dirty check — this function may have just
        // written its own debounce checkpoint there (above), and `.tai/` isn't guaranteed
        // gitignored in every project TAI runs against (brief §7 says it should be, but
        // this check shouldn't depend on that being true to behave correctly).
        const taiRootRel = path.relative(cwd, taiRoot).split(path.sep).join("/");
        const relevantChanges = statusOut
            .split("\n")
            .filter((line) => line.length > 0)
            .filter((line) => {
                const filePath = line.slice(3);
                return !(taiRootRel && (filePath === taiRootRel || filePath.startsWith(`${taiRootRel}/`)));
            });
        if (relevantChanges.length > 0) {
            return { kind: "diverged", branch: defaultBranch, reason: "working tree not clean" };
        }
        try {
            await git(["merge", "--ff-only", remoteRef], cwd);
        } catch (err) {
            return { kind: "diverged", branch: defaultBranch, reason: (err as Error).message };
        }
        return { kind: "fast-forwarded", branch: defaultBranch, from: localSha, to: remoteSha };
    }

    // Not checked out — update the branch ref directly, no working tree involved.
    try {
        await git(["update-ref", `refs/heads/${defaultBranch}`, remoteSha], cwd);
    } catch (err) {
        return { kind: "diverged", branch: defaultBranch, reason: (err as Error).message };
    }
    return { kind: "fast-forwarded", branch: defaultBranch, from: localSha, to: remoteSha };
}

/** Renders a one-line human-facing note for outcomes worth surfacing in CLI output —
 *  `undefined` for outcomes that are silent by design (debounced, not a repo, no remote,
 *  already up to date — nothing changed, nothing to say). */
export function renderLocalFetchNote(outcome: LocalFetchOutcome): string | undefined {
    switch (outcome.kind) {
        case "fast-forwarded":
            return `(fetched: ${outcome.branch} fast-forwarded to ${outcome.to.slice(0, 8)})`;
        case "diverged":
            return (
                `(warning: local ${outcome.branch} could not fast-forward from origin — ` +
                `${outcome.reason}; fetched anyway, pull/merge manually)`
            );
        case "fetch-failed":
            return `(warning: git fetch failed — ${outcome.message})`;
        default:
            return undefined;
    }
}
