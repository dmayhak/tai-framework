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
const TAIL_LINES = 10;
/** A run that exited 0 and finished its work: the message must be among its last two lines (one trailing warning is allowed for). */
export const FINISHED_RUN_TAIL_LINES = 2;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// The message itself, from the start of the line: "Claude usage limit reached", "5-hour limit reached", "Weekly limit reached",
// "Your usage limit has been reached", "You've hit your limit". Anchored at the start, so a summary line that merely talks about a
// limit ("- detects the 5-hour limit reached message", "Added detection of the usage limit reached message") is not one.
const LEAD = "^[^A-Za-z0-9]*";
// Where the message ends: the end of the line, a separator ("∙", "·", "|", "-", ":") that leads to the reset (a "resets" clause, an epoch
// time) or to nothing, a "resets" clause, or the prose form ("... reached. Your limit will reset at 3pm"). More words straight after it
// ("Usage limit reached handling is now covered by tests") or after a separator ("Usage limit reached: now handled by retry",
// "Weekly limit reached - handling added") are a closing line of a run that finished, not the message.
const SEPARATOR = "(?:[|∙·•—–:]|\\s-)\\s*(?:resets?\\b|\\d{9,}\\b|$)";
const END = `(?=\\s*$|\\s*${SEPARATOR}|\\.\\s*$|\\.\\s+(?:your\\s+)?limit\\b.*\\breset|\\s+resets?\\b)`;
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

const JUST_PASSED_MS = 5 * 60_000;

/**
 * The reset time in a limit message, or undefined. An epoch is exact. A clock time ("resets 3pm", "resets 3:30pm (America/Denver)",
 * "resets Nov 7, 10am") is read on the clock of the zone the message names, or the machine's own when it names none; one it names that is
 * not a time zone gives no reset time; a clock time that passed more than five minutes ago today is tomorrow's.
 */
export function parseReset(line: string, now: Date): Date | undefined {
    const epoch = /\|(\d{9,13})\b/.exec(line);
    if (epoch) {
        const n = Number(epoch[1]);
        return new Date(epoch[1]!.length > 10 ? n : n * 1000);
    }
    const clock = /resets?(?:\s+at)?\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+){0,2})\))?/i.exec(line);
    if (!clock) return undefined;
    const hour12 = Number(clock[3]);
    if (hour12 < 1 || hour12 > 12) return undefined;
    const hour = (hour12 % 12) + (clock[5]!.toLowerCase() === "pm" ? 12 : 0);
    const minute = clock[4] ? Number(clock[4]) : 0;
    if (minute > 59) return undefined;
    const monthIndex = clock[1] ? MONTHS.indexOf(clock[1].toLowerCase()) : -1;
    if (clock[1] && monthIndex < 0) return undefined;
    const day = clock[2] ? Number(clock[2]) : undefined;

    const zone: string | undefined = clock[6];
    let today: WallClock;
    if (zone) {
        try {
            today = clockIn(now, zone);
        } catch {
            // A zone the message names but Intl does not know (an abbreviation such as PST): the clock time cannot be placed, so there is
            // no reset time rather than a guess on the machine's clock; wait= then says the message gave none.
            return undefined;
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
    // A reset a few minutes ago is this reset, just reached while the message was printed or the run was shutting down: not a day away.
    return first.getTime() + JUST_PASSED_MS <= now.getTime() ? at(today.y, today.m, today.d + 1) : first;
}

/**
 * The usage limit a run ended on, or null. Only the last few lines of the output count, and only a short line that STARTS with the
 * message that a usage limit is reached; a throttle ("Rate limit reached"), a limit mentioned earlier in a long output and a summary
 * line that talks about a limit are not a limit hit. `tailLines` narrows the window (1 = the very last line only).
 */
export function detectUsageLimit(output: string, now: Date = new Date(), tailLines: number = TAIL_LINES): UsageLimit | null {
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-tailLines);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (line.length > MAX_LINE || THROTTLE.test(line) || SUMMARY_LINE.test(line)) continue;
        if (!NAMED_LIMIT.test(line) && !HIT_YOUR_LIMIT.test(line)) continue;
        const resetsAt = parseReset(line, now);
        return { text: line, ...(resetsAt ? { resetsAt } : {}) };
    }
    return null;
}

/**
 * The last lines of a run's output that mention a limit or running out of usage, or null. Used only for a run that failed without
 * matching a known message: its wording may be a usage limit this detector has not seen, and the person should be told.
 */
export function limitMention(output: string): string | null {
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-TAIL_LINES);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (line.length > MAX_LINE || THROTTLE.test(line) || SUMMARY_LINE.test(line)) continue;
        if (/\blimit\b|out of (?:extra )?usage/i.test(line)) return line;
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
/** A limit printed after the PR was already opened (a run that finished its work and then hit the limit): nothing is left to continue. */
export const PR_OPEN_BUILD_STAGE = "build run (PR open)";

/** The stage to record for a build run that ended on a limit: not continuable when its PR is already open, since a later run skips such a ticket. */
export async function buildStageAfterLimit(findPr: () => Promise<{ readonly prUrl: string | null }>): Promise<string> {
    try {
        return (await findPr()).prUrl ? PR_OPEN_BUILD_STAGE : CONTINUABLE_STAGE;
    } catch {
        return CONTINUABLE_STAGE; // cannot tell: the ticket's own pause note and the next prepare decide
    }
}

export function isContinuableStage(stage: string): boolean {
    return stage === CONTINUABLE_STAGE;
}

