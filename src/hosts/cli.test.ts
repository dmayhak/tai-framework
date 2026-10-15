import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    toHumanId,
    toIssueKey,
    toPageId,
    type CascadeWarning,
    type Comment,
    type HumanRef,
    type Issue,
    type IssueLink,
    type Page,
} from "../core/storage/interface.js";
import { DependencyRelation, Persona, Status, StoryType, SubtaskType } from "../core/schema/story-schema.js";
import {
    parseIssueSearchFilter,
    parseIssueUpdatePatch,
    renderPullRequestComments,
    parsePageGetRef,
    resolveCreatePriority,
    resolveMergePersona,
    renderChangeNotes,
    renderIssueSearchResults,
    PERSONA_LESS_CREATE_WARNING,
    parsePersonaArg,
    tryResolveCreateAssignee,
    resolveNamedAssignee,
    renderGroomTurn,
    renderKickoffTurn,
    renderLinkedIssues,
    renderIssueDetail,
    renderReadyWork,
    renderPRReadyWork,
    FLAG_MARKER,
    renderCascadeWarnings,
    renderInitStepResult,
    renderInitStatus,
    createdSubtaskMapNote,
    reviewOfMismatch,
    extractActingPersona,
    actingPersonaOf,
    renderMergeRefused,
} from "./cli.js";
import type { IssueFilter, IssueKey, WorkTracker } from "../core/storage/interface.js";
import type { InitState } from "../core/commands/target-init.js";

const AUTHOR: HumanRef = { id: toHumanId("del@example.com"), displayName: "Del", email: "del@example.com" };

function makeIssue(overrides: Partial<Issue> = {}): Issue {
    return {
        key: toIssueKey("TAI-1"),
        projectKey: "TAI",
        issueType: SubtaskType.Dev,
        summary: "A test issue",
        status: Status.ToDo,
        assignee: null,
        persona: null,
        labels: [],
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
        comments: [],
        ...overrides,
    };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
    return {
        id: "c1",
        author: AUTHOR,
        body: "A comment.",
        createdAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:00.000Z",
        ...overrides,
    };
}

describe("renderPullRequestComments (TAI-383)", () => {
    const author = { id: toHumanId("acct-1"), displayName: "Del" };
    const comment = (id: string, body: string, createdAt: string, inline?: { path: string; line?: number }) => ({
        id,
        author,
        body,
        createdAt,
        updatedAt: createdAt,
        ...(inline ? { inline } : {}),
    });

    it("says so plainly when there are no comments, still telling the reader to confirm that is intended", () => {
        assert.match(renderPullRequestComments("126", []), /No comments on PR 126/);
    });

    it("lists EVERY comment in order with author, time and the full body, under a count", () => {
        const out = renderPullRequestComments("126", [
            comment("1", "first body\nsecond line", "2026-10-02T14:49:49Z"),
            comment("2", "another review", "2026-10-02T15:10:00Z"),
        ]);
        assert.match(out, /Comments on PR 126 \(2\)/);
        assert.ok(out.indexOf("first body") < out.indexOf("another review"));
        assert.match(out, /second line/);
        assert.match(out, /Del/);
        assert.match(out, /2026-10-02 14:49 UTC/);
    });

    it("normalizes a non-UTC timestamp to UTC instead of mislabeling local time as UTC (PR #127 review)", () => {
        const out = renderPullRequestComments("126", [comment("1", "x", "2026-10-02T16:49:49.500060+02:00")]);
        assert.match(out, /2026-10-02 14:49 UTC/);
    });

    it("keeps a Bitbucket-style +00:00 timestamp as is", () => {
        const out = renderPullRequestComments("126", [comment("1", "x", "2026-10-02T14:49:49.500060+00:00")]);
        assert.match(out, /2026-10-02 14:49 UTC/);
    });

    it("shows an unparseable timestamp as given rather than guessing", () => {
        assert.match(renderPullRequestComments("126", [comment("1", "x", "not-a-date")]), /not-a-date/);
    });

    it("labels an inline comment with its file and line", () => {
        const out = renderPullRequestComments("126", [comment("1", "bug", "2026-10-02T14:49:49Z", { path: "src/db.ts", line: 42 })]);
        assert.match(out, /src\/db\.ts:42/);
    });

    it("ends with the decision prompt: fix only if very minor, ticket, or skip with a reason; ask if review-worthy", () => {
        const out = renderPullRequestComments("126", [comment("1", "x", "2026-10-02T14:49:49Z")]);
        assert.match(out, /very minor/i);
        assert.match(out, /merge with force=true/);
        assert.match(out, /ticket/i);
        assert.match(out, /review-worthy/i);
        assert.match(out, /ask the human/i);
    });
});

describe("parseIssueUpdatePatch (TAI-372/379)", () => {
    it("maps the existing fields through unchanged", () => {
        assert.deepEqual(
            parseIssueUpdatePatch({ summary: "s", description: "d", persona: "developer", priority: "Low", component: "c", severity: "x" }),
            { summary: "s", description: "d", persona: "developer", priority: "Low", component: "c", severity: "x" }
        );
    });

    it("parent= becomes parentKey", () => {
        assert.deepEqual(parseIssueUpdatePatch({ parent: "TAI-370" }), { parentKey: "TAI-370" });
    });

    it("labels= is the whole list: comma-split, trimmed, empties dropped; an empty value clears", () => {
        assert.deepEqual(parseIssueUpdatePatch({ labels: "a, b ,,c" }), { labels: ["a", "b", "c"] });
        assert.deepEqual(parseIssueUpdatePatch({ labels: "" }), { labels: [] });
    });

    it("an empty parent= is rejected: detaching from an Epic is not supported", () => {
        assert.throws(() => parseIssueUpdatePatch({ parent: "" }), /parent=/);
    });

    it("rejects a key it does not know, so a typo like lables= is not silently ignored", () => {
        assert.throws(() => parseIssueUpdatePatch({ lables: "a" }), /lables/);
    });
});

