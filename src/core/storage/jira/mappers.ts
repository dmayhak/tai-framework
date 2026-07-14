/**
 * TAI Framework — Jira <-> domain mapping
 *
 * Pure functions, no I/O, no network. Everything here is unit-testable against captured
 * fixtures, which matters because this layer is where the silent, plausible-looking bugs
 * live (a persona quietly mapped to the wrong Jira option is far worse than a crash).
 */

import {
    Persona,
    Status,
    StoryType,
    SubtaskType,
    DependencyRelation,
    DEFAULT_JIRA_LINK_TYPE_NAME,
    PERSONA_ROLE_LABEL,
} from "../../schema/story-schema.js";
import {
    type Issue,
    type Comment,
    type HumanRef,
    type AttachmentRef,
    type IssueFilter,
    type IssueKey,
    toIssueKey,
    toHumanId,
} from "../interface.js";

export type IssueType = StoryType | SubtaskType | "epic";

// ---------- Issue types ----------

/**
 * The enum values are internal kebab-case keys; Jira's issue-type names are PascalCase
 * display names provisioned by a Jira admin (brief §5.2 — one native sub-task issue type
 * per SubtaskType). The two are NOT mechanically derivable from each other, so this map is
 * written out in full and kept total: `Record<IssueType, string>` means the compiler fails
 * the build if a new type is added to the schema and forgotten here.
 */
export const JIRA_ISSUE_TYPE: Record<IssueType, string> = {
    epic: "Epic",

    [StoryType.Kickoff]: "Kickoff",
    [StoryType.Spike]: "Spike",
    [StoryType.Story]: "Story",
    [StoryType.Bug]: "Bug",

    [SubtaskType.Research]: "Research",
    [SubtaskType.Investigate]: "Investigate",
    [SubtaskType.Requirements]: "Requirements",
    [SubtaskType.UxDesign]: "UxDesign",
    [SubtaskType.Feasibility]: "Feasibility",
    [SubtaskType.ArchitectureDesign]: "ArchitectureDesign",
    [SubtaskType.DesignReview]: "DesignReview",
    [SubtaskType.Database]: "Database",
    [SubtaskType.Infra]: "Infra",
    [SubtaskType.Dev]: "Dev",
    [SubtaskType.CodeReview]: "CodeReview",
    [SubtaskType.IntegrationTest]: "IntegrationTest",
    [SubtaskType.SystemTest]: "SystemTest",
    [SubtaskType.E2ETest]: "E2ETest",
    [SubtaskType.Uat]: "UAT",
    [SubtaskType.Deploy]: "Deploy",
    [SubtaskType.PostDeploy]: "PostDeploy",
    // Renamed from `Spike` (brief rev 13): Jira issue-type names are unique site-wide and
    // the Story-level `Spike` above already owns that name.
    [SubtaskType.SpikeTask]: "SpikeTask",
    [SubtaskType.Triage]: "Triage",
};

const JIRA_ISSUE_TYPE_REVERSE: ReadonlyMap<string, IssueType> = new Map(
    Object.entries(JIRA_ISSUE_TYPE).map(([k, v]) => [v, k as IssueType])
);

export function toJiraIssueType(t: IssueType): string {
    return JIRA_ISSUE_TYPE[t];
}

export function fromJiraIssueType(name: string): IssueType {
    const t = JIRA_ISSUE_TYPE_REVERSE.get(name);
    // Deliberately throws rather than defaulting. An unrecognised issue type means the Jira
    // project is provisioned differently than the schema believes — guessing would produce
    // a wrong-but-plausible Issue and corrupt everything downstream that routes on type.
    if (t === undefined) {
        throw new Error(
            `Unknown Jira issue type "${name}". Provision it in Jira, or add it to SubtaskType/StoryType.`
        );
    }
    return t;
}

// ---------- Persona ----------

/**
 * The `Persona` single-select custom field (brief §5.6, the two-axis owner model).
 *
 * The field's option strings ARE the canonical role labels (PERSONA_ROLE_LABEL) — they were
 * provisioned in Jira to match, and the Persona Roster's column uses the same labels, so all
 * three read from one source rather than keeping copies that could drift. Verified against
 * the live field's actual options. The entries that would trip a naive "capitalise the
 * kebab-case key" derivation — "UX Designer", "Code Reviewer", "DBA", "PM" — are exactly why
 * this is a written-out map and not computed.
 */
