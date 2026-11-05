import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PauseReads, buildStageAfterLimit, pausedAwareHandoff, wasPausedOnLimit, decideWait, detectUsageLimit, limitMention, MAX_WAITS_PER_RUN, parseReset, parseWaitHours, pausedHandoff, RESET_MARGIN_MS, UsageLimitLatch } from "./usage-limit.js";

// A fixed local "now": 2026-11-04 10:00 on the machine's own clock, so clock-time resets read the same everywhere.
const NOW = new Date(2026, 10, 4, 10, 0, 0);

/**
 * NOT RECORDED FROM A REAL HIT (TAI-706, AC-1 as amended): a real hit would use up the account. These are the messages Claude Code
 * is documented or reported to print, as the last output of a `claude -p` run. Replace them with a captured sample when one exists.
 */
const REPORTED_LIMIT_MESSAGES: readonly { readonly name: string; readonly output: string; readonly resetsAt?: Date; readonly now?: Date }[] = [
    { name: "older epoch form", output: "Claude AI usage limit reached|1793800000", resetsAt: new Date(1793800000 * 1000) },
    { name: "5-hour limit with a clock time", output: "5-hour limit reached ∙ resets 3pm", resetsAt: new Date(2026, 10, 4, 15, 0) },
    // The zone is the message's own, so these use a fixed instant: 17:00Z on 2026-11-04 is 10:00 in Denver (MST, UTC-7).
    { name: "hit your limit with minutes and a zone", output: "You've hit your limit · resets 3:30pm (America/Denver)", now: new Date("2026-11-04T17:00:00Z"), resetsAt: new Date("2026-11-04T22:30:00Z") },
    { name: "prose form", output: "Claude usage limit reached. Your limit will reset at 3pm (America/Denver).", now: new Date("2026-11-04T17:00:00Z"), resetsAt: new Date("2026-11-04T22:00:00Z") },
    { name: "weekly limit with a date", output: "Weekly limit reached ∙ resets Nov 7, 10am", resetsAt: new Date(2026, 10, 7, 10, 0) },
    { name: "no reset time", output: "Your usage limit has been reached." },
];

