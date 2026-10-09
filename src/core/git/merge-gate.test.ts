import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { toHumanId, toIssueKey, type HumanRef, type Issue, type IssueFilter } from "../storage/interface.js";
import { toCommitSha, toPullRequestId, toRepoId, type PullRequestActivity, type PullRequestRef, type PullRequestReviewer } from "./interface.js";
import { checkMergeGate, evaluateMergeGate, mergeOverrideComment } from "./merge-gate.js";

const del: HumanRef = { id: toHumanId("acct-del"), displayName: "Del" };
const ana: HumanRef = { id: toHumanId("acct-ana"), displayName: "Ana" };
const OLD = toCommitSha("aaaaaaaaaaaa");
const HEAD = toCommitSha("bbbbbbbbbbbb");

let clock = 0;
const at = (): string => `2026-10-08T10:${String(clock++).padStart(2, "0")}:00Z`;
const update = (sha = HEAD): PullRequestActivity => ({ kind: "update", at: at(), sourceCommit: sha });
const approval = (human = del): PullRequestActivity => ({ kind: "approval", at: at(), human });

const approved = (human = del): PullRequestReviewer => ({ human, status: "approved" });
function pr(reviewers: readonly PullRequestReviewer[]): PullRequestRef {
    return { id: toPullRequestId("7"), repo: toRepoId("w/r"), reviewers, sourceCommit: HEAD } as unknown as PullRequestRef;
}
const gate = (reviewers: readonly PullRequestReviewer[], activity: readonly PullRequestActivity[], extra: { required?: number; tiers?: Issue[] } = {}) =>
    evaluateMergeGate({ pullRequest: pr(reviewers), activity, requiredApprovals: extra.required ?? 1, testTiers: extra.tiers ?? [] });

function tier(key: string, status: Status, issueType: SubtaskType = SubtaskType.IntegrationTest): Issue {
    return { key: toIssueKey(key), projectKey: "TAI", issueType, status, parentKey: toIssueKey("TAI-1") } as unknown as Issue;
}

describe("merge gate: fresh approvals", () => {
    it("passes with an approval cast on the current commit", () => {
        const verdict = gate([approved()], [update(), approval()]);
        assert.equal(verdict.ok, true);
        assert.deepEqual(verdict.freshApprovals, [del]);
    });

    it("does not count an approval cast before a later commit, and says whose it was", () => {
        const verdict = gate([approved()], [update(OLD), approval(), update(HEAD)]);
        assert.equal(verdict.ok, false);
        assert.deepEqual(verdict.staleApprovals, [del]);
        assert.match(verdict.blockers[0]!, /Needs 1 approval on the current commit \(bbbbbbbbbbbb\); has 0\. Del approved before the latest changes/);
    });

    it("keeps an approval fresh across an update that repeats the same commit", () => {
        assert.equal(gate([approved()], [update(HEAD), approval(), update(HEAD)]).ok, true);
    });

    it("judges an approval by the head when it was cast, not by a later return to an old date order", () => {
        // Approved on OLD, then HEAD pushed, then an update repeating HEAD: still stale.
        assert.equal(gate([approved()], [update(OLD), approval(), update(HEAD), update(HEAD)]).ok, false);
    });

    it("uses a human's latest approval when they approved more than once", () => {
        assert.equal(gate([approved()], [update(OLD), approval(), update(HEAD), approval()]).ok, true);
    });

    it("matches a short commit hash against a full one", () => {
        const full = toCommitSha("bbbbbbbbbbbb0123456789");
        assert.equal(gate([approved()], [update(full), approval()]).ok, true);
    });

    it("refuses with no approval at all", () => {
        const verdict = gate([], [update()]);
        assert.equal(verdict.ok, false);
        assert.match(verdict.blockers[0]!, /has 0\.$/);
    });

    it("does not count an approved reviewer the feed shows no approval for", () => {
        assert.equal(gate([approved()], [update()]).ok, false);
    });

    it("needs as many fresh approvals as required", () => {
        const activity = [update(OLD), approval(ana), update(HEAD), approval(del)];
        const verdict = gate([approved(del), approved(ana)], activity, { required: 2 });
        assert.equal(verdict.ok, false);
        assert.match(verdict.blockers[0]!, /Needs 2 approvals .* has 1\. Ana approved before/);
        assert.equal(gate([approved(del), approved(ana)], [update(HEAD), approval(ana), approval(del)], { required: 2 }).ok, true);
    });
});

describe("merge gate: request-changes and test tiers", () => {
    it("refuses while a request-changes stands, even with enough fresh approvals", () => {
        const verdict = gate([approved(del), { human: ana, status: "changesRequested" }], [update(), approval(del)]);
        assert.equal(verdict.ok, false);
        assert.deepEqual(verdict.blockers, ["Changes requested by Ana and not withdrawn."]);
    });

    it("refuses while a test tier on the ticket is not Done, naming it", () => {
        const verdict = gate([approved()], [update(), approval()], { tiers: [tier("TAI-5", Status.InProgress), tier("TAI-6", Status.Done)] });
        assert.deepEqual(verdict.blockers, ["Test tier TAI-5 (integration-test) is In Progress, not Done."]);
    });

    it("treats a canceled tier as satisfied", () => {
        assert.equal(gate([approved()], [update(), approval()], { tiers: [tier("TAI-5", Status.Canceled)] }).ok, true);
    });

    it("lists every unmet rule, not just the first", () => {
        const verdict = gate([{ human: ana, status: "changesRequested" }], [update()], { tiers: [tier("TAI-5", Status.ToDo)] });
        assert.equal(verdict.blockers.length, 3);
    });
});

describe("checkMergeGate: gathering", () => {
    const story = { key: toIssueKey("TAI-1"), projectKey: "TAI", issueType: StoryType.Story, status: Status.InProgress } as unknown as Issue;
    const dev = tier("TAI-2", Status.InProgress, SubtaskType.Dev);
    const integ = tier("TAI-5", Status.InProgress);
    const issues = new Map<string, Issue>([story, dev, integ].map((i) => [i.key, i]));
    const searches: IssueFilter[] = [];
    const deps = {
        gitHost: { listPullRequestActivity: async () => [update(), approval()] },
        workTracker: {
            getIssue: async (key: string) => issues.get(key) ?? null,
            search: async (filter: IssueFilter) => {
                searches.push(filter);
                return [integ];
            },
        },
    };

    it("checks the tiers under the Dev subtask's Story", async () => {
        const verdict = await checkMergeGate(deps, pr([approved()]), dev.key);
        assert.equal(searches.at(-1)?.parentKey, "TAI-1");
        assert.deepEqual(verdict.blockers, ["Test tier TAI-5 (integration-test) is In Progress, not Done."]);
    });

    it("checks the tiers under the Story itself for a governance PR", async () => {
        await checkMergeGate(deps, pr([approved()]), story.key);
        assert.equal(searches.at(-1)?.parentKey, "TAI-1");
    });

    it("does not make a test tier's own PR wait on that tier", async () => {
        assert.equal((await checkMergeGate(deps, pr([approved()]), integ.key)).ok, true);
    });

    it("checks approvals only when the PR is tied to no ticket", async () => {
        assert.equal((await checkMergeGate(deps, pr([approved()]), null)).ok, true);
    });
});

describe("mergeOverrideComment", () => {
    it("opens with the marker and lists what was overridden", () => {
        assert.equal(mergeOverrideComment(["A.", "B."]), "Merge-gate override: merged with force=true although\n\n* A.\n* B.");
    });
});
