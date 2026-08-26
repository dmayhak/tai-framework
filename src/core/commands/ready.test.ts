import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, type HumanRef, type StorageBackend } from "../storage/interface.js";
import {
    toCommitSha,
    toPullRequestId,
    toRepoId,
    type CommitStatus,
    type GitHost,
    type PullRequestRef,
    type PullRequestState,
    type RepoId,
} from "../git/interface.js";
import { findReadyWork, findReadyPRWork } from "./ready.js";

const CURRENT_USER: HumanRef = { id: toHumanId("del@example.com"), displayName: "Del", email: "del@example.com" };

async function withBackend(fn: (backend: StorageBackend, taiRoot: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-ready-command-"));
    try {
        await fn(createFilesystemBackend(dir, CURRENT_USER), dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("findReadyWork", () => {
    test("a story-level ticket is trivially ready once open, regardless of subtasks", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Top-level story",
                persona: Persona.Pm,
            });

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(result.ready.some((i) => i.key === story.key));
        });
    });

    test("TAI-192: a genuinely undecomposed Epic (zero children) is surfaced", async () => {
        await withBackend(async (backend, taiRoot) => {
            const epic = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: "epic",
                summary: "Fresh epic, nothing under it yet",
                persona: Persona.Pm,
            });

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(result.ready.some((i) => i.key === epic.key));
        });
    });

    test("TAI-192: an Epic that's already been decomposed (has at least one child) is NOT surfaced", async () => {
        await withBackend(async (backend, taiRoot) => {
            const epic = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: "epic",
                summary: "Already-decomposed epic",
                persona: Persona.Pm,
            });
            await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "One of its stories",
                parentKey: epic.key,
            });

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(!result.ready.some((i) => i.key === epic.key), "already-decomposed Epic should be dropped from Ready Work");
        });
    });

    test("a subtask blocked by an unfinished precedence sibling is excluded, then included once the blocker is Done", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story needing architecture first",
            });
            const arch = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.ArchitectureDesign,
                summary: "Design it",
                persona: Persona.Architect,
                parentKey: story.key,
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Build it",
                persona: Persona.Developer,
                parentKey: story.key,
            });

            const before = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(!before.ready.some((i) => i.key === dev.key), "Dev should be blocked by ArchitectureDesign");
            assert.ok(before.ready.some((i) => i.key === arch.key), "ArchitectureDesign has no blocker of its own");

            await backend.workTracker.transition(arch.key, Status.Done);

            const after = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(after.ready.some((i) => i.key === dev.key), "Dev should unblock once ArchitectureDesign is Done");
        });
    });

    test("a subtask with no applicable precedence rule (a root) is ready immediately", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Simple story",
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Just build it, nothing gates Dev here",
                persona: Persona.Developer,
                parentKey: story.key,
            });

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(result.ready.some((i) => i.key === dev.key));
        });
    });

    test("persona filter narrows the candidate set", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story",
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Dev work",
                persona: Persona.Developer,
                parentKey: story.key,
            });
            await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.CodeReview,
                summary: "Review work",
                persona: Persona.CodeReviewer,
                parentKey: story.key,
            });

            const result = await findReadyWork(
                { workTracker: backend.workTracker, taiRoot, projectKey: "TAI" },
                Persona.Developer
            );
            assert.deepEqual(
                result.ready.map((i) => i.key),
                [dev.key]
            );
        });
    });

    test("a Done subtask is excluded from ready work", async () => {
        await withBackend(async (backend, taiRoot) => {
            const story = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: StoryType.Story,
                summary: "Story",
            });
            const dev = await backend.workTracker.createIssue({
                projectKey: "TAI",
                issueType: SubtaskType.Dev,
                summary: "Already done",
                persona: Persona.Developer,
                parentKey: story.key,
            });
            await backend.workTracker.transition(dev.key, Status.Done);

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.ok(!result.ready.some((i) => i.key === dev.key));
        });
    });
});