describe("detecting a usage limit (TAI-706)", () => {
    for (const sample of REPORTED_LIMIT_MESSAGES) {
        it(`recognises the ${sample.name}`, () => {
            const found = detectUsageLimit(`Working on it...\nrunning tests\n${sample.output}\n`, sample.now ?? NOW);
            assert.ok(found, "a limit");
            if (sample.resetsAt) assert.equal(found.resetsAt?.getTime(), sample.resetsAt.getTime());
            else assert.equal(found.resetsAt, undefined);
        });
    }

    it("recognises it whatever else is printed around the message, as long as it is among the last lines", () => {
        assert.ok(detectUsageLimit("a\nb\nc\n5-hour limit reached ∙ resets 3pm\n\n", NOW));
    });

    const ordinaryFailures: readonly (readonly [string, string])[] = [
        ["a rate-limit throttle", "API Error: Rate limit reached"],
        ["a 429 error", "Error: 429 rate_limit_error: This request would exceed the rate limit"],
        ["a failing build", "npm ERR! code ELIFECYCLE\nnpm ERR! tai-framework@1.0.0 test: `node --test`\nnpm ERR! Exit status 1"],
        ["a run that was killed", "the run was killed by SIGTERM"],
        ["an ordinary finish", "Opened the PR for TAI-5 and recorded the check."],
        ["a test about limits", "ok 12 - the usage limit logic is tested\nok 13 - done"],
        ["a plain authentication failure", "Invalid API key · Please run /login"],
        ["empty output", ""],
    ];
    for (const [name, output] of ordinaryFailures) {
        it(`does not mistake ${name} for a usage limit`, () => {
            assert.equal(detectUsageLimit(output, NOW), null);
        });
    }

    // A run's own closing summary, which a ticket about limits can easily end with.
    const summaryLines: readonly (readonly [string, string])[] = [
        ["a bullet", "- detects the 5-hour limit reached message"],
        ["a starred bullet", "* handles: the usage limit reached case"],
        ["a numbered step", "3. the weekly limit reached output is parsed"],
        ["a quote", "> Claude usage limit reached|1793800000"],
        ["a heading", "## the usage limit reached path"],
        ["code", "`5-hour limit reached` is the message"],
        ["prose that talks about it", "Added detection of the 5-hour limit reached message."],
        // Not a bullet or a quote, but a closing line of a run that finished.
        ["a closing line that starts with the phrase", "Usage limit reached handling is now covered by tests"],
        ["a closing line with exceeded", "Weekly limit exceeded case added"],
        ["a closing line with hit", "5-hour limit hit detection is done"],
        ["a closing 'you've hit your limit' line", "You've hit your limit handling is covered by the new tests"],
        ["prose with the phrase in the middle", "The run stops when the usage limit is reached and resumes later."],
    ];
    for (const [name, line] of summaryLines) {
        it(`does not mistake ${name} in the closing summary for a usage limit`, () => {
            assert.equal(detectUsageLimit(`Opened the PR.\n${line}\nDone.`, NOW), null);
        });
    }

    it("still recognises the real message with a leading symbol, and the message that starts with a digit", () => {
        assert.ok(detectUsageLimit("⎿ 5-hour limit reached ∙ resets 3pm", NOW));
        assert.ok(detectUsageLimit("5-hour limit reached ∙ resets 3pm", NOW));
        assert.ok(detectUsageLimit("Opus weekly limit reached ∙ resets Nov 7, 10am", NOW));
    });

    it("still recognises each real form once the end of the message is required", () => {
        for (const real of ["Usage limit reached", "5-hour limit reached.", "Your usage limit has been reached.", "You've hit your limit", "Weekly limit reached - resets Nov 7, 10am", "Claude usage limit reached. Your limit will reset at 3pm (America/Denver).", "5-hour limit reached resets 3pm"]) {
            assert.ok(detectUsageLimit(`Working.\n${real}`, NOW), real);
        }
    });

    it("still finds the message with a few warnings printed after it", () => {
        const output = ["5-hour limit reached ∙ resets 3pm", ...Array.from({ length: 8 }, (_, i) => `(node:1) DeprecationWarning: ${i}`)].join("\n");
        assert.ok(detectUsageLimit(output, NOW));
    });

    it("ignores a limit message that is not near the end of the output", () => {
        const output = ["5-hour limit reached ∙ resets 3pm", ...Array.from({ length: 10 }, (_, i) => `line ${i}`)].join("\n");
        assert.equal(detectUsageLimit(output, NOW), null);
    });

    it("ignores a very long line that merely mentions a limit", () => {
        assert.equal(detectUsageLimit(`the usage limit was reached ${"x".repeat(400)}`, NOW), null);
    });
});

describe("a failed run that mentions a limit this detector does not know", () => {
    it("is reported by limitMention", () => {
        assert.equal(limitMention("working\nYou're out of extra usage · resets 3pm"), "You're out of extra usage · resets 3pm");
        assert.equal(limitMention("working\nSession limit: come back later"), "Session limit: come back later");
    });
    it("is not reported for a throttle, a summary line or an output that says nothing of a limit", () => {
        assert.equal(limitMention("API Error: Rate limit reached"), null);
        assert.equal(limitMention("- handled the usage limit"), null);
        assert.equal(limitMention("npm ERR! Exit status 1"), null);
    });
});

