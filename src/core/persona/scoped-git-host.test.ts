import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toHumanId } from "../storage/interface.js";
import type { Comment, HumanRef } from "../storage/interface.js";
import {
    toRepoId,
    toPullRequestId,
    toCommitSha,
    type CommitStatus,
    type CreatePullRequestInput,
    type GitHost,
    type GitMutationResult,
    type InlineCommentInput,
    type PullRequestId,
    type PullRequestRef,
    type PullRequestComment,
    type PullRequestState,
    type RepoId,
    type RepoRef,
} from "../git/interface.js";
import { emptyPersonaShell, type GitHostAction, type PersonaConfig } from "./config.js";
import { PersonaScopedGitHost } from "./scoped-git-host.js";
import { PersonaPermissionError } from "./scoped-work-tracker.js";

/** A fake inner GitHost that records every call it actually receives, so tests can prove a
 *  denied action never reaches it. */
class RecordingGitHost implements GitHost {
    readonly calls: string[] = [];

    async getCurrentUser(): Promise<HumanRef> {
        this.calls.push("getCurrentUser");
        return { id: toHumanId("x"), displayName: "x" };
    }

    async getRepository(_id: RepoId): Promise<RepoRef | null> {
        this.calls.push("getRepository");
        return null;
    }

    async listRepositories(_workspace: string): Promise<readonly RepoRef[]> {
        this.calls.push("listRepositories");
        return [];
    }

    async listBranches(_repo: RepoId): Promise<readonly string[]> {
        this.calls.push("listBranches");
        return [];
    }

    async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
        this.calls.push("createPullRequest");
        return prFixture({ repo: input.repo, title: input.title, sourceBranch: input.sourceBranch });
    }

    async listPullRequestActivity(): Promise<readonly []> {
        this.calls.push("listPullRequestActivity");
        return [];
    }

    async getPullRequest(_repo: RepoId, _id: PullRequestId): Promise<PullRequestRef | null> {
        this.calls.push("getPullRequest");
        return null;
    }

    /** TAI-562: the options the last `listPullRequests` call received, to check the scoped host passes them on. */
    lastListOptions: unknown = undefined;

    async listPullRequests(_repo: RepoId, _state?: PullRequestState, options?: unknown): Promise<readonly PullRequestRef[]> {
        this.calls.push("listPullRequests");
        this.lastListOptions = options;
        return [];
    }

    async reviewPullRequest(): Promise<void> {
        this.calls.push("reviewPullRequest");
    }

    async unapprovePullRequest(): Promise<void> {
        this.calls.push("unapprovePullRequest");
    }

    async addPullRequestComment(_repo: RepoId, _id: PullRequestId, _body: string): Promise<Comment> {
        this.calls.push("addPullRequestComment");
        return {
            id: "c1",
            author: { id: toHumanId("x"), displayName: "x" },
            body: "x",
            createdAt: "x",
            updatedAt: "x",
        };
    }

    async listPullRequestComments(_repo: RepoId, _id: PullRequestId): Promise<readonly PullRequestComment[]> {
        this.calls.push("listPullRequestComments");
        return [];
    }
    async addInlineComment(_repo: RepoId, _id: PullRequestId, _input: InlineCommentInput): Promise<Comment> {
        this.calls.push("addInlineComment");
        return {
            id: "c2",
            author: { id: toHumanId("x"), displayName: "x" },
            body: "x",
            createdAt: "x",
            updatedAt: "x",
        };
    }

    async mergePullRequest(): Promise<GitMutationResult> {
        this.calls.push("mergePullRequest");
        return { ok: true, pullRequest: prFixture({}) };
    }

    async getCommitStatuses(_repo: RepoId, _commit: unknown): Promise<readonly CommitStatus[]> {
        this.calls.push("getCommitStatuses");
        return [];
    }

    async createCommitStatus(_repo: RepoId, _commit: unknown, input: { key: string; name: string; state: CommitStatus["state"] }): Promise<CommitStatus> {
        this.calls.push("createCommitStatus");
        return { key: input.key, name: input.name, state: input.state };
    }
}

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

function configWith(id: string, displayName: string, gitHost: readonly GitHostAction[]): PersonaConfig {
    const shell = emptyPersonaShell(id, displayName);
    return { ...shell, permissions: { ...shell.permissions, gitHost } };
}

const devConfig = () => configWith("developer", "Dario", ["createPullRequest"]);
const reviewerConfig = () => configWith("code-reviewer", "Cole", ["reviewPullRequest"]);
const devopsConfig = () => configWith("devops", "Duncan", ["mergePullRequest"]);
const noGrantsConfig = () => configWith("developer", "Dario", []);

