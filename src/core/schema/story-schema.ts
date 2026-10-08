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

// Canonical human-readable ROLE labels — distinct from the friendly names above.
// This is the single source for "what a role is called in prose": the label that appears
// in the Persona Roster's `Persona` column (§5.6) AND the option strings provisioned for
// the Jira `Persona` custom field. Both must agree, so they read from here rather than each
// hardcoding their own copy (the two entries that don't fall out of the enum value
// mechanically — "UX Designer", "Code Reviewer", "DBA", "PM" — are exactly where independent
// copies would drift).
export const PERSONA_ROLE_LABEL: Record<Persona, string> = {
    [Persona.Analyst]: "Analyst",
    [Persona.Pm]: "PM",
    [Persona.Architect]: "Architect",
    [Persona.UxDesigner]: "UX Designer",
    [Persona.Developer]: "Developer",
    [Persona.Dba]: "DBA",
    [Persona.CodeReviewer]: "Code Reviewer",
    [Persona.Tester]: "Tester",
    [Persona.DevOps]: "DevOps",
};

// ---------- Story Types ----------

export enum StoryType {
    Kickoff = "kickoff",
    Spike = "spike",
    Story = "story", // Jira's native Story type — listed explicitly so it isn't missed when reading this enum
    Bug = "bug", // subtask structure TBD
}

// ---------- Statuses ----------

// The closed status lifecycle resolved in brief §5.3 (rev 15/16), encoded here for the
// first time — previously only described in prose. Values are the real Jira display
// strings (verified live against the actual TAI project), not internal keys like
// StoryType/SubtaskType use — both backends can use these strings directly, no separate
// ID-vs-display translation needed the way subtask/story issue-type IDs require.
export enum Status {
    // rev 27 — pre-`To Do` landing status for new/under-specified tickets, under Jira's `To
    // Do` status category; soft/unenforced (rev 28/§8.28), orthogonal to SUBTASK_PRECEDENCE.
    // Added here (PR #9 code review): real Jira issues sit in this status today (it's the
    // default landing status), and `fromJiraStatus` threw on any of them until now.
    Backlog = "Backlog",
    ToDo = "To Do",
    InProgress = "In Progress",
    InReview = "In Review", // universal on the issue type by default, but only Kickoff's flow actually transitions into it (§5.3)
    Done = "Done",
    Canceled = "Canceled", // rev 16 — a second terminal state; counts as satisfied for SUBTASK_PRECEDENCE purposes, same as Done
}

// ---------- Subtask Types ----------

export enum SubtaskType {
    Research = "research",                   // Analyst
    EpicReview = "epic-review",               // Analyst drives; a human stakeholder must sign off (TAI-354) — inherently human-gated (see ALWAYS_HUMAN_GATED_SUBTASKS), gates Requirements/UxDesign
    Investigate = "investigate",             // Analyst — Story/Bug refinement (brief §3.7); no fixed unblock effect (brief §8.13)
    Requirements = "requirements",           // PM
    UxDesign = "ux-design",                  // UX Designer
    Feasibility = "feasibility",             // Architect — quick, spike-like technical go/no-go
    ArchitectureDesign = "architecture-design", // Architect — deeper, non-time-boxed design work (ADRs, component boundaries)
    DesignReview = "design-review",          // Architect (2nd pass or peer) — optional gate on ArchitectureDesign, mirrors CodeReview
    Database = "database",                   // DBA — schema, migrations, query tuning, performance (not just schema)
    Infra = "infra",                         // DevOps
    Dev = "dev",                             // Developer — unit tests are folded in here, not a separate subtask
    CodeReview = "code-review",              // Code Reviewer
    IntegrationTest = "integration-test",    // Tester
    SystemTest = "system-test",              // Tester
    E2ETest = "e2e-test",                    // Tester
    Uat = "uat",                             // Tester + human stakeholder — optional, inherently human-gated (§3.3), gates Deploy
    Deploy = "deploy",                       // DevOps (default) — manual or gated deployment
    PostDeploy = "post-deploy",              // DevOps (default) — manual follow-up work after a deployment
    SpikeTask = "spike-task",                // No fixed owner — assignee set explicitly at creation time; ad-hoc, in-story escape hatch (distinct from StoryType.Spike, a standalone story-level ticket — renamed from `Spike` to avoid the Jira issue-type name collision)
    Triage = "triage",                       // Tester (default) — Bug entry point: confirm repro, assess severity, identify root cause
}

