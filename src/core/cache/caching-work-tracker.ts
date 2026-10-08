/**
 * TAI Framework — CachingWorkTracker (TAI-304/311 ADR, Confluence page 39518210)
 *
 * A `WorkTracker` decorator (same pattern as `connectivity-queue.ts`'s
 * `ConnectivityQueuedWorkTracker` / `persona/scoped-work-tracker.ts`'s
 * `PersonaScopedWorkTracker`) that writes a mutation's result through to the local disk
 * cache (`cache/issue-cache.ts`'s `cacheIssue`) immediately after it succeeds — replacing
 * TAI-303's call-site-specific `cacheIssue` calls with one mechanism every caller of
 * `WorkTracker.transition`/`updateIssue`/`assignIssue` gets automatically, cascades
 * included (`MutationResult.affectedIssues`, this same ADR).
 *
 * Deliberately a pure decorator wrapping an inner `WorkTracker`, not a change to either
 * backend: the backends still know nothing about `taiRoot`/caching (`cache/*.ts` wraps
 * `StorageBackend`, never the reverse) — see the ADR's rejected "push into the backend"
 * alternative for why that boundary matters.
 *
 * Wired centrally in `cli.ts`'s `resolveConfig()`, not ad hoc per call site, so every
 * caller starting from `config.backend.workTracker` (the CLI's own mutation handlers,
 * `git-pr merge`, `ready.ts`'s sync helpers, `work.ts`'s further-decorated instance, and
 * `connectivity-queue.ts`'s `replayPending`) gets write-through caching without any
 * per-call-site change.
 */

import type {
    AttachmentRef,
    Comment,
    CreateIssueInput,
    HumanRef,
    Issue,
    IssueFilter,
    IssueKey,
    IssueLink,
    IssuePatch,
    MutationResult,
    TransitionOptions,
    PageId,
    RemoteLink,
    WorkTracker,
} from "../storage/interface.js";
import type { DependencyRelation, Status } from "../schema/story-schema.js";
import { cacheIssue } from "./issue-cache.js";

export class CachingWorkTracker implements WorkTracker {
    constructor(
        private readonly inner: WorkTracker,
        private readonly taiRoot: string,
        private readonly projectKey: string
    ) {}

    async updateIssue(key: IssueKey, patch: IssuePatch): Promise<Issue> {
        const issue = await this.inner.updateIssue(key, patch);
        await cacheIssue(this.taiRoot, this.projectKey, issue);
        return issue;
    }

    async transition(key: IssueKey, target: Status, options?: TransitionOptions): Promise<MutationResult> {
        const result = await this.inner.transition(key, target, options);
        await this.cacheMutationResult(result);
        return result;
    }

    async assignIssue(key: IssueKey, human: HumanRef | null): Promise<MutationResult> {
        const result = await this.inner.assignIssue(key, human);
        await this.cacheMutationResult(result);
        return result;
    }

    /** Shared by `transition`/`assignIssue`: cache the primary issue plus any cascade-
     *  affected issues on success. A no-op on rejection -- there's nothing new to cache. */
    private async cacheMutationResult(result: MutationResult): Promise<void> {
        if (!result.ok) return;
        await cacheIssue(this.taiRoot, this.projectKey, result.issue);
        for (const affected of result.affectedIssues ?? []) {
            await cacheIssue(this.taiRoot, this.projectKey, affected);
        }
    }

    // ---------- pass-through: everything else is untouched ----------

    getIssue(key: IssueKey): Promise<Issue | null> {
        return this.inner.getIssue(key);
    }
    createIssue(input: CreateIssueInput): Promise<Issue> {
        return this.inner.createIssue(input);
    }
    getAvailableTransitions(key: IssueKey): Promise<readonly Status[]> {
        return this.inner.getAvailableTransitions(key);
    }
    resolveHuman(email: string): Promise<HumanRef | null> {
        return this.inner.resolveHuman(email);
    }
    addComment(key: IssueKey, body: string): Promise<Comment> {
        return this.inner.addComment(key, body);
    }
    editComment(key: IssueKey, commentId: string, body: string): Promise<Comment> {
        return this.inner.editComment(key, commentId, body);
    }
    addLabel(key: IssueKey, label: string): Promise<void> {
        return this.inner.addLabel(key, label);
    }
    removeLabel(key: IssueKey, label: string): Promise<void> {
        return this.inner.removeLabel(key, label);
    }
    createLink(from: IssueKey, relation: DependencyRelation, to: IssueKey): Promise<void> {
        return this.inner.createLink(from, relation, to);
    }
    getLinkedIssues(
        key: IssueKey,
        relation?: DependencyRelation,
        direction?: "outgoing" | "incoming"
    ): Promise<readonly IssueLink[]> {
        return this.inner.getLinkedIssues(key, relation, direction);
    }
    linkPage(key: IssueKey, page: PageId): Promise<void> {
        return this.inner.linkPage(key, page);
    }
    getLinkedPages(key: IssueKey): Promise<readonly PageId[]> {
        return this.inner.getLinkedPages(key);
    }
    createRemoteLink(key: IssueKey, url: string, title: string): Promise<void> {
        return this.inner.createRemoteLink(key, url, title);
    }
    getRemoteLinks(key: IssueKey): Promise<readonly RemoteLink[]> {
        return this.inner.getRemoteLinks(key);
    }
    listAttachments(key: IssueKey): Promise<readonly AttachmentRef[]> {
        return this.inner.listAttachments(key);
    }
    getAttachment(key: IssueKey, attachmentId: string): Promise<Buffer> {
        return this.inner.getAttachment(key, attachmentId);
    }
    search(filter: IssueFilter): Promise<readonly Issue[]> {
        return this.inner.search(filter);
    }
}
