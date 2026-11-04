import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decideWait, detectUsageLimit, MAX_WAITS_PER_RUN, parseReset, parseWaitHours, pausedHandoff, RESET_MARGIN_MS, UsageLimitLatch } from "./usage-limit.js";

// A fixed local "now": 2026-11-04 10:00 on the machine's own clock, so clock-time resets read the same everywhere.
const NOW = new Date(2026, 10, 4, 10, 0, 0);

/**
 * NOT RECORDED FROM A REAL HIT (TAI-706, AC-1 as amended): a real hit would use up the account. These are the messages Claude Code
 * is documented or reported to print, as the last output of a `claude -p` run. Replace them with a captured sample when one exists.
 */
const REPORTED_LIMIT_MESSAGES: readonly { readonly name: string; readonly output: string; readonly resetsAt?: Date }[] = [
    { name: "older epoch form", output: "Claude AI usage limit reached|1793800000", resetsAt: new Date(1793800000 * 1000) },
    { name: "5-hour limit with a clock time", output: "5-hour limit reached ∙ resets 3pm", resetsAt: new Date(2026, 10, 4, 15, 0) },
    { name: "hit your limit with minutes and a zone", output: "You've hit your limit · resets 3:30pm (America/Denver)", resetsAt: new Date(2026, 10, 4, 15, 30) },
    { name: "prose form", output: "Claude usage limit reached. Your limit will reset at 3pm (America/Denver).", resetsAt: new Date(2026, 10, 4, 15, 0) },
    { name: "weekly limit with a date", output: "Weekly limit reached ∙ resets Nov 7, 10am", resetsAt: new Date(2026, 10, 7, 10, 0) },
    { name: "no reset time", output: "Your usage limit has been reached." },
];

describe("detecting a usage limit (TAI-706)", () => {
    for (const sample of REPORTED_LIMIT_MESSAGES) {
        it(`recognises the ${sample.name}`, () => {
            const found = detectUsageLimit(`Working on it...\nrunning tests\n${sample.output}\n`, NOW);
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

    it("ignores a limit message that is not near the end of the output", () => {
        const output = ["5-hour limit reached ∙ resets 3pm", "one", "two", "three", "four", "five", "six"].join("\n");
        assert.equal(detectUsageLimit(output, NOW), null);
    });

    it("ignores a very long line that merely mentions a limit", () => {
        assert.equal(detectUsageLimit(`the usage limit was reached ${"x".repeat(400)}`, NOW), null);
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

    it("does not wait for a reset that has already passed", () => {
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

    it("writes a neutral note that says where it stopped and when it resets", () => {
        const note = pausedHandoff({ text: "5-hour limit reached", resetsAt: new Date("2026-11-04T22:00:00Z") }, "review run");
        assert.match(note, /^Handoff: DEV-YOLO paused on a usage limit/);
        assert.match(note, /while this ticket's review run was running/);
        assert.match(note, /2026-11-04T22:00:00\.000Z/);
        assert.match(note, /not a failure of the ticket/);
        assert.doesNotMatch(note, /stopped on this ticket|fix what it names/);
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