describe("flagged= and flag markers (TAI-390)", () => {
    const noLinks = {
        workTracker: { getLinkedIssues: async () => [], getLinkedPages: async () => [] },
        docStore: { getPage: async () => null },
    };

    it("flagged=true/false parse to a boolean patch field", () => {
        assert.deepEqual(parseIssueUpdatePatch({ flagged: "true" }), { flagged: true });
        assert.deepEqual(parseIssueUpdatePatch({ flagged: "false" }), { flagged: false });
    });

    it("rejects any other flagged= value instead of guessing", () => {
        assert.throws(() => parseIssueUpdatePatch({ flagged: "yes" }), /flagged= must be true or false/);
        assert.throws(() => parseIssueUpdatePatch({ flagged: "" }), /flagged= must be true or false/);
    });

    it("issue get and issue search show the marker only on a flagged issue", async () => {
        const flagged = makeIssue({ flagged: true });
        const plain = makeIssue();
        assert.ok((await renderIssueDetail(noLinks, flagged)).includes(FLAG_MARKER));
        assert.ok(!(await renderIssueDetail(noLinks, plain)).includes(FLAG_MARKER));
        assert.ok(renderIssueSearchResults([flagged], { projectKey: "TAI" }).includes(FLAG_MARKER));
        assert.ok(!renderIssueSearchResults([plain], { projectKey: "TAI" }).includes(FLAG_MARKER));
    });
});

