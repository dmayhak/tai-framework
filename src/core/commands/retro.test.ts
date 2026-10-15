import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status, StoryType } from "../schema/story-schema.js";
import { toHumanId, toIssueKey, type Comment, type HumanRef, type Issue } from "../storage/interface.js";
import { toPullRequestId, toRepoId, type CommitSha, type PullRequestActivity, type PullRequestRef } from "../git/interface.js";
import { computeRetro, parseRetroArgs, parseRetroSince, renderRetroBriefing, retroEpicCloseHint, retroWindow, type RetroPullRequest } from "./retro.js";

const ME: HumanRef = { id: toHumanId("a@b.c"), displayName: "Ann", email: "a@b.c" };
const BOB: HumanRef = { id: toHumanId("b@b.c"), displayName: "Bob", email: "b@b.c" };
const FROM = new Date("2026-10-01T00:00:00Z");

const comment = (body: string, at: string): Comment => ({ id: `c-${at}-${body.length}`, author: ME, body, createdAt: at, updatedAt: at });
const issue = (key: string, over: Partial<Issue> = {}): Issue =>
    ({
        key: toIssueKey(key),
        projectKey: "TAI",
        issueType: StoryType.Story,
        summary: `summary of ${key}`,
        status: Status.ToDo,
        assignee: null,
        persona: null,
        labels: [],
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:00Z",
        comments: [],
        ...over,
    }) as Issue;

const pr = (id: string, over: Partial<PullRequestRef> = {}): PullRequestRef => ({
    id: toPullRequestId(id),
    repo: toRepoId("w/r"),
    title: "TAI-9 - TAI-10 - a change",
    state: "merged",
    sourceBranch: "b",
    destinationBranch: "master",
    author: ME,
    reviewers: [],
    sourceCommit: "bbb" as CommitSha,
    url: `https://bitbucket.org/w/r/pull-requests/${id}`,
    createdAt: "2026-10-02T00:00:00Z",
    updatedAt: "2026-10-03T00:00:00Z",
    ...over,
});
const withPr = (p: PullRequestRef, comments: Comment[] = [], activity: PullRequestActivity[] = []): RetroPullRequest => ({ pr: p, comments, activity });

describe("retro summary (TAI-491)", () => {
    it("lists tickets cancelled in the window with the first line of the last comment as the reason", () => {
        const inWindow = issue("TAI-1", { status: Status.Canceled, updatedAt: "2026-10-05T00:00:00Z", comments: [comment("Cancelled: superseded\nmore", "2026-10-05T00:00:00Z")] });
        const before = issue("TAI-2", { status: Status.Canceled, updatedAt: "2026-09-20T00:00:00Z" });
        const open = issue("TAI-3", { updatedAt: "2026-10-05T00:00:00Z" });
        const r = computeRetro({ issues: [inWindow, before, open], pullRequests: null, from: FROM });
        assert.deepEqual(r.cancelled.map((c) => c.issue.key), ["TAI-1"]);
        assert.equal(r.cancelled[0]!.reason, "Cancelled: superseded");
    });

    it("lists Bugs created in the window and no other type", () => {
        const bug = issue("TAI-4", { issueType: StoryType.Bug, createdAt: "2026-10-02T00:00:00Z" });
        const oldBug = issue("TAI-5", { issueType: StoryType.Bug, createdAt: "2026-09-02T00:00:00Z" });
        const story = issue("TAI-6", { createdAt: "2026-10-02T00:00:00Z" });
        const r = computeRetro({ issues: [bug, oldBug, story], pullRequests: null, from: FROM });
        assert.deepEqual(r.bugs.map((b) => b.key), ["TAI-4"]);
    });

    it("lists a tier sent back: a Not verified: or Rejected: comment dated in the window, one row per comment", () => {
        const t = issue("TAI-7", {
            comments: [
                comment("Not verified: 1 of 3 criteria not met", "2026-10-04T00:00:00Z"),
                comment("Verified: all 3 criteria met", "2026-10-06T00:00:00Z"),
                comment("Not verified: older", "2026-09-04T00:00:00Z"),
                comment("Rejected: needs rework", "2026-10-07T00:00:00Z"),
            ],
        });
        const r = computeRetro({ issues: [t], pullRequests: null, from: FROM });
        assert.deepEqual(r.sentBack.map((s) => s.line), ["Not verified: 1 of 3 criteria not met", "Rejected: needs rework"]);
    });

    it("lists a merge-gate override comment on a PR updated in the window", () => {
        const ov = comment("Merge-gate override: merged with force=true although\n\n* Needs 1 approval", "2026-10-03T00:00:00Z");
        const other = comment("looks good", "2026-10-03T00:00:00Z");
        const r = computeRetro({ issues: [], pullRequests: [withPr(pr("5"), [ov, other])], from: FROM });
        assert.equal(r.overrides!.length, 1);
        assert.equal(r.overrides![0]!.pr.id, "5");
    });

    it("lists a stale approval: approved on an older head than the PR has now", () => {
        const stale = pr("6", { state: "open", sourceCommit: "bbb" as CommitSha, reviewers: [{ human: BOB, status: "approved" }] });
        const activity: PullRequestActivity[] = [
            { kind: "update", at: "2026-10-02T00:00:00Z", sourceCommit: "aaa" as CommitSha },
            { kind: "approval", at: "2026-10-02T01:00:00Z", human: BOB },
            { kind: "update", at: "2026-10-02T02:00:00Z", sourceCommit: "bbb" as CommitSha },
        ];
        const fresh = pr("7", { state: "open", sourceCommit: "ccc" as CommitSha, reviewers: [{ human: BOB, status: "approved" }] });
        const freshActivity: PullRequestActivity[] = [
            { kind: "update", at: "2026-10-02T00:00:00Z", sourceCommit: "ccc" as CommitSha },
            { kind: "approval", at: "2026-10-02T01:00:00Z", human: BOB },
        ];
        const r = computeRetro({ issues: [], pullRequests: [withPr(stale, [], activity), withPr(fresh, [], freshActivity)], from: FROM });
        assert.deepEqual(r.staleApprovals!.map((s) => s.pr.id), ["6"]);
        assert.deepEqual(r.staleApprovals![0]!.humans.map((h) => h.displayName), ["Bob"]);
    });

    it("ignores a PR last updated before the window", () => {
        const ov = comment("Merge-gate override: merged with force=true although", "2026-09-03T00:00:00Z");
        const r = computeRetro({ issues: [], pullRequests: [withPr(pr("8", { updatedAt: "2026-09-03T00:00:00Z" }), [ov])], from: FROM });
        assert.equal(r.overrides!.length, 0);
    });
});