// Shared type guards over an Issue's issueType (StoryType | SubtaskType | "epic" —
// spelled out here rather than importing that union from storage/interface.ts, which
// itself imports FROM this module; interface.ts must stay downstream, not the other way
// around). Used wherever code needs to tell a story-level ticket apart from a subtask
// (e.g. commands/ready.ts, commands/link-precedence.ts) without duplicating the same two
// Set-backed checks per call site.
const STORY_TYPE_VALUES: ReadonlySet<string> = new Set(Object.values(StoryType));
const SUBTASK_TYPE_VALUES: ReadonlySet<string> = new Set(Object.values(SubtaskType));

export function isStoryIssueType(issueType: StoryType | SubtaskType | "epic"): issueType is StoryType {
    return STORY_TYPE_VALUES.has(issueType);
}

export function isSubtaskIssueType(issueType: StoryType | SubtaskType | "epic"): issueType is SubtaskType {
    return SUBTASK_TYPE_VALUES.has(issueType);
}

// Single source of truth: which persona owns which subtask type BY DEFAULT.
// This is the DEFAULT VALUE for a real per-instance Jira custom field —
// `persona` — that every subtask carries (brief §5.6, the two-axis owner
// model, D15). `persona` is deliberately a STORED field, not derived from
// the native Jira Assignee, because a human can hold more than one
// persona's Project Role — deriving "which persona is this" purely from
// who's assigned would be ambiguous whenever they hold more than one.
// `persona` and Assignee are two separate axes: `persona` = which role is
// being acted in; Assignee = which real human is acting it out.
//
// A value of `null` here means there is no default `persona` value — it
// must be set explicitly at creation time (currently only true for
// SpikeTask, since a spike question could belong to any persona depending
// on what's being investigated). Deploy/PostDeploy default to DevOps but the
// `persona` field may be set to a different persona per-instance (e.g. a
// DBA-led data backfill post-deploy) — same override, always overridable
// even for the fixed-owner types above.
export const SUBTASK_OWNER: Record<SubtaskType, Persona | null> = {
    [SubtaskType.Research]: Persona.Analyst,
    [SubtaskType.EpicReview]: Persona.Analyst, // drives the discussion; a human stakeholder co-signs (see ALWAYS_HUMAN_GATED_SUBTASKS)
    [SubtaskType.Investigate]: Persona.Analyst,
    [SubtaskType.Requirements]: Persona.Pm,
    [SubtaskType.UxDesign]: Persona.UxDesigner,
    [SubtaskType.Feasibility]: Persona.Architect,
    [SubtaskType.ArchitectureDesign]: Persona.Architect,
    [SubtaskType.DesignReview]: Persona.Architect, // 2nd pass/peer — should not be the author (soft self-review separation)
    [SubtaskType.Database]: Persona.Dba,
    [SubtaskType.Infra]: Persona.DevOps,
    [SubtaskType.Dev]: Persona.Developer,
    [SubtaskType.CodeReview]: Persona.CodeReviewer,
    [SubtaskType.IntegrationTest]: Persona.Tester,
    [SubtaskType.SystemTest]: Persona.Tester,
    [SubtaskType.E2ETest]: Persona.Tester,
    [SubtaskType.Uat]: Persona.Tester, // Tester drives; a human stakeholder co-signs (see ALWAYS_HUMAN_GATED_SUBTASKS)
    [SubtaskType.Deploy]: Persona.DevOps,
    [SubtaskType.PostDeploy]: Persona.DevOps,
    [SubtaskType.SpikeTask]: null,
    [SubtaskType.Triage]: Persona.Tester,
};

