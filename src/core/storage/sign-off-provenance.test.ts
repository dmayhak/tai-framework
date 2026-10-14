import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { toHumanId, type Comment, type Issue } from "./interface.js";
import { signOffRowNote, signOffProvenance, renderSignOffProvenance } from "./sign-off-provenance.js";
import { signOffComment, stampComment } from "./stamp.js";

const perry = { id: "pm", displayName: "Perry" };
const ursula = { id: "ux-designer", displayName: "Ursula" };

let n = 0;
const comment = (body: string, author = "del"): Comment => ({
    id: String(++n),
    author: { id: toHumanId(author), displayName: author },
    body,
    createdAt: "2026-10-14T10:00:00.000-0600",
    updatedAt: "2026-10-14T10:00:00.000-0600",
});

const issue = (issueType: Issue["issueType"], status: Status, comments: readonly Comment[] = []): Issue => ({
    key: "TAI-1" as Issue["key"],
    projectKey: "TAI",
    issueType,
    summary: "s",
    status,
    assignee: null,
    persona: null,
    labels: [],
    createdAt: "2026-10-14T10:00:00.000-0600",
    updatedAt: "2026-10-14T10:00:00.000-0600",
    comments,
});

describe("signOffProvenance: Kickoff Approved: comments", () => {
    it("is not signed off with no Approved: comment", () => {
        const r = signOffProvenance(issue(StoryType.Kickoff, Status.InProgress, [comment("Looks good so far.")]));
        assert.equal(r?.provenance, "not-signed-off");
        assert.deepEqual(r?.approvals, []);
    });

    it("is via the TAI CLI when every Approved: comment is stamped", () => {
        const r = signOffProvenance(
            issue(StoryType.Kickoff, Status.InProgress, [
                comment(stampComment("Approved: PRD matches the flows.", perry)),
                comment(stampComment("Approved: flows match the PRD.", ursula)),
            ])
        );
        assert.equal(r?.provenance, "via-cli");
        assert.deepEqual(
            r?.approvals.map((a) => a.provenance),
            ["via-cli", "via-cli"]
        );
        assert.equal(r?.approvals[0]?.actingAs, "Perry (pm)");
    });

    it("is direct when an Approved: comment has no stamp", () => {
        const r = signOffProvenance(issue(StoryType.Kickoff, Status.InProgress, [comment("Approved: fine by me.")]));
        assert.equal(r?.provenance, "direct");
        assert.equal(r?.approvals[0]?.actingAs, undefined);
    });

    it("is direct, listing each approval, when only one of two went through the CLI", () => {
        const r = signOffProvenance(
            issue(StoryType.Kickoff, Status.InProgress, [comment(stampComment("Approved: PRD ok.", perry)), comment("Approved: flows ok.", "ursula")])
        );
        assert.equal(r?.provenance, "direct");
        assert.deepEqual(
            r?.approvals.map((a) => [a.author, a.provenance]),
            [
                ["del", "via-cli"],
                ["ursula", "direct"],
            ]
        );
    });

    it("ignores a stamp-looking line that is not the last line, and an Approved: that is not the first line", () => {
        const r = signOffProvenance(
            issue(StoryType.Kickoff, Status.InProgress, [
                comment("Approved: ok\n\nPosted via the TAI CLI as Perry (pm).\n\nand more"),
                comment("note\nApproved: not a marker"),
            ])
        );
        assert.equal(r?.provenance, "direct");
        assert.equal(r?.approvals.length, 1);
    });
});

