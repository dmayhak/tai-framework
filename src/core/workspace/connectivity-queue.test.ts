import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Status, SubtaskType } from "../schema/story-schema.js";
import {
    StorageConnectivityError,
    toIssueKey,
    type AttachmentRef,
    type Comment,
    type CreateIssueInput,
    type HumanRef,
    type Issue,
    type IssueFilter,
    type IssueKey,
    type IssueLink,
    type MutationResult,
    type PageId,
    type RemoteLink,
    type WorkTracker,
} from "../storage/interface.js";
import { readJournal } from "./journal.js";
import { ConnectivityQueuedWorkTracker, WriteQueuedError, replayPending } from "./connectivity-queue.js";
import { emptyPersonaShell } from "../persona/config.js";
import { PersonaPermissionError, PersonaScopedWorkTracker } from "../persona/scoped-work-tracker.js";

type Behavior<T> = () => Promise<T>;

/** A fully-scriptable fake: each queueable method pops the next behavior off its own
 *  script queue, recording every call it actually receives (so tests can prove ordering
 *  and prove a denied/queued action never reaches further than it should). */
class ScriptedWorkTracker implements WorkTracker {
    readonly calls: string[] = [];
    private addCommentScript: Behavior<Comment>[] = [];
    private transitionScript: Behavior<MutationResult>[] = [];
    private assignIssueScript: Behavior<MutationResult>[] = [];

    scriptAddComment(...behaviors: Behavior<Comment>[]): this {
        this.addCommentScript.push(...behaviors);
        return this;
    }
    scriptTransition(...behaviors: Behavior<MutationResult>[]): this {
        this.transitionScript.push(...behaviors);
        return this;
    }
    scriptAssignIssue(...behaviors: Behavior<MutationResult>[]): this {
        this.assignIssueScript.push(...behaviors);
        return this;
    }

    async addComment(key: IssueKey): Promise<Comment> {
        this.calls.push(`addComment(${key})`);
        const next = this.addCommentScript.shift();
        if (!next) throw new Error("addComment called with no scripted behavior left");
        return next();
    }
    async transition(key: IssueKey, target: Status): Promise<MutationResult> {
        this.calls.push(`transition(${key},${target})`);
        const next = this.transitionScript.shift();
        if (!next) throw new Error("transition called with no scripted behavior left");
        return next();
    }
    async assignIssue(key: IssueKey): Promise<MutationResult> {
        this.calls.push(`assignIssue(${key})`);
        const next = this.assignIssueScript.shift();
        if (!next) throw new Error("assignIssue called with no scripted behavior left");
        return next();
    }

    // ---------- pass-through stubs, just enough to prove delegation ----------
    async getIssue(): Promise<Issue | null> {
        this.calls.push("getIssue");
        return null;
    }
    async createIssue(_input: CreateIssueInput): Promise<Issue> {
        this.calls.push("createIssue");
        throw new Error("not used in these tests");
    }
    async updateIssue(): Promise<Issue> {
        this.calls.push("updateIssue");
        throw new Error("not used in these tests");
    }
    async getAvailableTransitions(): Promise<readonly Status[]> {
        this.calls.push("getAvailableTransitions");
        return [];
    }
    async resolveHuman(): Promise<HumanRef | null> {
        this.calls.push("resolveHuman");
        return null;
    }
    async editComment(): Promise<Comment> {
        this.calls.push("editComment");
        throw new Error("not used in these tests");
    }
    async addLabel(): Promise<void> {
        this.calls.push("addLabel");
    }
    async removeLabel(): Promise<void> {
        this.calls.push("removeLabel");
    }
    async createLink(): Promise<void> {
        this.calls.push("createLink");
    }
    async removeLink(): Promise<boolean> {
        this.calls.push("removeLink");
        return true;
    }
    async getLinkedIssues(): Promise<readonly IssueLink[]> {
        this.calls.push("getLinkedIssues");
        return [];
    }
    async linkPage(): Promise<void> {
        this.calls.push("linkPage");
    }
    async getLinkedPages(): Promise<readonly PageId[]> {
        this.calls.push("getLinkedPages");
        return [];
    }
    async createRemoteLink(): Promise<void> {
        this.calls.push("createRemoteLink");
    }
    async getRemoteLinks(): Promise<readonly RemoteLink[]> {
        this.calls.push("getRemoteLinks");
        return [];
    }
    async listAttachments(): Promise<readonly AttachmentRef[]> {
        this.calls.push("listAttachments");
        return [];
    }
    async getAttachment(): Promise<Buffer> {
        this.calls.push("getAttachment");
        throw new Error("not used in these tests");
    }
    async search(_filter: IssueFilter): Promise<readonly Issue[]> {
        this.calls.push("search");
        return [];
    }
}