/** Where the checkout stood when the run was cut off ("<branch>@<commit>"). A later run continues only if it still stands there. */
const POSITION_PREFIX = "Position: ";
const PAUSED_NOTE_START = "Handoff: DEV-YOLO paused on a usage limit.";
/** The part of the continues line that has no quote marks, so a tracker that rewrites quotes in a comment cannot hide it. */
const CONTINUES_MARK = "The run continues this ticket on its branch.";
const CONTINUES_LINE = `Next: once the limit has reset, run "Do all dev tasks" again. ${CONTINUES_MARK}`;

/** The note left on a ticket whose run was cut off by a usage limit. Neutral: the ticket did nothing wrong. */
export function pausedHandoff(limit: UsageLimit, stage: string, position?: string): string {
    const reset = limit.resetsAt ? ` It resets at ${limit.resetsAt.toISOString()}.` : "";
    const next = isContinuableStage(stage)
        ? CONTINUES_LINE
        : stage === "verification run"
          ? `Next: the PR is already merged, so only the verification is left. Once the limit has reset, run /tai-verify on the Story by hand.`
          : 'Next: the PR is already open, so "Do all dev tasks" skips this ticket. Once the limit has reset, continue it with /tai-work, or review and merge the PR by hand.';
    return (
        `${PAUSED_NOTE_START} The account's usage limit was reached while this ticket's ${stage} was running: "${limit.text}".${reset}\n\n` +
        "This is not a failure of the ticket. The branch and any uncommitted work were left as they were.\n\n" +
        (position ? `${POSITION_PREFIX}${position}\n\n` : "") +
        next
    );
}

/** A comment's time as a number, so offsets like -0700 compare exactly; NaN when it is missing or unreadable. */
function timeOf(createdAt: string | undefined): number {
    return createdAt ? Date.parse(createdAt) : Number.NaN;
}

/**
 * Whether the ticket's newest `Handoff:` comment is a pause note that says the run continues it. Only then may the next run carry on from
 * the uncommitted work on the Story branch: the dirty-tree stop is lifted for this ticket and no other.
 */
export async function wasPausedOnLimit(workTracker: Pick<WorkTracker, "getIssue">, key: IssueKey, current?: string): Promise<boolean> {
    const issue = await workTracker.getIssue(key);
    // Newest last by the comment's own time, not by the order a host happens to return them in.
    const handoffs = (issue?.comments ?? []).filter((c) => /^Handoff:/m.test(c.body));
    // Among several hand-offs, one whose time cannot be read makes the newest impossible to tell, so the dirty-tree stop applies.
    if (handoffs.length > 1 && handoffs.some((c) => Number.isNaN(timeOf(c.createdAt)))) return false;
    handoffs.sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt));
    const newest = handoffs[handoffs.length - 1];
    if (newest === undefined || !newest.body.includes(PAUSED_NOTE_START) || !newest.body.includes(CONTINUES_MARK)) return false;
    // A note that recorded where the checkout stood only counts while it still stands there: if the person has since committed, switched
    // branch or moved on, the tree's leftovers are not this pause's and the dirty-tree stop applies. An older note, or no way to tell, is trusted.
    const recorded = new RegExp(`^${POSITION_PREFIX}(\\S+)$`, "m").exec(newest.body)?.[1];
    return recorded === undefined || current === undefined || recorded === current;
}

/**
 * Whether each ticket was paused on a limit, with the lifetime of every answer stated. The answer read while picking the next ticket is used
 * once, by that ticket's preparation; the answer preparation settled on is used once, by that attempt's build. A later attempt reads afresh.
 */
export class PauseReads {
    private readonly seen = new Map<string, boolean>();
    private readonly attempt = new Map<string, boolean>();

    constructor(private readonly read: (key: IssueKey) => Promise<boolean>) {}

    /**
     * Read while picking the next ticket (a failure here is the caller's to handle). The answer for a ticket that is not worked next stays
     * until its own preparation; that is safe because only a run's own pause changes a ticket's note, and that goes through remember().
     */
    async whilePicking(key: IssueKey): Promise<boolean> {
        const paused = await this.read(key);
        this.seen.set(key, paused);
        return paused;
    }

    /** This run knows the ticket was just paused (whether or not its note could be posted): the next preparation uses that without a read. */
    remember(key: IssueKey): void {
        this.seen.set(key, true);
    }

    /** For a ticket's preparation: the answer seen while picking, else a read. Kept for this attempt's build. */
    async forPrepare(key: IssueKey): Promise<boolean> {
        const paused = this.seen.get(key) ?? (await this.read(key));
        this.seen.delete(key);
        this.attempt.set(key, paused);
        return paused;
    }

    /** For the build: this attempt's answer. With none (preparation did not run), a read that cannot fail the ticket: an unreadable ticket is built from the default branch. */
    async forBuild(key: IssueKey): Promise<boolean> {
        const paused = this.attempt.get(key);
        this.attempt.delete(key);
        if (paused !== undefined) return paused;
        try {
            return await this.read(key);
        } catch {
            return false;
        }
    }
}

/**
 * Wraps a hand-off poster so that, once a run has hit the usage limit, whatever hand-off the ticket's code goes on to write (a failure
 * hand-off, a "run did not finish" note) is replaced by the neutral paused note: the ticket did not fail.
 */
export function pausedAwareHandoff(latch: UsageLimitLatch | undefined, post: (key: string, body: string) => Promise<void>, position?: () => Promise<string | undefined>): (key: string, body: string) => Promise<void> {
    return async (key, body) => {
        const hit = latch?.current();
        if (!hit) return post(key, body);
        let where: string | undefined;
        try {
            where = await position?.();
        } catch {
            where = undefined; // the note is still posted, without the position
        }
        return post(key, pausedHandoff(hit.limit, hit.stage, where));
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
