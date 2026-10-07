import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isUnrunnableSshCommand, runRemoteGit, type GitRunner } from "./remote-git.js";
import { withFakeSshAndEmptySshCommand } from "./fake-ssh.testing.js";

const execFileAsync = promisify(execFile);
async function git(args: readonly string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync("git", args as string[], { cwd });
    return stdout.trim();
}

const CANNOT_RUN = Object.assign(new Error("Command failed: git fetch origin\nerror: cannot run : No such file or directory\nfatal: unable to fork\n"), {
    stderr: "error: cannot run : No such file or directory\nfatal: unable to fork\n",
});

describe("isUnrunnableSshCommand", () => {
    it("recognizes git's 'cannot run <empty>' failure, from the message or from stderr", () => {
        assert.equal(isUnrunnableSshCommand(CANNOT_RUN), true);
        assert.equal(isUnrunnableSshCommand({ stderr: "error: cannot run : No such file or directory" }), true);
        assert.equal(isUnrunnableSshCommand(new Error("error: cannot run /nonexistent-ssh: No such file or directory")), true);
    });
    it("does not match ordinary fetch failures", () => {
        assert.equal(isUnrunnableSshCommand(new Error("fatal: Could not read from remote repository.")), false);
        assert.equal(isUnrunnableSshCommand(new Error("Permission denied (publickey).")), false);
        assert.equal(isUnrunnableSshCommand("not an error"), false);
    });
});

describe("runRemoteGit (injected runner)", () => {
    it("returns the first attempt's output and does not retry when it succeeds", async () => {
        const calls: Array<NodeJS.ProcessEnv | undefined> = [];
        const runner: GitRunner = async (_args, o) => {
            calls.push(o.env);
            return "ok";
        };
        assert.equal(await runRemoteGit(["fetch", "origin"], "/x", { runner, env: {} }), "ok");
        assert.equal(calls.length, 1);
    });

    it("runs the first attempt in the given env too, not only the retry (PR 151 review)", async () => {
        const calls: Array<NodeJS.ProcessEnv | undefined> = [];
        const runner: GitRunner = async (_args, o) => {
            calls.push(o.env);
            if (calls.length === 1) throw CANNOT_RUN;
            return "fetched";
        };
        const env = { PATH: "/bin", MARKER: "x" };
        await runRemoteGit(["fetch", "origin"], "/x", { runner, env });
        assert.equal(calls[0]!["MARKER"], "x");
        assert.equal(calls[1]!["MARKER"], "x");
        assert.equal(calls[1]!["GIT_SSH_COMMAND"], "ssh");
        assert.equal(calls[0]!["GIT_SSH_COMMAND"], undefined);
    });

    it("retries once with GIT_SSH_COMMAND=ssh when the first attempt fails with 'cannot run'", async () => {
        const calls: Array<NodeJS.ProcessEnv | undefined> = [];
        const runner: GitRunner = async (_args, o) => {
            calls.push(o.env);
            if (calls.length === 1) throw CANNOT_RUN;
            return "fetched";
        };
        assert.equal(await runRemoteGit(["fetch", "origin"], "/x", { runner, env: { PATH: "/bin" } }), "fetched");
        assert.equal(calls.length, 2);
        assert.equal(calls[1]!["GIT_SSH_COMMAND"], "ssh");
        assert.equal(calls[1]!["PATH"], "/bin"); // the rest of the environment is kept
    });

    it("does not override a GIT_SSH_COMMAND the environment already sets (it beats the config, so a failure is real)", async () => {
        let n = 0;
        const runner: GitRunner = async () => {
            n++;
            throw CANNOT_RUN;
        };
        await assert.rejects(runRemoteGit(["fetch", "origin"], "/x", { runner, env: { GIT_SSH_COMMAND: "ssh -i /my/key" } }), /cannot run/);
        assert.equal(n, 1);
    });

    it("does not retry on an ordinary failure", async () => {
        let n = 0;
        const runner: GitRunner = async () => {
            n++;
            throw new Error("fatal: Could not read from remote repository.");
        };
        await assert.rejects(runRemoteGit(["fetch", "origin"], "/x", { runner, env: {} }), /Could not read/);
        assert.equal(n, 1);
    });

    it("reports the failure when the retry also fails, and retries only once", async () => {
        let n = 0;
        const runner: GitRunner = async () => {
            n++;
            throw n === 1 ? CANNOT_RUN : new Error("fatal: Could not read from remote repository.");
        };
        await assert.rejects(runRemoteGit(["fetch", "origin"], "/x", { runner, env: {} }), /Could not read/);
        assert.equal(n, 2);
    });
});

describe("runRemoteGit (real git, fake ssh, empty core.sshCommand)", () => {
    /** root/remote.git (bare) with one commit on master, and root/clone whose origin is ssh://fakehost/<remote>. */
    async function withSshClone<T>(fn: (d: { clone: string }) => Promise<T>): Promise<T> {
        const root = await mkdtemp(path.join(tmpdir(), "tai-remote-git-"));
        try {
            const remote = path.join(root, "remote.git");
            const seed = path.join(root, "seed");
            const clone = path.join(root, "clone");
            await git(["init", "--bare", "-b", "master", remote], root);
            await mkdir(seed);
            await git(["init", "-b", "master"], seed);
            await git(["config", "user.email", "t@example.com"], seed);
            await git(["config", "user.name", "T"], seed);
            await writeFile(path.join(seed, "a.txt"), "one\n");
            await git(["add", "."], seed);
            await git(["commit", "-m", "init"], seed);
            await git(["push", remote, "master"], seed);
            await mkdir(clone);
            await git(["init", "-b", "master"], clone);
            await git(["remote", "add", "origin", `ssh://fakehost${remote}`], clone);
            return await fn({ clone });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }

    it("baseline: a plain git fetch fails with 'cannot run' under an empty core.sshCommand", async () => {
        await withSshClone(async ({ clone }) => {
            await withFakeSshAndEmptySshCommand(async (ssh) => {
                await assert.rejects(execFileAsync("git", ["fetch", "origin"], { cwd: clone }), (e: unknown) => isUnrunnableSshCommand(e));
                assert.equal(await ssh.invocations(), 0);
            });
        });
    });

    it("runRemoteGit succeeds through the retry, using the (fake) ssh transport", async () => {
        await withSshClone(async ({ clone }) => {
            await withFakeSshAndEmptySshCommand(async (ssh) => {
                await runRemoteGit(["fetch", "origin"], clone);
                assert.ok((await ssh.invocations()) >= 1);
                assert.match(await git(["rev-parse", "origin/master"], clone), /^[0-9a-f]{40}$/);
            });
        });
    });

    it("an already-set GIT_SSH_COMMAND is respected: no override, the failure surfaces", async () => {
        await withSshClone(async ({ clone }) => {
            await withFakeSshAndEmptySshCommand(async (ssh) => {
                process.env["GIT_SSH_COMMAND"] = "/nonexistent-ssh-for-test";
                // (a shell-run bad command fails with "not found", not git's "cannot run" -- either way the
                // failure must surface and the fake ssh on PATH must NOT have been used as an override)
                await assert.rejects(runRemoteGit(["fetch", "origin"], clone));
                assert.equal(await ssh.invocations(), 0);
            });
        });
    });
});