describe("reading a reset time", () => {
    it("takes a clock time that has already passed today as tomorrow's", () => {
        assert.equal(parseReset("resets 9am", NOW)?.getTime(), new Date(2026, 10, 5, 9, 0).getTime());
    });

    it("reads 12am and 12pm", () => {
        assert.equal(parseReset("resets 12am", NOW)?.getHours(), 0);
        assert.equal(parseReset("resets 12pm", NOW)?.getHours(), 12);
    });

    describe("on the clock of the zone the message names", () => {
        // 17:00Z on 2026-11-04: 10:00 in Denver (MST, UTC-7), 09:00 in Los Angeles (PST, UTC-8), 18:00 in Berlin (CET, UTC+1), 02:00 on the 5th in Tokyo.
        const at = new Date("2026-11-04T17:00:00Z");
        it("reads a clock time in that zone, whatever the machine's zone is", () => {
            assert.equal(parseReset("resets 3pm (America/Denver)", at)?.toISOString(), "2026-11-04T22:00:00.000Z");
            assert.equal(parseReset("resets 3pm (America/Los_Angeles)", at)?.toISOString(), "2026-11-04T23:00:00.000Z");
            assert.equal(parseReset("resets 3pm (Europe/Berlin)", at)?.toISOString(), "2026-11-05T14:00:00.000Z", "already past in Berlin today, so tomorrow's");
        });

        it("takes today in that zone, which can be another date than in UTC", () => {
            // 02:00 on the 5th in Tokyo: 1am is already past, so the next 1am is the 6th in Tokyo.
            assert.equal(parseReset("resets 1am (Asia/Tokyo)", at)?.toISOString(), "2026-11-05T16:00:00.000Z");
            assert.equal(parseReset("resets 11am (Asia/Tokyo)", at)?.toISOString(), "2026-11-05T02:00:00.000Z");
        });

        it("follows daylight saving: the same clock time is a different instant in summer", () => {
            const summer = new Date("2026-07-04T17:00:00Z");
            assert.equal(parseReset("resets 3pm (America/Denver)", summer)?.toISOString(), "2026-07-04T21:00:00.000Z", "MDT is UTC-6");
        });

        it("reads a date in that zone", () => {
            assert.equal(parseReset("resets Nov 7, 10am (America/Denver)", at)?.toISOString(), "2026-11-07T17:00:00.000Z");
        });

        it("reads a bare zone name such as UTC or GMT, which has no slash", () => {
            assert.equal(parseReset("resets 3pm (UTC)", at)?.toISOString(), "2026-11-05T15:00:00.000Z", "3pm UTC is already past at 17:00Z, so tomorrow's");
            assert.equal(parseReset("resets 3pm (GMT)", at)?.toISOString(), "2026-11-05T15:00:00.000Z");
        });

        it("falls back to the machine's clock for a zone name that is not one", () => {
            const local = new Date(2026, 10, 4, 10, 0);
            assert.equal(parseReset("resets 3pm (Not/AZone)", local)?.getTime(), new Date(2026, 10, 4, 15, 0).getTime());
        });
    });

    it("gives nothing for a time it cannot read", () => {
        assert.equal(parseReset("resets soon", NOW), undefined);
        assert.equal(parseReset("resets 13pm", NOW), undefined);
    });

    it("reads an epoch in seconds or milliseconds", () => {
        assert.equal(parseReset("limit|1793800000", NOW)?.getTime(), 1793800000 * 1000);
        assert.equal(parseReset("limit|1793800000000", NOW)?.getTime(), 1793800000000);
    });
});