// ---------- readyToTest / readyToMerge / readyToReview (rev 52, TAI-159 ADR) ----------
//
// CodeReview is retired going forward — the anchor is now an In-Progress `Dev` subtask
// (stays open until its PR merges, story-schema.ts) correlated against the PR's own live
// approval/CI state, not a Done CodeReview subtask's Jira status.

const REVIEWER_A: HumanRef = { id: toHumanId("a@x.test"), displayName: "A", email: "a@x.test" };
const REVIEWER_B: HumanRef = { id: toHumanId("b@x.test"), displayName: "B", email: "b@x.test" };

function prFixture(overrides: Partial<PullRequestRef>): PullRequestRef {
    return {
        id: toPullRequestId("10"),
        repo: toRepoId("dmayhak/tai-framework"),
        title: "x",
        state: "open",
        sourceBranch: "feature",
        destinationBranch: "master",
        author: { id: toHumanId("x"), displayName: "x" },
        reviewers: [],
        sourceCommit: toCommitSha("abc123"),
        url: "https://bitbucket.org/dmayhak/tai-framework/pull-requests/1",
        createdAt: "x",
        updatedAt: "x",
        ...overrides,
    };
}

/** A fake exposing only what `findReadyWork`'s PR-awareness path actually needs. */
class FakeGitHost implements Pick<GitHost, "listPullRequests" | "getCommitStatuses"> {
    constructor(
        private readonly prsByRepo: ReadonlyMap<RepoId, readonly PullRequestRef[]>,
        private readonly statuses: readonly CommitStatus[] = [{ key: "build", name: "build", state: "successful" }]
    ) {}

    async listPullRequests(repo: RepoId, state?: PullRequestState): Promise<readonly PullRequestRef[]> {
        const prs = this.prsByRepo.get(repo) ?? [];
        return state ? prs.filter((pr) => pr.state === state) : prs;
    }

    async getCommitStatuses(): Promise<readonly CommitStatus[]> {
        return this.statuses;
    }
}

async function inProgressDev(backend: StorageBackend, summary: string): Promise<{ key: import("../storage/interface.js").IssueKey }> {
    const story = await backend.workTracker.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "Story" });
    const dev = await backend.workTracker.createIssue({
        projectKey: "TAI",
        issueType: SubtaskType.Dev,
        summary,
        persona: Persona.Developer,
        parentKey: story.key,
        assignee: CURRENT_USER,
    });
    await backend.workTracker.transition(dev.key, Status.InProgress);
    return dev;
}

describe("findReadyWork readyToTest / readyToMerge", () => {
    const repo = toRepoId("dmayhak/tai-framework");

    test("empty when gitHost/repos aren't supplied — never a partial guess", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            await backend.workTracker.createRemoteLink(dev.key, prFixture({}).url, "PR");

            const result = await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });
            assert.deepEqual(result.readyToTest, []);
            assert.deepEqual(result.readyToMerge, []);
        });
    });

    test("an In-Progress Dev subtask with a linked, approved, green PR is surfaced in both lists", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.equal(result.readyToTest.length, 1);
            assert.equal(result.readyToTest[0]?.devSubtaskKey, dev.key);
            assert.equal(result.readyToMerge.length, 1);
            assert.equal(result.readyToMerge[0]?.devSubtaskKey, dev.key);
        });
    });

    test("readyToTest has NO approval requirement — testing runs in parallel with review, not gated behind it (human-confirmed, TAI-160)", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [] }); // no reviews cast at all yet
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                requiredApprovals: 1,
            });

            assert.equal(result.readyToTest.length, 1, "an unreviewed PR is still ready to test");
            assert.deepEqual(result.readyToMerge, [], "but not ready to merge without approval");
        });
    });

    test("requiredApprovals > 1: one approval doesn't meet the readyToMerge threshold for two (readyToTest is unaffected either way)", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                requiredApprovals: 2,
            });

            assert.equal(result.readyToTest.length, 1);
            assert.deepEqual(result.readyToMerge, [], "one approval doesn't meet a required count of 2");
        });
    });

    test("requiredApprovals > 1: two approvals meet the readyToMerge threshold", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({
                reviewers: [
                    { human: REVIEWER_A, status: "approved" },
                    { human: REVIEWER_B, status: "approved" },
                ],
            });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                requiredApprovals: 2,
            });

            assert.equal(result.readyToMerge.length, 1);
        });
    });

    test("red CI excludes the PR from readyToMerge even though it's approved (readyToTest is unaffected — never checked CI, pre- or post-rev-52)", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]), [
                { key: "build", name: "build", state: "failed" },
            ]);
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.equal(result.readyToTest.length, 1);
            assert.deepEqual(result.readyToMerge, []);
        });
    });

    test("an In-Progress Dev subtask with no remote link is not surfaced", async () => {
        await withBackend(async (backend, taiRoot) => {
            await inProgressDev(backend, "Dev, never linked to a PR");

            const gitHost = new FakeGitHost(new Map([[repo, [prFixture({})]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.deepEqual(result.readyToTest, []);
        });
    });

    test("a linked PR that's already merged (no longer open) is not surfaced", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({});
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            // The PR is merged now — listPullRequests(repo, "open") no longer returns it.
            const gitHost = new FakeGitHost(new Map([[repo, []]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.deepEqual(result.readyToTest, []);
        });
    });

    test("a Dev subtask that's Done (already merged, rev 52) is not surfaced even with an approved linked PR", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");
            await backend.workTracker.transition(dev.key, Status.Done);

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.deepEqual(result.readyToTest, [], "only In-Progress Dev subtasks are candidates");
        });
    });
});

