import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { acceptanceCriteria, findNotVerified, hasVerification, isVerification, latestVerification, unverifiedCloseNote } from "./verification.js";
import { StoryType, SubtaskType } from "../schema/story-schema.js";
import type { Comment, HumanId } from "./interface.js";

const comment = (id: string, body: string): Comment => ({
    id,
    author: { id: "u" as HumanId, displayName: "U", email: "u@example.com" },
    body,
    createdAt: `2026-10-13T00:00:0${id}Z`,
    updatedAt: `2026-10-13T00:00:0${id}Z`,
});

describe("isVerification (TAI-546)", () => {
    it("matches Verified: and Not verified: on the first line, in any case", () => {
        assert.ok(isVerification("Verified: all 3 criteria met"));
        assert.ok(isVerification("Not verified: 1 of 3 criteria not met\n* AC-2 — not met"));
        assert.ok(isVerification("  verified:x"));
        assert.ok(isVerification("NOT   VERIFIED: x"));
    });

    it("does not match the word further into a comment, or without the colon", () => {
        assert.ok(!isVerification("Handoff: Verified: later"));
        assert.ok(!isVerification("First line\nVerified: yes"));
        assert.ok(!isVerification("Verified by Tessa"));
        assert.ok(!isVerification("Unverified: no"));
    });
});

describe("hasVerification / latestVerification", () => {
    it("finds a marker among other comments and returns the latest one", () => {
        const comments = [comment("1", "Verified: all 1 criteria met"), comment("2", "thanks"), comment("3", "Not verified: 1 of 1 criteria not met")];
        assert.ok(hasVerification(comments));
        assert.equal(latestVerification(comments)?.id, "3");
    });

    it("is false/null with no marker", () => {
        assert.ok(!hasVerification([comment("1", "Handoff: next")]));
        assert.equal(latestVerification([]), null);
    });
});

describe("acceptanceCriteria", () => {
    it("returns the AC-n lines, trimmed, in order, as list items or bold", () => {
        const description = "Intro.\n\n* AC-1 the first\n  AC-2 the second\n**AC-4** bold\nplain AC-5 mid-line";
        assert.deepEqual(acceptanceCriteria(description), ["* AC-1 the first", "AC-2 the second", "**AC-4** bold"]);
    });

    it("is empty without a description or without criteria", () => {
        assert.deepEqual(acceptanceCriteria(undefined), []);
        assert.deepEqual(acceptanceCriteria("no criteria here"), []);
    });
});

describe("unverifiedCloseNote (TAI-546)", () => {
    const base = { key: "TAI-9" as never, comments: [] as Comment[] };

    it("warns for a Story or Bug with no verification comment, naming the command", () => {
        for (const issueType of [StoryType.Story, StoryType.Bug] as const) {
            const note = unverifiedCloseNote({ ...base, issueType });
            assert.match(note ?? "", /TAI-9 has no Verified: or Not verified: comment/);
            assert.match(note ?? "", /`verify TAI-9`/);
        }
    });

    it("is silent once a verification comment exists, either kind", () => {
        assert.equal(unverifiedCloseNote({ ...base, issueType: StoryType.Story, comments: [comment("1", "Not verified: 1 of 2 criteria not met")] }), null);
        assert.equal(unverifiedCloseNote({ ...base, issueType: StoryType.Bug, comments: [comment("1", "Verified: all 2 criteria met")] }), null);
    });

    it("is silent for every other type", () => {
        for (const issueType of [StoryType.Kickoff, StoryType.Spike, "epic", SubtaskType.Dev] as const) {
            assert.equal(unverifiedCloseNote({ ...base, issueType }), null);
        }
    });
});

describe("findNotVerified (TAI-550)", () => {
    const issue = (key: string, issueType: string, comments: Comment[] = []): never =>
        ({ key, issueType, status: "In Progress", summary: "s", labels: [], comments }) as never;
    const dev = (status: string): never => ({ key: "TAI-9", issueType: SubtaskType.Dev, status }) as never;
    const tracker = (devsByParent: Record<string, never[]>) => ({
        search: async (q: { parentKey?: string }) => devsByParent[q.parentKey ?? ""] ?? [],
    });

    it("includes a Story or Bug whose Dev subtasks are all Done (canceled ones ignored) and which has no verification comment", async () => {
        const got = await findNotVerified(
            tracker({ "TAI-1": [dev("Done")], "TAI-2": [dev("Done"), dev("Canceled")] }),
            "TAI",
            [issue("TAI-1", StoryType.Story), issue("TAI-2", StoryType.Bug)]
        );
        assert.deepEqual([...got].sort(), ["TAI-1", "TAI-2"]);
    });

    it("leaves out a verified one, one with an open Dev subtask, one with no Dev subtask, and other ticket types", async () => {
        const got = await findNotVerified(
            tracker({ "TAI-1": [dev("Done")], "TAI-2": [dev("Done"), dev("In Progress")], "TAI-4": [dev("Done")] }),
            "TAI",
            [
                issue("TAI-1", StoryType.Story, [comment("1", "Not verified: 1 of 2 criteria not met")]),
                issue("TAI-2", StoryType.Story),
                issue("TAI-3", StoryType.Story),
                issue("TAI-4", StoryType.Kickoff),
            ]
        );
        assert.deepEqual([...got], []);
    });
});