describe("waiting for the reset", () => {
    const limit = { text: "5-hour limit reached", resetsAt: new Date(NOW.getTime() + 2 * 3_600_000) };

    it("waits until the reset, plus a margin, when wait= covers it", () => {
        assert.deepEqual(decideWait(limit, 6, NOW), { wait: true, ms: 2 * 3_600_000 + RESET_MARGIN_MS });
    });

    it("does not wait with no wait=", () => {
        assert.equal(decideWait(limit, undefined, NOW).wait, false);
    });

    it("does not wait for a reset beyond the cap, such as a weekly limit", () => {
        const weekly = { text: "Weekly limit reached", resetsAt: new Date(NOW.getTime() + 72 * 3_600_000) };
        const d = decideWait(weekly, 6, NOW);
        assert.equal(d.wait, false);
        assert.match((d as { why: string }).why, /further off than wait=6 hours/);
    });

    it("does not wait when the message gave no reset time", () => {
        assert.equal(decideWait({ text: "limit reached" }, 6, NOW).wait, false);
    });

    it("carries on at once for a reset that has already passed", () => {
        assert.deepEqual(decideWait({ text: "x", resetsAt: new Date(NOW.getTime() - 3_600_000 - RESET_MARGIN_MS) }, 6, NOW), { wait: true, ms: 0 });
    });

    it("allows a few waits in one run, not an endless number", () => {
        assert.ok(MAX_WAITS_PER_RUN >= 1 && MAX_WAITS_PER_RUN <= 5);
    });
});

describe("wait= values", () => {
    it("takes hours, whole or fractional", () => {
        assert.equal(parseWaitHours("6"), 6);
        assert.equal(parseWaitHours("0.5"), 0.5);
    });

    for (const bad of ["", "0", "-1", "abc", "6h", "169", "1e3", "NaN"]) {
        it(`refuses "${bad}"`, () => {
            assert.throws(() => parseWaitHours(bad), /wait= takes a number of hours/);
        });
    }
});

