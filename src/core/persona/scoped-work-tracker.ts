/**
 * TAI Framework — PersonaScopedWorkTracker (TAI-51 ADR decision 3)
 *
 * Wraps a real backend's `WorkTracker`, binding ONE persona for its lifetime. Checks
 * `canCreate`/`canComplete` (permission-gate.ts) before delegating; every other
 * method passes through unchanged. Zero changes to `storage/interface.ts` or either existing
 * backend — this is a pure decorator, not a new backend, chosen specifically over threading an
 * `actingPersona` parameter through `WorkTracker` itself (see the ADR's rejected option (a)).
 *
 * `workOn` is NOT enforced here — it's checked once, before a persona turn begins, by TAI-8's
 * (not yet built) invocation entry point, via the standalone `canWorkOn` predicate. There's no
 * `WorkTracker` call corresponding to "start a turn" for this decorator to intercept.
 *
 * `createIssue`/`updateIssue` return `Promise<Issue>` (no rejection shape in their signature),
 * so a permission denial there THROWS `PersonaPermissionError`. `transition` already returns
 * `MutationResult`, so a denial there returns `{ ok: false, reason }` instead — matching each
 * method's own existing contract rather than inventing a new one.
 */

import { Status, type DependencyRelation } from "../schema/story-schema.js";
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
import type { PersonaConfig } from "./config.js";
import { canComplete, canCreate } from "./permission-gate.js";

export class PersonaPermissionError extends Error {
    constructor(personaId: string, action: string, detail: string) {
        super(`Persona "${personaId}" is not permitted to ${action} ${detail} (brief §3.1 permission matrix).`);
        this.name = "PersonaPermissionError";
    }
}

/** "Completing" = reaching a terminal status — `Done` or `Canceled` (brief §5.3:
 *  Canceled counts as satisfied for precedence purposes, same as Done). Any other transition
 *  (e.g. `To Do` -> `In Progress`) isn't a completion and isn't gated by `canComplete`. */
function isCompletingTransition(target: Status): boolean {
    return target === Status.Done || target === Status.Canceled;
}

export class PersonaScopedWorkTracker implements WorkTracker {
    constructor(
        private readonly inner: WorkTracker,
        private readonly persona: PersonaConfig
    ) {}

    async createIssue(input: CreateIssueInput): Promise<Issue> {
        if (!canCreate(this.persona, input.issueType)) {
            throw new PersonaPermissionError(this.persona.id, "create", `issue type "${input.issueType}"`);
        }
        return this.inner.createIssue(input);
    }

    getIssue(key: IssueKey): Promise<Issue | null> {
        return this.inner.getIssue(key);
    }

    /** Not gated: per-field `update` grants were deleted (TAI-478). */
    updateIssue(key: IssueKey, patch: IssuePatch): Promise<Issue> {
        return this.inner.updateIssue(key, patch);
    }

    async transition(key: IssueKey, target: Status, options?: TransitionOptions): Promise<MutationResult> {
        if (isCompletingTransition(target)) {
            const current = await this.inner.getIssue(key);
            if (current && !canComplete(this.persona, current)) {
                return {
                    ok: false,
                    reason: `Persona "${this.persona.id}" is not permitted to complete ${current.issueType} issues (brief §3.1 permission matrix).`,
                };
            }
        }
        return this.inner.transition(key, target, options);
    }

    getAvailableTransitions(key: IssueKey): Promise<readonly Status[]> {
        return this.inner.getAvailableTransitions(key);
    }

    assignIssue(key: IssueKey, human: HumanRef | null): Promise<MutationResult> {
        return this.inner.assignIssue(key, human);
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
