/**
 * TAI Framework — telling a usage limit from a failure in an unattended run (TAI-706).
 *
 * When the account hits its usage limit, a `claude -p` run ends like any other failure, and the loop would go on to fail every
 * later ticket the same way. A limit is a "paused" outcome: the run stops cleanly and, with `wait=<hours>`, sleeps until the reset.
 *
 * What a limit hit looks like is NOT captured from a real hit (that would use up the account). It is built from what Claude
 * Code documents and what is reported: a run exits non-zero on a failure, but a limit message can also come back with exit
 * code 0, and the message is the last thing in the output. So the end of the output is read whatever the exit code. The sample
 * messages in `usage-limit.test.ts` are marked as reported, not recorded; replace them when a real hit is captured.
 */

/** A usage limit the account has reached. */
export interface UsageLimit {
    /** The line that said so, as the run printed it. */
    readonly text: string;
    /** When the limit resets, when the message gave a time this can read. */
    readonly resetsAt?: Date;
}

/** How much of the end of the output is read. A limit ends the run, so its message is among the last lines. */
const TAIL_LINES = 6;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// "usage limit reached", "5-hour limit reached", "Weekly limit reached", "You've hit your limit"
const NAMED_LIMIT = /\b(?:usage|5-hour|five-hour|weekly|daily|session|opus|sonnet)\s+limit\b/i;
const REACHED = /\b(?:reached|hit|exceeded)\b/i;
const HIT_YOUR_LIMIT = /\byou(?:'|’)?ve\s+(?:hit|reached)\s+your\b.*\blimit\b/i;
// A throttle (HTTP 429) is retried by Claude Code itself and has no reset time to wait for: it is not a usage limit.
const THROTTLE = /rate[\s_-]?limit/i;
const MAX_LINE = 300;

/** The reset time in a limit message, read as local time (the message shows the person's own clock), or undefined. */
export function parseReset(line: string, now: Date): Date | undefined {
    const epoch = /\|(\d{9,13})\b/.exec(line);
    if (epoch) {
        const n = Number(epoch[1]);
        return new Date(epoch[1]!.length > 10 ? n : n * 1000);
    }
    const clock = /resets?(?:\s+at)?\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(line);
    if (!clock) return undefined;
    const hour12 = Number(clock[3]);
    if (hour12 < 1 || hour12 > 12) return undefined;
    const hour = (hour12 % 12) + (clock[5]!.toLowerCase() === "pm" ? 12 : 0);
    const minute = clock[4] ? Number(clock[4]) : 0;
    if (minute > 59) return undefined;
    if (clock[1]) {
        const month = MONTHS.indexOf(clock[1].toLowerCase());
        if (month < 0) return undefined;
        const at = new Date(now.getFullYear(), month, Number(clock[2]), hour, minute);
        return at.getTime() <= now.getTime() ? new Date(now.getFullYear() + 1, month, Number(clock[2]), hour, minute) : at;
    }
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    return today.getTime() <= now.getTime() ? new Date(today.getTime() + 24 * 3_600_000) : today;
}

/**
 * The usage limit a run ended on, or null. Only the last few lines of the output count, and only a short line that names a usage
 * limit as reached; a throttle ("Rate limit reached") and a limit mentioned earlier in a long output are not a limit hit.
 */
export function detectUsageLimit(output: string, now: Date = new Date()): UsageLimit | null {
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-TAIL_LINES);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (line.length > MAX_LINE || THROTTLE.test(line)) continue;
        const named = NAMED_LIMIT.test(line) && REACHED.test(line);
        if (!named && !HIT_YOUR_LIMIT.test(line)) continue;
        const resetsAt = parseReset(line, now);
        return { text: line, ...(resetsAt ? { resetsAt } : {}) };
    }
    return null;
}

/** Records the first usage limit a run hit, so every step that learns of it, and the code that stops the batch, read the same one. */
export class UsageLimitLatch {
    private limit: UsageLimit | null = null;
    private stage: string | null = null;

    /** Keeps the first hit: the later steps of the same ticket only repeat it. */
    hit(limit: UsageLimit, stage: string): void {
        if (this.limit === null) {
            this.limit = limit;
            this.stage = stage;
        }
    }

    current(): { readonly limit: UsageLimit; readonly stage: string } | null {
        return this.limit === null ? null : { limit: this.limit, stage: this.stage! };
    }

    clear(): void {
        this.limit = null;
        this.stage = null;
    }
}