describe("findReadyWork readyToReview", () => {
    const repo = toRepoId("dmayhak/tai-framework");

    test("empty when gitHost/repos/currentHuman/prReviewers aren't all supplied", async () => {
        await withBackend(async (backend, taiRoot) => {
            const pr = prFixture({});
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                // currentHuman/prReviewers omitted
            });
            assert.deepEqual(result.readyToReview, []);
        });
    });

    test("an open PR is surfaced when the current human is an eligible reviewer with no decision yet", async () => {
        await withBackend(async (backend, taiRoot) => {
            const pr = prFixture({});
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                currentHuman: REVIEWER_A,
                prReviewers: [REVIEWER_A],
            });
            assert.equal(result.readyToReview.length, 1);
            assert.equal(result.readyToReview[0]?.pullRequest.url, pr.url);
        });
    });

    test("not surfaced when the current human isn't on the PR Reviewers roster", async () => {
        await withBackend(async (backend, taiRoot) => {
            const pr = prFixture({});
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                currentHuman: REVIEWER_A,
                prReviewers: [REVIEWER_B], // A is not on the roster
            });
            assert.deepEqual(result.readyToReview, []);
        });
    });

    test("a PR the current human already approved is not surfaced again", async () => {
        await withBackend(async (backend, taiRoot) => {
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                currentHuman: REVIEWER_A,
                prReviewers: [REVIEWER_A],
            });
            assert.deepEqual(result.readyToReview, []);
        });
    });

    test("a PR the current human is assigned as reviewer on but hasn't voted (pending) IS surfaced", async () => {
        await withBackend(async (backend, taiRoot) => {
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "pending" }] });
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                currentHuman: REVIEWER_A,
                prReviewers: [REVIEWER_A],
            });
            assert.equal(result.readyToReview.length, 1);
        });
    });
});