const okComment = (): Promise<Comment> =>
    Promise.resolve({ id: "c1", author: { id: "u1", displayName: "U1" } as unknown as HumanRef, body: "x", createdAt: "x", updatedAt: "x" });
const okMutation = (issueKey: IssueKey): Behavior<MutationResult> =>
    (): Promise<MutationResult> =>
        Promise.resolve({ ok: true, issue: { key: issueKey } as unknown as Issue });
const rejectMutation = (reason: string): Behavior<MutationResult> => (): Promise<MutationResult> => Promise.resolve({ ok: false, reason });
const throwOffline: Behavior<never> = () => {
    throw new StorageConnectivityError("offline");
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-connqueue-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("ConnectivityQueuedWorkTracker — queueing", () => {
    it("queues addComment on StorageConnectivityError and throws WriteQueuedError, not the original error", async () => {
        await withTempDir(async (dir) => {
            const inner = new ScriptedWorkTracker().scriptAddComment(throwOffline);
            const queued = new ConnectivityQueuedWorkTracker(inner, dir, "TAI", "TAI-1");

            await assert.rejects(() => queued.addComment(toIssueKey("TAI-1"), "hello"), WriteQueuedError);

            const journal = await readJournal(dir, "TAI", "TAI-1");
            assert.match(journal ?? "", /QUEUED: addComment/);
        });
    });

    it("queues transition and assignIssue the same way", async () => {
        await withTempDir(async (dir) => {
            const inner = new ScriptedWorkTracker().scriptTransition(throwOffline).scriptAssignIssue(throwOffline);
            const queued = new ConnectivityQueuedWorkTracker(inner, dir, "TAI", "TAI-1");

            await assert.rejects(() => queued.transition(toIssueKey("TAI-1"), Status.Done), WriteQueuedError);
            await assert.rejects(() => queued.assignIssue(toIssueKey("TAI-1"), null), WriteQueuedError);

            const journal = await readJournal(dir, "TAI", "TAI-1");
            assert.match(journal ?? "", /QUEUED: transition/);
            assert.match(journal ?? "", /QUEUED: assignIssue/);
        });
    });

    it("does NOT queue a non-connectivity error -- it propagates unchanged", async () => {
        await withTempDir(async (dir) => {
            const boom = new Error("some other real failure");
            const inner = new ScriptedWorkTracker().scriptAddComment(() => {
                throw boom;
            });
            const queued = new ConnectivityQueuedWorkTracker(inner, dir, "TAI", "TAI-1");

            await assert.rejects(() => queued.addComment(toIssueKey("TAI-1"), "hi"), (err: unknown) => err === boom);
            assert.equal(await readJournal(dir, "TAI", "TAI-1"), null);
        });
    });

    it("passes an allowed call straight through when the inner tracker succeeds", async () => {
        await withTempDir(async (dir) => {
            const inner = new ScriptedWorkTracker().scriptAddComment(okComment);
            const queued = new ConnectivityQueuedWorkTracker(inner, dir, "TAI", "TAI-1");
            const comment = await queued.addComment(toIssueKey("TAI-1"), "hi");
            assert.equal(comment.id, "c1");
            assert.equal(await readJournal(dir, "TAI", "TAI-1"), null);
        });
    });

    it("delegates every other WorkTracker method unchanged", async () => {
        await withTempDir(async (dir) => {
            const inner = new ScriptedWorkTracker();
            const queued = new ConnectivityQueuedWorkTracker(inner, dir, "TAI", "TAI-1");
            const key = toIssueKey("TAI-1");
            await queued.getIssue(key);
            await queued.getAvailableTransitions(key);
            await queued.resolveHuman("x@example.com");
            await queued.addLabel(key, "x");
            await queued.search({ projectKey: "TAI" });
            assert.deepEqual(inner.calls, ["getIssue", "getAvailableTransitions", "resolveHuman", "addLabel", "search"]);
        });
    });
});

describe("replayPending", () => {
    it("replays a queued write in a later attempt and marks it REPLAYED", async () => {
        await withTempDir(async (dir) => {
            const offlineTracker = new ScriptedWorkTracker().scriptTransition(throwOffline);
            const queued = new ConnectivityQueuedWorkTracker(offlineTracker, dir, "TAI", "TAI-1");
            await assert.rejects(() => queued.transition(toIssueKey("TAI-1"), Status.Done));

            const backOnline = new ScriptedWorkTracker().scriptTransition(okMutation(toIssueKey("TAI-1")));
            const outcome = await replayPending(backOnline, dir, "TAI", "TAI-1");

            assert.equal(outcome.replayed, 1);
            assert.equal(outcome.stillQueued, 0);
            assert.deepEqual(outcome.escalated, []);
            assert.deepEqual(backOnline.calls, [`transition(TAI-1,${Status.Done})`]);

            const journal = await readJournal(dir, "TAI", "TAI-1");
            assert.match(journal ?? "", /REPLAYED: transition/);
        });
    });

    it("does not replay the same entry twice", async () => {
        await withTempDir(async (dir) => {
            const offlineTracker = new ScriptedWorkTracker().scriptTransition(throwOffline);
            const queued = new ConnectivityQueuedWorkTracker(offlineTracker, dir, "TAI", "TAI-1");
            await assert.rejects(() => queued.transition(toIssueKey("TAI-1"), Status.Done));

            const backOnline = new ScriptedWorkTracker().scriptTransition(okMutation(toIssueKey("TAI-1")));
            await replayPending(backOnline, dir, "TAI", "TAI-1");

            // A second replay pass should find nothing left to do -- no scripted behavior
            // needed because transition() should never be called again.
            const secondPass = new ScriptedWorkTracker();
            const outcome = await replayPending(secondPass, dir, "TAI", "TAI-1");
            assert.equal(outcome.replayed, 0);
            assert.deepEqual(secondPass.calls, []);
        });
    });

    it("replays multiple queued writes in original FIFO order", async () => {
        await withTempDir(async (dir) => {
            const offlineTracker = new ScriptedWorkTracker().scriptAddComment(throwOffline).scriptTransition(throwOffline);
            const queued = new ConnectivityQueuedWorkTracker(offlineTracker, dir, "TAI", "TAI-1");
            await assert.rejects(() => queued.addComment(toIssueKey("TAI-1"), "first"));
            await assert.rejects(() => queued.transition(toIssueKey("TAI-1"), Status.Done));

            const backOnline = new ScriptedWorkTracker().scriptAddComment(okComment).scriptTransition(okMutation(toIssueKey("TAI-1")));
            const outcome = await replayPending(backOnline, dir, "TAI", "TAI-1");

            assert.equal(outcome.replayed, 2);
            assert.deepEqual(backOnline.calls, [`addComment(TAI-1)`, `transition(TAI-1,${Status.Done})`]);
        });
    });

    it("leaves a still-offline write queued, without escalating it", async () => {
        await withTempDir(async (dir) => {
            const offlineTracker = new ScriptedWorkTracker().scriptTransition(throwOffline);
            const queued = new ConnectivityQueuedWorkTracker(offlineTracker, dir, "TAI", "TAI-1");
            await assert.rejects(() => queued.transition(toIssueKey("TAI-1"), Status.Done));

            const stillOffline = new ScriptedWorkTracker().scriptTransition(throwOffline);
            const outcome = await replayPending(stillOffline, dir, "TAI", "TAI-1");

            assert.equal(outcome.stillQueued, 1);
            assert.equal(outcome.replayed, 0);
            assert.deepEqual(outcome.escalated, []);
            const journal = await readJournal(dir, "TAI", "TAI-1");
            assert.match(journal ?? "", /QUEUED: transition/);
            assert.doesNotMatch(journal ?? "", /REPLAYED:/);
        });
    });

    it("escalates a REAL rejection on replay (brief §3.3 unplanned checkpoint) instead of dropping it", async () => {
        await withTempDir(async (dir) => {
            const offlineTracker = new ScriptedWorkTracker().scriptTransition(throwOffline);
            const queued = new ConnectivityQueuedWorkTracker(offlineTracker, dir, "TAI", "TAI-1");
            await assert.rejects(() => queued.transition(toIssueKey("TAI-1"), Status.Done));

            const nowRejects = new ScriptedWorkTracker().scriptTransition(rejectMutation("workflow validator blocked this"));
            const outcome = await replayPending(nowRejects, dir, "TAI", "TAI-1");

            assert.equal(outcome.replayed, 0);
            assert.equal(outcome.escalated.length, 1);
            assert.equal(outcome.escalated[0]?.reason, "workflow validator blocked this");
            // Not marked REPLAYED -- stays visible as still-pending in the journal.
            const journal = await readJournal(dir, "TAI", "TAI-1");
            assert.doesNotMatch(journal ?? "", /REPLAYED:/);
        });
    });

    it("stops at the first rejection rather than attempting later queued entries out of order (Gemini CLI review, PR #8)", async () => {
        await withTempDir(async (dir) => {
            const offlineTracker = new ScriptedWorkTracker().scriptAssignIssue(throwOffline).scriptTransition(throwOffline);
            const queued = new ConnectivityQueuedWorkTracker(offlineTracker, dir, "TAI", "TAI-1");
            await assert.rejects(() => queued.assignIssue(toIssueKey("TAI-1"), null));
            await assert.rejects(() => queued.transition(toIssueKey("TAI-1"), Status.Done));

            // First queued entry (assignIssue) now gets a REAL rejection on replay. The second
            // (transition) has NO scripted behavior at all -- if replayPending attempted it,
            // ScriptedWorkTracker would throw "no scripted behavior left", failing this test.
            const nowRejects = new ScriptedWorkTracker().scriptAssignIssue(rejectMutation("blocked"));
            const outcome = await replayPending(nowRejects, dir, "TAI", "TAI-1");

            assert.equal(outcome.replayed, 0);
            assert.equal(outcome.escalated.length, 1);
            assert.equal(outcome.escalated[0]?.method, "assignIssue");
            assert.equal(outcome.stillQueued, 1); // the transition entry, left untouched behind it
            assert.deepEqual(nowRejects.calls, [`assignIssue(TAI-1)`]); // transition() never attempted
        });
    });

    it("stops attempting further network calls once StorageConnectivityError is hit, rather than hammering an offline backend (Gemini CLI review, PR #8)", async () => {
        await withTempDir(async (dir) => {
            const offlineTracker = new ScriptedWorkTracker().scriptAddComment(throwOffline).scriptTransition(throwOffline);
            const queued = new ConnectivityQueuedWorkTracker(offlineTracker, dir, "TAI", "TAI-1");
            await assert.rejects(() => queued.addComment(toIssueKey("TAI-1"), "first"));
            await assert.rejects(() => queued.transition(toIssueKey("TAI-1"), Status.Done));

            // Still offline -- the second entry (transition) has no scripted behavior; if
            // replayPending attempted it after the first StorageConnectivityError, this fake
            // would throw "no scripted behavior left" and fail the test.
            const stillOffline = new ScriptedWorkTracker().scriptAddComment(throwOffline);
            const outcome = await replayPending(stillOffline, dir, "TAI", "TAI-1");

            assert.equal(outcome.stillQueued, 2); // both entries -- one attempted-and-offline, one never touched
            assert.equal(outcome.replayed, 0);
            assert.deepEqual(outcome.escalated, []);
            assert.deepEqual(stillOffline.calls, [`addComment(TAI-1)`]); // transition() never attempted
        });
    });

    it("returns an empty outcome when there's no journal at all yet", async () => {
        await withTempDir(async (dir) => {
            const tracker = new ScriptedWorkTracker();
            const outcome = await replayPending(tracker, dir, "TAI", "TAI-1");
            assert.deepEqual(outcome, { replayed: 0, stillQueued: 0, escalated: [] });
        });
    });
});

describe("composition with PersonaScopedWorkTracker (TAI-52)", () => {
    it("a permission denial short-circuits before ever reaching the connectivity layer", async () => {
        await withTempDir(async (dir) => {
            const inner = new ScriptedWorkTracker(); // no scripted behaviors -- must never be called
            const connectivityLayer = new ConnectivityQueuedWorkTracker(inner, dir, "TAI", "TAI-1");
            const persona = emptyPersonaShell("developer", "Dario"); // no grants at all
            const scoped = new PersonaScopedWorkTracker(connectivityLayer, persona);

            await assert.rejects(
                () => scoped.createIssue({ projectKey: "TAI", issueType: SubtaskType.Dev, summary: "x" }),
                PersonaPermissionError
            );
            assert.deepEqual(inner.calls, []); // never reached the connectivity layer's inner tracker
            assert.equal(await readJournal(dir, "TAI", "TAI-1"), null); // nothing queued either
        });
    });
});
