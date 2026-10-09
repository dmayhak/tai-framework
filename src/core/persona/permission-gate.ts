/**
 * TAI Framework — persona action-permission predicates (TAI-51 ADR decision 3)
 *
 * Pure functions over `PersonaConfig` + `Issue`, no I/O — same "pure decision function,
 * caller wires it up" shape as `autocompletion.ts`/`review-gate.ts`. These answer "what may
 * persona X itself do", the axis orthogonal to `Roster` (`persona/roster.ts`, TAI-14), which
 * answers "which humans may act as persona X."
 *
 * `canWorkOn`/`canComplete`/`canCreate` all return `false` for a disabled persona
 * as defense-in-depth — the loader is expected not to hand out a disabled persona's config at
 * all, but a caller that already holds one (e.g. a stale reference) still gets denied here,
 * not just upstream.
 *
 * Deliberately NOT implemented here: `cannotApprove`/self-approval enforcement. Brief §4 is
 * explicit that this is currently a soft default, not a hard lock ("a solo developer
 * legitimately reviews their own work") — out of scope for this Story, same as it's out of
 * scope for `review-gate.ts` today.
 */

import { StoryType, type SubtaskType } from "../schema/story-schema.js";
import type { Issue } from "../storage/interface.js";
import type { PersonaConfig, PermissionTarget, GitHostAction } from "./config.js";

const STORY_TYPES: ReadonlySet<string> = new Set(Object.values(StoryType));

function targetForIssueType(issueType: StoryType | SubtaskType | "epic"): PermissionTarget {
    if (issueType === "epic" || STORY_TYPES.has(issueType)) {
        return { kind: "issue", issueType: issueType as StoryType | "epic" };
    }
    return { kind: "subtask", subtaskType: issueType as SubtaskType };
}

function includesTarget(list: readonly PermissionTarget[], target: PermissionTarget): boolean {
    return list.some((t) => {
        if (t.kind !== target.kind) return false;
        return t.kind === "issue" && target.kind === "issue"
            ? t.issueType === target.issueType
            : t.kind === "subtask" && target.kind === "subtask" && t.subtaskType === target.subtaskType;
    });
}

/** May `config`'s persona create an issue of `issueType`? Checked at `WorkTracker.createIssue`
 *  time (via `PersonaScopedWorkTracker`), before the issue exists — hence a bare `issueType`
 *  rather than an `Issue`. */
export function canCreate(config: PersonaConfig, issueType: StoryType | SubtaskType | "epic"): boolean {
    if (!config.enabled) return false;
    return includesTarget(config.permissions.create, targetForIssueType(issueType));
}

/** Should `config`'s persona even be invoked for `issue` right now? Checked once, before a
 *  persona turn begins (TAI-8's invocation entry point) — not a `WorkTracker` mutation gate,
 *  hence a plain predicate rather than something `PersonaScopedWorkTracker` enforces. */
export function canWorkOn(config: PersonaConfig, issue: Pick<Issue, "issueType">): boolean {
    if (!config.enabled) return false;
    return includesTarget(config.permissions.workOn, targetForIssueType(issue.issueType));
}

/** May `config`'s persona complete (transition to a terminal-for-that-type status) `issue`? */
export function canComplete(config: PersonaConfig, issue: Pick<Issue, "issueType">): boolean {
    if (!config.enabled) return false;
    return includesTarget(config.permissions.complete, targetForIssueType(issue.issueType));
}

/**
 * May `config`'s persona update `field` on an issue of `entityType` (e.g. "Story",
 * "implementationNotes")? Deliberately decoupled from `IssuePatch`'s current field set —
 * several grants here (`Story.implementationNotes`, `Bug.reproSteps`, ...) name fields
 * `IssuePatch` (`storage/interface.ts`) doesn't yet expose. Reconciling that gap is a
 * separate, pre-existing concern this Story doesn't take on.
 */
/** May `config`'s persona perform `action` on `GitHost` (TAI-33/34 ADRs — create/review/merge
 *  a PR)? Checked by `PersonaScopedGitHost` (TAI-73), the git-hosting sibling of
 *  `PersonaScopedWorkTracker`, before delegating each gated method. */
export function canPerformGitAction(config: PersonaConfig, action: GitHostAction): boolean {
    if (!config.enabled) return false;
    return config.permissions.gitHost.includes(action);
}

/**
 * TAI-478 (human decision TAI-455): the note the CLI prints when the acting persona creates or closes
 * something its doc grants it no `create`/`complete` for. A note, never a refusal: the command has
 * already gone ahead. `null` when the grant covers it. The create wording allows for the one
 * legitimate case, a subtask a persona creates because it knows in context that it is needed
 * (`workflows/dependencies.md`, eager subtask creation).
 */
export function grantNote(config: PersonaConfig, action: "create" | "complete", issueType: StoryType | SubtaskType | "epic"): string | null {
    const covered = action === "create" ? canCreate(config, issueType) : canComplete(config, { issueType });
    if (covered) return null;
    const who = config.displayName === config.id ? config.id : `${config.displayName} (${config.id})`;
    const tail =
        action === "create"
            ? "If this persona knows in context that the ticket is needed, that is allowed; otherwise it was probably another persona's to create."
            : "Check that closing it was this persona's to do. A human-gated item, and an Epic, is closed only when the human says so.";
    return `Note: ${who} has no \`${action}\` grant for "${issueType}" (personas/${config.id}.md). The command went ahead. ${tail}`;
}
