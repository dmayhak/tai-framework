/**
 * TAI Framework — parent-status cascade gate for WorkTracker.transition() (TAI-220/221/222)
 *
 * When a Subtask starts real work (transitions into In Progress or In Review), its parent
 * Story should genuinely move to In Progress in Jira too -- not just via the existing
 * read-time Epic derivation (brief §5.3, ready.ts), which never writes anything. Same one
 * level up, Story to Epic. Decided in full (ADR, Confluence page 29753345, linked to
 * TAI-221/222):
 *
 * - Real writes, parent-first, best-effort (a rejected parent-cascade transition never
 *   blocks the child's own transition).
 * - `shouldCascadeTransitionParent` does double duty as both the idempotency check (a
 *   parent already In Progress/In Review is left alone) and the never-regress guard (a
 *   Done parent is never moved backward) -- both collapse to the same one rule: only a
 *   ToDo/Backlog parent is eligible.
 * - The actual walk-up mechanism is recursion through `WorkTracker.transition()` itself
 *   (see each backend's own `transition()`), not implemented here -- this module is pure
 *   logic, no I/O, same posture as `assignment-gate.ts`/`review-gate.ts`.
 */

import { Status } from "../schema/story-schema.js";

/** True if `target` is a status that should trigger the parent cascade -- only the two
 *  "work has started" statuses. Done/ToDo/Backlog/Canceled never cascade. */
export function cascadeTriggersOn(target: Status): boolean {
    return target === Status.InProgress || target === Status.InReview;
}

/** True if `parentStatus` is eligible for the cascade write. Only ToDo/Backlog -- a parent
 *  already at In Progress/In Review is idempotently skipped, and a Done parent is never
 *  regressed backward just because a child started (brief §5.3's existing Epic-derivation
 *  asymmetry, extended here to a real write). */
export function shouldCascadeTransitionParent(parentStatus: Status): boolean {
    return parentStatus === Status.ToDo || parentStatus === Status.Backlog;
}
