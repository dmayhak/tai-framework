import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toHumanId } from "../storage/interface.js";
import {
    toCommitSha,
    toPullRequestId,
    toRepoId,
    type GitHost,
    type PullRequestRef,
    type PullRequestState,
    type RepoId,
} from "../git/interface.js";
import { resolvePullRequestId, parseReviewArgs, parseMergeArgs } from "./git-pr.js";

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
