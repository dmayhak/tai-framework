import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { Status } from "../schema/story-schema.js";
import { branchHasCommitsBeyond } from "./dev-tasks-git.js";
import { newestCommentIsOwnPause, pausedHandoff } from "./usage-limit.js";
import { servicePickupReason, stillToDoReason } from "./service-pickup.js";

const limit = { text: "5-hour limit reached" };
const pause = (position?: string, stage = "build run") => pausedHandoff(limit, stage, position);
const at = (minutes: number): string => new Date(Date.UTC(2026, 10, 19, 10, minutes)).toISOString();
const comment = (body: string, minutes: number) => ({ body, createdAt: at(minutes) });

describe("newestCommentIsOwnPause (TAI-773 AC-1, AC-2)", () => {
    it("is ok when the newest comment is the service's own pause note, and gives its recorded position", () => {
        const r = newestCommentIsOwnPause([comment("Handoff: earlier", 1), comment(pause("TAI-5-x@abc1234"), 2)]);
        assert.deepEqual(r, { ok: true, position: "TAI-5-x@abc1234" });
    });

    it("is not ok when any comment, handoff or not, came after the pause note", () => {
        const r = newestCommentIsOwnPause([comment(pause("TAI-5-x@abc1234"), 1), comment("I'm looking at this one myself", 2)]);
        assert.equal(r.ok, false);
        assert.match((r as { reason: string }).reason, /came after the service's usage-limit pause note/);
    });

    it("is not ok when the newest hand-off is another stop, or there are no comments", () => {
        for (const body of ['Handoff: "Do all dev tasks" stopped on this ticket. tests failed', pause("TAI-5-x@abc1234", "review run"), "a plain comment"]) {
            const r = newestCommentIsOwnPause([comment(body, 1)]);
            assert.equal(r.ok, false, body);
            assert.match((r as { reason: string }).reason, /not the service's usage-limit pause note/);
        }
        assert.equal(newestCommentIsOwnPause([]).ok, false);
    });

    it("orders by the comment's own time, not the list order, and cannot tell when a time is unreadable", () => {
        assert.equal(newestCommentIsOwnPause([comment(pause("a@b"), 2), comment("later person comment", 3)]).ok, false);
        assert.equal(newestCommentIsOwnPause([comment("earlier", 1), comment(pause("a@b"), 2)]).ok, true);
        assert.equal(newestCommentIsOwnPause([{ body: pause("a@b"), createdAt: "not a time" }, comment("x", 1)]).ok, false);
    });
});

describe("servicePickupReason (TAI-773 AC-1, AC-2)", () => {
    const tracker = (...comments: { body: string; createdAt: string }[]) => ({ getIssue: async () => ({ comments }) as never });
    const never = async (): Promise<boolean | null> => {
        throw new Error("git must not be asked");
    };

    it("resumes a ticket whose newest comment is the pause note and whose branch has no outside commits", async () => {
        let asked = "";
        const why = await servicePickupReason({ workTracker: tracker(comment(pause("TAI-5-x@abc1234"), 1)), branchHasCommitsBeyond: async (b, c) => ((asked = `${b} ${c}`), false) }, { key: "TAI-10" as never });
        assert.equal(why, null);
        assert.equal(asked, "TAI-5-x abc1234");
    });

    it("leaves a ticket alone when a comment came after the pause, without asking git", async () => {
        const why = await servicePickupReason({ workTracker: tracker(comment(pause("TAI-5-x@abc1234"), 1), comment("mine", 2)), branchHasCommitsBeyond: never }, { key: "TAI-10" as never });
        assert.match(why ?? "", /a person has touched it/);
    });

    it("leaves a ticket alone when its newest hand-off is another stop", async () => {
        const why = await servicePickupReason({ workTracker: tracker(comment('Handoff: "Do all dev tasks" stopped on this ticket. x', 1)), branchHasCommitsBeyond: never }, { key: "TAI-10" as never });
        assert.match(why ?? "", /a person is working it or it stopped for another reason/);
    });

    it("leaves a ticket alone when the branch has a commit from outside the clone since the pause", async () => {
        const why = await servicePickupReason({ workTracker: tracker(comment(pause("TAI-5-x@abc1234"), 1)), branchHasCommitsBeyond: async () => true }, { key: "TAI-10" as never });
        assert.match(why ?? "", /a commit on TAI-5-x came from outside the service's clone/);
    });

    it("leaves a ticket alone when it cannot be told: no recorded position, a position git does not know, or an unreadable ticket", async () => {
        assert.match((await servicePickupReason({ workTracker: tracker(comment(pause(), 1)), branchHasCommitsBeyond: never }, { key: "TAI-10" as never })) ?? "", /records no checkout position/);
        assert.match((await servicePickupReason({ workTracker: tracker(comment(pause("TAI-5-x@abc1234"), 1)), branchHasCommitsBeyond: async () => null }, { key: "TAI-10" as never })) ?? "", /not in this clone/);
        assert.match((await servicePickupReason({ workTracker: { getIssue: async () => null }, branchHasCommitsBeyond: never }, { key: "TAI-10" as never })) ?? "", /cannot be read/);
    });
});

describe("stillToDoReason (TAI-773 AC-3)", () => {
    it("is null while the ticket is To Do and says who moved it otherwise", async () => {
        const status = (s: string) => ({ getIssue: async () => ({ status: s }) as never });
        assert.equal(await stillToDoReason(status(Status.ToDo), { key: "TAI-10" as never }), null);
        assert.match((await stillToDoReason(status(Status.InProgress), { key: "TAI-10" as never })) ?? "", /no longer To Do \(it is In Progress\)/);
        assert.match((await stillToDoReason({ getIssue: async () => null }, { key: "TAI-10" as never })) ?? "", /cannot be read/);
    });
});

describe("branchHasCommitsBeyond", () => {
    it("tells a commit pushed to the branch from outside the clone from none, and an unknown recorded commit", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-pickup-"));
        try {
            const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", ...a], { cwd, stdio: "pipe" }).toString().trim();
            const origin = path.join(dir, "origin.git");
            git(dir, "init", "-q", "--bare", "-b", "main", origin);
            const clone = path.join(dir, "clone");
            git(dir, "clone", "-q", origin, clone);
            await writeFile(path.join(clone, "a"), "1");
            git(clone, "add", ".");
            git(clone, "commit", "-q", "-m", "one");
            git(clone, "checkout", "-q", "-b", "TAI-5-x");
            await writeFile(path.join(clone, "b"), "2");
            git(clone, "add", ".");
            git(clone, "commit", "-q", "-m", "two");
            const recorded = git(clone, "rev-parse", "--short", "HEAD");
            assert.equal(await branchHasCommitsBeyond(clone, "TAI-5-x", recorded), false, "nothing pushed yet: no remote branch");
            git(clone, "push", "-q", "origin", "TAI-5-x");
            git(clone, "fetch", "-q");
            assert.equal(await branchHasCommitsBeyond(clone, "TAI-5-x", recorded), false, "pushed by the clone itself, nothing beyond");
            // Someone else pushes another commit from their own checkout.
            const other = path.join(dir, "other");
            git(dir, "clone", "-q", "-b", "TAI-5-x", origin, other);
            await writeFile(path.join(other, "c"), "3");
            git(other, "add", ".");
            git(other, "commit", "-q", "-m", "three");
            git(other, "push", "-q", "origin", "TAI-5-x");
            git(clone, "fetch", "-q");
            assert.equal(await branchHasCommitsBeyond(clone, "TAI-5-x", recorded), true);
            assert.equal(await branchHasCommitsBeyond(clone, "TAI-5-x", "deadbee"), null, "a commit this clone does not have cannot be compared");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
