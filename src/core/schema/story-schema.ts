/**
 * TAI Framework — Story & Subtask Type Schema
 * Defines the work-tracking hierarchy: Epic -> Story -> Subtask
 * Each subtask type is owned by exactly one persona, enabling
 * effort/time tracking to roll up correctly regardless of which
 * story type the subtask is attached to.
 */

// ---------- Personas ----------

// Personas are identified in code by ROLE, not friendly/display name.
// Friendly names (Ada, Perry, Aria, etc.) are configurable via the
// Confluence settings/config page and resolved at runtime through a
// separate PersonaDisplayName lookup — never hardcoded here.

export enum Persona {
    Analyst = "analyst",
    Pm = "pm",
    Architect = "architect",
    UxDesigner = "ux-designer",
    Developer = "developer",
    Dba = "dba",
    CodeReviewer = "code-reviewer",
    Tester = "tester",
    DevOps = "devops",
}

// Default/fallback friendly names — actual display names are pulled from
// Confluence config at runtime and may override these per-org or per-user.
export const DEFAULT_PERSONA_DISPLAY_NAME: Record<Persona, string> = {
    [Persona.Analyst]: "Ada",
    [Persona.Pm]: "Perry",
    [Persona.Architect]: "Aria",
    [Persona.UxDesigner]: "Uma",
    [Persona.Developer]: "Dario",
    [Persona.Dba]: "Dana",
    [Persona.CodeReviewer]: "Cole",
    [Persona.Tester]: "Tessa",
    [Persona.DevOps]: "Duncan",
};

// ---------- Story Types ----------

export enum StoryType {
    Kickoff = "kickoff",
    Spike = "spike",
    Story = "story", // Jira's native Story type — listed explicitly so it isn't missed when reading this enum
    Bug = "bug", // subtask structure TBD
}

// ---------- Subtask Types ----------

export enum SubtaskType {
    Research = "research",                   // Analyst
    Requirements = "requirements",           // PM
    UxDesign = "ux-design",                  // UX Designer
    Feasibility = "feasibility",             // Architect — quick, spike-like technical go/no-go
    ArchitectureDesign = "architecture-design", // Architect — deeper, non-time-boxed design work (ADRs, component boundaries)
    Database = "database",                   // DBA — schema, migrations, query tuning, performance (not just schema)
    Infra = "infra",                         // DevOps
    Dev = "dev",                             // Developer — unit tests are folded in here, not a separate subtask
    CodeReview = "code-review",              // Code Reviewer
    IntegrationTest = "integration-test",    // Tester
    SystemTest = "system-test",              // Tester
    E2ETest = "e2e-test",                    // Tester
    Deploy = "deploy",                       // DevOps (default) — manual or gated deployment
    PostDeploy = "post-deploy",              // DevOps (default) — manual follow-up work after a deployment
    Spike = "spike",                         // No fixed owner — assignee set explicitly at creation time
    Triage = "triage",                       // Tester (default) — Bug entry point: confirm repro, assess severity, identify root cause
}

// Single source of truth: which persona owns which subtask type BY DEFAULT.
// A value of `null` means there is no fixed owner — the assignee must be
// set explicitly at creation time (currently only true for Spike, since a
// spike question could belong to any persona depending on what's being
// investigated). Deploy/PostDeploy default to DevOps but may be
// reassigned per-instance (e.g. a DBA-led data backfill post-deploy).
export const SUBTASK_OWNER: Record<SubtaskType, Persona | null> = {
    [SubtaskType.Research]: Persona.Analyst,
    [SubtaskType.Requirements]: Persona.Pm,
    [SubtaskType.UxDesign]: Persona.UxDesigner,
    [SubtaskType.Feasibility]: Persona.Architect,
    [SubtaskType.ArchitectureDesign]: Persona.Architect,
    [SubtaskType.Database]: Persona.Dba,
    [SubtaskType.Infra]: Persona.DevOps,
    [SubtaskType.Dev]: Persona.Developer,
    [SubtaskType.CodeReview]: Persona.CodeReviewer,
    [SubtaskType.IntegrationTest]: Persona.Tester,
    [SubtaskType.SystemTest]: Persona.Tester,
    [SubtaskType.E2ETest]: Persona.Tester,
    [SubtaskType.Deploy]: Persona.DevOps,
    [SubtaskType.PostDeploy]: Persona.DevOps,
    [SubtaskType.Spike]: null,
    [SubtaskType.Triage]: Persona.Tester,
};

