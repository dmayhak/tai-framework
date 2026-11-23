/**
 * TAI Framework — one guarded tick of the unattended Dev service (Epic TAI-763, Story TAI-770).
 *
 * `runServiceTick` is the single command both the timer and kick-off-now call. In order: take the run lock (a second start does nothing
 * and exits 0), skip while the account's usage limit has not reset, check the preflight (a failure starts no run and is logged once),
 * refresh the clone, run `do-dev-tasks` with a cap on tickets, and record what happened. Everything that touches Claude, git, Jira or the
 * clock is injected, so the order and every stop are tested offline. The lock, state directory and clone path are inputs, not
 * assumptions about a local process, so an orchestrator or a cloud runner can call it later.
 */

import { acquireLock, alreadyRunningMessage, type LockDeps } from "./lock.js";
import { clearLimitedUntil, clearPreflightNote, noteFailedPreflight, readLimitedUntil, readPause, writeLastRun, writeLimitedUntil } from "./state.js";
import type { RefreshOutcome } from "./refresh.js";

/** What a run of `do-dev-tasks` came to (`RunSummary` of that command, or why it gave no summary). */
export interface WorkSummary {
    readonly tickets: readonly { readonly key: string; readonly state: string; readonly detail?: string }[];
    readonly capReached: boolean;
    readonly limit: { readonly text: string; readonly resetsAt?: string } | null;
    readonly stopReason: string | null;
    /** TAI-777: In Progress tickets the pickup rule left alone (a person's own), with why. */
    readonly skipped?: readonly { readonly key: string; readonly reason: string }[];
}

export interface ServiceTickDeps {
    readonly stateDir: string;
    /** The service root, where a pause for every project (`tai service pause` with no project) is kept. */
    readonly rootDir?: string;
    readonly waitHours: number;
    readonly cap: number;
    /** How long ticks skip when a limit gave no reset time. */
    readonly limitBackoffMs?: number;
    readonly lock: LockDeps;
    readonly now: () => Date;
    /** One line for the run log (the unit's output goes to the journal). */
    readonly say: (line: string) => void;
    /** The first thing missing before a run, or null when the run may start. */
    readonly preflight: () => Promise<string | null>;
    readonly refresh: () => Promise<RefreshOutcome>;
    /** Runs `do-dev-tasks` in the clone with the wait and cap. Rejects when it gave no summary (it crashed). */
    readonly work: (options: { readonly waitHours: number; readonly cap: number }) => Promise<WorkSummary>;
}

export type TickResult =
    | { readonly status: "locked"; readonly exitCode: 0 }
    | { readonly status: "paused"; readonly exitCode: 0; readonly since: string; readonly scope: "all" | "project" }
    | { readonly status: "limited"; readonly exitCode: 0; readonly until: string }
    | { readonly status: "preflight-failed"; readonly exitCode: 0; readonly message: string }
    | { readonly status: "refresh-failed"; readonly exitCode: 1; readonly why: string }
    | { readonly status: "ran"; readonly exitCode: 0 | 1; readonly stopReason: string };

/** A message without its own closing full stop, so a line built from it can add one. */
const sentence = (text: string): string => text.replace(/[.\s]+$/, "");

const DEFAULT_LIMIT_BACKOFF_MS = 60 * 60_000;

function endReason(summary: WorkSummary, limitedUntil: string | null): string {
    if (summary.limit) return `usage limit: ${summary.limit.text}${limitedUntil ? ` (limited until ${limitedUntil})` : ""}`;
    if (summary.stopReason) return `stopped: ${summary.stopReason}`;
    if (summary.capReached) return "cap reached";
    return summary.tickets.length === 0 ? "no ready tickets" : "no more ready tickets";
}