/** How long a run waits for the reset after the limit message, so it starts after the limit has lifted and not on the minute. */
export const RESET_MARGIN_MS = 60_000;
/** A reset that keeps being followed by another limit hit is not read right; the run stops after this many waits. */
export const MAX_WAITS_PER_RUN = 3;

export type WaitDecision =
    | { readonly wait: true; readonly ms: number }
    | { readonly wait: false; readonly why: string };

/** Whether to sleep until the reset: only with `wait=<hours>`, only for a reset the message gave, and only within that many hours. */
export function decideWait(limit: UsageLimit, waitHours: number | undefined, now: Date): WaitDecision {
    if (waitHours === undefined) return { wait: false, why: "no wait= was given" };
    if (!limit.resetsAt) return { wait: false, why: "the message gave no reset time" };
    const ms = limit.resetsAt.getTime() - now.getTime() + RESET_MARGIN_MS;
    if (ms <= 0) return { wait: true, ms: 0 };
    if (ms > waitHours * 3_600_000) return { wait: false, why: `the reset is further off than wait=${waitHours} hours` };
    return { wait: true, ms };
}

/** `wait=<hours>`: a positive number of hours, at most a week. Anything else, including nothing, is refused like any mistyped argument. */
export function parseWaitHours(value: string): number {
    const hours = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
    if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
        throw new Error(`wait= takes a number of hours above 0 and up to 168, such as wait=6 (got: ${value === "" ? "nothing" : value}).`);
    }
    return hours;
}

/** The step whose cut-off work can be picked up again: the build. After it a PR is open, and "Do all dev tasks" leaves a ticket with an open PR to a person. */
export const CONTINUABLE_STAGE = "build run";
export function isContinuableStage(stage: string): boolean {
    return stage === CONTINUABLE_STAGE;
}

const PAUSED_NOTE_START = "Handoff: DEV-YOLO paused on a usage limit.";
const CONTINUES_LINE = 'Next: once the limit has reset, run "Do all dev tasks" again. The run continues this ticket on its branch.';

/** The note left on a ticket whose run was cut off by a usage limit. Neutral: the ticket did nothing wrong. */
export function pausedHandoff(limit: UsageLimit, stage: string): string {
    const reset = limit.resetsAt ? ` It resets at ${limit.resetsAt.toISOString()}.` : "";
    const next = isContinuableStage(stage)
        ? CONTINUES_LINE
        : 'Next: the PR is already open, so "Do all dev tasks" skips this ticket. Once the limit has reset, continue it with /tai-work, or review and merge the PR by hand.';
    return (
        `${PAUSED_NOTE_START} The account's usage limit was reached while this ticket's ${stage} was running: "${limit.text}".${reset}\n\n` +
        "This is not a failure of the ticket. The branch and any uncommitted work were left as they were.\n\n" +
        next
    );
}

/**
 * Whether the ticket's newest `Handoff:` comment is a pause note that says the run continues it. Only then may the next run carry on from
 * the uncommitted work on the Story branch: the dirty-tree stop is lifted for this ticket and no other (TAI-706 review).
 */
export async function wasPausedOnLimit(workTracker: { getIssue(key: never): Promise<{ readonly comments: readonly { readonly body: string }[] } | null> }, key: string): Promise<boolean> {
    const issue = await workTracker.getIssue(key as never);
    const handoffs = (issue?.comments ?? []).filter((c) => /^Handoff:/m.test(c.body));
    const newest = handoffs[handoffs.length - 1];
    return newest !== undefined && newest.body.includes(PAUSED_NOTE_START) && newest.body.includes(CONTINUES_LINE);
}

/**
 * Wraps a hand-off poster so that, once a run has hit the usage limit, whatever hand-off the ticket's code goes on to write (a failure
 * hand-off, a "run did not finish" note) is replaced by the neutral paused note: the ticket did not fail.
 */
export function pausedAwareHandoff(latch: UsageLimitLatch | undefined, post: (key: string, body: string) => Promise<void>): (key: string, body: string) => Promise<void> {
    return (key, body) => {
        const hit = latch?.current();
        return post(key, hit ? pausedHandoff(hit.limit, hit.stage) : body);
    };
}

/** Sleeps for `ms`, in short steps so an interrupt ends the wait within a step instead of after hours. */
export async function sleepUnlessInterrupted(ms: number, interrupted: () => boolean, stepMs = 5_000): Promise<void> {
    const end = Date.now() + ms;
    while (!interrupted()) {
        const left = end - Date.now();
        if (left <= 0) return;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(stepMs, left)));
    }
}