describe("signOffProvenance: UAT, EpicReview, DesignReview and Epic closes", () => {
    const closes: readonly [string, Issue["issueType"]][] = [
        ["UAT", SubtaskType.Uat],
        ["EpicReview", SubtaskType.EpicReview],
        ["DesignReview", SubtaskType.DesignReview],
        ["Epic", "epic"],
    ];

    for (const [label, type] of closes) {
        const companion = signOffComment({ issueType: type }, Status.Done, perry)!;

        it(`${label}: Done with the CLI's sign-off companion comment is via the TAI CLI`, () => {
            const r = signOffProvenance(issue(type, Status.Done, [comment("Accepted."), comment(companion)]));
            assert.equal(r?.provenance, "via-cli");
            assert.equal(r?.approvals[0]?.actingAs, "Perry (pm)");
        });

        it(`${label}: Done with no companion comment was closed directly`, () => {
            assert.equal(signOffProvenance(issue(type, Status.Done, [comment("Accepted.")]))?.provenance, "direct");
        });

        it(`${label}: not Done is not signed off, even with a companion comment left by an earlier close`, () => {
            assert.equal(signOffProvenance(issue(type, Status.InProgress))?.provenance, "not-signed-off");
            assert.equal(signOffProvenance(issue(type, Status.ToDo, [comment(companion)]))?.provenance, "not-signed-off");
        });

        it(`${label}: Canceled is not a sign-off at all`, () => {
            assert.equal(signOffProvenance(issue(type, Status.Canceled)), null);
        });

        it(`${label}: a hand-typed Sign-off: line with no stamp does not count as via the TAI CLI`, () => {
            const typed = comment(`Sign-off: ${label} moved to "Done" through the TAI CLI.`);
            assert.equal(signOffProvenance(issue(type, Status.Done, [typed]))?.provenance, "direct");
        });
    }
});

describe("signOffProvenance: canceled and reopened", () => {
    it("a canceled Kickoff is not a sign-off, with or without Approved: comments", () => {
        assert.equal(signOffProvenance(issue(StoryType.Kickoff, Status.Canceled)), null);
        assert.equal(signOffProvenance(issue(StoryType.Kickoff, Status.Canceled, [comment(stampComment("Approved: ok", perry))])), null);
    });

    it("documents the known limit: an old companion comment still reads as via the TAI CLI after a later direct close", () => {
        const earlier = comment(signOffComment({ issueType: SubtaskType.Uat }, Status.Done, perry)!);
        const r = signOffProvenance(issue(SubtaskType.Uat, Status.Done, [earlier, comment("Reopened: missed a case."), comment("Accepted now.")]));
        assert.equal(r?.provenance, "via-cli");
    });
});

describe("signOffProvenance: tickets that are not sign-offs", () => {
    it("is null for a Story, Bug, Dev subtask and the like (closing those is not a sign-off)", () => {
        for (const type of [StoryType.Story, StoryType.Bug, StoryType.Spike, SubtaskType.Dev, SubtaskType.Research]) {
            assert.equal(signOffProvenance(issue(type, Status.Done, [comment("Approved: yes")])), null, type);
        }
    });
});

describe("renderSignOffProvenance and signOffRowNote", () => {
    it("says plainly how each classification was reached", () => {
        const cli = signOffProvenance(issue("epic", Status.Done, [comment(signOffComment({ issueType: "epic" }, Status.Done, perry)!)]))!;
        assert.match(renderSignOffProvenance(cli), /Epic.*through the TAI CLI as Perry \(pm\)/);

        const direct = signOffProvenance(issue(SubtaskType.Uat, Status.Done))!;
        assert.match(renderSignOffProvenance(direct), /UAT.*directly/);

        const open = signOffProvenance(issue(SubtaskType.EpicReview, Status.ToDo))!;
        assert.match(renderSignOffProvenance(open), /EpicReview.*not signed off/);
    });

    it("lists each Kickoff approval", () => {
        const text = renderSignOffProvenance(
            signOffProvenance(
                issue(StoryType.Kickoff, Status.InProgress, [comment(stampComment("Approved: ok", perry)), comment("Approved: ok too", "ursula")])
            )!
        );
        assert.match(text, /del.*through the TAI CLI as Perry \(pm\)/);
        assert.match(text, /ursula.*directly/);
    });

    it("signOffRowNote is empty for a ticket with nothing signed off, and for one that is not a sign-off", () => {
        assert.equal(signOffRowNote(issue(StoryType.Kickoff, Status.InProgress)), "");
        assert.equal(signOffRowNote(issue(SubtaskType.Uat, Status.ToDo)), "");
        assert.equal(signOffRowNote(issue(StoryType.Story, Status.InProgress)), "");
    });

    it("signOffRowNote carries the sign-off for a ticket that has one", () => {
        assert.match(signOffRowNote(issue(StoryType.Kickoff, Status.InProgress, [comment("Approved: ok")])), /^ — sign-off: .*directly/);
    });
});
