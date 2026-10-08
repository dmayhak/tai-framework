/**
 * TAI Framework — Jira <-> domain mapping
 *
 * Pure functions, no I/O, no network. Everything here is unit-testable against captured
 * fixtures, which matters because this layer is where the silent, plausible-looking bugs
 * live (a persona quietly mapped to the wrong Jira option is far worse than a crash).
 */

import { parseUpdatedSince } from "../issue-filter.js";
import { UnreadableIssueError } from "../unreadable-issues.js";
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
    [SubtaskType.EpicReview]: "EpicReview",
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

/**
 * A target project's own per-project override on top of `JIRA_ISSUE_TYPE`/
 * `JIRA_ISSUE_TYPE_REVERSE` (TAI-116 piece 4, TAI-178 ADR) — lets a pre-existing Jira
 * project's native issue-type names (e.g. a generic "Sub-task") stand in for one of TAI's
 * own bundled display names, without TAI's custom issue-type scheme being re-provisioned
 * to match exactly. Sourced from an optional "Type Aliases" Confluence page
 * (`type-alias-config.ts`, which owns the parsing/loading — this module stays free of any
 * `DocStore`/network dependency, per its own "pure functions, no I/O" header).
 */
export interface TypeAliasMap {
    /** Project's native Jira issue-type display name -> IssueType. */
    readonly fromJira: ReadonlyMap<string, IssueType>;
    /** IssueType -> the native Jira issue-type display name to use when CREATING an issue
     *  of this type. Only present for a type the project has explicitly aliased. */
    readonly toJira: ReadonlyMap<IssueType, string>;
}

export const EMPTY_TYPE_ALIAS_MAP: TypeAliasMap = { fromJira: new Map(), toJira: new Map() };

export function toJiraIssueType(t: IssueType, aliases: TypeAliasMap = EMPTY_TYPE_ALIAS_MAP): string {
    return aliases.toJira.get(t) ?? JIRA_ISSUE_TYPE[t];
}

/** Thrown for a Jira type TAI has no mapping for; `toIssue` upgrades it to an `UnreadableIssueError` that knows the key. */
export class UnknownJiraIssueTypeError extends Error {
    constructor(readonly typeName: string, message: string) {
        super(message);
        this.name = "UnknownJiraIssueTypeError";
    }
}

export function fromJiraIssueType(name: string, aliases: TypeAliasMap = EMPTY_TYPE_ALIAS_MAP): IssueType {
    const aliased = aliases.fromJira.get(name);
    if (aliased !== undefined) return aliased;
    const t = JIRA_ISSUE_TYPE_REVERSE.get(name);
    // Deliberately throws rather than defaulting. An unrecognised issue type means the Jira
    // project is provisioned differently than the schema believes — guessing would produce
    // a wrong-but-plausible Issue and corrupt everything downstream that routes on type.
    if (t === undefined) {
        throw new UnknownJiraIssueTypeError(
            name,
            `Unknown Jira issue type "${name}". Provision it in Jira, add it to SubtaskType/StoryType, ` +
                `or map it on the "Type Aliases" Confluence page (TAI-116 piece 4).`
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

/** TAI-390: the one option TAI sets/reads on Jira's multi-checkbox "Flagged" field. */
export const JIRA_FLAG_OPTION = "Impediment";

/** TAI-405: `fromJiraIssueType`, but an unmapped type surfaces as an `UnreadableIssueError` naming the ticket. */
function issueTypeOrUnreadable(key: string, typeName: string, aliases: TypeAliasMap): IssueType {
    try {
        return fromJiraIssueType(typeName, aliases);
    } catch (e) {
        if (e instanceof UnknownJiraIssueTypeError) throw new UnreadableIssueError(key, e.typeName, e.message);
        throw e;
    }
}

export function toIssue(
    raw: RawIssue,
    personaFieldId: string,
    aliases: TypeAliasMap = EMPTY_TYPE_ALIAS_MAP,
    flaggedFieldId: string | null = null
): Issue {
    const f = raw.fields;
    const personaRaw = f[personaFieldId] as { value?: string } | null | undefined;
    const flaggedRaw = flaggedFieldId ? (f[flaggedFieldId] as { value?: string }[] | null | undefined) : undefined;
    const flagged = flaggedRaw?.some((o) => o?.value === JIRA_FLAG_OPTION) === true;

    return {
        key: toIssueKey(raw.key),
        projectKey: f.project.key,
        issueType: issueTypeOrUnreadable(raw.key, f.issuetype.name, aliases),
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
        ...(flagged ? { flagged: true } : {}),
        createdAt: f.created,
        updatedAt: f.updated,
        comments: (f.comment?.comments ?? []).map(toComment),
    };
}

// ---------- IssueFilter -> JQL ----------

export function jqlString(s: string): string {
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
export function toJql(filter: IssueFilter, aliases: TypeAliasMap = EMPTY_TYPE_ALIAS_MAP): string {
    const clauses: string[] = [`project = ${jqlString(filter.projectKey)}`];

    if (filter.issueTypes?.length) {
        const names = filter.issueTypes.map((t) => jqlString(toJiraIssueType(t, aliases)));
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
        // Epoch milliseconds, not the ISO string: found live (TAI-420) that Jira silently matches NOTHING for
        // `updated >= "2026-07-07T18:50:16.985Z"` (no error, zero rows), while an epoch value is exact and
        // timezone-free. `parseUpdatedSince` is the shared strict contract (ISO only) and throws on anything else.
        const sinceMs = parseUpdatedSince(filter.updatedSince);
        clauses.push(`updated >= ${sinceMs}`);
    }
    if (filter.component) {
        clauses.push(`component = ${jqlString(filter.component)}`);
    }
    for (const label of filter.labels ?? []) {
        clauses.push(`labels = ${jqlString(label)}`);
    }

    return `${clauses.join(" AND ")} ORDER BY key ASC`;
}

/** Fields to request explicitly — Jira omits custom fields unless asked. */
export function issueFields(personaFieldId: string, flaggedFieldId: string | null = null): string {
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
        ...(flaggedFieldId ? [flaggedFieldId] : []),
    ].join(",");
}