describe("the latch and the note", () => {
    it("keeps the first hit and clears", () => {
        const latch = new UsageLimitLatch();
        assert.equal(latch.current(), null);
        latch.hit({ text: "first" }, "build run");
        latch.hit({ text: "second" }, "review run");
        assert.deepEqual(latch.current(), { limit: { text: "first" }, stage: "build run" });
        latch.clear();
        assert.equal(latch.current(), null);
    });

    it("says a verification-run pause is after the merge, not an open PR", () => {
        const note = pausedHandoff({ text: "5-hour limit reached" }, "verification run");
        assert.match(note, /already merged[\s\S]*\/tai-verify/);
        assert.doesNotMatch(note, /already open/);
    });

    it("writes a neutral note that says where it stopped and when it resets", () => {
        const note = pausedHandoff({ text: "5-hour limit reached", resetsAt: new Date("2026-11-04T22:00:00Z") }, "review run");
        assert.match(note, /^Handoff: DEV-YOLO paused on a usage limit/);
        assert.match(note, /while this ticket's review run was running/);
        assert.match(note, /2026-11-04T22:00:00\.000Z/);
        assert.match(note, /not a failure of the ticket/);
        assert.doesNotMatch(note, /stopped on this ticket|fix what it names/);
    });
});

describe("the stage of a build run that ended on a limit", () => {
    it("is continuable with no open PR, and not when the PR is already open", async () => {
        assert.equal(await buildStageAfterLimit(async () => ({ prUrl: null })), "build run");
        assert.equal(await buildStageAfterLimit(async () => ({ prUrl: "https://pr/1" })), "build run (PR open)");
    });
    it("stays continuable when the PR cannot be looked up", async () => {
        assert.equal(await buildStageAfterLimit(async () => { throw new Error("host down"); }), "build run");
    });
});

describe("the position a pause note records", () => {
    const note = (position?: string) => pausedHandoff({ text: "5-hour limit reached" }, "build run", position);
    const tracker = (body: string) => ({ getIssue: async () => ({ comments: [{ body }] }) }) as never;

    it("is written into the note", () => {
        assert.match(note("TAI-1-x@abc1234"), /\nPosition: TAI-1-x@abc1234\n/);
        assert.doesNotMatch(note(), /Position:/);
    });

    it("counts only while the checkout still stands there", async () => {
        const t = tracker(note("TAI-1-x@abc1234"));
        assert.equal(await wasPausedOnLimit(t, "TAI-1" as never, "TAI-1-x@abc1234"), true);
        assert.equal(await wasPausedOnLimit(t, "TAI-1" as never, "TAI-1-x@def5678"), false, "committed since");
        assert.equal(await wasPausedOnLimit(t, "TAI-1" as never, "TAI-1-y@abc1234"), false, "another branch");
    });

    it("trusts a note with no position, and a checkout git cannot describe", async () => {
        assert.equal(await wasPausedOnLimit(tracker(note()), "TAI-1" as never, "TAI-1-x@abc1234"), true);
        assert.equal(await wasPausedOnLimit(tracker(note("TAI-1-x@abc1234")), "TAI-1" as never, undefined), true);
    });

    it("is attached by the hand-off wrapper, and a failing lookup still posts the note", async () => {
        const latch = new UsageLimitLatch();
        latch.hit({ text: "5-hour limit reached" }, "build run");
        const posted: string[] = [];
        await pausedAwareHandoff(latch, async (_k, b) => void posted.push(b), async () => "b@c")("TAI-1", "ignored");
        await pausedAwareHandoff(latch, async (_k, b) => void posted.push(b), async () => { throw new Error("no git"); })("TAI-1", "ignored");
        assert.match(posted[0]!, /Position: b@c/);
        assert.match(posted[1]!, /^Handoff: DEV-YOLO paused/);
        assert.doesNotMatch(posted[1]!, /Position:/);
    });
});

describe("PauseReads: one answer per attempt", () => {
    const reads = (answers: boolean[]) => {
        const log: string[] = [];
        return { log, pauses: new PauseReads(async (k) => (log.push(k), answers.shift() ?? false)) };
    };

    it("reads once while picking, uses that for preparation, and hands preparation's answer to the build, each once", async () => {
        const { log, pauses } = reads([true]);
        assert.equal(await pauses.whilePicking("TAI-10" as never), true);
        assert.equal(await pauses.forPrepare("TAI-10" as never), true);
        assert.equal(await pauses.forBuild("TAI-10" as never), true);
        assert.deepEqual(log, ["TAI-10"], "a single read for the whole attempt");
    });

    it("uses what this run remembered, with no read, for the next preparation and its build", async () => {
        const { log, pauses } = reads([false]);
        pauses.remember("TAI-10" as never);
        assert.equal(await pauses.forPrepare("TAI-10" as never), true);
        assert.equal(await pauses.forBuild("TAI-10" as never), true);
        assert.deepEqual(log, []);
    });

    it("reads afresh for the next attempt, so a retry after a wait sees the new note", async () => {
        const { log, pauses } = reads([true, false]);
        await pauses.forPrepare("TAI-10" as never);
        await pauses.forBuild("TAI-10" as never);
        assert.equal(await pauses.forPrepare("TAI-10" as never), false);
        assert.equal(log.length, 2);
    });

    it("a build with no preparation reads, and a failed read does not fail the ticket", async () => {
        const pauses = new PauseReads(async () => { throw new Error("jira down"); });
        assert.equal(await pauses.forBuild("TAI-10" as never), false);
        await assert.rejects(pauses.forPrepare("TAI-10" as never), /jira down/, "preparation still reports it: it decides the branch");
    });
});

describe("sleeping until the reset", () => {
    it("waits the time given", async () => {
        const start = Date.now();
        const { sleepUnlessInterrupted } = await import("./usage-limit.js");
        await sleepUnlessInterrupted(60, () => false, 20);
        assert.ok(Date.now() - start >= 55);
    });

    it("ends within a step of an interrupt, not after the whole wait", async () => {
        const { sleepUnlessInterrupted } = await import("./usage-limit.js");
        let stop = false;
        setTimeout(() => (stop = true), 30);
        const start = Date.now();
        await sleepUnlessInterrupted(10_000, () => stop, 20);
        assert.ok(Date.now() - start < 500);
    });
});