// Which subtask types are valid/expected under each story type.
// A subtask type CAN appear under multiple story types (e.g. Database
// under both Spike and Story) — this is what allows DBA/DevOps work to
// roll up correctly regardless of context.
export const STORY_SUBTASK_MAP: Record<StoryType, SubtaskType[]> = {
    [StoryType.Kickoff]: [
        SubtaskType.Research,
        SubtaskType.Requirements,
        SubtaskType.UxDesign,
        SubtaskType.ArchitectureDesign,
        // Open question: should Feasibility / Database / Infra also be allowed
        // here for early technical-risk flagging during kickoff?
    ],
    [StoryType.Spike]: [
        SubtaskType.Feasibility,
        SubtaskType.Database,
        SubtaskType.Infra,
    ],
    [StoryType.Story]: [
        SubtaskType.ArchitectureDesign, // feature-level design before Dev starts, when needed
        SubtaskType.Dev,
        SubtaskType.CodeReview,
        SubtaskType.IntegrationTest,
        SubtaskType.SystemTest,
        SubtaskType.E2ETest,
        SubtaskType.Database,
        SubtaskType.Infra,
        SubtaskType.Deploy,
        SubtaskType.PostDeploy,
        SubtaskType.Spike, // ad-hoc investigation without spinning up a full Spike story
    ],
    [StoryType.Bug]: [
        SubtaskType.Triage, // entry point — replaces Research/Requirements/UxDesign for reported issues
        SubtaskType.Dev,
        SubtaskType.CodeReview,
        SubtaskType.IntegrationTest,
        SubtaskType.SystemTest,
        SubtaskType.E2ETest,
        SubtaskType.Database,
        SubtaskType.Infra,
        SubtaskType.Deploy,
        SubtaskType.PostDeploy,
        SubtaskType.Spike, // for root-cause investigation when the fix isn't obvious
    ],
};

// ---------- Story-Level Dependencies (discovered, not derivable) ----------

// These are judgment calls made by the Analyst (or others) during
// discovery — code cannot infer them, they must be captured as data.
//
// Each relation is stored ONE-directional; Jira's inverse naming
// ("blocks" / "is blocked by") is an API/display concern, not a reason
// to store both directions here.
export enum DependencyRelation {
    DependsOn = "depends-on", // from cannot start until to is done (to "blocks" from, in Jira's terms)
    CausedBy = "caused-by",   // from (a Bug) was caused by to (a Story/Bug)
    RelatesTo = "relates-to", // non-blocking association, informational only
}

// Maps our semantic relation to the actual Jira Issue Link Type name.
// DEFAULTS ONLY — verify these against the actual Jira instance/project
// template before relying on them. "Causes" in particular is NOT a
// universal Jira default and may need to be added, or CausedBy may need
// to map to "Relates" instead if no such type exists.
export const DEFAULT_JIRA_LINK_TYPE_NAME: Record<DependencyRelation, string> = {
    [DependencyRelation.DependsOn]: "Blocks",
    [DependencyRelation.CausedBy]: "Causes", // TODO: confirm this link type exists in target Jira instance
    [DependencyRelation.RelatesTo]: "Relates",
};

// A reference to a story that may not exist in Jira yet. During a single
// discovery session, the Analyst may find several related stories before
// any of them have been created — localId lets dependencies be recorded
// immediately and resolved to real Jira keys once the tickets exist.
export interface StoryRef {
    jiraKey?: string;
    localId?: string; // e.g. "2026-07-kickoff-batch1#3"
}

