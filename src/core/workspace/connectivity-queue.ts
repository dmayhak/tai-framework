/**
 * TAI Framework — ConnectivityQueuedWorkTracker (TAI-56 ADR decision 3)
 *
 * A `WorkTracker` decorator (same pattern as TAI-52's `PersonaScopedWorkTracker`) that
 * queues `addComment`/`transition`/`assignIssue` — brief §3.6's own enumeration, "comments,
 * transitions, assignments" — when the inner tracker throws `StorageConnectivityError`,
 * instead of letting the error propagate as an ordinary failure. `createIssue`/`updateIssue`
 * are deliberately NOT queued: starting new work while offline is a materially different,
 * riskier case than deferring a write that continues already-started work, and brief §3.6
 * never lists them.
 *
 * Queued writes live directly in `journal.md` as `QUEUED:`/`REPLAYED:` entries (ADR: "the
 * journal is already the append-only ... record ... so queuing pending writes there is the
 * same mechanism, not a new one") — not a separate file.
 *
 * **Refinement over the ADR's literal wording, found during implementation:** the ADR said
 * a queued write "returns a distinct `queued: true` result rather than propagating the
 * throw." That doesn't type-check against `WorkTracker`'s real signatures —
 * `addComment` always resolves to a `Comment` or throws (no rejection shape to repurpose),
 * and overloading `transition`/`assignIssue`'s `MutationResult.ok: false` to also mean
 * "queued, not actually rejected" would incorrectly feed brief §3.3's unplanned-checkpoint/
 * escalation path for something that isn't a rejection at all. Instead: queue the write,
 * then **throw `WriteQueuedError`** (a `StorageConnectivityError` subclass) — a caller with
 * existing `StorageConnectivityError` handling picks this up automatically (semantically
 * correct: the write didn't happen against the live backend), while a caller that wants to
 * specifically distinguish "queued for replay" from "connectivity still down" can check
 * `instanceof WriteQueuedError`. Every `WorkTracker` method is already allowed to throw
 * regardless of its declared resolved type, so this keeps full interface compliance.
 *
 * The journal a queued write lands in is always the **bound `subtaskKey`'s** — not
 * necessarily the `key` a given call targets. This is intentional: brief §7's journal
 * belongs to the *work session* (one subtask), which may legitimately write to a different
 * issue mid-session (e.g. a comment placed on the parent per §4's "who needs to know"
 * rule) — the journal records what that session did, not a per-target-issue history.
 */

import type { DependencyRelation, Status } from "../schema/story-schema.js";
import {
    StorageConnectivityError,
    type AttachmentRef,
    type Comment,
    type CreateIssueInput,
    type HumanRef,
    type Issue,
    type IssueFilter,
    type IssueKey,
    type IssueLink,
    type IssuePatch,
    type MutationResult,
    type PageId,
    type WorkTracker,
} from "../storage/interface.js";
import { appendJournalEntry, parseJournalEntries, readJournal } from "./journal.js";

export type QueueableMethod = "addComment" | "transition" | "assignIssue";

interface QueuedAddComment {
    readonly method: "addComment";
    readonly key: IssueKey;
    readonly body: string;
}
interface QueuedTransition {
    readonly method: "transition";
    readonly key: IssueKey;
    readonly target: Status;
}
interface QueuedAssignIssue {
    readonly method: "assignIssue";
    readonly key: IssueKey;
    readonly human: HumanRef | null;
}
export type QueuedCall = QueuedAddComment | QueuedTransition | QueuedAssignIssue;

export class WriteQueuedError extends StorageConnectivityError {
    constructor(method: QueueableMethod, key: IssueKey) {
        super(`${method} on ${key} could not reach the backend right now and was queued for replay (see journal.md).`);
        this.name = "WriteQueuedError";
    }
}

const JSON_FENCE = /```json\r?\n([\s\S]*?)\r?\n```/;

function formatQueuedCall(call: QueuedCall): string {
    return "```json\n" + JSON.stringify(call, null, 2) + "\n```";
}

function parseQueuedCall(detail: string): QueuedCall | null {
    const match = JSON_FENCE.exec(detail);
    if (!match) return null;
    try {
        return JSON.parse(match[1]!) as QueuedCall;
    } catch {
        return null;
    }
}

export class ConnectivityQueuedWorkTracker implements WorkTracker {
    constructor(
        private readonly inner: WorkTracker,
        private readonly taiRoot: string,
        private readonly projectKey: string,
        private readonly subtaskKey: string
    ) {}

    async addComment(key: IssueKey, body: string): Promise<Comment> {
        try {
            return await this.inner.addComment(key, body);
        } catch (err) {
            return this.queueOrRethrow(err, { method: "addComment", key, body });
        }
    }

