import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Status, SubtaskType } from "../schema/story-schema.js";
import {
    toHumanId,
    toIssueKey,
    type Issue,
    type IssueFilter,
    type IssueKey,
    type RemoteLink,
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
    findLinkedDevSubtask,
    validateBranchName,
    validatePrTitle,
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
        status: Status.InProgress,
        assignee: null,
        persona: null,
        labels: [],
        createdAt: "x",
        updatedAt: "x",
        comments: [],
        ...overrides,
    };
}

/** A fake exposing only the two methods `findLinkedDevSubtask` actually needs. */
class FakeSearchLinksWorkTracker implements Pick<WorkTracker, "search" | "getRemoteLinks"> {
    constructor(
        private readonly issues: readonly Issue[],
        private readonly links: ReadonlyMap<IssueKey, readonly RemoteLink[]> = new Map()
    ) {}

    async search(filter: IssueFilter): Promise<readonly Issue[]> {
        return this.issues.filter(
            (i) =>
                (!filter.issueTypes || filter.issueTypes.includes(i.issueType)) &&
                (!filter.statuses || filter.statuses.includes(i.status))
        );
    }

    async getRemoteLinks(key: IssueKey): Promise<readonly RemoteLink[]> {
        return this.links.get(key) ?? [];
    }
}

describe("findLinkedDevSubtask (rev 52, TAI-159 ADR §4)", () => {
    const prUrl = "https://bitbucket.org/dmayhak/tai-framework/pull-requests/1";

    it("returns null when no In-Progress Dev subtask exists", async () => {
        const wt = new FakeSearchLinksWorkTracker([]);
        assert.equal(await findLinkedDevSubtask(wt, "TAI", prUrl), null);
    });

    it("finds the In-Progress Dev subtask whose remote link matches the PR URL", async () => {
        const dev = issueFixture({ key: toIssueKey("TAI-160"), issueType: SubtaskType.Dev, status: Status.InProgress });
        const wt = new FakeSearchLinksWorkTracker([dev], new Map([[dev.key, [{ url: prUrl, title: "PR" }]]]));
        assert.equal(await findLinkedDevSubtask(wt, "TAI", prUrl), dev.key);
    });

    it("returns null when a Dev subtask exists but its link doesn't match this PR", async () => {
        const dev = issueFixture({ key: toIssueKey("TAI-160"), issueType: SubtaskType.Dev, status: Status.InProgress });
        const wt = new FakeSearchLinksWorkTracker(
            [dev],
            new Map([[dev.key, [{ url: "https://bitbucket.org/x/y/pull-requests/99", title: "Other PR" }]]])
        );
        assert.equal(await findLinkedDevSubtask(wt, "TAI", prUrl), null);
    });

    it("doesn't match a Dev subtask that's already Done — only In Progress is a candidate", async () => {
        const dev = issueFixture({ key: toIssueKey("TAI-160"), issueType: SubtaskType.Dev, status: Status.Done });
        // The fake's search() filters by status same as a real backend would — a Done Dev
        // subtask wouldn't even be returned by the InProgress-scoped search.
        const wt = new FakeSearchLinksWorkTracker([dev], new Map([[dev.key, [{ url: prUrl, title: "PR" }]]]));
        assert.equal(await findLinkedDevSubtask(wt, "TAI", prUrl), null);
    });

    it("picks the correct Dev subtask among several In-Progress ones", async () => {
        const devA = issueFixture({ key: toIssueKey("TAI-160"), issueType: SubtaskType.Dev, status: Status.InProgress });
        const devB = issueFixture({ key: toIssueKey("TAI-161"), issueType: SubtaskType.Dev, status: Status.InProgress });
        const wt = new FakeSearchLinksWorkTracker(
            [devA, devB],
            new Map([
                [devA.key, [{ url: "https://bitbucket.org/x/y/pull-requests/1", title: "A" }]],
                [devB.key, [{ url: prUrl, title: "B" }]],
            ])
        );
        assert.equal(await findLinkedDevSubtask(wt, "TAI", prUrl), devB.key);
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

describe("validatePrTitle", () => {
    const story = toIssueKey("TAI-112");
    const subtask = toIssueKey("TAI-113");

    it("passes when the title starts with 'Story - Subtask - description'", () => {
        assert.doesNotThrow(() => validatePrTitle("TAI-112 - TAI-113 - some description", story, subtask));
    });

    it("passes when the title starts with 'Story - description' and there's no subtask", () => {
        assert.doesNotThrow(() => validatePrTitle("TAI-112 - some description", story, null));
    });

    it("throws when titled by subtask key alone (this ticket's own motivating pattern)", () => {
        assert.throws(
            () => validatePrTitle("TAI-113: some description", story, subtask),
            /should start with "TAI-112 - TAI-113 - "/
        );
    });

    it("throws when titled by Story key alone but a subtask was actually passed", () => {
        assert.throws(
            () => validatePrTitle("TAI-112: some description", story, subtask),
            /should start with "TAI-112 - TAI-113 - "/
        );
    });

    it("passes for a bare-Story-key PR even if the description happens to mention another key", () => {
        // Prefix-only check, by design (same posture as validateBranchName) — this isn't
        // testing for a false positive, just documenting that only the required prefix is
        // enforced, not the rest of the title's content.
        assert.doesNotThrow(() => validatePrTitle("TAI-112 - TAI-113 - some description", story, null));
    });
});