export const JIRA_PERSONA: Record<Persona, string> = PERSONA_ROLE_LABEL;

const JIRA_PERSONA_REVERSE: ReadonlyMap<string, Persona> = new Map(
    Object.entries(JIRA_PERSONA).map(([k, v]) => [v, k as Persona])
);

export function toJiraPersona(p: Persona): string {
    return JIRA_PERSONA[p];
}

export function fromJiraPersona(value: string): Persona {
    const p = JIRA_PERSONA_REVERSE.get(value);
    if (p === undefined) {
        throw new Error(`Unknown Persona field value "${value}". Expected one of: ${Object.values(JIRA_PERSONA).join(", ")}`);
    }
    return p;
}

// ---------- Status ----------

const STATUS_VALUES: ReadonlySet<string> = new Set(Object.values(Status));

/**
 * Identity, not translation: `Status`'s values are already the real Jira display strings
 * ("To Do", "In Progress", "In Review", "Done", "Canceled"), verified live against the TAI
 * project (see the enum's own comment in story-schema.ts). This function exists to VALIDATE
 * rather than convert — an unrecognised status means Jira's workflow drifted from §5.3 and
 * we want to hear about it loudly.
 */
export function fromJiraStatus(name: string): Status {
    if (!STATUS_VALUES.has(name)) {
        throw new Error(
            `Unknown Jira status "${name}". Expected one of: ${Object.values(Status).join(", ")} (brief §5.3).`
        );
    }
    return name as Status;
}

// ---------- Link types ----------

export function toJiraLinkType(relation: DependencyRelation): string {
    return DEFAULT_JIRA_LINK_TYPE_NAME[relation];
}

export function fromJiraLinkType(name: string): DependencyRelation | null {
    for (const [rel, jira] of Object.entries(DEFAULT_JIRA_LINK_TYPE_NAME)) {
        if (jira === name) return rel as DependencyRelation;
    }
    // Unlike issue types and personas, an unknown LINK type is not a schema violation —
    // a human is free to add "Duplicates"/"Clones"/etc. links in Jira that TAI has no
    // opinion about. Ignore them rather than throwing.
    return null;
}

// ---------- Raw Jira shapes (what /rest/api/2 actually returns) ----------

export interface RawUser {
    accountId: string;
    displayName: string;
    emailAddress?: string;
}

export interface RawComment {
    id: string;
    author: RawUser;
    body: string; // plain string on /rest/api/2 (ADF on v3 — see rest-client.ts)
    created: string;
    updated: string;
}

export interface RawIssue {
    key: string;
    fields: {
        project: { key: string };
        issuetype: { name: string };
        summary: string;
        description?: string | null;
        status: { name: string };
        assignee?: RawUser | null;
        parent?: { key: string };
        components?: { name: string }[];
        priority?: { name: string } | null;
        labels?: string[];
        created: string;
        updated: string;
        comment?: { comments?: RawComment[] };
        attachment?: { id: string; filename: string; size?: number }[];
        [customField: string]: unknown;
    };
}

// ---------- Raw -> domain ----------

export function toHumanRef(raw: RawUser | null | undefined): HumanRef | null {
    // Jira omits `assignee` entirely when unassigned. (The mcp-atlassian wrapper instead
    // invents `{display_name: "Unassigned"}`, which is a wrapper artifact and not something
    // real Jira ever sends — noted so nobody "helpfully" adds a check for it here.)
    if (!raw) return null;
    return {
        id: toHumanId(raw.accountId),
        displayName: raw.displayName,
        ...(raw.emailAddress ? { email: raw.emailAddress } : {}),
    };
}

export function toComment(raw: RawComment): Comment {
    return {
        id: raw.id,
        author: toHumanRef(raw.author) ?? {
            id: toHumanId("unknown"),
            displayName: "Unknown",
        },
        body: raw.body,
        createdAt: raw.created,
        updatedAt: raw.updated,
    };
}