export interface StoryDependency {
    from: StoryRef;
    relation: DependencyRelation;
    to: StoryRef;
    note?: string; // Analyst's reasoning, e.g. "auth must land before profile editing"
}

// Resolves a batch of StoryDependency records (some possibly using
// localId) into fully-keyed dependencies once all referenced stories
// have real Jira keys. Throws if any localId wasn't resolved — this is
// intentional, so a missed mapping fails loudly instead of silently
// dropping a discovered dependency.
export function resolveStoryDependencies(
    dependencies: StoryDependency[],
    localIdToJiraKey: Map<string, string>
): { from: string; relation: DependencyRelation; to: string; note?: string }[] {
    const resolve = (ref: StoryRef): string => {
        if (ref.jiraKey) return ref.jiraKey;
        if (ref.localId) {
            const key = localIdToJiraKey.get(ref.localId);
            if (!key) {
                throw new Error(`Unresolved local story reference: ${ref.localId}`);
            }
            return key;
        }
        throw new Error("StoryRef must have either jiraKey or localId set");
    };

    return dependencies.map((d) => ({
        from: resolve(d.from),
        relation: d.relation,
        to: resolve(d.to),
        note: d.note,
    }));
}

// ---------- Subtask-Level Precedence (structural, derivable) ----------

// Defines the FULL possible precedence graph per story type. A concrete
// story instance will usually only have a subset of these subtask types
// present (e.g. no Database subtask, no ArchitectureDesign) — the
// resolver below filters this graph down to only the edges where BOTH
// ends are actually present on that instance.
export interface SubtaskPrecedenceRule {
    before: SubtaskType; // must be Done first
    after: SubtaskType;  // becomes workable once ALL its 'before' rules are satisfied
}

export const SUBTASK_PRECEDENCE: Record<StoryType, SubtaskPrecedenceRule[]> = {
    [StoryType.Kickoff]: [
        { before: SubtaskType.Research, after: SubtaskType.Requirements },
        { before: SubtaskType.Research, after: SubtaskType.UxDesign },
        { before: SubtaskType.Requirements, after: SubtaskType.ArchitectureDesign },
    ],
    [StoryType.Story]: [
        { before: SubtaskType.ArchitectureDesign, after: SubtaskType.Dev },
        { before: SubtaskType.Database, after: SubtaskType.Dev },
        { before: SubtaskType.Infra, after: SubtaskType.Dev },
        { before: SubtaskType.Dev, after: SubtaskType.CodeReview },
        // Test tiers run in parallel off CodeReview, not chained to each
        // other — open question below on whether this matches intent.
        { before: SubtaskType.CodeReview, after: SubtaskType.IntegrationTest },
        { before: SubtaskType.CodeReview, after: SubtaskType.SystemTest },
        { before: SubtaskType.CodeReview, after: SubtaskType.E2ETest },
        { before: SubtaskType.IntegrationTest, after: SubtaskType.Deploy },
        { before: SubtaskType.SystemTest, after: SubtaskType.Deploy },
        { before: SubtaskType.E2ETest, after: SubtaskType.Deploy },
        { before: SubtaskType.Deploy, after: SubtaskType.PostDeploy },
    ],
    [StoryType.Bug]: [
        { before: SubtaskType.Triage, after: SubtaskType.Dev },
        { before: SubtaskType.Database, after: SubtaskType.Dev },
        { before: SubtaskType.Infra, after: SubtaskType.Dev },
        { before: SubtaskType.Dev, after: SubtaskType.CodeReview },
        { before: SubtaskType.CodeReview, after: SubtaskType.IntegrationTest },
        { before: SubtaskType.CodeReview, after: SubtaskType.SystemTest },
        { before: SubtaskType.CodeReview, after: SubtaskType.E2ETest },
        { before: SubtaskType.IntegrationTest, after: SubtaskType.Deploy },
        { before: SubtaskType.SystemTest, after: SubtaskType.Deploy },
        { before: SubtaskType.E2ETest, after: SubtaskType.Deploy },
        { before: SubtaskType.Deploy, after: SubtaskType.PostDeploy },
    ],
    [StoryType.Spike]: [
        // Spike story subtasks (Feasibility/Database/Infra) are typically
        // independent investigations — no default precedence enforced.
    ],
};

