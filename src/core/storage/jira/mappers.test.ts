import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    Persona,
    Status,
    StoryType,
    SubtaskType,
    DependencyRelation,
} from "../../schema/story-schema.js";
import {
    JIRA_ISSUE_TYPE,
    JIRA_PERSONA,
    toJiraIssueType,
    fromJiraIssueType,
    toJiraPersona,
    fromJiraPersona,
    fromJiraStatus,
    toJiraLinkType,
    fromJiraLinkType,
    toIssue,
    toHumanRef,
    toComment,
    toJql,
    type RawIssue,
} from "./mappers.js";

// A realistic /rest/api/2 payload, shaped from a live TAI issue rather than invented —
// including the details that bite: assignee omitted entirely when unassigned, the Persona
// custom field as `{value}`, components as a list even though TAI only ever uses one.
const PERSONA_FIELD = "customfield_10105";

function rawIssue(overrides: Partial<RawIssue["fields"]> = {}): RawIssue {
    return {
        key: "TAI-21",
        fields: {
            project: { key: "TAI" },
            issuetype: { name: "Dev" },
            summary: "Implement WorkTracker against Jira",
            description: "Some description",
            status: { name: "In Progress" },
            parent: { key: "TAI-12" },
            labels: ["backend"],
            created: "2026-07-13T09:02:20.437-0600",
            updated: "2026-07-13T09:41:49.825-0600",
            [PERSONA_FIELD]: { value: "Developer" },
            ...overrides,
        },
    };
}

describe("issue-type mapping", () => {
    it("is total over every StoryType and SubtaskType", () => {
        // The compiler enforces this via Record<IssueType, string>, but a runtime check
        // catches an enum member added with a duplicate/blank Jira name.
        for (const t of Object.values(StoryType)) {
            assert.ok(JIRA_ISSUE_TYPE[t], `missing Jira name for StoryType.${t}`);
        }
        for (const t of Object.values(SubtaskType)) {
            assert.ok(JIRA_ISSUE_TYPE[t], `missing Jira name for SubtaskType.${t}`);
        }
        assert.equal(JIRA_ISSUE_TYPE.epic, "Epic");
    });

    it("round-trips every type", () => {
        for (const t of [...Object.values(StoryType), ...Object.values(SubtaskType)]) {
            assert.equal(fromJiraIssueType(toJiraIssueType(t)), t);
        }
    });

    it("maps Jira names are unique (no two types collide)", () => {
        const names = Object.values(JIRA_ISSUE_TYPE);
        assert.equal(new Set(names).size, names.length, "duplicate Jira issue-type name");
    });

    it("keeps StoryType.Spike and SubtaskType.SpikeTask distinct", () => {
        // Brief rev 13: these collided in Jira (issue-type names are unique site-wide),
        // which is why the subtask type was renamed. Regression guard.
        assert.equal(toJiraIssueType(StoryType.Spike), "Spike");
        assert.equal(toJiraIssueType(SubtaskType.SpikeTask), "SpikeTask");
    });

    it("throws on an unknown Jira type rather than guessing", () => {
        assert.throws(() => fromJiraIssueType("Epic Story Thing"), /Unknown Jira issue type/);
    });
});

describe("persona mapping", () => {
    it("round-trips every persona", () => {
        for (const p of Object.values(Persona)) {
            assert.equal(fromJiraPersona(toJiraPersona(p)), p);
        }
    });

    it("uses the exact live field option strings for the non-obvious ones", () => {
        // These four do NOT fall out of the kebab-case enum value mechanically, and are
        // where a "just capitalise it" derivation would silently write the wrong option.
        assert.equal(JIRA_PERSONA[Persona.UxDesigner], "UX Designer");
        assert.equal(JIRA_PERSONA[Persona.CodeReviewer], "Code Reviewer");
        assert.equal(JIRA_PERSONA[Persona.Dba], "DBA");
        assert.equal(JIRA_PERSONA[Persona.Pm], "PM");
    });

    it("throws on an unknown option value", () => {
        assert.throws(() => fromJiraPersona("Scrum Master"), /Unknown Persona field value/);
    });
});

describe("status mapping", () => {
    it("accepts every schema status verbatim (identity, not translation)", () => {
        for (const s of Object.values(Status)) {
            assert.equal(fromJiraStatus(s), s);
        }
    });

    it("accepts the two statuses that only exist because of live reconciliation", () => {
        assert.equal(fromJiraStatus("To Do"), Status.ToDo); // rev 15: not "Open"
        assert.equal(fromJiraStatus("Canceled"), Status.Canceled); // rev 16
    });

    it("throws on a status outside the §5.3 lifecycle", () => {
        assert.throws(() => fromJiraStatus("Blocked"), /Unknown Jira status/);
    });
});

describe("link-type mapping", () => {
    it("maps DependsOn to Blocks and RelatesTo to Relates", () => {
        assert.equal(toJiraLinkType(DependencyRelation.DependsOn), "Blocks");
        assert.equal(toJiraLinkType(DependencyRelation.RelatesTo), "Relates");
        assert.equal(fromJiraLinkType("Blocks"), DependencyRelation.DependsOn);
    });

    it("ignores link types TAI has no opinion about, rather than throwing", () => {
        // A human is free to add a "Duplicates" link in Jira; that is not a schema violation.
        assert.equal(fromJiraLinkType("Duplicates"), null);
    });
});

