/**
 * Test support (TAI-433): a fake `ssh` executable plus the environment of a host that sets an EMPTY
 * `core.sshCommand` on the git command line (Gemini CLI's shell does — TAI-431 triage, page 52887553).
 *
 * The fake `ssh` runs the remote command locally, so `ssh://fakehost/<abs path>` remotes work with no
 * server, and it records every invocation so a test can tell whether the transport was used at all.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface FakeSsh {
    readonly dir: string;
    /** Number of times the fake ssh was invoked. */
    invocations(): Promise<number>;
}

export async function withFakeSshAndEmptySshCommand<T>(fn: (ssh: FakeSsh) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-fake-ssh-"));
    const log = path.join(dir, "invocations.log");
    const script = [
        "#!/bin/sh",
        `echo called >> "${log}"`,
        // git calls: ssh [-o ...] <host> "<remote command>" -- the command is the last argument.
        'while [ "$#" -gt 1 ]; do shift; done',
        // `git-upload-pack` may not be on PATH (it lives in git's exec path); `git upload-pack` always works.
        `exec sh -c "$(printf '%s' "$1" | sed 's/^git-upload-pack/git upload-pack/')"`,
        "",
    ].join("\n");
    await writeFile(path.join(dir, "ssh"), script);
    await chmod(path.join(dir, "ssh"), 0o755);
    await writeFile(log, "");

    const saved: Record<string, string | undefined> = {};
    const set = (k: string, v: string | undefined): void => {
        if (!(k in saved)) saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    };
    set("PATH", `${dir}${path.delimiter}${process.env["PATH"] ?? ""}`);
    set("GIT_SSH_COMMAND", undefined);
    set("GIT_SSH", undefined);
    // What Gemini CLI's shell does: command-line config with core.sshCommand set to the empty string.
    set("GIT_CONFIG_COUNT", "1");
    set("GIT_CONFIG_KEY_0", "core.sshCommand");
    set("GIT_CONFIG_VALUE_0", "");
    try {
        return await fn({
            dir,
            invocations: async () => (await readFile(log, "utf8")).split("\n").filter((l) => l.length > 0).length,
        });
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        await rm(dir, { recursive: true, force: true });
    }
}
