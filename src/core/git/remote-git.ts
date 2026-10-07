/**
 * TAI Framework — git commands that talk to a remote, with one retry for an unrunnable ssh command
 * (TAI-431 triage, Confluence page 52887553)
 *
 * Gemini CLI's shell runs git with command-line config that sets `core.sshCommand` to the EMPTY
 * string. Git does not treat that as "unset": it tries to run the empty command, so every ssh git
 * operation fails with `error: cannot run : No such file or directory` / `fatal: unable to fork`.
 * `GIT_SSH_COMMAND` takes precedence over `core.sshCommand`, so one retry with `GIT_SSH_COMMAND=ssh`
 * restores the default transport (`~/.ssh/config` is still honored by plain `ssh`).
 *
 * Used by every TAI call that reaches a remote (`review-prep`'s fetch, `local-fetch`'s fetch and
 * ls-remote) so there is one copy of the rule. Deliberately narrow:
 *   - only on the 'cannot run' failure, never on an ordinary one (auth, network);
 *   - never when `GIT_SSH_COMMAND` is already set — that variable already beats the config, so a
 *     failure there is real, and overriding it would discard a deliberately chosen command;
 *   - exactly one retry; if it also fails, that failure is the one reported.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitRunOptions {
    readonly cwd: string;
    /** Full environment for the child process; omitted means inherit the parent's. */
    readonly env?: NodeJS.ProcessEnv;
}

/** Runs git with these arguments and resolves to its stdout (rejects with an Error carrying `stderr`). */
export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<string>;

export const defaultGitRunner: GitRunner = async (args, { cwd, env }) => {
    const { stdout } = await execFileAsync("git", args as string[], {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        ...(env ? { env } : {}),
    });
    return stdout;
};

/** True for git's failure to execute the configured ssh command ('cannot run <cmd>: No such file or directory'). */
export function isUnrunnableSshCommand(err: unknown): boolean {
    if (typeof err !== "object" || err === null) return false;
    const e = err as { message?: unknown; stderr?: unknown };
    const text = `${typeof e.message === "string" ? e.message : ""}\n${typeof e.stderr === "string" ? e.stderr : ""}`;
    return /cannot run [^\n]*: No such file or directory/.test(text);
}

export interface RunRemoteGitOptions {
    readonly runner?: GitRunner;
    /** The environment the first attempt runs in and the retry is derived from; defaults to `process.env`. */
    readonly env?: NodeJS.ProcessEnv;
}

export async function runRemoteGit(args: readonly string[], cwd: string, options: RunRemoteGitOptions = {}): Promise<string> {
    const runner = options.runner ?? defaultGitRunner;
    const env = options.env ?? process.env;
    try {
        return await runner(args, options.env ? { cwd, env: options.env } : { cwd });
    } catch (err) {
        if (!isUnrunnableSshCommand(err) || env["GIT_SSH_COMMAND"]) throw err;
        return runner(args, { cwd, env: { ...env, GIT_SSH_COMMAND: "ssh" } });
    }
}
