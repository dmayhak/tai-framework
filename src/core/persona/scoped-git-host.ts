/**
 * TAI Framework — PersonaScopedGitHost (TAI-73, the git-hosting sibling of TAI-51's
 * PersonaScopedWorkTracker)
 *
 * Wraps a real backend's `GitHost`, binding ONE persona for its lifetime. Checks
 * `canPerformGitAction` (`permission-gate.ts`) before delegating `createPullRequest`/
 * `reviewPullRequest`/`mergePullRequest`; every other method — including `unapprovePullRequest`
 * (TAI-217/219), a mutation but never reached through THIS class in practice, since it's only
 * ever invoked via the roster-gated `resolveReviewerGitHost` path (cli.ts), same as
 * `addPullRequestComment` — passes through unchanged, same restraint as `GitHost` itself
 * (`git/interface.ts`'s own doc comment: scoped to exactly what the TAI-34 checkpoint chain
 * gates, not the full breadth of either host's API).
 *
 * Same per-method rejection shape discipline as `PersonaScopedWorkTracker`: a denial on a
 * method with no rejection shape in its own signature (`createPullRequest` ->
 * `PullRequestRef`, `reviewPullRequest` -> `void`) THROWS `PersonaPermissionError`;
 * `mergePullRequest` already returns `GitMutationResult`, so a denial there returns
 * `{ ok: false, reason }` instead — matching each method's own existing contract rather
 * than inventing a new one.
 */

import type {
    CommitSha,
    CommitStatus,
    CreatePullRequestInput,
    GitHost,
    GitMutationResult,
    PullRequestId,
    PullRequestRef,
    PullRequestState,
    RepoId,
    RepoRef,
} from "../git/interface.js";
import type { Comment, HumanRef } from "../storage/interface.js";
import type { PersonaConfig } from "./config.js";
import { canPerformGitAction } from "./permission-gate.js";
import { PersonaPermissionError } from "./scoped-work-tracker.js";

export class PersonaScopedGitHost implements GitHost {
    constructor(
        private readonly inner: GitHost,
        private readonly persona: PersonaConfig
    ) {}

    getCurrentUser(): Promise<HumanRef> {
        return this.inner.getCurrentUser();
    }

    getRepository(id: RepoId): Promise<RepoRef | null> {
        return this.inner.getRepository(id);
    }

    listRepositories(workspace: string): Promise<readonly RepoRef[]> {
        return this.inner.listRepositories(workspace);
    }

    listBranches(repo: RepoId, limit?: number): Promise<readonly string[]> {
        return this.inner.listBranches(repo, limit);
    }

    async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
        if (!canPerformGitAction(this.persona, "createPullRequest")) {
            throw new PersonaPermissionError(this.persona.id, "create", "a pull request (GitHost)");
        }
        return this.inner.createPullRequest(input);
    }

    getPullRequest(repo: RepoId, id: PullRequestId): Promise<PullRequestRef | null> {
        return this.inner.getPullRequest(repo, id);
    }

    listPullRequests(repo: RepoId, state?: PullRequestState): Promise<readonly PullRequestRef[]> {
        return this.inner.listPullRequests(repo, state);
    }

    async reviewPullRequest(
        repo: RepoId,
        id: PullRequestId,
        decision: "approve" | "requestChanges",
        comment?: string
    ): Promise<void> {
        if (!canPerformGitAction(this.persona, "reviewPullRequest")) {
            throw new PersonaPermissionError(this.persona.id, "review", "a pull request (GitHost)");
        }
        return this.inner.reviewPullRequest(repo, id, decision, comment);
    }

    unapprovePullRequest(repo: RepoId, id: PullRequestId): Promise<void> {
        return this.inner.unapprovePullRequest(repo, id);
    }

    addPullRequestComment(repo: RepoId, id: PullRequestId, body: string): Promise<Comment> {
        return this.inner.addPullRequestComment(repo, id, body);
    }

    async mergePullRequest(
        repo: RepoId,
        id: PullRequestId,
        strategy?: "mergeCommit" | "squash" | "fastForward"
    ): Promise<GitMutationResult> {
        if (!canPerformGitAction(this.persona, "mergePullRequest")) {
            return {
                ok: false,
                reason: `Persona "${this.persona.id}" is not permitted to merge pull requests (brief §3.1 permission matrix).`,
            };
        }
        return this.inner.mergePullRequest(repo, id, strategy);
    }

    getCommitStatuses(repo: RepoId, commit: CommitSha): Promise<readonly CommitStatus[]> {
        return this.inner.getCommitStatuses(repo, commit);
    }
}