// Note: the ad-hoc `Spike` SUBTASK (used inside a Story/Bug) deliberately
// has no entry here, same reason it has no fixed owner — whether it
// blocks Dev or is purely informational depends on what's being
// investigated, and must be set explicitly per instance.

// Filters the full precedence graph down to only the edges relevant to
// a specific story instance's actual subtask set.
export function resolveApplicablePrecedence(
    storyType: StoryType,
    presentSubtaskTypes: SubtaskType[]
): SubtaskPrecedenceRule[] {
    const present = new Set(presentSubtaskTypes);
    return SUBTASK_PRECEDENCE[storyType].filter(
        (rule) => present.has(rule.before) && present.has(rule.after)
    );
}

// Given the actual subtasks present on a story instance and which of
// them are currently Done, determines whether a target subtask is
// unblocked. A subtask with no applicable 'before' rules is a root and
// is always ready.
export function isSubtaskReady(
    target: SubtaskType,
    storyType: StoryType,
    presentSubtaskTypes: SubtaskType[],
    doneSubtaskTypes: Set<SubtaskType>
): boolean {
    const applicable = resolveApplicablePrecedence(storyType, presentSubtaskTypes).filter(
        (rule) => rule.after === target
    );
    return applicable.every((rule) => doneSubtaskTypes.has(rule.before));
}

export interface ReviewGate {
    storyType: StoryType;
    requiredReviewers: Persona[];
    description: string;
}

export const REVIEW_GATES: ReviewGate[] = [
    {
        storyType: StoryType.Kickoff,
        requiredReviewers: [Persona.Pm, Persona.UxDesigner],
        description:
            "PRD + UX must be reviewed and signed off before a kickoff story can spawn work stories.",
    },
    // Analyst `Investigate` output review gate — dual PM + Architect.
    // Not tied to a full StoryType yet; may live at the subtask level
    // (Research subtask output) rather than story level. Revisit.
];

// ---------- Open Design Questions (tracked in code for visibility) ----------

/**
 * TODO / OPEN:
 * 1. Now that ArchitectureDesign can appear under Kickoff, should the
 *    Kickoff review gate widen to PM + UX + Architect, or only conditionally
 *    add Architect when ArchitectureDesign was actually used?
 * 2. Should Feasibility / Database / Infra be allowed under Kickoff for
 *    early technical-risk flags, rather than being locked out until
 *    Spike/Story?
 * 3. Spike subtask has no fixed owner (SUBTASK_OWNER = null) — confirm the
 *    UI/workflow requires an explicit assignee at creation and doesn't
 *    silently default to anyone.
 * 4. PostDeploy defaults to DevOps but is often actually owned by whoever
 *    matches the follow-up work (DBA for backfills, Dev for flag flips) —
 *    decide whether default-owner-with-override is sufficient or whether
 *    PostDeploy needs the same "no fixed owner" treatment as Spike.
 * 5. Should a severe/hotfix Bug get an expedited path (e.g. skip full
 *    CodeReview, or compress test tiers to just one) rather than always
 *    running the full Story-equivalent subtask chain?
 * 6. Should a Bug story ever require a Kickoff-style review gate (e.g. for
 *    bugs with product/UX impact), or is Triage sign-off by Tester alone
 *    always sufficient to proceed to Dev?
 * 7. Should a failed PostDeploy check be able to auto-spawn a Bug story,
 *    linking the two, rather than relying on manual creation?
 */