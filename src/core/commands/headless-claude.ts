/**
 * TAI Framework — one unattended Claude run for one ticket (TAI-633, ADR page 64782337 decision 8).
 *
 * A fresh non-interactive `claude -p` per ticket, so each ticket has a clean context and a failure stops only that
 * ticket. The prompt spells the steps out and does not rely on a skill being loadable in print mode. The run builds the
 * change, opens the PR and records the check, and does nothing past that: no review, approval, merge or close.
 */

import { spawn } from "node:child_process";

export interface HeadlessRunOptions {
    readonly cwd: string;
    readonly timeoutMs: number;
    /** The Claude executable; `claude` unless the machine says otherwise. */
    readonly bin?: string;
}

export interface HeadlessRunResult {
    readonly ok: boolean;
    readonly summary: string;
}

/** The instructions for building one Dev subtask unattended; `cli` is the command that runs TAI's CLI. */
export function buildDevPrompt(key: string, cli: string): string {
    return [
        `You are working Jira ticket ${key} on your own, with nobody to answer questions. Do not ask any; where something is unclear, make the smallest reasonable choice and say so in the hand-off.`,
        "",
        "Steps, in order:",
        `1. Run \`${cli} issue transition ${key} "In Progress"\` (it may already be). If it is refused, stop and say why.`,
        `2. Run \`${cli} work ${key}\`, read all of it, and act as the persona it names, following that persona's instructions and the project rules in the output.`,
        "3. Build the change on the Story's branch, with its tests. Run the project's checks (typecheck, lint, tests) until they pass.",
        `4. Commit, push, and open the PR with \`${cli} git-pr create\` as the persona instructions describe, then record the check with \`${cli} git-pr check\`.`,
        `5. Post a hand-off comment on ${key} with \`${cli} issue comment ${key} "Handoff: ..."\`: what you did, what is in the PR, and the next step.`,
        "",
        "Stop after step 5. Do not review, approve or merge the PR, do not run the verification, and do not close or transition any ticket past In Progress. Never use force=true.",
        "If you cannot finish, post a Handoff: comment saying where you stopped and why, and end.",
    ].join("\n");
}

export function runHeadlessClaude(prompt: string, options: HeadlessRunOptions): Promise<HeadlessRunResult> {
    return new Promise((resolve) => {
        const child = spawn(options.bin ?? "claude", ["-p", prompt], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, options.timeoutMs);
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr.on("data", (d: Buffer) => (out += d.toString()));
        child.on("error", (err) => {
            clearTimeout(timer);
            resolve({ ok: false, summary: `could not start ${options.bin ?? "claude"}: ${err.message}` });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            const tail = out.trim().split("\n").slice(-6).join("\n");
            if (timedOut) resolve({ ok: false, summary: `the run was stopped after ${Math.round(options.timeoutMs / 60000)} minutes. Last output:\n${tail}` });
            else if (code !== 0) resolve({ ok: false, summary: `the run exited with code ${code}. Last output:\n${tail}` });
            else resolve({ ok: true, summary: tail });
        });
    });
}
