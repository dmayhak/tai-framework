import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status, StoryType } from "../schema/story-schema.js";
import { toIssueKey, toPageId, type Comment, type Issue, type IssueFilter, type IssueKey, type Page, type PageId } from "../storage/interface.js";
import { findEditedAfterApproval, latestApprovalAt, renderEditedAfterApproval, tryFindEditedAfterApproval } from "./edited-after-approval.js";

const comment = (id: string, body: string, at: string, editedAt = at): Comment => ({ id, body, createdAt: at, updatedAt: editedAt, author: { id: "u1", displayName: "Del" } }) as Comment;
const issue = (key: string, issueType: string, status: Status, over: Partial<Issue> = {}): Issue =>
    ({ key: toIssueKey(key), projectKey: "TAI", issueType, status, summary: `${key} summary`, comments: [], labels: [], ...over }) as unknown as Issue;
const page = (id: string, title: string, updatedAt: string): Page => ({ id: toPageId(id), title, updatedAt, content: "", spaceKey: "TA", createdAt: updatedAt, comments: [] }) as Page;

function world(issues: Issue[], links: Record<string, string[]>, pages: Page[]) {
    const reads = { getIssue: 0, getPage: 0 };
    return {
        reads,
        deps: {
            projectKey: "TAI",
            workTracker: {
                search: async (f: IssueFilter) => issues.filter((i) => (f.issueTypes ?? []).includes(i.issueType as never) && (f.statuses ?? []).includes(i.status)).map((i) => ({ ...i, comments: [] })),
                getIssue: async (key: IssueKey) => (reads.getIssue++, issues.find((i) => i.key === key) ?? null),
                getLinkedPages: async (key: IssueKey) => (links[key] ?? []).map(toPageId),
            },
            docStore: { getPage: async (ref: { id: PageId } | { spaceKey: string; title: string }) => (reads.getPage++, pages.find((p) => "id" in ref && p.id === ref.id) ?? null) },
        } as never,
    };
}

const APPROVED = "2026-10-01T10:00:00Z";
const epic = issue("TAI-1", "epic", Status.InProgress);
const kickoff = issue("TAI-2", StoryType.Kickoff, Status.Done, { parentKey: toIssueKey("TAI-1"), comments: [comment("c1", "Approved: PRD and flows agree", APPROVED)] });

describe("pages edited after their Kickoff was approved (TAI-481)", () => {
    it("lists a linked page updated after the Kickoff's latest Approved: comment, and not one updated before", async () => {
        const w = world([epic, kickoff], { "TAI-2": ["10", "11"] }, [page("10", "PRD", "2026-10-03T09:00:00Z"), page("11", "UX flows", "2026-09-30T09:00:00Z")]);
        const found = await findEditedAfterApproval(w.deps);
        assert.deepEqual(found, [
            { kickoffKey: "TAI-2", kickoffSummary: "TAI-2 summary", pageId: "10", pageTitle: "PRD", approvedAt: APPROVED, editedAt: "2026-10-03T09:00:00Z" },
        ]);
    });

    it("reads the Kickoff fresh for its comments: a search result may not carry them", async () => {
        const w = world([epic, kickoff], { "TAI-2": ["10"] }, [page("10", "PRD", "2026-10-03T09:00:00Z")]);
        assert.equal((await findEditedAfterApproval(w.deps)).length, 1);
        assert.equal(w.reads.getIssue, 1);
    });

    it("looks only at Done Kickoffs whose Epic is still open", async () => {
        const closedEpic = issue("TAI-5", "epic", Status.Done);
        const underClosed = issue("TAI-6", StoryType.Kickoff, Status.Done, { parentKey: toIssueKey("TAI-5"), comments: kickoff.comments });
        const notDone = issue("TAI-7", StoryType.Kickoff, Status.InReview, { parentKey: toIssueKey("TAI-1"), comments: kickoff.comments });
        const w = world([epic, closedEpic, underClosed, notDone], { "TAI-6": ["10"], "TAI-7": ["10"] }, [page("10", "PRD", "2026-10-03T09:00:00Z")]);
        assert.deepEqual(await findEditedAfterApproval(w.deps), []);
        assert.equal(w.reads.getPage, 0);
    });

    it("skips a Kickoff with no Approved: comment, and a linked page that no longer exists", async () => {
        const unapproved = issue("TAI-8", StoryType.Kickoff, Status.Done, { parentKey: toIssueKey("TAI-1") });
        const w = world([epic, unapproved, kickoff], { "TAI-8": ["10"], "TAI-2": ["99"] }, [page("10", "PRD", "2026-10-03T09:00:00Z")]);
        assert.deepEqual(await findEditedAfterApproval(w.deps), []);
    });

    it("narrows to one Epic when asked", async () => {
        const otherEpic = issue("TAI-20", "epic", Status.ToDo);
        const otherKickoff = issue("TAI-21", StoryType.Kickoff, Status.Done, { parentKey: toIssueKey("TAI-20"), comments: kickoff.comments });
        const w = world([epic, kickoff, otherEpic, otherKickoff], { "TAI-2": ["10"], "TAI-21": ["10"] }, [page("10", "PRD", "2026-10-03T09:00:00Z")]);
        const found = await findEditedAfterApproval({ ...(w.deps as object), epicKey: toIssueKey("TAI-20") } as never);
        assert.deepEqual(found.map((f) => f.kickoffKey), ["TAI-21"]);
    });

    it("latestApprovalAt takes the latest Approved: comment, counting an edit, and ignores other comments", () => {
        const comments = [comment("c1", "Approved: first", "2026-10-01T10:00:00Z"), comment("c2", "A note", "2026-10-09T10:00:00Z"), comment("c3", "Approved: second", "2026-10-02T10:00:00Z", "2026-10-04T10:00:00Z")];
        assert.equal(latestApprovalAt({ comments }), "2026-10-04T10:00:00Z");
        assert.equal(latestApprovalAt({ comments: [comment("c2", "A note", "2026-10-09T10:00:00Z")] }), null);
    });

    it("a failure in the check yields nothing instead of breaking the command", async () => {
        const failing = { projectKey: "TAI", workTracker: { search: async () => Promise.reject(new Error("tracker down")) }, docStore: {} } as never;
        assert.deepEqual(await tryFindEditedAfterApproval(failing), []);
        await assert.rejects(findEditedAfterApproval(failing), /tracker down/);
    });

    it("renders an information section grouped by Kickoff, and nothing when there is nothing to show", () => {
        assert.equal(renderEditedAfterApproval([]), undefined);
        const text = renderEditedAfterApproval([
            { kickoffKey: toIssueKey("TAI-2"), kickoffSummary: "Kickoff: billing", pageId: toPageId("10"), pageTitle: "PRD", approvedAt: APPROVED, editedAt: "2026-10-03T09:00:00Z" },
            { kickoffKey: toIssueKey("TAI-2"), kickoffSummary: "Kickoff: billing", pageId: toPageId("11"), pageTitle: "UX flows", approvedAt: APPROVED, editedAt: "2026-10-05T09:00:00Z" },
        ])!;
        assert.match(text, /^## Pages edited after their Kickoff was approved\n\nFor information: nothing is blocked and no gate reopens\./);
        assert.match(text, /- \*\*TAI-2\*\* Kickoff: billing — approved 2026-10-01\n {2}- "PRD" \(page 10\) edited 2026-10-03\n {2}- "UX flows" \(page 11\) edited 2026-10-05/);
    });
});
