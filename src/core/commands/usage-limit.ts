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

import type { IssueKey, WorkTracker } from "../storage/interface.js";

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

// The message itself, from the start of the line: "Claude usage limit reached", "5-hour limit reached", "Weekly limit reached",
// "Your usage limit has been reached", "You've hit your limit". Anchored at the start, so a summary line that merely talks about a
// limit ("- detects the 5-hour limit reached message", "Added detection of the usage limit reached message") is not one.
const LEAD = "^[^A-Za-z0-9]*";
// Where the message ends: the end of the line, a separator before the reset ("∙", "·", "|", "-", ":"), a "resets" clause, or the
// prose form ("... reached. Your limit will reset at 3pm"). More words straight after it ("Usage limit reached handling is now covered
// by tests", "Weekly limit exceeded case added") are a closing line of a run that finished, not the message (TAI-706 review).
const END = "(?=\\s*$|\\s*[|∙·•—–:]|\\s+-|\\.\\s*$|\\.\\s+(?:your\\s+)?limit\\b.*\\breset|\\s+resets?\\b)";
const NAMED_LIMIT = new RegExp(`${LEAD}(?:claude(?:\\s+ai)?\\s+)?(?:your\\s+)?(?:(?:opus|sonnet)\\s+)?(?:usage|5-hour|five-hour|weekly|daily|session|opus|sonnet)\\s+limit\\b[^.\\n]{0,30}?\\b(?:reached|hit|exceeded)\\b${END}`, "i");
const HIT_YOUR_LIMIT = new RegExp(`${LEAD}you(?:'|’)?ve\\s+(?:hit|reached)\\s+your\\b[^.\\n]*?\\blimit\\b${END}`, "i");
// A list item, a quote, a heading, a numbered step or code: how a run's own summary is written, never how Claude Code prints a limit.
const SUMMARY_LINE = /^\s*(?:[-*+>#`]|\d+[.)]\s)/;
// A throttle (HTTP 429) is retried by Claude Code itself and has no reset time to wait for: it is not a usage limit.
const THROTTLE = /rate[\s_-]?limit/i;
const MAX_LINE = 300;

interface WallClock {
    readonly y: number;
    readonly m: number;
    readonly d: number;
    readonly h: number;
    readonly min: number;
}

/** The date and time on the wall clock of `zone` at `at`. Throws a RangeError for a name that is not a time zone. */
function clockIn(at: Date, zone: string): WallClock {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(at);
    const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    return { y: n("year"), m: n("month") - 1, d: n("day"), h: n("hour"), min: n("minute") };
}

/** The instant at which the wall clock of `zone` reads y-m-d h:min (day overflow, such as the 32nd, rolls over). */
function instantIn(zone: string, y: number, m: number, d: number, h: number, min: number): Date {
    const wanted = Date.UTC(y, m, d, h, min);
    let t = wanted;
    // The zone's offset depends on the instant, so settle on it in two passes (a daylight-saving change in between is rare and settles too).
    for (let i = 0; i < 2; i++) {
        const c = clockIn(new Date(t), zone);
        t += wanted - Date.UTC(c.y, c.m, c.d, c.h, c.min);
    }
    return new Date(t);
}

/**
 * The reset time in a limit message, or undefined. An epoch is exact. A clock time ("resets 3pm", "resets 3:30pm (America/Denver)",
 * "resets Nov 7, 10am") is read on the clock of the zone the message names, or the machine's own when it names none or one that is
 * not a time zone; a clock time already past today is tomorrow's.
 */
export function parseReset(line: string, now: Date): Date | undefined {
    const epoch = /\|(\d{9,13})\b/.exec(line);
    if (epoch) {
        const n = Number(epoch[1]);
        return new Date(epoch[1]!.length > 10 ? n : n * 1000);
    }
    const clock = /resets?(?:\s+at)?\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+){1,2})\))?/i.exec(line);
    if (!clock) return undefined;
    const hour12 = Number(clock[3]);
    if (hour12 < 1 || hour12 > 12) return undefined;
    const hour = (hour12 % 12) + (clock[5]!.toLowerCase() === "pm" ? 12 : 0);
    const minute = clock[4] ? Number(clock[4]) : 0;
    if (minute > 59) return undefined;
    const monthIndex = clock[1] ? MONTHS.indexOf(clock[1].toLowerCase()) : -1;
    if (clock[1] && monthIndex < 0) return undefined;
    const day = clock[2] ? Number(clock[2]) : undefined;

    let zone: string | undefined = clock[6];
    let today: WallClock;
    if (zone) {
        try {
            today = clockIn(now, zone);
        } catch {
            zone = undefined;
            today = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate(), h: 0, min: 0 };
        }
    } else {
        today = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate(), h: 0, min: 0 };
    }
    const at = (y: number, m: number, d: number): Date => (zone ? instantIn(zone, y, m, d, hour, minute) : new Date(y, m, d, hour, minute));
    if (day !== undefined) {
        const thisYear = at(today.y, monthIndex, day);
        return thisYear.getTime() <= now.getTime() ? at(today.y + 1, monthIndex, day) : thisYear;
    }
    const first = at(today.y, today.m, today.d);
    return first.getTime() <= now.getTime() ? at(today.y, today.m, today.d + 1) : first;
}

/**
 * The usage limit a run ended on, or null. Only the last few lines of the output count, and only a short line that STARTS with the
 * message that a usage limit is reached; a throttle ("Rate limit reached"), a limit mentioned earlier in a long output and a summary
 * line that talks about a limit are not a limit hit.
 */
export function detectUsageLimit(output: string, now: Date = new Date()): UsageLimit | null {
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-TAIL_LINES);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (line.length > MAX_LINE || THROTTLE.test(line) || SUMMARY_LINE.test(line)) continue;
        if (!NAMED_LIMIT.test(line) && !HIT_YOUR_LIMIT.test(line)) continue;
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
export async function wasPausedOnLimit(workTracker: Pick<WorkTracker, "getIssue">, key: IssueKey): Promise<boolean> {
    const issue = await workTracker.getIssue(key);
    // Newest last by the comment's own time, not by the order a host happens to return them in.
    const handoffs = (issue?.comments ?? []).filter((c) => /^Handoff:/m.test(c.body)).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
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
