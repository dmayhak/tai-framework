/**
 * TAI Framework — one unattended Claude run for one ticket (TAI-633, ADR page 64782337 decision 8).
 *
 * A fresh non-interactive `claude -p` per ticket, so each ticket has a clean context and a failure stops only that
 * ticket. The prompt spells the steps out and does not rely on a skill being loadable in print mode. The run builds the
 * change, opens the PR and records the check, and does nothing past that: no review, approval, merge or close.
 *
 * Permissions: file edits are accepted (`--permission-mode acceptEdits`); every other command must already be allowed by
 * the person's own Claude permission rules, and one that is not is denied and fails that ticket with a hand-off. The run
 * is never given a blanket allow, because that would include `git-pr merge`, which stays the person's separate opt-in.
 */

import { spawn } from "node:child_process";

/** Minutes a run may take, from `TAI_DEV_RUN_TIMEOUT_MIN` (default 45). A value that is not a positive number is refused, not guessed. */
export function devRunTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env["TAI_DEV_RUN_TIMEOUT_MIN"];
    if (raw === undefined || raw.trim() === "") return 45 * 60_000;
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error(`TAI_DEV_RUN_TIMEOUT_MIN must be a positive number of minutes (got "${raw}").`);
    }
    return Math.round(minutes * 60_000);
}

export interface HeadlessRunOptions {
    readonly cwd: string;
    readonly timeoutMs: number;
    /** The Claude executable; `claude` unless the machine says otherwise. */
    readonly bin?: string;
    /** Milliseconds between the stop and the kill when a run ignores the stop; 10 seconds unless a test says otherwise. */
    readonly killGraceMs?: number;
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

const TAIL_BYTES = 8_000;

/** Process groups of the runs in flight, so an interrupt of this command can stop them instead of leaving them working. */
const activeGroups = new Set<number>();

/** Stops every run in flight (SIGTERM to its whole process group). Returns how many it signalled. */
export function stopActiveRuns(): number {
    let n = 0;
    for (const pid of activeGroups) {
        try {
            process.kill(-pid, "SIGTERM");
            n++;
        } catch {
            // already gone
        }
    }
    return n;
}

/** On Ctrl-C or a terminate, stops the runs in flight and exits, so no unattended run outlives the command that started it. */
export function stopRunsOnInterrupt(): void {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.once(signal, () => {
            const n = stopActiveRuns();
            console.error(`\nInterrupted: stopped ${n} running Claude run${n === 1 ? "" : "s"}. Tickets already started may be left In Progress with changes on a branch.`);
            process.exit(signal === "SIGINT" ? 130 : 143);
        });
    }
}

/** `text` with the values of credential-looking environment variables and bearer tokens masked, since it is posted to a ticket. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
    let out = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***");
    for (const [name, value] of Object.entries(env)) {
        if (value && value.length >= 8 && /TOKEN|SECRET|PASSWORD|API_KEY|^TAI_/i.test(name)) out = out.split(value).join("***");
    }
    return out;
}

/**
 * Runs `claude -p` for one ticket and resolves when it ends. It always ends: on the timeout the whole process group is
 * stopped (SIGTERM, then SIGKILL after `killGraceMs`), because the run's own children (npm, tsx, a test run) can keep the
 * output pipes open after `claude` itself is gone, and the result is returned from the timeout and not left to a `close`
 * that may never come. Only the tail of the output is kept.
 */
export function runHeadlessClaude(prompt: string, options: HeadlessRunOptions): Promise<HeadlessRunResult> {
    return new Promise((resolve) => {
        const bin = options.bin ?? "claude";
        const child = spawn(bin, ["-p", prompt, "--permission-mode", "acceptEdits"], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
        if (child.pid !== undefined) activeGroups.add(child.pid);
        let tail = "";
        let settled = false;
        const grace = options.killGraceMs ?? 10_000;
        const keep = (d: Buffer): void => {
            tail = (tail + d.toString()).slice(-TAIL_BYTES);
        };
        const lastLines = (): string => redactSecrets(tail.trim().split("\n").slice(-6).join("\n"));
        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;
        const stoppedSummary = (): string => `the run was stopped after ${Math.round(options.timeoutMs / 60000)} minutes. Last output:\n${lastLines()}`;
        const killGroup = (signal: NodeJS.Signals): void => {
            if (settled) return; // the group is gone and its id may belong to something else by now
            try {
                if (child.pid !== undefined) process.kill(-child.pid, signal);
            } catch {
                child.kill(signal);
            }
        };
        const finish = (result: HeadlessRunResult): void => {
            if (settled) return;
            settled = true;
            if (child.pid !== undefined) activeGroups.delete(child.pid);
            clearTimeout(timer);
            clearTimeout(killTimer);
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve(result);
        };
        const timer = setTimeout(() => {
            timedOut = true;
            killGroup("SIGTERM");
            killTimer = setTimeout(() => {
                killGroup("SIGKILL");
                finish({ ok: false, summary: stoppedSummary() });
            }, grace);
            killTimer.unref();
        }, options.timeoutMs);
        child.stdout?.on("data", keep);
        child.stderr?.on("data", keep);
        child.on("error", (err) => finish({ ok: false, summary: `could not start ${bin}: ${err.message}` }));
        child.on("close", (code) => {
            if (timedOut) finish({ ok: false, summary: stoppedSummary() });
            else if (code === 0) finish({ ok: true, summary: lastLines() });
            else finish({ ok: false, summary: `the run exited with code ${code}. Last output:\n${lastLines()}` });
        });
    });
}
