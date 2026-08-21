import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DependencyRelation, StoryType, SubtaskType } from "../schema/story-schema.js";
import {
    toHumanId,
    toIssueKey,
    type Issue,
    type IssueFilter,
    type IssueKey,
    type IssueLink,
    type WorkTracker,
} from "../storage/interface.js";
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
import {
    resolvePullRequestId,
    parseReviewArgs,
    parseMergeArgs,
    isGreen,
    findCodeReviewSiblingForLink,
    validateBranchName,
} from "./git-pr.js";

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
        url: "https://example.com",
        createdAt: "x",
        updatedAt: "x",
        ...overrides,
    };
}

/** A fake exposing only the one method `resolvePullRequestId` actually needs. */
class FakeListOnlyGitHost implements Pick<GitHost, "listPullRequests"> {
    constructor(private readonly prs: readonly PullRequestRef[]) {}

    async listPullRequests(_repo: RepoId, state?: PullRequestState): Promise<readonly PullRequestRef[]> {
        return state ? this.prs.filter((pr) => pr.state === state) : this.prs;
    }
}

const repo = toRepoId("dmayhak/tai-framework");

describe("resolvePullRequestId", () => {
    it("returns the explicit ID unchanged when one is given, without calling listPullRequests", async () => {
        const gitHost = new FakeListOnlyGitHost([]);
        const id = await resolvePullRequestId(gitHost, repo, "42");
        assert.equal(id, toPullRequestId("42"));
    });

    it("resolves to the sole open PR when exactly one exists", async () => {
        const gitHost = new FakeListOnlyGitHost([prFixture({ id: toPullRequestId("7") })]);
        const id = await resolvePullRequestId(gitHost, repo, undefined);
        assert.equal(id, toPullRequestId("7"));
    });

    it("throws a clear error when no open PRs exist", async () => {
        const gitHost = new FakeListOnlyGitHost([]);
        await assert.rejects(() => resolvePullRequestId(gitHost, repo, undefined), /No open pull requests/);
    });

    it("throws and lists every candidate when multiple open PRs exist, rather than guessing", async () => {
        const gitHost = new FakeListOnlyGitHost([
            prFixture({ id: toPullRequestId("7"), title: "First" }),
            prFixture({ id: toPullRequestId("9"), title: "Second" }),
        ]);
        await assert.rejects(() => resolvePullRequestId(gitHost, repo, undefined), (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /Multiple open pull requests/);
            assert.match(err.message, /7: First/);
            assert.match(err.message, /9: Second/);
            return true;
        });
    });

    it("only considers open PRs — a merged/declined one with no open sibling still resolves as zero matches", async () => {
        const gitHost = new FakeListOnlyGitHost([prFixture({ id: toPullRequestId("3"), state: "merged" })]);
        await assert.rejects(() => resolvePullRequestId(gitHost, repo, undefined), /No open pull requests/);
    });
});

describe("parseReviewArgs", () => {
    it("PR-ID omitted: decision in first position", () => {
        assert.deepEqual(parseReviewArgs(["approve"]), { prIdArg: undefined, decision: "approve", comment: undefined });
    });

    it("PR-ID given: decision in second position, plus a comment", () => {
        assert.deepEqual(parseReviewArgs(["42", "requestChanges", "needs work"]), {
            prIdArg: "42",
            decision: "requestChanges",
            comment: "needs work",
        });
    });

    it("PR-ID omitted, with a comment", () => {
        assert.deepEqual(parseReviewArgs(["approve", "looks good"]), {
            prIdArg: undefined,
            decision: "approve",
            comment: "looks good",
        });
    });

    it("throws on a missing/invalid decision rather than defaulting", () => {
        assert.throws(() => parseReviewArgs([]), /Usage: git-pr review/);
        assert.throws(() => parseReviewArgs(["42"]), /Usage: git-pr review/);
        assert.throws(() => parseReviewArgs(["42", "not-a-decision"]), /Usage: git-pr review/);
    });
});