describe("findReadyWork out-of-band merge sync (rev 52, TAI-159 ADR)", () => {
    const repo = toRepoId("dmayhak/tai-framework");

    test("an In-Progress Dev subtask whose linked PR is now merged (not via git-pr merge) is synced to Done", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ state: "merged" });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            const synced = await backend.workTracker.getIssue(dev.key);
            assert.equal(synced?.status, Status.Done);
        });
    });

    test("a just-synced Dev subtask doesn't spuriously appear in readyToTest/readyToMerge from the same refresh", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ state: "merged", reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyWork({
                workTracker: backend.workTracker,
                taiRoot,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.deepEqual(result.readyToTest, []);
            assert.deepEqual(result.readyToMerge, []);
        });
    });

    test("an In-Progress Dev subtask with no remote link is left untouched", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev, never linked");
            const gitHost = new FakeGitHost(new Map([[repo, []]]));
            await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI", gitHost, repos: [repo] });

            const untouched = await backend.workTracker.getIssue(dev.key);
            assert.equal(untouched?.status, Status.InProgress);
        });
    });

    test("an In-Progress Dev subtask whose linked PR is still open is left untouched", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ state: "open" });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI", gitHost, repos: [repo] });

            const untouched = await backend.workTracker.getIssue(dev.key);
            assert.equal(untouched?.status, Status.InProgress);
        });
    });

    test("skipped entirely when gitHost/repos aren't supplied", async () => {
        await withBackend(async (backend, taiRoot) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ state: "merged" });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            await findReadyWork({ workTracker: backend.workTracker, taiRoot, projectKey: "TAI" });

            const untouched = await backend.workTracker.getIssue(dev.key);
            assert.equal(untouched?.status, Status.InProgress);
        });
    });
});

// ---------- findReadyPRWork (TAI-211/212) ----------
//
// Lighter, PR-review-mode-only sibling of findReadyWork — same readyToReview/readyToMerge
// computation (shared internally via computePRSections), but no general Jira-wide `ready`
// query, no readyToTest, no inFlight rollup, and no `taiRoot` dependency at all.

describe("findReadyPRWork", () => {
    const repo = toRepoId("dmayhak/tai-framework");

    test("result only ever has readyToReview and readyToMerge — no ready/readyToTest/inFlight fields", async () => {
        await withBackend(async (backend) => {
            const result = await findReadyPRWork({ workTracker: backend.workTracker, projectKey: "TAI" });
            assert.deepEqual(Object.keys(result).sort(), ["readyToMerge", "readyToReview"]);
        });
    });

    test("readyToReview: an open PR is surfaced when the current human is an eligible reviewer with no decision yet", async () => {
        await withBackend(async (backend) => {
            const pr = prFixture({});
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyPRWork({
                workTracker: backend.workTracker,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                currentHuman: REVIEWER_A,
                prReviewers: [REVIEWER_A],
            });
            assert.equal(result.readyToReview.length, 1);
            assert.equal(result.readyToReview[0]?.pullRequest.url, pr.url);
        });
    });

    test("readyToReview: empty when gitHost/repos/currentHuman/prReviewers aren't all supplied", async () => {
        await withBackend(async (backend) => {
            const pr = prFixture({});
            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyPRWork({
                workTracker: backend.workTracker,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                // currentHuman/prReviewers omitted
            });
            assert.deepEqual(result.readyToReview, []);
        });
    });

    test("readyToMerge: an In-Progress Dev subtask with a linked, approved, green PR is surfaced", async () => {
        await withBackend(async (backend) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [{ human: REVIEWER_A, status: "approved" }] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyPRWork({
                workTracker: backend.workTracker,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
            });

            assert.equal(result.readyToMerge.length, 1);
            assert.equal(result.readyToMerge[0]?.devSubtaskKey, dev.key);
        });
    });

    test("readyToMerge: not surfaced without enough approvals, even though it would still be readyToTest under findReadyWork", async () => {
        await withBackend(async (backend) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ reviewers: [] });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            const result = await findReadyPRWork({
                workTracker: backend.workTracker,
                projectKey: "TAI",
                gitHost,
                repos: [repo],
                requiredApprovals: 1,
            });

            assert.deepEqual(result.readyToMerge, []);
        });
    });

    test("out-of-band merge sync still runs first — a Dev subtask whose linked PR merged elsewhere is synced to Done, not left dangling", async () => {
        await withBackend(async (backend) => {
            const dev = await inProgressDev(backend, "Dev");
            const pr = prFixture({ state: "merged" });
            await backend.workTracker.createRemoteLink(dev.key, pr.url, "PR");

            const gitHost = new FakeGitHost(new Map([[repo, [pr]]]));
            await findReadyPRWork({ workTracker: backend.workTracker, projectKey: "TAI", gitHost, repos: [repo] });

            const synced = await backend.workTracker.getIssue(dev.key);
            assert.equal(synced?.status, Status.Done);
        });
    });
});