const repo = toRepoId("dmayhak/tai-framework");
const pr = toPullRequestId("10");

describe("PersonaScopedGitHost.createPullRequest", () => {
    it("rejects when the persona lacks createPullRequest, before the inner GitHost is ever called", async () => {
        const inner = new RecordingGitHost();
        const scoped = new PersonaScopedGitHost(inner, noGrantsConfig());

        await assert.rejects(
            () => scoped.createPullRequest({ repo, title: "x", sourceBranch: "a", destinationBranch: "master" }),
            PersonaPermissionError
        );
        assert.deepEqual(inner.calls, []);
    });

    it("passes an allowed create straight through unchanged", async () => {
        const inner = new RecordingGitHost();
        const scoped = new PersonaScopedGitHost(inner, devConfig());

        const created = await scoped.createPullRequest({
            repo,
            title: "My PR",
            sourceBranch: "feature",
            destinationBranch: "master",
        });
        assert.equal(created.title, "My PR");
        assert.deepEqual(inner.calls, ["createPullRequest"]);
    });
});

describe("PersonaScopedGitHost.reviewPullRequest", () => {
    it("rejects when the persona lacks reviewPullRequest, before the inner GitHost is ever called", async () => {
        const inner = new RecordingGitHost();
        const scoped = new PersonaScopedGitHost(inner, noGrantsConfig());

        await assert.rejects(() => scoped.reviewPullRequest(repo, pr, "approve"), PersonaPermissionError);
        assert.deepEqual(inner.calls, []);
    });

    it("delegates an allowed review", async () => {
        const inner = new RecordingGitHost();
        const scoped = new PersonaScopedGitHost(inner, reviewerConfig());

        await scoped.reviewPullRequest(repo, pr, "approve");
        assert.deepEqual(inner.calls, ["reviewPullRequest"]);
    });
});

describe("PersonaScopedGitHost.mergePullRequest", () => {
    it("returns ok:false for a denied merge, without delegating to the inner mergePullRequest", async () => {
        const inner = new RecordingGitHost();
        const scoped = new PersonaScopedGitHost(inner, noGrantsConfig());

        const result = await scoped.mergePullRequest(repo, pr);
        assert.equal(result.ok, false);
        assert.deepEqual(inner.calls, []);
    });

    it("delegates a granted merge", async () => {
        const inner = new RecordingGitHost();
        const scoped = new PersonaScopedGitHost(inner, devopsConfig());

        const result = await scoped.mergePullRequest(repo, pr);
        assert.equal(result.ok, true);
        assert.deepEqual(inner.calls, ["mergePullRequest"]);
    });
});

describe("PersonaScopedGitHost listPullRequests options (TAI-562)", () => {
    it("passes updatedSince on to the inner host", async () => {
        const inner = new RecordingGitHost();
        const scoped = new PersonaScopedGitHost(inner, devopsConfig());
        await scoped.listPullRequests(repo, "merged", { updatedSince: "2026-10-01T00:00:00Z" });
        assert.deepEqual(inner.lastListOptions, { updatedSince: "2026-10-01T00:00:00Z" });
    });
});

describe("PersonaScopedGitHost pass-through methods", () => {
    it("delegates every read-only method unchanged, regardless of gitHost grants", async () => {
        const inner = new RecordingGitHost();
        const scoped = new PersonaScopedGitHost(inner, noGrantsConfig());

        await scoped.getCurrentUser();
        await scoped.getRepository(repo);
        await scoped.listRepositories("dmayhak");
        await scoped.listBranches(repo);
        await scoped.getPullRequest(repo, pr);
        await scoped.listPullRequests(repo);
        await scoped.unapprovePullRequest(repo, pr);
        await scoped.addPullRequestComment(repo, pr, "x");
        await scoped.addInlineComment(repo, pr, { path: "a.ts", line: 1, body: "x" });
        await scoped.listPullRequestComments(repo, pr);
        await scoped.getCommitStatuses(repo, toCommitSha("abc123"));

        assert.deepEqual(inner.calls, [
            "getCurrentUser",
            "getRepository",
            "listRepositories",
            "listBranches",
            "getPullRequest",
            "listPullRequests",
            "unapprovePullRequest",
            "addPullRequestComment",
            "addInlineComment",
            "listPullRequestComments",
            "getCommitStatuses",
        ]);
    });
});