describe("renderReadyWork flagged view (TAI-390)", () => {
    const emptyResult = {
        ready: [],
        onHold: [],
        inProgress: [],
        unblockedSubtaskHints: [],
        readyToReview: [],
        readyToTest: [],
        readyToMerge: [],
        blockedBy: new Map(),
        staleLivingDocs: [], notVerified: new Set<IssueKey>(),
        assigneeSuggestions: new Map(),
    };

    it("a ready ticket with a suggestion shows 'needs an assignee' and the best candidate with the reason (TAI-419)", () => {
        const issue = makeIssue({ key: toIssueKey("TAI-5") });
        const out = renderReadyWork({
            ...emptyResult,
            ready: [issue],
            assigneeSuggestions: new Map([[issue.key, "Ann (worked on this Story (TAI-1))"]]),
        });
        assert.match(out, /TAI-5\*\*.*needs an assignee — suggest: Ann \(worked on this Story \(TAI-1\)\)/);
        assert.doesNotMatch(renderReadyWork({ ...emptyResult, ready: [issue] }), /needs an assignee/);
    });

    it("an In Progress Kickoff, a Ready one and a held one each say how their Approved: comments were made; others say nothing (TAI-500)", () => {
        const approved = (body: string) => makeIssue({ issueType: StoryType.Kickoff, status: Status.InProgress, comments: [makeComment({ body })] });
        const inProgress = approved("Approved: ok\n\nPosted via the TAI CLI as Perry (pm).");
        const out = renderReadyWork({ ...emptyResult, inProgress: [{ issue: { ...inProgress, key: toIssueKey("TAI-2") } }] });
        assert.match(out, /TAI-2\*\*.*— sign-off: Kickoff approval: .* through the TAI CLI as Perry \(pm\)/);

        const ready = renderReadyWork({ ...emptyResult, ready: [{ ...approved("Approved: ok"), key: toIssueKey("TAI-3"), status: Status.ToDo }] });
        assert.match(ready, /TAI-3\*\*.*— sign-off: Kickoff approval: .* directly/);

        const held = renderReadyWork({ ...emptyResult, onHold: [{ ...approved("Approved: ok"), key: toIssueKey("TAI-4"), flagged: true }] });
        assert.match(held, /TAI-4\*\*.*— sign-off: .* directly/);

        const plain = renderReadyWork({ ...emptyResult, ready: [makeIssue({ issueType: SubtaskType.Uat }), makeIssue({ key: toIssueKey("TAI-6"), issueType: StoryType.Story })] });
        assert.doesNotMatch(plain, /sign-off/);
    });

    it("has no On hold section when nothing is held", () => {
        assert.ok(!renderReadyWork({ ...emptyResult, ready: [makeIssue()] }).includes("On hold"));
    });

    it("lists held items in a numbered On hold section after Ready Work, with the latest comment's first line", () => {
        const out = renderReadyWork({
            ...emptyResult,
            ready: [makeIssue({ key: toIssueKey("TAI-1") })],
            onHold: [
                makeIssue({
                    key: toIssueKey("TAI-2"),
                    flagged: true,
                    comments: [makeComment({ body: "old" }), makeComment({ body: "\nWaiting on the vendor's API key.\nMore detail." })],
                }),
            ],
        });
        assert.ok(out.indexOf("## Ready Work") < out.indexOf("## On hold (flagged)"));
        assert.match(out, /1\. \*\*TAI-1\*\*/);
        assert.match(out, /2\. \*\*TAI-2\*\*.*🚩 flagged — latest comment: Waiting on the vendor's API key\./);
        assert.ok(!out.includes("More detail."));
        assert.match(out, /Reply with a number/);
    });

    it("a held item with no comments still renders (no reason shown)", () => {
        const out = renderReadyWork({ ...emptyResult, onHold: [makeIssue({ flagged: true })] });
        assert.match(out, /## On hold \(flagged\)/);
        assert.ok(!out.includes("latest comment"));
    });

    it("a flagged In Progress item stays under In Progress with the marker", () => {
        const out = renderReadyWork({
            ...emptyResult,
            inProgress: [{ issue: makeIssue({ status: Status.InProgress, flagged: true }) }],
        });
        assert.match(out, /## In Progress/);
        assert.ok(out.includes(FLAG_MARKER));
        assert.ok(!out.includes("On hold"));
    });

    it("an In Progress Story that is not verified carries a short marker; a verified one does not (TAI-546, TAI-548)", () => {
        const story = makeIssue({ status: Status.InProgress, issueType: StoryType.Story });
        const flagged = renderReadyWork({ ...emptyResult, inProgress: [{ issue: story }], notVerified: new Set<IssueKey>([story.key]) });
        assert.match(flagged, /\(persona: [^)]*\) ⚠️ not verified\s*$/m);
        assert.doesNotMatch(flagged, /run `verify/);
        const plain = renderReadyWork({ ...emptyResult, inProgress: [{ issue: story }] });
        assert.ok(!plain.includes("not verified"));
    });

    it("lists a not-verified Story under a numbered Ready to verify section that names /tai-verify (TAI-548)", () => {
        const story = makeIssue({ key: toIssueKey("TAI-7"), summary: "Finish the thing", status: Status.InProgress, issueType: StoryType.Story });
        const out = renderReadyWork({ ...emptyResult, inProgress: [{ issue: story }], notVerified: new Set<IssueKey>([story.key]) });
        assert.match(out, /^## Ready to verify$/m);
        assert.match(out, /^2\. \*\*TAI-7\*\* \[story\] Finish the thing — verify it with `\/tai-verify TAI-7`$/m);
    });

    it("has no Ready to verify section when nothing is not verified, and counts only the not-verified ones (TAI-548)", () => {
        const done = makeIssue({ key: toIssueKey("TAI-7"), status: Status.InProgress, issueType: StoryType.Story });
        const other = makeIssue({ key: toIssueKey("TAI-8"), status: Status.InProgress, issueType: StoryType.Story });
        assert.ok(!renderReadyWork({ ...emptyResult, inProgress: [{ issue: done }] }).includes("Ready to verify"));
        const out = renderReadyWork({
            ...emptyResult,
            inProgress: [{ issue: done }, { issue: other }],
            notVerified: new Set<IssueKey>([other.key]),
        });
        assert.match(out, /tai-verify TAI-8`/);
        assert.doesNotMatch(out, /tai-verify TAI-7`/);
    });

    it("Ready to verify shares one counter with the other sections: it continues after Ready Work and before the PR sections (TAI-548)", () => {
        const story = makeIssue({ key: toIssueKey("TAI-7"), status: Status.InProgress, issueType: StoryType.Story });
        const ready = makeIssue({ key: toIssueKey("TAI-9"), status: Status.ToDo });
        const out = renderReadyWork({ ...emptyResult, inProgress: [{ issue: story }], ready: [ready], notVerified: new Set<IssueKey>([story.key]) });
        assert.match(out, /^1\. \*\*TAI-7\*\*.*not verified$/m);
        assert.match(out, /^2\. \*\*TAI-9\*\*/m);
        assert.match(out, /^3\. \*\*TAI-7\*\* .*tai-verify/m);
    });

    it("an In Progress line carries no local-history note (TAI-490: nothing wrote the file it came from)", () => {
        const out = renderReadyWork({ ...emptyResult, inProgress: [{ issue: makeIssue({ status: Status.InProgress }) }] });
        assert.match(out, /## In Progress/);
        assert.ok(!/local (session )?history/.test(out));
    });
});

describe("parseIssueSearchFilter", () => {
    it("defaults to the given projectKey when none is passed in fields", () => {
        assert.deepEqual(parseIssueSearchFilter({}, "TAI"), { projectKey: "TAI" });
    });

    it("an explicit projectKey field overrides the default", () => {
        assert.deepEqual(parseIssueSearchFilter({ projectKey: "OTHER" }, "TAI"), { projectKey: "OTHER" });
    });

    it("splits status/type on commas", () => {
        const filter = parseIssueSearchFilter({ status: "To Do,In Progress", type: "dev,bug" }, "TAI");
        assert.deepEqual(filter.statuses, ["To Do", "In Progress"]);
        assert.deepEqual(filter.issueTypes, ["dev", "bug"]);
    });

    it("passes through persona/parent/updatedSince/limit", () => {
        const filter = parseIssueSearchFilter(
            { persona: "developer", parent: "TAI-1", updatedSince: "2026-01-01", limit: "200" },
            "TAI"
        );
        assert.equal(filter.persona, "developer");
        assert.equal(filter.parentKey, "TAI-1");
        assert.equal(filter.updatedSince, "2026-01-01");
        assert.equal(filter.limit, 200);
    });

    it("omits a field entirely when not given -- unfiltered on that axis, not narrowed", () => {
        const filter = parseIssueSearchFilter({}, "TAI");
        assert.equal("statuses" in filter, false);
        assert.equal("issueTypes" in filter, false);
        assert.equal("limit" in filter, false);
    });
});

describe("resolveCreatePriority", () => {
    it("an explicit priority always wins, regardless of the parent's priority", () => {
        assert.equal(resolveCreatePriority("Low", SubtaskType.Dev, "High"), "Low");
    });

    it("an explicit priority wins even with no parent priority available", () => {
        assert.equal(resolveCreatePriority("Low", SubtaskType.Dev, undefined), "Low");
    });

    it("inherits the parent's priority for a subtask when none was given explicitly", () => {
        assert.equal(resolveCreatePriority(undefined, SubtaskType.Dev, "High"), "High");
    });

    it("resolves to undefined (Jira's own default) when neither an explicit nor a parent priority exists", () => {
        assert.equal(resolveCreatePriority(undefined, SubtaskType.Dev, undefined), undefined);
    });

    it("does NOT inherit for a Story/Bug/Spike -- only actual subtask issue types", () => {
        assert.equal(resolveCreatePriority(undefined, StoryType.Story, "High"), undefined);
        assert.equal(resolveCreatePriority(undefined, StoryType.Bug, "High"), undefined);
        assert.equal(resolveCreatePriority(undefined, "epic", "High"), undefined);
    });
});

describe("parsePageGetRef", () => {
    it("parses an id=<PAGE-ID> first argument as the by-id form", () => {
        assert.deepEqual(parsePageGetRef("id=12345", undefined), { id: toPageId("12345") });
    });

    it("parses <SPACE-KEY> <TITLE> as the by-space-and-title form", () => {
        assert.deepEqual(parsePageGetRef("TA", "Persona Roster"), { spaceKey: "TA", title: "Persona Roster" });
    });

    it("returns null when neither id= nor a title is given -- caller's job to error", () => {
        assert.equal(parsePageGetRef("TA", undefined), null);
    });
});

describe("renderIssueSearchResults", () => {
    it("renders \"No matches.\" for an empty result set, without a limit-hit warning", () => {
        const out = renderIssueSearchResults([], { projectKey: "TAI" });
        assert.match(out, /No matches\./);
        assert.doesNotMatch(out, /Hit the search limit/);
    });

    it("renders each issue's key/type/status/summary, persona, parent, and description", () => {
        const issue = makeIssue({
            key: toIssueKey("TAI-99"),
            issueType: StoryType.Bug,
            status: Status.InProgress,
            summary: "Something broke",
            persona: Persona.Developer,
            parentKey: toIssueKey("TAI-9"),
            description: "The actual broken behavior.",
        });
        const out = renderIssueSearchResults([issue], { projectKey: "TAI" });
        assert.match(out, /## TAI-99 \[bug\] In Progress — Something broke/);
        assert.match(out, /Persona: developer/);
        assert.match(out, /Parent: TAI-9/);
        assert.match(out, /The actual broken behavior\./);
    });

    it("falls back to a placeholder for a missing description", () => {
        const out = renderIssueSearchResults([makeIssue()], { projectKey: "TAI" });
        assert.match(out, /_\(no description\)_/);
    });

    it("includes the filter's scope line (status/type/persona/parent/updatedSince) when given", () => {
        const out = renderIssueSearchResults([], {
            projectKey: "TAI",
            statuses: [Status.ToDo],
            issueTypes: [SubtaskType.Dev],
            persona: Persona.Developer,
            parentKey: toIssueKey("TAI-1"),
            updatedSince: "2026-01-01",
        });
        assert.match(out, /status: To Do/);
        assert.match(out, /type: dev/);
        assert.match(out, /persona: developer/);
        assert.match(out, /parent: TAI-1/);
        assert.match(out, /updatedSince: 2026-01-01/);
    });

    it("warns when the result count hits the effective limit (explicit or default)", () => {
        const issues = [makeIssue({ key: toIssueKey("TAI-1") }), makeIssue({ key: toIssueKey("TAI-2") })];
        const hit = renderIssueSearchResults(issues, { projectKey: "TAI", limit: 2 });
        assert.match(hit, /Hit the search limit \(2\)/);

        const notHit = renderIssueSearchResults(issues, { projectKey: "TAI", limit: 3 });
        assert.doesNotMatch(notHit, /Hit the search limit/);
    });

    it("counts rows the backend skipped as unreadable toward the limit hint (TAI-405)", () => {
        const one = [makeIssue({ key: toIssueKey("TAI-1") })];
        assert.doesNotMatch(renderIssueSearchResults(one, { projectKey: "TAI", limit: 2 }), /Hit the search limit/);
        assert.match(renderIssueSearchResults(one, { projectKey: "TAI", limit: 2 }, 1), /Hit the search limit \(2\)/);
    });
});

describe("renderLinkedIssues", () => {
    it("renders \"None.\" when both directions are empty", () => {
        assert.equal(renderLinkedIssues([], []), "None.");
    });

    it("renders outgoing links with an arrow-right and incoming with an arrow-left", () => {
        const outgoing: readonly IssueLink[] = [{ relation: DependencyRelation.DependsOn, key: toIssueKey("TAI-2") }];
        const incoming: readonly IssueLink[] = [{ relation: DependencyRelation.RelatesTo, key: toIssueKey("TAI-3") }];
        const out = renderLinkedIssues(outgoing, incoming);
        assert.match(out, /- depends-on → TAI-2 \(outgoing\)/);
        assert.match(out, /- relates-to ← TAI-3 \(incoming\)/);
    });
});

describe("renderIssueDetail", () => {
    it("renders full detail: description, comments, linked issues, linked pages", async () => {
        const issue = makeIssue({
            key: toIssueKey("TAI-42"),
            summary: "A fully-linked ticket",
            description: "Full description text.",
            persona: Persona.Pm,
            priority: "High",
            labels: ["a", "b"],
            comments: [makeComment({ body: "First comment." })],
        });
        const page: Page = {
            id: toPageId("100"),
            spaceKey: "TA",
            title: "Linked Page",
            content: "content",
            createdAt: "2026-08-28T00:00:00.000Z",
            updatedAt: "2026-08-28T00:00:00.000Z",
            comments: [],
        };

        const out = await renderIssueDetail(
            {
                workTracker: {
                    getLinkedIssues: async (_key, _relation, direction) =>
                        direction === "outgoing" ? [{ relation: DependencyRelation.DependsOn, key: toIssueKey("TAI-1") }] : [],
                    getLinkedPages: async () => [toPageId("100")],
                },
                docStore: { getPage: async () => page },
            },
            issue
        );

        assert.match(out, /# Issue TAI-42/);
        assert.match(out, /Full description text\./);
        assert.match(out, /### Del — 2026-08-28T00:00:00\.000Z\n\nFirst comment\./);
        assert.match(out, /depends-on → TAI-1 \(outgoing\)/);
        assert.match(out, /- Linked Page \(id: 100, space: TA\)/);
    });

    it("flags a linked page id that no longer resolves as MISSING, not silently dropped", async () => {
        const out = await renderIssueDetail(
            {
                workTracker: {
                    getLinkedIssues: async () => [],
                    getLinkedPages: async () => [toPageId("gone")],
                },
                docStore: { getPage: async () => null },
            },
            makeIssue()
        );
        assert.match(out, /\*\*MISSING\*\* — linked page id gone no longer exists/);
    });

    it("renders placeholders for no comments and no linked pages", async () => {
        const out = await renderIssueDetail(
            {
                workTracker: { getLinkedIssues: async () => [], getLinkedPages: async () => [] },
                docStore: { getPage: async () => null },
            },
            makeIssue()
        );
        assert.match(out, /_\(no comments\)_/);
        assert.match(out, /## Linked pages\n\nNone\./);
    });
});

describe("renderChangeNotes (TAI-285 ADR)", () => {
    it("returns undefined for an empty list -- nothing worth mentioning", () => {
        assert.equal(renderChangeNotes([]), undefined);
    });

    it("renders a mild note for a 'content' severity change", () => {
        const out = renderChangeNotes([{ key: toIssueKey("TAI-1"), severity: "content", fields: ["summary"] }]);
        assert.match(out!, /TAI-1/);
        assert.match(out!, /summary changed/);
        assert.doesNotMatch(out!, /⚠️/);
    });

    it("renders a prominent warning for a 'structural' severity change, telling the persona to confirm with the human", () => {
        const out = renderChangeNotes([{ key: toIssueKey("TAI-1"), severity: "structural", fields: ["status"] }]);
        assert.match(out!, /⚠️/);
        assert.match(out!, /TAI-1/);
        assert.match(out!, /status/);
        assert.match(out!, /confirm with the human/);
    });

    it("names the specific field(s) that changed, not a generic list of every possible cause (PR #85 review)", () => {
        const out = renderChangeNotes([{ key: toIssueKey("TAI-1"), severity: "structural", fields: ["assignee"] }]);
        assert.match(out!, /assignee/);
        assert.doesNotMatch(out!, /status\/priority/);
    });

    it("names multiple changed fields together, comma-separated", () => {
        const out = renderChangeNotes([{ key: toIssueKey("TAI-1"), severity: "structural", fields: ["status", "priority"] }]);
        assert.match(out!, /status, priority/);
    });

    it("names 'relationship' when that's the field that changed", () => {
        const out = renderChangeNotes([{ key: toIssueKey("TAI-1"), severity: "structural", fields: ["relationship"] }]);
        assert.match(out!, /relationship/);
    });

    it("renders one line per note when both the subtask and parent changed", () => {
        const out = renderChangeNotes([
            { key: toIssueKey("TAI-1"), severity: "content", fields: ["description"] },
            { key: toIssueKey("TAI-100"), severity: "structural", fields: ["status"] },
        ]);
        const lines = out!.split("\n");
        assert.equal(lines.length, 2);
        assert.match(lines[0]!, /TAI-1/);
        assert.match(lines[1]!, /⚠️ TAI-100/);
    });
});

describe("renderCascadeWarnings", () => {
    it("renders nothing for undefined or an empty array", () => {
        assert.equal(renderCascadeWarnings(undefined), "");
        assert.equal(renderCascadeWarnings([]), "");
    });

    it("renders one line per warning, each naming the key and reason", () => {
        const warnings: readonly CascadeWarning[] = [
            { key: toIssueKey("TAI-253"), reason: "TAI-253 has no Assignee." },
            { key: toIssueKey("TAI-9"), reason: "some other rejection" },
        ];
        const out = renderCascadeWarnings(warnings);
        assert.match(out, /⚠️ Cascade warning: TAI-253 — TAI-253 has no Assignee\./);
        assert.match(out, /⚠️ Cascade warning: TAI-9 — some other rejection/);
    });
});

describe("resolveMergePersona (TAI-314/315/316)", () => {
    class FakeWorkTracker implements Pick<WorkTracker, "search" | "getIssue"> {
        constructor(
            private readonly issues: readonly Issue[]
        ) {}

        async search(filter: IssueFilter): Promise<readonly Issue[]> {
            return this.issues.filter(
                (i) =>
                    (!filter.parentKey || i.parentKey === filter.parentKey) &&
                    (!filter.issueTypes || filter.issueTypes.includes(i.issueType))
            );
        }

        async getIssue(key: IssueKey): Promise<Issue | null> {
            return this.issues.find((i) => i.key === key) ?? null;
        }
    }

    it("a non-test-tier issue resolves via its own persona field, unchanged", async () => {
        const dev = makeIssue({ key: toIssueKey("TAI-312"), issueType: SubtaskType.Dev, persona: Persona.Developer });
        const wt = new FakeWorkTracker([dev]);
        assert.equal(await resolveMergePersona(wt, "TAI", dev), Persona.Developer);
    });

    it("a test-tier subtask with no parentKey resolves via its own persona field (defensive)", async () => {
        const testTier = makeIssue({ key: toIssueKey("TAI-313"), issueType: SubtaskType.IntegrationTest, persona: Persona.Tester });
        const wt = new FakeWorkTracker([testTier]);
        assert.equal(await resolveMergePersona(wt, "TAI", testTier), Persona.Tester);
    });

    it("a test-tier subtask resolves via its sibling Dev subtask's persona, not its own", async () => {
        const story = makeIssue({ key: toIssueKey("TAI-304"), issueType: StoryType.Bug, persona: Persona.Pm });
        const dev = makeIssue({
            key: toIssueKey("TAI-312"),
            issueType: SubtaskType.Dev,
            persona: Persona.Developer,
            parentKey: story.key,
        });
        const testTier = makeIssue({
            key: toIssueKey("TAI-313"),
            issueType: SubtaskType.IntegrationTest,
            persona: Persona.Tester,
            parentKey: story.key,
        });
        const wt = new FakeWorkTracker([story, dev, testTier]);
        assert.equal(await resolveMergePersona(wt, "TAI", testTier), Persona.Developer);
    });

    it("falls back to the parent Story's own persona when no sibling Dev subtask exists", async () => {
        const story = makeIssue({ key: toIssueKey("TAI-304"), issueType: StoryType.Bug, persona: Persona.Pm });
        const testTier = makeIssue({
            key: toIssueKey("TAI-313"),
            issueType: SubtaskType.SystemTest,
            persona: Persona.Tester,
            parentKey: story.key,
        });
        const wt = new FakeWorkTracker([story, testTier]);
        assert.equal(await resolveMergePersona(wt, "TAI", testTier), Persona.Pm);
    });

    it("falls back to the test-tier subtask's own persona when neither a sibling Dev nor the parent resolves one", async () => {
        const testTier = makeIssue({
            key: toIssueKey("TAI-313"),
            issueType: SubtaskType.E2ETest,
            persona: Persona.Tester,
            parentKey: toIssueKey("TAI-999"), // parent not in the fake's issue set at all
        });
        const wt = new FakeWorkTracker([testTier]);
        assert.equal(await resolveMergePersona(wt, "TAI", testTier), Persona.Tester);
    });
});

describe("renderInitStepResult heading (TAI-377)", () => {
    it("defaults to `# init <step>`, which the individual init actions keep using", () => {
        assert.match(renderInitStepResult("claude-md", true, "Wrote CLAUDE.md."), /^# init claude-md\n/);
    });

    it("takes an optional display label for a step that now covers more than its key says", () => {
        const out = renderInitStepResult("claude-md", true, "Wrote both.", false, "claude-md + gemini-md");
        assert.match(out, /^# init claude-md \+ gemini-md\n/);
    });
});

describe("renderInitStepResult / renderInitStatus (TAI-349)", () => {
    it("renderInitStepResult appends the next-step hint only when ok AND fullyInitialized", () => {
        const bare = renderInitStepResult("env", true, "Wrote .env.");
        assert.doesNotMatch(bare, /Perry/);

        const midway = renderInitStepResult("claude-md", true, "Wrote CLAUDE.md.", false);
        assert.doesNotMatch(midway, /Perry/);

        const done = renderInitStepResult("claude-md", true, "Wrote CLAUDE.md.", true);
        assert.match(done, /Perry/);
        assert.match(done, /Kickoff Story/);
    });

    it("renderInitStepResult never appends the hint on failure, even if fullyInitialized is somehow true", () => {
        const failed = renderInitStepResult("jira", false, "Missing issue types.", true);
        assert.doesNotMatch(failed, /Perry/);
    });

    it("renderInitStatus reports the project's rules file without making it part of setup (TAI-516)", () => {
        const state: InitState = { version: 1, steps: {} };
        assert.doesNotMatch(renderInitStatus(state), /project-context/);
        const text = renderInitStatus(state, { state: "missing", path: "/repo/project-context.md" });
        assert.match(text, /Not part of setup:\n\n- \[ \] project-context\.md — none yet\. Optional: `.* init project-context`/);
    });

    it("renderInitStatus appends the next-step hint only once every step is done", () => {
        const incomplete: InitState = {
            version: 1,
            steps: { jira: { at: "2026-01-01T00:00:00Z", detail: "ok" } },
        };
        assert.doesNotMatch(renderInitStatus(incomplete), /Perry/);

        const complete: InitState = {
            version: 1,
            steps: {
                jira: { at: "2026-01-01T00:00:00Z", detail: "ok" },
                confluence: { at: "2026-01-01T00:00:00Z", detail: "ok" },
                bitbucket: { at: "2026-01-01T00:00:00Z", detail: "ok" },
                env: { at: "2026-01-01T00:00:00Z", detail: "ok" },
                "claude-md": { at: "2026-01-01T00:00:00Z", detail: "ok" },
            },
        };
        assert.match(renderInitStatus(complete), /Perry/);
    });
});

describe("PERSONA_LESS_CREATE_WARNING (TAI-409)", () => {
    it("names the ticket and the command that fixes it", () => {
        const w = PERSONA_LESS_CREATE_WARNING("TAI-9");
        assert.match(w, /TAI-9 was created with NO persona/);
        assert.match(w, /issue update TAI-9 persona=<PERSONA>/);
    });
});

describe("persona= validation and create-time assignment safety (TAI-409 review)", () => {
    it("parsePersonaArg accepts every real persona id and rejects a typo, naming the valid values", () => {
        for (const id of ["analyst", "pm", "architect", "ux-designer", "developer", "dba", "code-reviewer", "tester", "devops"]) {
            assert.equal(parsePersonaArg(id), id);
        }
        assert.throws(() => parsePersonaArg("developr"), /Unknown persona "developr"\. Expected one of: analyst, pm/);
    });

    it("issue update and issue search reject a bad persona= too, instead of passing it through", () => {
        assert.throws(() => parseIssueUpdatePatch({ persona: "nope" }), /Unknown persona/);
        assert.throws(() => parseIssueSearchFilter({ persona: "nope" }, "TAI"), /Unknown persona/);
        assert.deepEqual(parseIssueUpdatePatch({ persona: "pm" }), { persona: "pm" });
    });

    it("tryResolveCreateAssignee passes the resolved assignee through", async () => {
        const human = { id: toHumanId("a@b.c"), displayName: "A" };
        assert.deepEqual(await tryResolveCreateAssignee(async () => ({ assignee: human, candidates: [human] })), {
            assignee: human,
            note: undefined,
        });
        assert.deepEqual(await tryResolveCreateAssignee(async () => ({ assignee: null, candidates: [] })), {
            assignee: undefined,
            note: undefined,
        });
    });

    it("tryResolveCreateAssignee turns a roster failure into an unassigned create with a note, never a throw", async () => {
        const result = await tryResolveCreateAssignee(async () => {
            throw new Error('Persona Roster page "Persona Roster" not found');
        });
        assert.equal(result.assignee, undefined);
        assert.match(result.note!, /Created UNASSIGNED/);
        assert.match(result.note!, /Persona Roster page/);
    });
});

describe("resolveNamedAssignee (TAI-421)", () => {
    const del = { id: toHumanId("acct-1"), displayName: "Del", email: "del@example.com" };

    it("resolves the named person to the real identity", async () => {
        assert.deepEqual(await resolveNamedAssignee(async (e) => (e === "del@example.com" ? del : null), "del@example.com"), {
            assignee: del,
            note: undefined,
        });
    });

    it("a name that resolves to nobody still lets the ticket be created, unassigned, with a note", async () => {
        const r = await resolveNamedAssignee(async () => null, "ghost@example.com");
        assert.equal(r.assignee, undefined);
        assert.match(r.note!, /Created UNASSIGNED: no Jira user found for "ghost@example\.com"/);
    });

    it("a failed lookup is also non-fatal for the create", async () => {
        const r = await resolveNamedAssignee(async () => {
            throw new Error("network down");
        }, "del@example.com");
        assert.equal(r.assignee, undefined);
        assert.match(r.note!, /could not look up "del@example\.com" \(network down\)/);
    });
});

describe("renderKickoffTurn (TAI-450)", () => {
    it("is the persona heading, her instructions, a --- separator, then the briefing, in that order", () => {
        const out = renderKickoffTurn({ displayName: "Perry", id: "pm", prompt: "# Perry\n\nBe the PM." }, "# Kickoff briefing\n\n## Existing Epics");
        assert.match(out, /^# Persona: Perry \(pm\)/);
        assert.ok(out.indexOf("Be the PM.") < out.indexOf("---"));
        assert.ok(out.indexOf("---") < out.indexOf("# Kickoff briefing"));
    });
});

describe("renderGroomTurn (TAI-395)", () => {
    it("opens with the persona heading, then her instructions, a separator and the briefing, exactly like a work turn", () => {
        const out = renderGroomTurn({ displayName: "Perry", id: "pm", prompt: "# Perry\n\nBe the PM." }, "# Grooming briefing\n\n## 1. x");
        assert.equal(out, "# Persona: Perry (pm)\n\n# Perry\n\nBe the PM.\n\n---\n\n# Grooming briefing\n\n## 1. x");
    });
});

describe("the 'ready for your review' line names review-prep with the PR's real repo and id (TAI-430)", () => {
    const candidate = {
        pullRequest: { id: "9", repo: "ws/repo", url: "https://bitbucket.org/ws/repo/pull-requests/9", sourceBranch: "TAI-1-x", destinationBranch: "master" },
    } as never;

    it("renderReadyWork points the review line at git-pr review-prep", () => {
        const out = renderReadyWork({
            ready: [], onHold: [], inProgress: [], unblockedSubtaskHints: [], readyToReview: [candidate], readyToTest: [], readyToMerge: [],
            blockedBy: new Map(), staleLivingDocs: [], notVerified: new Set<IssueKey>(), assigneeSuggestions: new Map(),
        });
        assert.match(out, /git-pr review-prep ws\/repo 9/);
        assert.doesNotMatch(out, /git-pr review <REPO> approve/);
    });

    it("renderPRReadyWork (pr-ready) does too", () => {
        const out = renderPRReadyWork({ readyToReview: [candidate], readyToMerge: [] } as never);
        assert.match(out, /git-pr review-prep ws\/repo 9/);
        assert.doesNotMatch(out, /git-pr review <REPO> approve/);
    });
});

describe("a re-review line says so, names both commits and the diff between them (TAI-563)", () => {
    const pullRequest = { id: "9", repo: "ws/repo", url: "https://bitbucket.org/ws/repo/pull-requests/9", sourceBranch: "TAI-1-x", destinationBranch: "master" };
    const mark = (reReview: unknown) => ({ pullRequest, reReview }) as never;
    const render = (c: never) => ({
        pr: renderPRReadyWork({ readyToReview: [c], readyToMerge: [] } as never),
        ready: renderReadyWork({
            ready: [], onHold: [], inProgress: [], unblockedSubtaskHints: [], readyToReview: [c], readyToTest: [], readyToMerge: [],
            blockedBy: new Map(), staleLivingDocs: [], notVerified: new Set<IssueKey>(), assigneeSuggestions: new Map(),
        }),
    });

    it("an approval or request for changes before the new commit: says which, and gives git diff old..new", () => {
        for (const [decision, said] of [["approved", /you approved at old111/], ["changesRequested", /you requested changes at old111/]] as const) {
            const out = render(mark({ decision, commit: "new999", since: "old111" }));
            for (const text of [out.pr, out.ready]) {
                assert.match(text, /re-review/);
                assert.match(text, said);
                assert.match(text, /now new999/);
                assert.match(text, /git diff old111\.\.new999/);
                assert.match(text, /git-pr review-prep ws\/repo 9/);
            }
        }
    });

    it("an unknown old commit names only the new one, and says so", () => {
        const text = render(mark({ decision: "approved", commit: "new999", since: null })).pr;
        assert.match(text, /re-review/);
        assert.match(text, /new999/);
        assert.doesNotMatch(text, /git diff/);
    });

    it("a history that could not be read says that instead of guessing", () => {
        const text = render(mark({ decision: "approved", commit: "new999", since: null, unreadable: true })).pr;
        assert.match(text, /re-review/);
        assert.match(text, /could not be read/);
        assert.doesNotMatch(text, /git diff/);
    });

    it("a first review has no re-review mark", () => {
        const text = render({ pullRequest } as never).pr;
        assert.doesNotMatch(text, /re-review/);
    });
});

describe("renderReadyWork unblocked-subtask hints (TAI-373)", () => {
    const base = {
        ready: [],
        onHold: [],
        inProgress: [],
        unblockedSubtaskHints: [],
        readyToReview: [],
        readyToTest: [],
        readyToMerge: [],
        blockedBy: new Map(),
        staleLivingDocs: [], notVerified: new Set<IssueKey>(),
        assigneeSuggestions: new Map(),
    };
    const kickoff = makeIssue({ key: toIssueKey("EXA-2"), persona: "pm" as never, status: Status.InProgress });

    it("names the unblocked types, the command and the owner, and drops 'Nothing is currently ready'", () => {
        const out = renderReadyWork({
            ...base,
            unblockedSubtaskHints: [{ story: kickoff, types: [SubtaskType.Requirements, SubtaskType.UxDesign] }],
        });
        assert.match(out, /1\. \*\*EXA-2\*\*: Requirements and UxDesign are unblocked -- run \/tai-work EXA-2 \(Perry\)/);
        assert.doesNotMatch(out, /Nothing is currently ready to start/);
        assert.match(out, /Reply with a number/);
    });

    it("a single type reads 'is unblocked'; three read 'A, B and C'", () => {
        const one = renderReadyWork({ ...base, unblockedSubtaskHints: [{ story: kickoff, types: [SubtaskType.EpicReview] }] });
        assert.match(one, /EpicReview is unblocked/);
        const three = renderReadyWork({
            ...base,
            unblockedSubtaskHints: [{ story: kickoff, types: [SubtaskType.EpicReview, SubtaskType.Requirements, SubtaskType.UxDesign] }],
        });
        assert.match(three, /EpicReview, Requirements and UxDesign are unblocked/);
    });

    it("hints are numbered after Ready Work items on the shared counter", () => {
        const out = renderReadyWork({
            ...base,
            ready: [makeIssue({ key: toIssueKey("TAI-1") })],
            unblockedSubtaskHints: [{ story: kickoff, types: [SubtaskType.Requirements] }],
        });
        assert.match(out, /1\. \*\*TAI-1\*\*/);
        assert.match(out, /2\. \*\*EXA-2\*\*/);
        assert.ok(out.indexOf("## Ready Work") < out.indexOf("## Subtasks ready to create"));
    });

    it("with no hints and nothing ready, the empty message is unchanged", () => {
        assert.match(renderReadyWork(base), /Nothing is currently ready to start\./);
        assert.ok(!renderReadyWork(base).includes("Subtasks ready to create"));
    });
});

describe("extractActingPersona (TAI-477)", () => {
    it("takes a leading --as <persona> off the arguments", () => {
        assert.deepEqual(extractActingPersona(["--as", "pm", "issue", "create", "TAI", "story", "S"]), {
            actingPersona: "pm",
            args: ["issue", "create", "TAI", "story", "S"],
        });
    });

    it("accepts --as=<persona> too", () => {
        assert.deepEqual(extractActingPersona(["--as=code-reviewer", "git-pr", "comments", "r"]), {
            actingPersona: "code-reviewer",
            args: ["git-pr", "comments", "r"],
        });
    });

    it("leaves the arguments alone when there is no --as", () => {
        assert.deepEqual(extractActingPersona(["issue", "get", "TAI-1"]), { actingPersona: undefined, args: ["issue", "get", "TAI-1"] });
    });

    it("only reads --as in the leading position, so a comment body containing it is untouched", () => {
        assert.deepEqual(extractActingPersona(["issue", "comment", "TAI-1", "--as", "pm"]), {
            actingPersona: undefined,
            args: ["issue", "comment", "TAI-1", "--as", "pm"],
        });
    });

    it("rejects a missing or malformed persona id", () => {
        assert.throws(() => extractActingPersona(["--as"]), /--as needs a persona id/);
        assert.throws(() => extractActingPersona(["--as=Not A Persona", "issue"]), /not a persona id/);
    });
});

describe("actingPersonaOf (TAI-475)", () => {
    it("pairs a built-in persona id with its display name", () => {
        assert.deepEqual(actingPersonaOf({ actingPersona: "tester" }), { id: "tester", displayName: "Tessa" });
    });

    it("uses the id itself for a persona with no built-in name, and is undefined when none was named", () => {
        assert.deepEqual(actingPersonaOf({ actingPersona: "release-manager" }), { id: "release-manager", displayName: "release-manager" });
        assert.equal(actingPersonaOf({}), undefined);
    });
});

describe("renderMergeRefused (TAI-462)", () => {
    it("says nothing was merged, lists every unmet rule, and names the override and when to use it", () => {
        const out = renderMergeRefused(["Needs 1 approval on the current commit (abc); has 0.", "Test tier TAI-5 (integration-test) is In Progress, not Done."], "developer");
        assert.match(out, /^# Merge refused \(as developer\)/);
        assert.match(out, /Nothing was merged/);
        assert.match(out, /- Needs 1 approval on the current commit \(abc\); has 0\./);
        assert.match(out, /- Test tier TAI-5/);
        assert.match(out, /force=true/);
        assert.match(out, /only when the human says so/);
    });
});

describe("createdSubtaskMapNote (TAI-479): when issue create prints the subtask-map note", () => {
    const key = toIssueKey("TAI-1");
    const parent = (issueType: string) => ({ issueType }) as never;
    const neverFetch = async (): Promise<never> => assert.fail("must not fetch the parent");

    it("prints nothing for a subtask type its parent's type lists", async () => {
        assert.equal(await createdSubtaskMapNote({ issueType: SubtaskType.Dev, parentKey: key }, parent(StoryType.Story), neverFetch), null);
    });

    it("prints the note for a subtask type its parent's type does not list", async () => {
        const note = await createdSubtaskMapNote({ issueType: SubtaskType.Triage, parentKey: key }, parent(StoryType.Story), neverFetch);
        assert.match(note ?? "", /^Note: a "triage" subtask is not one of the types expected under a story/);
    });

    it("prints the note for a subtask created directly under an Epic", async () => {
        const note = await createdSubtaskMapNote({ issueType: SubtaskType.Dev, parentKey: key }, parent("epic"), neverFetch);
        assert.match(note ?? "", /created directly under an Epic/);
    });

    it("uses a parent the caller already read, and does not fetch it again", async () => {
        // Also the "read and not found" case: null is an answer, not a reason to fetch.
        assert.equal(await createdSubtaskMapNote({ issueType: SubtaskType.Triage, parentKey: key }, null, neverFetch), null);
    });

    it("fetches the parent by its key when the caller has not read it (priority= was given)", async () => {
        const fetched: string[] = [];
        const note = await createdSubtaskMapNote({ issueType: SubtaskType.Triage, parentKey: key }, undefined, async (k) => {
            fetched.push(k);
            return parent(StoryType.Story);
        });
        assert.deepEqual(fetched, ["TAI-1"]);
        assert.match(note ?? "", /not one of the types expected under a story/);
    });

    it("never needs the parent for a story-level ticket or a ticket with no parent", async () => {
        assert.equal(await createdSubtaskMapNote({ issueType: StoryType.Story, parentKey: key }, undefined, neverFetch), null);
        assert.equal(await createdSubtaskMapNote({ issueType: SubtaskType.Dev }, undefined, neverFetch), null);
    });

    it("prints nothing when the parent cannot be fetched", async () => {
        const failing = async (): Promise<never> => Promise.reject(new Error("tracker down"));
        assert.equal(await createdSubtaskMapNote({ issueType: SubtaskType.Triage, parentKey: key }, undefined, failing), null);
    });
});

describe("reviewOfMismatch (TAI-527): findings are posted only on the PR they review", () => {
    it("is null when the repo and PR match, ignoring the repo's letter case", () => {
        assert.equal(reviewOfMismatch({ repo: "Acme/Widgets", pr: "12" }, "acme/widgets", "12"), null);
    });

    it("names both PRs and says nothing was posted when they differ", () => {
        const reason = reviewOfMismatch({ repo: "acme/widgets", pr: "12" }, "acme/widgets", "13")!;
        assert.match(reason, /review acme\/widgets PR 12, not acme\/widgets PR 13\. Nothing was posted\./);
        assert.ok(reviewOfMismatch({ repo: "acme/other", pr: "12" }, "acme/widgets", "12"));
    });
});