describe("parseMergeArgs", () => {
    it("no args at all: PR-ID omitted, strategy defaults to mergeCommit", () => {
        assert.deepEqual(parseMergeArgs([]), { prIdArg: undefined, strategy: "mergeCommit" });
    });

    it("a bare strategy literal: PR-ID omitted", () => {
        assert.deepEqual(parseMergeArgs(["squash"]), { prIdArg: undefined, strategy: "squash" });
    });

    it("PR-ID given, no strategy: defaults to mergeCommit", () => {
        assert.deepEqual(parseMergeArgs(["14"]), { prIdArg: "14", strategy: "mergeCommit" });
    });

    it("PR-ID and strategy both given", () => {
        assert.deepEqual(parseMergeArgs(["14", "fastForward"]), { prIdArg: "14", strategy: "fastForward" });
    });

    it("a typo'd PR-ID throws rather than silently resolving to whatever's open (Gemini CLI review finding, PR #15)", () => {
        assert.throws(() => parseMergeArgs(["12s"]), /Invalid merge strategy or PR-ID "12s"/);
    });

    it("a typo'd strategy after a valid PR-ID throws rather than silently defaulting to mergeCommit", () => {
        assert.throws(() => parseMergeArgs(["14", "sqaush"]), /Invalid merge strategy "sqaush"/);
    });
});

function statusFixture(state: CommitStatus["state"]): CommitStatus {
    return { key: "build", name: "build", state };
}

describe("isGreen", () => {
    it("false when there are no statuses at all (pipeline never ran, or wrong commit)", () => {
        assert.equal(isGreen([]), false);
    });

    it("true when every status succeeded", () => {
        assert.equal(isGreen([statusFixture("successful"), statusFixture("successful")]), true);
    });

    it("false when any status failed", () => {
        assert.equal(isGreen([statusFixture("successful"), statusFixture("failed")]), false);
    });

    it("false when a status is still in progress", () => {
        assert.equal(isGreen([statusFixture("inProgress")]), false);
    });
});

function issueFixture(overrides: Partial<Issue> & Pick<Issue, "key" | "issueType">): Issue {
    return {
        projectKey: "TAI",
        summary: "x",
        status: undefined as never, // not read by findCodeReviewSiblingForLink
        assignee: null,
        persona: null,
        labels: [],
        createdAt: "x",
        updatedAt: "x",
        comments: [],
        ...overrides,
    };
}

/** A fake exposing only the two methods `findCodeReviewSiblingForLink` actually needs. */
class FakeSearchLinksWorkTracker implements Pick<WorkTracker, "search" | "getLinkedIssues"> {
    constructor(
        private readonly issues: readonly Issue[],
        private readonly links: ReadonlyMap<IssueKey, readonly IssueLink[]> = new Map()
    ) {}

    async search(filter: IssueFilter): Promise<readonly Issue[]> {
        return this.issues.filter((i) => !filter.parentKey || i.parentKey === filter.parentKey);
    }

    async getLinkedIssues(key: IssueKey): Promise<readonly IssueLink[]> {
        return this.links.get(key) ?? [];
    }
}

