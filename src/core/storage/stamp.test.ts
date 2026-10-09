import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { parseCommentMarkers } from "./comment-markers.js";
import type { Comment } from "./interface.js";
import { isStamped, reviewDecisionComment, signOffComment, stampComment, stampLine } from "./stamp.js";

const perry = { id: "pm", displayName: "Perry" };

describe("stampLine", () => {
    it("names the persona the command was run as", () => {
        assert.equal(stampLine(perry), "Posted via the TAI CLI as Perry (pm).");
    });

    it("says only that it came through the CLI when no persona was named", () => {
        assert.equal(stampLine(), "Posted via the TAI CLI.");
    });

    it("does not repeat an id that doubles as the display name (a user-added persona)", () => {
        assert.equal(stampLine({ id: "release-manager", displayName: "release-manager" }), "Posted via the TAI CLI as release-manager.");
    });
});

describe("stampComment", () => {
    it("puts the stamp on its own line at the end, after a blank line", () => {
        assert.equal(stampComment("Looks right.\n", perry), "Looks right.\n\nPosted via the TAI CLI as Perry (pm).");
    });

    it("replaces a stamp the body already ends with instead of doubling it", () => {
        const once = stampComment("Looks right.", perry);
        assert.equal(stampComment(once, perry), once);
        assert.equal(stampComment("Looks right.\n\nPosted via the TAI CLI.", perry), once);
    });

    it("isStamped recognises both forms and nothing else", () => {
        assert.equal(isStamped(stampComment("x")), true);
        assert.equal(isStamped(stampComment("x", perry)), true);
        assert.equal(isStamped("Posted via the TAI CLI as Perry (pm).\n\nmore text"), false);
        assert.equal(isStamped("Approved: fine"), false);
    });

    it("leaves a first-line marker readable by the marker scan", () => {
        const body = stampComment("Approved: PRD and UX flows agree.", perry);
        const markers = parseCommentMarkers([{ body, author: { id: "u" } } as unknown as Comment]);
        assert.equal(markers[0]?.kind, "Approved");
    });
});

describe("signOffComment", () => {
    it("is left for a UAT, EpicReview or DesignReview subtask, or an Epic, moved to Done", () => {
        for (const issueType of [SubtaskType.Uat, SubtaskType.EpicReview, SubtaskType.DesignReview, "epic"] as const) {
            const comment = signOffComment({ issueType }, Status.Done, perry);
            assert.ok(comment?.startsWith("Sign-off: "), issueType);
            assert.ok(comment?.endsWith("Posted via the TAI CLI as Perry (pm)."), issueType);
        }
        assert.ok(signOffComment({ issueType: SubtaskType.Uat }, Status.Done)?.includes('UAT moved to "Done"'));
    });

    it("is not left for any other ticket type or any other target", () => {
        assert.equal(signOffComment({ issueType: SubtaskType.Dev }, Status.Done, perry), null);
        assert.equal(signOffComment({ issueType: StoryType.Story }, Status.Done, perry), null);
        assert.equal(signOffComment({ issueType: StoryType.Bug }, Status.Done, perry), null);
        assert.equal(signOffComment({ issueType: SubtaskType.Uat }, Status.InProgress, perry), null);
        assert.equal(signOffComment({ issueType: "epic" }, Status.Canceled, perry), null);
    });
});

describe("reviewDecisionComment", () => {
    it("records an approval, keeping the reviewer's own note first", () => {
        assert.equal(
            reviewDecisionComment("approve", "Reads well.", perry),
            "Reads well.\n\nApproved through the TAI CLI.\n\nPosted via the TAI CLI as Perry (pm)."
        );
    });

    it("records a decision that came with no note", () => {
        assert.equal(reviewDecisionComment("requestChanges", undefined), "Changes requested through the TAI CLI.\n\nPosted via the TAI CLI.");
    });
});
