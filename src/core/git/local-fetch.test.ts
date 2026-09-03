import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { lastFetchPath, refreshLocalDefaultBranch, renderLocalFetchNote } from "./local-fetch.js";

const execFileAsync = promisify(execFile);

async function git(args: readonly string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync("git", args as string[], { cwd });
    return stdout.trim();
}

/** Sets up a bare "remote" repo plus a local clone with one initial commit on `master`,
 *  and hands the caller both directories plus a `taiRoot` (a sibling `.tai/` under the
 *  clone) to drive `refreshLocalDefaultBranch` against. */
async function withRemoteAndClone<T>(fn: (dirs: { remote: string; local: string; taiRoot: string }) => Promise<T>): Promise<T> {
    const root = await mkdtemp(path.join(tmpdir(), "tai-local-fetch-"));
    try {
        const remote = path.join(root, "remote.git");
        const local = path.join(root, "local");
        const taiRoot = path.join(local, ".tai");

        await git(["init", "--bare", "-b", "master", remote], root);
        await git(["clone", remote, local], root);
        await git(["config", "user.email", "test@example.com"], local);
        await git(["config", "user.name", "Test"], local);
        await writeFile(path.join(local, "file.txt"), "one\n");
        await git(["add", "file.txt"], local);
        await git(["commit", "-m", "initial"], local);
        await git(["push", "origin", "master"], local);
        // A clone from a bare repo doesn't set the origin/HEAD symref by default in every
        // git version -- set it explicitly so `resolveDefaultBranch`'s fast local path is
        // exercised (the ls-remote fallback is covered separately below).
        await git(["remote", "set-head", "origin", "master"], local);

        return await fn({ remote, local, taiRoot });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

/** Advances the bare remote's `master` by one commit, made from a second clone so the
 *  first clone's working tree/index are untouched. */
async function advanceRemote(root: string, remote: string): Promise<string> {
    const other = path.join(root, "other");
    await git(["clone", remote, other], root);
    await git(["config", "user.email", "test@example.com"], other);
    await git(["config", "user.name", "Test"], other);
    await writeFile(path.join(other, "file.txt"), "two\n");
    await git(["add", "file.txt"], other);
    await git(["commit", "-m", "second"], other);
    await git(["push", "origin", "master"], other);
    return git(["rev-parse", "master"], other);
}

describe("refreshLocalDefaultBranch", () => {
    it("returns not-a-repo for a directory with no .git at all", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-local-fetch-plain-"));
        try {
            const outcome = await refreshLocalDefaultBranch(dir, path.join(dir, ".tai"));
            assert.deepEqual(outcome, { kind: "not-a-repo" });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("returns no-remote for a real repo with no origin configured", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-local-fetch-noremote-"));
        try {
            await git(["init", "-b", "master"], dir);
            const outcome = await refreshLocalDefaultBranch(dir, path.join(dir, ".tai"));
            assert.deepEqual(outcome, { kind: "no-remote" });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("returns up-to-date when local already matches origin", async () => {
        await withRemoteAndClone(async ({ local, taiRoot }) => {
            const outcome = await refreshLocalDefaultBranch(local, taiRoot);
            assert.deepEqual(outcome, { kind: "up-to-date", branch: "master" });
        });
    });

    it("fast-forwards the checked-out default branch when the working tree is clean (test clone has no .gitignore for .tai/ -- this also pins the debounce checkpoint write itself never counting as dirty)", async () => {
        await withRemoteAndClone(async ({ remote, local, taiRoot }) => {
            const root = path.dirname(remote);
            const newSha = await advanceRemote(root, remote);

            const outcome = await refreshLocalDefaultBranch(local, taiRoot);
            assert.equal(outcome.kind, "fast-forwarded");
            assert.equal((outcome as { to: string }).to, newSha);

            assert.equal(await git(["rev-parse", "master"], local), newSha);
            assert.equal(await readFile(path.join(local, "file.txt"), "utf8"), "two\n");
        });
    });

    it("fast-forwards a NOT-checked-out default branch via a direct ref update, without touching the working tree", async () => {
        await withRemoteAndClone(async ({ remote, local, taiRoot }) => {
            await git(["checkout", "-b", "some-story-branch"], local);

            const root = path.dirname(remote);
            const newSha = await advanceRemote(root, remote);

            const outcome = await refreshLocalDefaultBranch(local, taiRoot);
            assert.equal(outcome.kind, "fast-forwarded");

            assert.equal(await git(["rev-parse", "master"], local), newSha);
            // Still on the story branch -- the working tree/HEAD were never touched.
            assert.equal(await git(["rev-parse", "--abbrev-ref", "HEAD"], local), "some-story-branch");
        });
    });

    it("fetches but does not touch a checked-out default branch with local commits ahead (diverged)", async () => {
        await withRemoteAndClone(async ({ remote, local, taiRoot }) => {
            const root = path.dirname(remote);
            await advanceRemote(root, remote);

            await writeFile(path.join(local, "file.txt"), "local-only\n");
            await git(["add", "file.txt"], local);
            await git(["commit", "-m", "local divergent commit"], local);
            const localSha = await git(["rev-parse", "master"], local);

            const outcome = await refreshLocalDefaultBranch(local, taiRoot);
            assert.equal(outcome.kind, "diverged");
            assert.equal(await git(["rev-parse", "master"], local), localSha, "local branch must be untouched");
        });
    });

    it("fetches but does not touch a checked-out default branch with a dirty working tree", async () => {
        await withRemoteAndClone(async ({ remote, local, taiRoot }) => {
            const root = path.dirname(remote);
            await advanceRemote(root, remote);
            await writeFile(path.join(local, "file.txt"), "uncommitted change\n");
            const localSha = await git(["rev-parse", "master"], local);

            const outcome = await refreshLocalDefaultBranch(local, taiRoot);
            assert.equal(outcome.kind, "diverged");
            assert.equal(await git(["rev-parse", "master"], local), localSha);
            assert.equal(await readFile(path.join(local, "file.txt"), "utf8"), "uncommitted change\n");
        });
    });

    it("writes a .tai/last-fetch.json checkpoint after a real fetch, and debounces the next call", async () => {
        await withRemoteAndClone(async ({ remote, local, taiRoot }) => {
            const first = await refreshLocalDefaultBranch(local, taiRoot, new Date("2026-09-03T10:00:00.000Z"));
            assert.equal(first.kind, "up-to-date");

            const checkpoint = JSON.parse(await readFile(lastFetchPath(taiRoot), "utf8"));
            assert.equal(checkpoint.fetchedAt, "2026-09-03T10:00:00.000Z");

            // A commit lands on origin between the two calls -- but the second call is
            // still within the debounce window, so it must be invisible to it.
            const root = path.dirname(remote);
            await advanceRemote(root, remote);
            const localShaBeforeSecondCall = await git(["rev-parse", "master"], local);

            const second = await refreshLocalDefaultBranch(local, taiRoot, new Date("2026-09-03T10:05:00.000Z"));
            assert.deepEqual(second, { kind: "skipped-debounce" });
            assert.equal(
                await git(["rev-parse", "master"], local),
                localShaBeforeSecondCall,
                "debounced call must not touch local master"
            );
        });
    });

    it("fetches again once the debounce window has elapsed", async () => {
        await withRemoteAndClone(async ({ remote, local, taiRoot }) => {
            await refreshLocalDefaultBranch(local, taiRoot, new Date("2026-09-03T10:00:00.000Z"));

            const root = path.dirname(remote);
            const newSha = await advanceRemote(root, remote);

            const outcome = await refreshLocalDefaultBranch(local, taiRoot, new Date("2026-09-03T10:11:00.000Z"));
            assert.equal(outcome.kind, "fast-forwarded");
            assert.equal(await git(["rev-parse", "master"], local), newSha);
        });
    });

    it("resolves the default branch via ls-remote when origin/HEAD's symref was never set locally", async () => {
        await withRemoteAndClone(async ({ remote, local, taiRoot }) => {
            // Undo the explicit `remote set-head` this suite's setup does, so resolution
            // must fall back to the network `ls-remote --symref` path.
            await git(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], local);

            const root = path.dirname(remote);
            const newSha = await advanceRemote(root, remote);

            const outcome = await refreshLocalDefaultBranch(local, taiRoot);
            assert.equal(outcome.kind, "fast-forwarded");
            assert.equal((outcome as { branch: string }).branch, "master");
            assert.equal(await git(["rev-parse", "master"], local), newSha);
        });
    });
});

describe("renderLocalFetchNote", () => {
    it("renders nothing for silent-by-design outcomes", () => {
        assert.equal(renderLocalFetchNote({ kind: "skipped-debounce" }), undefined);
        assert.equal(renderLocalFetchNote({ kind: "not-a-repo" }), undefined);
        assert.equal(renderLocalFetchNote({ kind: "no-remote" }), undefined);
        assert.equal(renderLocalFetchNote({ kind: "up-to-date", branch: "master" }), undefined);
    });

    it("renders a note naming the branch and new sha for a fast-forward", () => {
        const note = renderLocalFetchNote({ kind: "fast-forwarded", branch: "master", from: "aaa", to: "bbbbbbbbcccc" });
        assert.match(note!, /master/);
        assert.match(note!, /bbbbbbbb/);
    });

    it("renders a warning naming the reason for a diverged branch, without silently overwriting it", () => {
        const note = renderLocalFetchNote({ kind: "diverged", branch: "master", reason: "working tree not clean" });
        assert.match(note!, /master/);
        assert.match(note!, /working tree not clean/);
        assert.match(note!, /pull\/merge manually/);
    });

    it("renders a warning for a fetch failure", () => {
        const note = renderLocalFetchNote({ kind: "fetch-failed", message: "network unreachable" });
        assert.match(note!, /network unreachable/);
    });
});