describe("findCodeReviewSiblingForLink", () => {
    const story = toIssueKey("TAI-96");
    const dev = issueFixture({ key: toIssueKey("TAI-98"), issueType: SubtaskType.Dev, parentKey: story });

    it("returns null when the issue has no parentKey", async () => {
        const wt = new FakeSearchLinksWorkTracker([]);
        const result = await findCodeReviewSiblingForLink(wt, issueFixture({ key: toIssueKey("TAI-1"), issueType: StoryType.Story }));
        assert.equal(result, null);
    });

    it("returns null when no CodeReview sibling exists", async () => {
        const wt = new FakeSearchLinksWorkTracker([dev]);
        assert.equal(await findCodeReviewSiblingForLink(wt, dev), null);
    });

    it("returns the sole CodeReview sibling when exactly one exists (the common case)", async () => {
        const codeReview = issueFixture({ key: toIssueKey("TAI-99"), issueType: SubtaskType.CodeReview, parentKey: story });
        const wt = new FakeSearchLinksWorkTracker([dev, codeReview]);
        assert.equal(await findCodeReviewSiblingForLink(wt, dev), codeReview.key);
    });

    it("REGRESSION (live bug, TAI-110): a sole CodeReview sibling already claimed by a DIFFERENT subtask must not be returned as a false match", async () => {
        const test = issueFixture({ key: toIssueKey("TAI-100"), issueType: SubtaskType.IntegrationTest, parentKey: story });
        // TAI-109's real shape: the only CodeReview subtask under the Story, but its
        // DependsOn link points at TAI-108 (Dev), not `test` (an IntegrationTest sibling
        // with no CodeReview subtask of its own) — asking on behalf of `test` must get
        // null, not TAI-109's key, even though it's the sole CodeReview candidate present.
        const claimedByDev = issueFixture({ key: toIssueKey("TAI-109"), issueType: SubtaskType.CodeReview, parentKey: story });
        const wt = new FakeSearchLinksWorkTracker(
            [dev, test, claimedByDev],
            new Map([[claimedByDev.key, [{ relation: DependencyRelation.DependsOn, key: dev.key }]]])
        );
        assert.equal(await findCodeReviewSiblingForLink(wt, test), null);
        assert.equal(await findCodeReviewSiblingForLink(wt, dev), claimedByDev.key);
    });

    it("disambiguates via the DependsOn precedence link when multiple CodeReview siblings exist (TAI-105's own case)", async () => {
        const test = issueFixture({ key: toIssueKey("TAI-100"), issueType: SubtaskType.IntegrationTest, parentKey: story });
        const crForDev = issueFixture({ key: toIssueKey("TAI-99"), issueType: SubtaskType.CodeReview, parentKey: story });
        const crForTest = issueFixture({ key: toIssueKey("TAI-105"), issueType: SubtaskType.CodeReview, parentKey: story });
        const wt = new FakeSearchLinksWorkTracker(
            [dev, test, crForDev, crForTest],
            new Map([
                [crForDev.key, [{ relation: DependencyRelation.DependsOn, key: dev.key }]],
                [crForTest.key, [{ relation: DependencyRelation.DependsOn, key: test.key }]],
            ])
        );
        assert.equal(await findCodeReviewSiblingForLink(wt, test), crForTest.key);
        assert.equal(await findCodeReviewSiblingForLink(wt, dev), crForDev.key);
    });

    it("returns null when multiple CodeReview siblings exist and none disambiguates via a precedence link", async () => {
        const crA = issueFixture({ key: toIssueKey("TAI-99"), issueType: SubtaskType.CodeReview, parentKey: story });
        const crB = issueFixture({ key: toIssueKey("TAI-105"), issueType: SubtaskType.CodeReview, parentKey: story });
        const wt = new FakeSearchLinksWorkTracker([dev, crA, crB]);
        assert.equal(await findCodeReviewSiblingForLink(wt, dev), null);
    });
});

describe("validateBranchName", () => {
    const story = toIssueKey("TAI-96");

    it("passes when the branch is named after the parent Story key plus a slug", () => {
        assert.doesNotThrow(() => validateBranchName("TAI-96-materialize-precedence-links", story));
    });

    it("passes when the branch IS the bare Story key", () => {
        assert.doesNotThrow(() => validateBranchName("TAI-96", story));
    });

    it("throws when the branch is named after a subtask's own key instead (this session's own deviation)", () => {
        assert.throws(
            () => validateBranchName("TAI-98-materialize-precedence-links", story),
            /should start with the parent Story\/Bug's key "TAI-96-"/
        );
    });

    it("hyphen-anchors the prefix check — TAI-9 is not treated as a valid prefix of TAI-96's branch", () => {
        assert.throws(() => validateBranchName("TAI-96-foo", toIssueKey("TAI-9")));
    });
});