export function toAttachmentRef(raw: { id: string; filename: string; size?: number }): AttachmentRef {
    return {
        id: raw.id,
        filename: raw.filename,
        ...(raw.size !== undefined ? { sizeBytes: raw.size } : {}),
    };
}

export function toIssue(raw: RawIssue, personaFieldId: string): Issue {
    const f = raw.fields;
    const personaRaw = f[personaFieldId] as { value?: string } | null | undefined;

    return {
        key: toIssueKey(raw.key),
        projectKey: f.project.key,
        issueType: fromJiraIssueType(f.issuetype.name),
        summary: f.summary,
        // Explicit presence check, not truthy — a falsy check would collapse an
        // intentionally-cleared description ("") to the same undefined as a missing one,
        // breaking round-trip fidelity for a value IssuePatch's tri-state contract treats as
        // meaningful (found by the conformance suite, TAI-15).
        ...(f.description !== undefined && f.description !== null ? { description: f.description } : {}),
        status: fromJiraStatus(f.status.name),
        assignee: toHumanRef(f.assignee),
        persona: personaRaw?.value ? fromJiraPersona(personaRaw.value) : null,
        ...(f.parent ? { parentKey: toIssueKey(f.parent.key) } : {}),
        // Subtask-scoped in TAI's model (brief §4/§5.4 — one repo per subtask), so only the
        // first component is meaningful. Jira allows many; we don't.
        ...(f.components?.[0] ? { component: f.components[0].name } : {}),
        // `severity` has NO Jira counterpart on this site. Brief §5.2 explicitly says to
        // reuse native Priority for the Bug D5 expedited path rather than inventing a
        // custom field, so it is intentionally never populated by this backend.
        ...(f.priority ? { priority: f.priority.name } : {}),
        labels: f.labels ?? [],
        createdAt: f.created,
        updatedAt: f.updated,
        comments: (f.comment?.comments ?? []).map(toComment),
    };
}

// ---------- IssueFilter -> JQL ----------

function jqlString(s: string): string {
    // JQL string literals: backslash and double-quote need escaping.
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build JQL from a filter.
 *
 * HARD RULE (learned the expensive way): every input is validated against the schema and
 * an unmappable value THROWS. It must never be possible for a bad filter to produce a
 * query that quietly returns zero rows — during Phase 4 planning, the mcp-atlassian
 * wrapper silently swallowed a JQL error and returned `[]`, which made 21 nonexistent Jira
 * issue types look like they existed. Real Jira returns a 400 here, but the rule stands on
 * its own: an empty result must only ever mean "no matches."
 */
export function toJql(filter: IssueFilter): string {
    const clauses: string[] = [`project = ${jqlString(filter.projectKey)}`];

    if (filter.issueTypes?.length) {
        const names = filter.issueTypes.map((t) => jqlString(toJiraIssueType(t)));
        clauses.push(`issuetype IN (${names.join(", ")})`);
    }
    if (filter.statuses?.length) {
        // Round-trips through the validator so a bogus status can't reach Jira.
        const names = filter.statuses.map((s) => jqlString(fromJiraStatus(s)));
        clauses.push(`status IN (${names.join(", ")})`);
    }
    if (filter.assignee) {
        clauses.push(`assignee = ${jqlString(filter.assignee)}`);
    }
    if (filter.persona) {
        clauses.push(`Persona = ${jqlString(toJiraPersona(filter.persona))}`);
    }
    if (filter.parentKey) {
        clauses.push(`parent = ${jqlString(filter.parentKey)}`);
    }
    if (filter.updatedSince) {
        // Powers brief §7's bulk "what changed since last sync" query.
        clauses.push(`updated >= ${jqlString(filter.updatedSince)}`);
    }

    return `${clauses.join(" AND ")} ORDER BY key ASC`;
}

/** Fields to request explicitly — Jira omits custom fields unless asked. */
export function issueFields(personaFieldId: string): string {
    return [
        "project",
        "issuetype",
        "summary",
        "description",
        "status",
        "assignee",
        "parent",
        "components",
        "priority",
        "labels",
        "created",
        "updated",
        "comment",
        "attachment",
        personaFieldId,
    ].join(",");
}