    async transition(key: IssueKey, target: Status): Promise<MutationResult> {
        try {
            return await this.inner.transition(key, target);
        } catch (err) {
            return this.queueOrRethrow(err, { method: "transition", key, target });
        }
    }

    async assignIssue(key: IssueKey, human: HumanRef | null): Promise<MutationResult> {
        try {
            return await this.inner.assignIssue(key, human);
        } catch (err) {
            return this.queueOrRethrow(err, { method: "assignIssue", key, human });
        }
    }

    private async queueOrRethrow(err: unknown, call: QueuedCall): Promise<never> {
        if (!(err instanceof StorageConnectivityError)) throw err;
        await appendJournalEntry(this.taiRoot, this.projectKey, this.subtaskKey, `QUEUED: ${call.method}`, formatQueuedCall(call));
        throw new WriteQueuedError(call.method, call.key);
    }

    // ---------- pass-through: everything else is untouched ----------

    getIssue(key: IssueKey): Promise<Issue | null> {
        return this.inner.getIssue(key);
    }
    createIssue(input: CreateIssueInput): Promise<Issue> {
        return this.inner.createIssue(input);
    }
    updateIssue(key: IssueKey, patch: IssuePatch): Promise<Issue> {
        return this.inner.updateIssue(key, patch);
    }
    getAvailableTransitions(key: IssueKey): Promise<readonly Status[]> {
        return this.inner.getAvailableTransitions(key);
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

// ---------- replay ----------

export interface ReplayOutcome {
    /** Successfully replayed against the real backend this pass. */
    readonly replayed: number;
    /** Still offline — untouched, will be retried on the next replay call. */
    readonly stillQueued: number;
    /** A REAL (non-connectivity) failure on replay — an unplanned checkpoint (brief §3.3),
     *  never silently dropped or retried; left as an unresolved `QUEUED:` entry for a human
     *  to look at, same as any other unplanned checkpoint. */
    readonly escalated: readonly { readonly timestamp: string; readonly method: string; readonly reason: string }[];
}

// Matches a QUEUED entry to its REPLAYED counterpart by timestamp string. Assumes
// millisecond-ISO timestamps from distinct appendJournalEntry calls never collide — true in
// practice (sequential, awaited disk writes always take longer than 1ms), not enforced.
const REPLAYED_DESC = /^REPLAYED: \S+ \(queued (.+)\)$/;

function isRejection(result: unknown): result is { ok: false; reason: string } {
    return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false;
}

async function invokeQueuedCall(inner: WorkTracker, call: QueuedCall): Promise<unknown> {
    switch (call.method) {
        case "addComment":
            return inner.addComment(call.key, call.body);
        case "transition":
            return inner.transition(call.key, call.target);
        case "assignIssue":
            return inner.assignIssue(call.key, call.human);
    }
}

/**
 * Replays every not-yet-replayed `QUEUED:` journal entry against `inner`, in original
 * (FIFO) order, at the next refresh point (brief §3.6 timing — this is not a background
 * poller, a caller invokes it explicitly).
 */
export async function replayPending(
    inner: WorkTracker,
    taiRoot: string,
    projectKey: string,
    subtaskKey: string
): Promise<ReplayOutcome> {
    const journalText = await readJournal(taiRoot, projectKey, subtaskKey);
    if (!journalText) return { replayed: 0, stillQueued: 0, escalated: [] };

    const entries = parseJournalEntries(journalText);
    const alreadyReplayedTimestamps = new Set(
        entries
            .filter((e) => e.description.startsWith("REPLAYED:"))
            .map((e) => REPLAYED_DESC.exec(e.description)?.[1])
            .filter((t): t is string => t !== undefined)
    );

    let replayed = 0;
    let stillQueued = 0;
    const escalated: { timestamp: string; method: string; reason: string }[] = [];

    for (const entry of entries) {
        if (!entry.description.startsWith("QUEUED:") || alreadyReplayedTimestamps.has(entry.timestamp)) continue;

        const call = parseQueuedCall(entry.detail);
        if (!call) continue; // malformed/foreign entry -- skip, don't crash the whole replay pass

        try {
            const result = await invokeQueuedCall(inner, call);
            if (isRejection(result)) {
                escalated.push({ timestamp: entry.timestamp, method: call.method, reason: result.reason });
                continue; // real rejection -- leave QUEUED, do not mark replayed
            }
            await appendJournalEntry(taiRoot, projectKey, subtaskKey, `REPLAYED: ${call.method} (queued ${entry.timestamp})`);
            replayed++;
        } catch (err) {
            if (err instanceof StorageConnectivityError) {
                stillQueued++; // still offline -- leave it for the next replay attempt
                continue;
            }
            escalated.push({
                timestamp: entry.timestamp,
                method: call.method,
                reason: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return { replayed, stillQueued, escalated };
}