describe("retro window (TAI-491)", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    it("defaults to the last 30 days with neither an epic nor since", () => {
        const w = retroWindow({ now });
        assert.equal(w.from.toISOString().slice(0, 10), "2026-09-14");
        assert.match(w.label, /last 30 days/);
    });
    it("defaults to the epic's whole life for an epic", () => {
        const w = retroWindow({ now, epic: issue("TAI-452", { issueType: "epic", createdAt: "2026-09-30T08:00:00Z" }) });
        assert.equal(w.from.toISOString().slice(0, 10), "2026-09-30");
        assert.match(w.label, /TAI-452/);
    });
    it("since= wins, and a bad date is rejected", () => {
        assert.equal(retroWindow({ now, since: "2026-10-01" }).from.toISOString().slice(0, 10), "2026-10-01");
        assert.throws(() => parseRetroSince("last week"), /since=/);
    });
});

describe("retro briefing (TAI-491)", () => {
    const empty = computeRetro({ issues: [], pullRequests: [], from: FROM });
    const w = retroWindow({ now: new Date("2026-10-14T12:00:00Z") });

    it("prints all five sections, each None when empty, and names the window", () => {
        const text = renderRetroBriefing({ summary: empty, window: w, scope: "the whole board" });
        assert.match(text, /^# Retro briefing/m);
        assert.match(text, /Window: .*last 30 days/);
        for (const heading of ["Tickets cancelled", "Bugs raised", "Tiers sent back", "Stamped overrides", "Stale approvals"]) {
            assert.match(text, new RegExp(`## \\d\\. ${heading}\\n\\nNone\\.`));
        }
    });

    it("says the two PR sections were not read when no git host is configured", () => {
        const text = renderRetroBriefing({ summary: computeRetro({ issues: [], pullRequests: null, from: FROM }), window: w, scope: "the whole board" });
        assert.match(text, /## 4\. Stamped overrides\n\nNot read:/);
        assert.match(text, /## 5\. Stale approvals\n\nNot read:/);
    });

    it("lists each item with its ticket or PR key, and tells Perry to write nothing to the human's data until she has asked", () => {
        const s = computeRetro({
            issues: [issue("TAI-1", { status: Status.Canceled, updatedAt: "2026-10-05T00:00:00Z" })],
            pullRequests: [withPr(pr("5"), [comment("Merge-gate override: merged with force=true although", "2026-10-03T00:00:00Z")])],
            from: FROM,
        });
        const text = renderRetroBriefing({ summary: s, window: w, scope: "the whole board" });
        assert.match(text, /\*\*TAI-1\*\*/);
        assert.match(text, /PR 5/);
        assert.match(text, /ask the human a few questions/i);
    });
});

describe("retro epic-close hint (TAI-491)", () => {
    it("names /tai-retro with the epic key only when an Epic moved to Done", () => {
        assert.match(retroEpicCloseHint(issue("TAI-452", { issueType: "epic", status: Status.Done }))!, /\/tai-retro TAI-452/);
        assert.equal(retroEpicCloseHint(issue("TAI-452", { issueType: "epic", status: Status.InProgress })), null);
        assert.equal(retroEpicCloseHint(issue("TAI-9", { status: Status.Done })), null);
    });
});

describe("retro arguments (TAI-491)", () => {
    it("takes an epic key, since=<date>, both in either order, or nothing", () => {
        assert.deepEqual(parseRetroArgs([]), {});
        assert.deepEqual(parseRetroArgs(["TAI-452"]), { epicKey: "TAI-452" });
        assert.deepEqual(parseRetroArgs(["since=2026-10-01"]), { since: "2026-10-01" });
        assert.deepEqual(parseRetroArgs(["since=2026-10-01", "TAI-452"]), { epicKey: "TAI-452", since: "2026-10-01" });
    });
    it("rejects a repeated since=, a second key and a word that is neither, with the usage text", () => {
        for (const words of [["since=2026-10-01", "since=2026-09-01"], ["TAI-1", "TAI-2"], ["since", "2026-10-01"], ["last week"], ["tai-452"]]) {
            assert.throws(() => parseRetroArgs(words), /Usage: retro \[EPIC-KEY \| since=<date>\]/, words.join(" "));
        }
    });
});