describe("toIssue", () => {
    it("maps a full issue", () => {
        const issue = toIssue(rawIssue(), PERSONA_FIELD);
        assert.equal(issue.key, "TAI-21");
        assert.equal(issue.projectKey, "TAI");
        assert.equal(issue.issueType, SubtaskType.Dev);
        assert.equal(issue.status, Status.InProgress);
        assert.equal(issue.persona, Persona.Developer);
        assert.equal(issue.parentKey, "TAI-12");
        assert.deepEqual(issue.labels, ["backend"]);
    });

    it("treats an omitted assignee as null", () => {
        // Real Jira omits the field entirely when unassigned. (The mcp-atlassian wrapper
        // instead invents {display_name: "Unassigned"} — a wrapper artifact we must not
        // "helpfully" special-case here.)
        const issue = toIssue(rawIssue(), PERSONA_FIELD);
        assert.equal(issue.assignee, null);
    });

    it("maps an assignee to a HumanRef", () => {
        const issue = toIssue(
            rawIssue({
                assignee: {
                    accountId: "712020:abc",
                    displayName: "del",
                    emailAddress: "del@mayhak.com",
                },
            }),
            PERSONA_FIELD
        );
        assert.equal(issue.assignee?.id, "712020:abc");
        assert.equal(issue.assignee?.email, "del@mayhak.com");
    });

    it("treats a null Persona field as null, not a crash", () => {
        const issue = toIssue(rawIssue({ [PERSONA_FIELD]: null }), PERSONA_FIELD);
        assert.equal(issue.persona, null);
    });

    it("takes only the first component (a subtask targets exactly one repo)", () => {
        const issue = toIssue(
            rawIssue({ components: [{ name: "tai-framework" }, { name: "other" }] }),
            PERSONA_FIELD
        );
        assert.equal(issue.component, "tai-framework");
    });

    it("never populates severity — it has no Jira counterpart (brief §5.2)", () => {
        const issue = toIssue(rawIssue({ priority: { name: "High" } }), PERSONA_FIELD);
        assert.equal(issue.severity, undefined);
        assert.equal(issue.priority, "High");
    });

    it("preserves an explicitly-cleared empty-string description (not the same as absent)", () => {
        // REGRESSION: a truthy check used to collapse description: "" to the same undefined
        // as a missing/null description, losing the distinction IssuePatch's tri-state
        // contract says matters (a patch CAN legitimately set description to "").
        const issue = toIssue(rawIssue({ description: "" }), PERSONA_FIELD);
        assert.equal(issue.description, "");
    });

    it("still treats a missing description as absent", () => {
        const issue = toIssue(rawIssue({ description: undefined }), PERSONA_FIELD);
        assert.equal(issue.description, undefined);
    });

    it("still treats a null description as absent", () => {
        const issue = toIssue(rawIssue({ description: null }), PERSONA_FIELD);
        assert.equal(issue.description, undefined);
    });

    it("maps comments inline (they are part of the issue payload, brief §7)", () => {
        const issue = toIssue(
            rawIssue({
                comment: {
                    comments: [
                        {
                            id: "10000",
                            author: { accountId: "a1", displayName: "del" },
                            body: "Approved: looks good",
                            created: "2026-07-13T09:28:02.401-0600",
                            updated: "2026-07-13T09:28:02.401-0600",
                        },
                    ],
                },
            }),
            PERSONA_FIELD
        );
        assert.equal(issue.comments.length, 1);
        assert.equal(issue.comments[0]?.body, "Approved: looks good");
    });

    it("surfaces updatedAt on comments — §3.9's marker re-scan depends on seeing edits", () => {
        const c = toComment({
            id: "1",
            author: { accountId: "a", displayName: "d" },
            body: "Approved:",
            created: "2026-07-13T09:00:00.000-0600",
            updated: "2026-07-13T10:00:00.000-0600",
        });
        assert.notEqual(c.createdAt, c.updatedAt);
    });

    it("returns null for a missing user", () => {
        assert.equal(toHumanRef(null), null);
        assert.equal(toHumanRef(undefined), null);
    });
});

describe("toJql", () => {
    it("always scopes to the project", () => {
        assert.match(toJql({ projectKey: "TAI" }), /^project = "TAI"/);
    });

    it("maps issue types through the Jira names, not the enum values", () => {
        const jql = toJql({ projectKey: "TAI", issueTypes: [SubtaskType.Dev, SubtaskType.CodeReview] });
        assert.match(jql, /issuetype IN \("Dev", "CodeReview"\)/);
        assert.doesNotMatch(jql, /code-review/); // the raw enum value must never reach Jira
    });

    it("maps persona through the field option string", () => {
        const jql = toJql({ projectKey: "TAI", persona: Persona.UxDesigner });
        assert.match(jql, /Persona = "UX Designer"/);
    });

    it("supports the bulk incremental-sync query (brief §7)", () => {
        const jql = toJql({ projectKey: "TAI", updatedSince: "2026-07-13 09:00" });
        assert.match(jql, /updated >= "2026-07-13 09:00"/);
    });

    it("escapes quotes so a crafted value cannot break out of the literal", () => {
        const jql = toJql({ projectKey: 'TA"I' });
        assert.match(jql, /project = "TA\\"I"/);
    });

    it("throws on an unmappable filter rather than emitting a query that returns nothing", () => {
        // The whole point: during Phase 4 planning, a wrapper silently swallowed a JQL error
        // and returned [], which made 21 nonexistent issue types look like they existed.
        // An empty result must only ever mean "no matches."
        assert.throws(
            () => toJql({ projectKey: "TAI", statuses: ["Blocked" as Status] }),
            /Unknown Jira status/
        );
    });
});