export async function runServiceTick(deps: ServiceTickDeps): Promise<TickResult> {
    const lock = await acquireLock(deps.stateDir, deps.lock);
    if (!lock.acquired) {
        deps.say(alreadyRunningMessage(lock.held));
        return { status: "locked", exitCode: 0 };
    }
    try {
        if (lock.tookOver) deps.say(`Took over a lock left by pid ${lock.tookOver.pid} (started ${lock.tookOver.startedAt}), which is no longer running.`);

        // TAI-772: a pause (`tai service pause`) starts nothing, and says so in the log on every tick so a forgotten one is seen.
        const pausedAll = deps.rootDir ? await readPause(deps.rootDir) : null;
        const paused = pausedAll ?? (await readPause(deps.stateDir));
        if (paused) {
            const scope = pausedAll ? "all" : "project";
            deps.say(`Skipping: ${scope === "all" ? "every project is" : "this project is"} paused by \`tai service pause\` since ${paused.since}; \`tai service resume${scope === "all" ? "" : " <project>"}\` lets the next tick run.`);
            return { status: "paused", exitCode: 0, since: paused.since, scope };
        }

        const limited = await readLimitedUntil(deps.stateDir, deps.now());
        if (limited) {
            deps.say(`Skipping: the usage limit has not reset (limited until ${limited.until}).`);
            return { status: "limited", exitCode: 0, until: limited.until };
        }
        await clearLimitedUntil(deps.stateDir);

        const failure = await deps.preflight();
        if (failure) {
            // Logged when it is new or changed; the same failure on later ticks stays out of the log.
            if (await noteFailedPreflight(deps.stateDir, failure, deps.now())) deps.say(`Not starting a run: ${sentence(failure)}.`);
            return { status: "preflight-failed", exitCode: 0, message: failure };
        }
        await clearPreflightNote(deps.stateDir);

        const started = deps.now();
        const refreshed = await deps.refresh();
        if (refreshed.action === "failed") {
            const why = `the clone could not be refreshed: ${refreshed.why}`;
            deps.say(`Not starting a run: ${sentence(why)}.`);
            await writeLastRun(deps.stateDir, { started: started.toISOString(), ended: deps.now().toISOString(), tickets: [], stopReason: why });
            return { status: "refresh-failed", exitCode: 1, why };
        }
        deps.say(refreshed.action === "fast-forwarded" ? `Clone refreshed (${refreshed.branch} fast-forwarded).` : `Clone fetched, left as it is: ${refreshed.why}.`);

        let summary: WorkSummary;
        try {
            summary = await deps.work({ waitHours: deps.waitHours, cap: deps.cap });
        } catch (e) {
            const stopReason = `the run failed without a summary: ${e instanceof Error ? e.message : String(e)}`;
            deps.say(stopReason);
            await writeLastRun(deps.stateDir, { started: started.toISOString(), ended: deps.now().toISOString(), tickets: [], stopReason });
            return { status: "ran", exitCode: 1, stopReason };
        }

        let limitedUntil: string | null = null;
        if (summary.limit) {
            const reset = summary.limit.resetsAt ? Date.parse(summary.limit.resetsAt) : Number.NaN;
            limitedUntil = new Date(Number.isNaN(reset) ? deps.now().getTime() + (deps.limitBackoffMs ?? DEFAULT_LIMIT_BACKOFF_MS) : reset).toISOString();
            await writeLimitedUntil(deps.stateDir, { until: limitedUntil, text: summary.limit.text });
            deps.say(`Usage limit reached (${summary.limit.text}): limited until ${limitedUntil}; later ticks skip until then.`);
        }
        if (summary.capReached) deps.say(`Cap reached: ${summary.tickets.length} ticket${summary.tickets.length === 1 ? "" : "s"} worked (cap ${deps.cap}); the rest wait for the next tick.`);
        for (const left of summary.skipped ?? []) deps.say(`Left alone ${left.key}: ${sentence(left.reason)}.`);
        const stopReason = endReason(summary, limitedUntil);
        await writeLastRun(deps.stateDir, { started: started.toISOString(), ended: deps.now().toISOString(), tickets: summary.tickets, ...(summary.skipped && summary.skipped.length > 0 ? { skipped: summary.skipped } : {}), stopReason });
        deps.say(`Run ended: ${stopReason}.`);
        return { status: "ran", exitCode: 0, stopReason };
    } finally {
        await lock.release();
    }
}