/**
 * TAI-409: the persona a new ticket gets when the creator names none (brief §5.6) --
 * `SUBTASK_OWNER[type]` for a subtask, PM for every story-level ticket and Epic. `null` only for
 * `SpikeTask`, which has no default owner and must be given one. An explicit persona always wins;
 * this is only the fallback. Applied by `WorkTracker.createIssue` on every backend.
 */
export function defaultPersonaFor(issueType: StoryType | SubtaskType | "epic"): Persona | null {
    return isSubtaskIssueType(issueType) ? SUBTASK_OWNER[issueType] : Persona.Pm;
}

// Which subtask types are valid/expected under each story type.
// A subtask type CAN appear under multiple story types (e.g. Database
// under both Spike and Story) — this is what allows DBA/DevOps work to
// roll up correctly regardless of context.
export const STORY_SUBTASK_MAP: Record<StoryType, SubtaskType[]> = {
    [StoryType.Kickoff]: [
        SubtaskType.Research,
        SubtaskType.EpicReview, // TAI-354 — human-gated per-Epic discussion/probing of Research's proposed breakdown, before Requirements/UxDesign start
        SubtaskType.Requirements,
        SubtaskType.UxDesign,
        SubtaskType.ArchitectureDesign,
        // Decided: Feasibility / Database / Infra are NOT allowed under Kickoff,
        // even for early technical-risk flagging. If discovery surfaces a
        // specific technical question, spawn a Spike story after discovery,
        // scoped to that question, rather than adding a subtask here.
    ],
    [StoryType.Spike]: [
        SubtaskType.Feasibility,
        SubtaskType.Database,
        SubtaskType.Infra,
    ],
    [StoryType.Story]: [
        SubtaskType.Investigate, // refinement — adds detail before implementation subtasks are (separately) created, brief §3.7
        SubtaskType.UxDesign, // Story-level detailing/tweaking beyond Kickoff's higher-level flows; smaller design docs scoped to this Story when Epic-level isn't the right granularity
        SubtaskType.ArchitectureDesign, // feature-level design before Dev starts, when needed
        SubtaskType.DesignReview, // optional gate on ArchitectureDesign (mirrors CodeReview); present-when-added
        SubtaskType.Dev,
        // CodeReview retired going forward (rev 52, TAI-159 ADR) — deliberately absent
        // from this "expected going forward" list. Still a legal SubtaskType/Jira issue
        // type (never removed from the enum — historical tickets like TAI-137 must stay
        // parseable), just never created for new work. See story-schema.ts's
        // SUBTASK_PRECEDENCE comment for why review readiness now lives in
        // ready.ts's readyToReview/readyToTest instead.
        SubtaskType.IntegrationTest,
        SubtaskType.SystemTest,
        SubtaskType.E2ETest,
        SubtaskType.Uat, // optional, inherently human-gated acceptance before Deploy; present-when-added
        SubtaskType.Database,
        SubtaskType.Infra,
        SubtaskType.Deploy,
        SubtaskType.PostDeploy,
        SubtaskType.SpikeTask, // ad-hoc investigation without spinning up a full Spike story
    ],
    [StoryType.Bug]: [
        SubtaskType.Triage, // entry point — replaces Research/Requirements/UxDesign for reported issues
        SubtaskType.Investigate, // refinement — rarer on a Bug (Triage usually covers it), but available
        SubtaskType.Dev,
        // CodeReview retired going forward (rev 52, TAI-159 ADR) — see the Story entry
        // above for the full rationale.
        SubtaskType.IntegrationTest,
        SubtaskType.SystemTest,
        SubtaskType.E2ETest,
        SubtaskType.Uat, // optional human-gated acceptance for user-facing fixes; present-when-added
        SubtaskType.Database,
        SubtaskType.Infra,
        SubtaskType.Deploy,
        SubtaskType.PostDeploy,
        SubtaskType.SpikeTask, // for root-cause investigation when the fix isn't obvious
    ],
};

// Subtask types that are INHERENTLY human-gated (brief §3.3): they always
// require a human sign-off and can never autocomplete, even when
// autocompletion is otherwise enabled for the persona/project — a
// human-gated checkpoint takes priority over all autocompletion settings.
export const ALWAYS_HUMAN_GATED_SUBTASKS: SubtaskType[] = [
    SubtaskType.Uat, // Tester drives the run; a human stakeholder must sign off
    SubtaskType.EpicReview, // TAI-354 — Analyst drives the discussion; a human stakeholder must sign off
];

