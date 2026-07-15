import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toRepoId } from "../interface.js";
import { toHumanRef, toRepoRef, toPullRequestRef, toCommitStatus, toComment } from "./mappers.js";
import type {
    BitbucketUserJson,
    BitbucketRepositoryJson,
    BitbucketPullRequestJson,
    BitbucketCommitStatusJson,
    BitbucketCommentJson,
} from "./mappers.js";

const USER: BitbucketUserJson = {
    account_id: "acct-123",
    display_name: "Del Mayhak",
    nickname: "del",
};

describe("toHumanRef", () => {
    it("prefers account_id and display_name", () => {
        const ref = toHumanRef(USER);
        assert.equal(ref.id, "acct-123");
        assert.equal(ref.displayName, "Del Mayhak");
        assert.equal(ref.email, undefined, "Bitbucket user objects never carry email");
    });

    it("falls back to uuid and nickname when account_id/display_name are absent", () => {
        const ref = toHumanRef({ uuid: "{uuid-1}", nickname: "del" });
        assert.equal(ref.id, "{uuid-1}");
        assert.equal(ref.displayName, "del");
    });
});

describe("toRepoRef", () => {
    it("maps full_name, mainbranch, and the html link", () => {
        const repo: BitbucketRepositoryJson = {
            full_name: "dmayhak/tai-framework",
            name: "tai-framework",
            mainbranch: { name: "master" },
            links: { html: { href: "https://bitbucket.org/dmayhak/tai-framework" } },
        };
        const ref = toRepoRef(repo);
        assert.equal(ref.id, "dmayhak/tai-framework");
        assert.equal(ref.defaultBranch, "master");
        assert.equal(ref.url, "https://bitbucket.org/dmayhak/tai-framework");
    });

    it("defaults defaultBranch to master when mainbranch is absent", () => {
        const repo: BitbucketRepositoryJson = {
            full_name: "dmayhak/tai-framework",
            name: "tai-framework",
            links: { html: { href: "https://bitbucket.org/dmayhak/tai-framework" } },
        };
        assert.equal(toRepoRef(repo).defaultBranch, "master");
    });
});

describe("toPullRequestRef", () => {
    const BASE_PR: BitbucketPullRequestJson = {
        id: 7,
        title: "TAI-38 Dev: GitHost interface",
        description: "body",
        state: "OPEN",
        source: { branch: { name: "TAI-37-git-host" }, commit: { hash: "abc123def456" } },
        destination: { branch: { name: "master" } },
        author: USER,
        participants: [
            {
                user: { account_id: "reviewer-1", display_name: "Reviewer One" },
                role: "REVIEWER",
                state: "approved",
            },
            {
                user: { account_id: "reviewer-2", display_name: "Reviewer Two" },
                role: "REVIEWER",
                state: "changes_requested",
            },
            {
                user: { account_id: "reviewer-3", display_name: "Reviewer Three" },
                role: "REVIEWER",
                state: null,
            },
            // A PARTICIPANT with no decision (e.g. a watcher, or the author) must never show
            // up as a "reviewer".
            {
                user: { account_id: "watcher-1", display_name: "Watcher" },
                role: "PARTICIPANT",
                state: null,
            },
            // Found LIVE (TAI-38's own end-to-end demo, 2026-07-15): a human who approves a
            // PR they were never formally requested to review lands here — role
            // PARTICIPANT, state "approved". This MUST still count as a reviewer, or a real
            // approval silently vanishes from what TAI-34's checkpoint inspects.
            {
                user: { account_id: "ad-hoc-approver", display_name: "Ad Hoc Approver" },
                role: "PARTICIPANT",
                state: "approved",
            },
        ],
        created_on: "2026-07-15T10:00:00Z",
        updated_on: "2026-07-15T10:05:00Z",
        links: { html: { href: "https://bitbucket.org/dmayhak/tai-framework/pull-requests/7" } },
    };

    it("maps state, branches, commit, and reviewers (requested REVIEWERs + any participant with a real decision)", () => {
        const ref = toPullRequestRef(BASE_PR, toRepoId("dmayhak/tai-framework"));
        assert.equal(ref.id, "7");
        assert.equal(ref.repo, "dmayhak/tai-framework");
        assert.equal(ref.state, "open");
        assert.equal(ref.sourceBranch, "TAI-37-git-host");
        assert.equal(ref.destinationBranch, "master");
        assert.equal(ref.sourceCommit, "abc123def456");
        assert.equal(
            ref.reviewers.length,
            4,
            "3 requested REVIEWERs + the ad-hoc PARTICIPANT approver; the no-decision watcher is excluded"
        );
        assert.deepEqual(
            ref.reviewers.map((r) => r.status),
            ["approved", "changesRequested", "pending", "approved"]
        );
        assert.ok(
            !ref.reviewers.some((r) => r.human.id === "watcher-1"),
            "a PARTICIPANT with no decision must still be excluded"
        );
    });

    it("maps MERGED and DECLINED states", () => {
        assert.equal(toPullRequestRef({ ...BASE_PR, state: "MERGED" }, toRepoId("w/r")).state, "merged");
        assert.equal(toPullRequestRef({ ...BASE_PR, state: "DECLINED" }, toRepoId("w/r")).state, "declined");
    });

    it("buckets SUPERSEDED into declined — TAI's 3-state union has no separate slot for it", () => {
        assert.equal(
            toPullRequestRef({ ...BASE_PR, state: "SUPERSEDED" }, toRepoId("w/r")).state,
            "declined"
        );
    });

    it("REGRESSION (found live via listPullRequests, 2026-07-15): tolerates a missing participants field", () => {
        // Bitbucket's list-pullrequests endpoint omits `participants` entirely (not `[]`) —
        // crashed the mapper the first time it ran against real list-endpoint data.
        const { participants: _omitted, ...withoutParticipants } = BASE_PR;
        const ref = toPullRequestRef(
            withoutParticipants as unknown as BitbucketPullRequestJson,
            toRepoId("dmayhak/tai-framework")
        );
        assert.deepEqual(ref.reviewers, []);
    });
});

describe("toCommitStatus", () => {
    it("maps every Bitbucket state to its lowercase TAI equivalent", () => {
        const base: BitbucketCommitStatusJson = { key: "build", name: "Typecheck & test", state: "SUCCESSFUL" };
        assert.equal(toCommitStatus(base).state, "successful");
        assert.equal(toCommitStatus({ ...base, state: "FAILED" }).state, "failed");
        assert.equal(toCommitStatus({ ...base, state: "INPROGRESS" }).state, "inProgress");
        assert.equal(toCommitStatus({ ...base, state: "STOPPED" }).state, "stopped");
    });

    it("omits url when absent rather than setting it to undefined explicitly", () => {
        const status = toCommitStatus({ key: "build", name: "n", state: "SUCCESSFUL" });
        assert.ok(!("url" in status));
    });
});

describe("toComment", () => {
    it("maps id, body, author, and timestamps", () => {
        const c: BitbucketCommentJson = {
            id: 42,
            content: { raw: "Approved: looks good" },
            user: USER,
            created_on: "2026-07-15T10:00:00Z",
            updated_on: "2026-07-15T10:00:00Z",
        };
        const comment = toComment(c);
        assert.equal(comment.id, "42");
        assert.equal(comment.body, "Approved: looks good");
        assert.equal(comment.author.id, "acct-123");
        assert.equal(comment.createdAt, "2026-07-15T10:00:00Z");
    });
});