// ---------- Story-Level Dependencies (discovered, not derivable) ----------

// These are judgment calls made by the Analyst (or others) during
// discovery — code cannot infer them, they must be captured as data.
//
// Each relation is stored ONE-directional; Jira's inverse naming
// ("blocks" / "is blocked by") is an API/display concern, not a reason
// to store both directions here.
//
// NOTE: a "CausedBy" relation (e.g. Bug caused-by Story) was considered
// and deferred — "Causes"/"is caused by" isn't a universal Jira default
// link type, and we're sticking to Jira's defaults for now. Revisit if
// a real need for it comes up and the link type is confirmed to exist.
export enum DependencyRelation {
    DependsOn = "depends-on", // from cannot start until to is done (to "blocks" from, in Jira's terms)
    RelatesTo = "relates-to", // non-blocking association, informational only
}

// Maps our semantic relation to the actual Jira Issue Link Type name.
// These are Jira's own default link types — no custom types required.
export const DEFAULT_JIRA_LINK_TYPE_NAME: Record<DependencyRelation, string> = {
    [DependencyRelation.DependsOn]: "Blocks",
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

// Defines the precedence graph per story type as its SHORTEST chain: each
// rule names a subtask's nearest prerequisite, and everything further
// upstream follows from the chain. A concrete story instance usually has
// only a subset of these subtask types present; an ABSENT type passes its
// own prerequisites through (TAI-463), so a gate is never skipped merely
// because the subtask in the middle has not been created yet.
export interface SubtaskPrecedenceRule {
    before: SubtaskType; // must be Done first
    after: SubtaskType;  // becomes workable once everything upstream of it is satisfied
}

export const SUBTASK_PRECEDENCE: Record<StoryType, SubtaskPrecedenceRule[]> = {
    [StoryType.Kickoff]: [
        { before: SubtaskType.Research, after: SubtaskType.EpicReview },
        // TAI-354: EpicReview (human-gated per-Epic discussion of Research's proposed
        // breakdown) sits between Research and Requirements/UxDesign — PRD/UX-flow work
        // shouldn't start against an epic shape that's still being probed/revised.
        { before: SubtaskType.EpicReview, after: SubtaskType.Requirements },
        { before: SubtaskType.EpicReview, after: SubtaskType.UxDesign },
        // Flows and requirements are expected to converge before the Architect
        // finalizes any design (personas/ux-designer.md) — ArchitectureDesign
        // waits on BOTH. When neither exists yet it still waits on EpicReview,
        // through them (TAI-463).
        { before: SubtaskType.Requirements, after: SubtaskType.ArchitectureDesign },
        { before: SubtaskType.UxDesign, after: SubtaskType.ArchitectureDesign },
    ],
    [StoryType.Story]: [
        // ArchitectureDesign is gated by an optional DesignReview before it
        // reaches Dev. With no DesignReview present, ArchitectureDesign gates
        // Dev through it.
        { before: SubtaskType.ArchitectureDesign, after: SubtaskType.DesignReview },
        { before: SubtaskType.DesignReview, after: SubtaskType.Dev },
        { before: SubtaskType.UxDesign, after: SubtaskType.Dev }, // Story-level detailing gates Dev, same as its sibling prerequisites
        { before: SubtaskType.Database, after: SubtaskType.Dev },
        { before: SubtaskType.Infra, after: SubtaskType.Dev },
        // rev 52 (TAI-159 ADR): CodeReview is retired going forward, so the test
        // tiers hang off Dev. `Dev` stays In Progress until its PR merges, so
        // this edge never actually fires via this static graph — readiness for
        // the tiers and UAT comes from `ready.ts`'s live-computed `readyToTest`
        // list (the linked PR's real state), not from a Jira-status fact. The
        // edge is what keeps a newly created tier from reading as "ready"
        // before there is anything to test.
        //
        // Test tiers run SEQUENTIALLY by default (D12): Integration -> System -> E2E,
        // cheapest/fastest tier first, then the optional human-gated UAT, then
        // Deploy, then PostDeploy. Whether a given tier applies to a story at all
        // is a per-instance judgment call (present-when-added); a skipped tier
        // passes its prerequisites through, so e.g. a Story with only Dev and
        // Deploy has Deploy waiting on Dev (TAI-456/TAI-463).
        { before: SubtaskType.Dev, after: SubtaskType.IntegrationTest },
        { before: SubtaskType.IntegrationTest, after: SubtaskType.SystemTest },
        { before: SubtaskType.SystemTest, after: SubtaskType.E2ETest },
        { before: SubtaskType.E2ETest, after: SubtaskType.Uat },
        { before: SubtaskType.Uat, after: SubtaskType.Deploy },
        { before: SubtaskType.Deploy, after: SubtaskType.PostDeploy },
    ],
    [StoryType.Bug]: [
        { before: SubtaskType.Triage, after: SubtaskType.Dev },
        { before: SubtaskType.Database, after: SubtaskType.Dev },
        { before: SubtaskType.Infra, after: SubtaskType.Dev },
        // Same chain as Story from Dev onward — see the Story entry above for
        // the rev 52 and TAI-463 rationale.
        { before: SubtaskType.Dev, after: SubtaskType.IntegrationTest },
        { before: SubtaskType.IntegrationTest, after: SubtaskType.SystemTest },
        { before: SubtaskType.SystemTest, after: SubtaskType.E2ETest },
        { before: SubtaskType.E2ETest, after: SubtaskType.Uat },
        { before: SubtaskType.Uat, after: SubtaskType.Deploy },
        { before: SubtaskType.Deploy, after: SubtaskType.PostDeploy },
    ],
    [StoryType.Spike]: [
        // Spike story subtasks (Feasibility/Database/Infra) are typically
        // independent investigations — no default precedence enforced.
    ],
};

// Note: the ad-hoc `SpikeTask` SUBTASK (used inside a Story/Bug) deliberately
// has no entry here, same reason it has no fixed owner — whether it
// blocks Dev or is purely informational depends on what's being
// investigated, and must be set explicitly per instance.
//
// Note: `Investigate` also deliberately has no entry here, for a different
// reason — it has a fixed owner (Analyst), but per brief §3.7, turning its
// refined output into actual implementation subtasks is a separate human/
// Orchestrator decision, not an automatic unblock. What formally marks a
// Story "ready for implementation" once Investigate is done is still open
// (brief §8.13) — this is why there's no Investigate -> Dev edge (yet).

/** Every subtask type upstream of `target` in the story type's graph, present or not. */
export function upstreamSubtaskTypes(storyType: StoryType, target: SubtaskType): Set<SubtaskType> {
    const rules = SUBTASK_PRECEDENCE[storyType];
    const seen = new Set<SubtaskType>();
    const visit = (type: SubtaskType): void => {
        for (const rule of rules) {
            if (rule.after !== type || seen.has(rule.before)) continue;
            seen.add(rule.before);
            visit(rule.before);
        }
    };
    visit(target);
    return seen;
}

// The precedence links that apply to a specific story instance's actual
// subtask set: for each present subtask, its nearest PRESENT prerequisites,
// reached through any absent types in between (TAI-463), minus any link a
// longer path between present subtasks already implies. This is what
// `link-precedence` materializes as Jira `Blocks` links.
export function resolveApplicablePrecedence(
    storyType: StoryType,
    presentSubtaskTypes: SubtaskType[]
): SubtaskPrecedenceRule[] {
    const rules = SUBTASK_PRECEDENCE[storyType];
    const present = new Set(presentSubtaskTypes);

    const nearestPresent = (type: SubtaskType, found: Set<SubtaskType>, seen: Set<SubtaskType>): Set<SubtaskType> => {
        for (const rule of rules) {
            if (rule.after !== type || seen.has(rule.before)) continue;
            seen.add(rule.before);
            if (present.has(rule.before)) found.add(rule.before);
            else nearestPresent(rule.before, found, seen);
        }
        return found;
    };

    const result: SubtaskPrecedenceRule[] = [];
    for (const after of present) {
        const candidates = [...nearestPresent(after, new Set(), new Set())];
        for (const before of candidates) {
            const impliedByAnother = candidates.some((other) => other !== before && upstreamSubtaskTypes(storyType, other).has(before));
            if (!impliedByAnother) result.push({ before, after });
        }
    }
    return result;
}

// Given the actual subtasks present on a story instance and which of
// them are currently Done, determines whether a target subtask is
// unblocked: EVERY present subtask upstream of it must be done, not only
// the nearest one (TAI-463) — so a prerequisite that was cancelled or not
// created never opens a path past an unfinished one further up. A subtask
// with nothing present upstream is a root and is always ready.
export function isSubtaskReady(
    target: SubtaskType,
    storyType: StoryType,
    presentSubtaskTypes: SubtaskType[],
    doneSubtaskTypes: Set<SubtaskType>
): boolean {
    const present = new Set(presentSubtaskTypes);
    for (const ancestor of upstreamSubtaskTypes(storyType, target)) {
        if (present.has(ancestor) && !doneSubtaskTypes.has(ancestor)) return false;
    }
    return true;
}

/**
 * TAI-373: the subtask types that are absent from a story instance but whose precedence
 * prerequisites are ALL present and finished -- i.e. work the graph now allows that nobody has
 * created yet. Unlike `isSubtaskReady` (a root with no applicable rules is always ready), a type
 * only counts here when the graph gives it at least one prerequisite and every one of them is
 * Done/Canceled: a root type such as Research, or a type whose prerequisites were never created,
 * is not "newly unblocked", it is just absent. Pure; callers decide which story types care.
 */
export function unblockedAbsentSubtaskTypes(
    storyType: StoryType,
    presentSubtaskTypes: SubtaskType[],
    doneSubtaskTypes: Set<SubtaskType>
): SubtaskType[] {
    const present = new Set(presentSubtaskTypes);
    const rules = SUBTASK_PRECEDENCE[storyType];
    const candidates = new Set<SubtaskType>();
    for (const rule of rules) {
        if (!present.has(rule.after)) candidates.add(rule.after);
    }
    return [...candidates].filter((type) =>
        rules.filter((rule) => rule.after === type).every((rule) => doneSubtaskTypes.has(rule.before))
    );
}

// ---------- D5: Bug expedited-path test-tier compression (TAI-119) ----------

/** Native Jira Priority value treated as "Priority=1 (Urgent/Emergency)" for D5's
 *  purposes — the highest of Jira Cloud's default 5-level scheme (Highest/High/Medium/
 *  Low/Lowest), confirmed live against this site (`priority = Highest` is a valid JQL
 *  value here); not a new custom field. */
export const EXPEDITED_BUG_PRIORITY = "Highest";

/**
 * D5's Bug expedited-path recommendation (`workflows/bug.md` "Expedited Path"): a
 * `Priority=1` (Urgent/Emergency) Bug compresses its test tiers down to just
 * `IntegrationTest`, skipping `SystemTest`/`E2ETest`. This is *guidance* consulted at
 * subtask-creation time (Triage) — brief's own "overridable by whoever triages" phrasing
 * only makes sense as a creation-time recommendation, not a hard resolver-level gate.
 * `SUBTASK_PRECEDENCE`/`resolveApplicablePrecedence`/`isSubtaskReady` are deliberately
 * NOT made priority-aware: "whether a given tier applies at all remains a per-instance
 * judgment call by whoever adds it" (this file's own design notes above) already handles
 * compression correctly once `SystemTest`/`E2ETest` simply aren't created — the resolver
 * doesn't need to know why a subtask type is absent.
 *
 * `CodeReview` and `Deploy`/`PostDeploy` are unaffected — they stay mandatory regardless
 * of priority and aren't test tiers at all.
 */
export function defaultTestTiersForBug(priority: string | null | undefined): readonly SubtaskType[] {
    if (priority === EXPEDITED_BUG_PRIORITY) {
        return [SubtaskType.IntegrationTest];
    }
    return [SubtaskType.IntegrationTest, SubtaskType.SystemTest, SubtaskType.E2ETest];
}

// ---------- Dynamic Subtask Insertion ----------

// Stories don't always ship with their full subtask set upfront. e.g.
// Architecture work on a Story may surface the need for a Database
// subtask partway through — one that should run IN PARALLEL with the
// still-in-progress Architecture work, while also gating Dev.
//
// The static SUBTASK_PRECEDENCE graph already models this correctly:
// there's no edge between ArchitectureDesign and Database, only
// independent edges from each into Dev — so a Database subtask added
// mid-flight naturally becomes a parallel input, not a blocker on
// Architecture. What's needed is a way to compute ONLY the new edges
// created by the insertion, without recomputing or duplicating links
// for subtasks that already exist and are already wired up.
//
// Use this any time a subtask type is added to a story after creation
// (Database discovered during Architecture, PostDeploy discovered
// during Deploy planning, etc.) — pass the story's currently-present
// subtask types BEFORE adding the new one.
export function getNewPrecedenceEdgesForInsertedSubtask(
    storyType: StoryType,
    insertedSubtaskType: SubtaskType,
    existingPresentSubtaskTypes: SubtaskType[]
): SubtaskPrecedenceRule[] {
    // The links of the story WITH the new subtask that touch it. A link the insertion makes
    // redundant (e.g. Dev -> Deploy once UAT sits between them) is left in place: harmless.
    return resolveApplicablePrecedence(storyType, [...existingPresentSubtaskTypes, insertedSubtaskType]).filter(
        (rule) => rule.before === insertedSubtaskType || rule.after === insertedSubtaskType
    );
}

// ---------- Ad-Hoc Subtask-Level Dependencies (escape hatch) ----------

// Most dynamically-inserted subtasks are already covered by the static
// template via getNewPrecedenceEdgesForInsertedSubtask above (e.g. the
// Database/Architecture/Dev case). This is the escape hatch for the
// rarer case where a subtask discovered mid-flight needs a relationship
// the template genuinely doesn't define — same pattern as StoryRef /
// StoryDependency, but at subtask granularity.
export interface SubtaskRef {
    jiraKey?: string;
    localId?: string; // for a subtask being created in the same batch as its dependency
}

export interface SubtaskDependencyOverride {
    from: SubtaskRef;
    relation: DependencyRelation;
    to: SubtaskRef;
    note: string; // required — explain why this falls outside the standard template
}

export interface ReviewGate {
    storyType: StoryType;
    requiredReviewers: Persona[];
    description: string;
}

// Sign-off for any gate here is tracked via an `Approved:`-prefixed Jira comment from
// each of requiredReviewers — no custom field. The commenting human must additionally
// appear in that persona's Persona Roster entry (brief §5.6, rev 12) — this is what lets
// TAI verify a raw Jira comment author actually corresponds to "the PM" or "the UX
// Designer", not just trusting the comment's content. An edit to the Confluence doc(s) backing an
// already-passed gate REOPENS it (brief §6) — detected via the same cachedAt/lastUpdated
// staleness check used everywhere else (brief §3.6/§7), not a separate mechanism. See
// design-notes doc "Review-gate approval tracking" and workflows/kickoff.md.
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
 * RESOLVED (kept for history — see workflows/kickoff.md and workflows/bug.md
 * for the fuller writeups):
 * - Kickoff review gate stays fixed at PM + UX Designer always; Architect is
 *   never added, even when ArchitectureDesign was used.
 * - Feasibility / Database / Infra are locked out of Kickoff entirely — a
 *   technical question during discovery spawns a Spike story after discovery
 *   instead (see STORY_SUBTASK_MAP[Kickoff]).
 * - A Bug story never requires a Kickoff-style review gate, regardless of
 *   product/UX impact — Triage sign-off by Tester alone is always sufficient
 *   to proceed to Dev.
 * - Kickoff-stage ArchitectureDesign stays ungated (no DesignReview under
 *   Kickoff) — it's early/exploratory technical input, not a committed
 *   design. Real design rigor (with DesignReview) applies later, once the
 *   Story exists (see STORY_SUBTASK_MAP[Kickoff] / [Story]).
 * - Severe/hotfix Bug expedited path (D5): a Bug with native Jira Priority=1
 *   (Urgent/Emergency) compresses its test tiers down to just IntegrationTest
 *   (SystemTest/E2ETest skipped, overridable by whoever triages) — CodeReview
 *   and Deploy/PostDeploy stay mandatory regardless of priority. Uses the
 *   existing Priority field, not a new custom severity field. **Implemented
 *   (TAI-119):** `defaultTestTiersForBug()` below — guidance consulted at
 *   subtask-creation time (Triage), not a resolver-level gate; the D12
 *   sequential ordering means "skip SystemTest/E2ETest" already just means
 *   not creating those subtasks, so `SUBTASK_PRECEDENCE`/
 *   `resolveApplicablePrecedence`/`isSubtaskReady` needed no changes.
 * - Test tiers (D12): IntegrationTest -> SystemTest -> E2ETest run
 *   SEQUENTIALLY by default, cheapest/fastest tier first, not in parallel off
 *   CodeReview as originally modeled. Whether a given tier applies to a
 *   Story/Bug at all remains a per-instance judgment call by whoever adds it
 *   (same present-when-added pattern as DesignReview/UAT/Database/Infra) — no
 *   formal rule engine decides tier applicability. See SUBTASK_PRECEDENCE
 *   [Story]/[Bug] and workflows/dependencies.md.
 * - PostDeploy failure handling (D7): NOT a new Rollback subtask/action type.
 *   A major/showstopper failure reopens the existing Deploy subtask to In
 *   Progress — DevOps executes the rollback plan that's already part of
 *   Deploy's own `deploy-runbook` output, same "reopen, don't invent a new
 *   artifact" pattern as the Dev<->Test and ArchitectureDesign<->DesignReview
 *   loops. A minor failure doesn't touch Deploy/PostDeploy status at all — it
 *   spawns a linked Bug, DevOps proposes/drafts it and PM confirms/creates it
 *   (mirrors the propose/create split already used for Spike outcomes and
 *   Ada's decomposition). See workflows/story.md, personas/devops.md.
 * - The two-axis owner model (D15, brief §5.6): every Story-level ticket and
 *   every Subtask carries a stored `persona` field, separate from the native
 *   Jira Assignee — defaulting to SUBTASK_OWNER[type] (subtasks) or PM
 *   (story-level), always overridable, and set explicitly at creation with NO
 *   default for the ad-hoc SpikeTask subtask (same as it has no default human
 *   Assignee either). A STORED field, not derived from Persona Roster
 *   membership (brief §5.6, rev 12), because a human can be listed under
 *   more than one relevant persona. This
 *   resolves both the ad-hoc SpikeTask subtask's "what persona drives it" question
 *   and PostDeploy's "how does default-owner-with-override relate to human
 *   Assignee" question — both were previously open TODOs here, now settled.
 *
 * TODO / OPEN — see the design-notes doc for active discussion on these:
 * 1. UAT failure is human-adjudicated — a rejected UAT may be an implementation
 *    bug (route back to Dev, In Progress) OR an acceptance-criteria gap, so it
 *    deliberately does NOT use the automatic single-retry loop used for
 *    automated test failures. A rejected UAT CAN reopen a Requirements task, not
 *    only Dev; the trigger/authority mechanism falls out of the persona-capability
 *    design (what each persona may do or cause) and is settled there.
 *
 * RESOLVED (D9, added to history above): output taxonomy — what each
 * story/subtask type produces — is intentionally NOT formalized as a schema
 * construct (no OutputType enum). Every type's output is already documented
 * in prose (each persona's confluenceOutputs front-matter, each workflow
 * doc's Output section, Spike's variable-outcome handling). Nothing consumes
 * "what kind of output is this" programmatically yet (no storage plugin, no
 * reporting layer — still Phase 0/1); adding a construct now would be a
 * second source of truth alongside the front-matter, with the same drift
 * risk just fixed for the PostDeploy/D15 note above. Revisit once the
 * storage plugin or a reporting need actually requires querying this in
 * code (brief §9 Phase 3+).
 */