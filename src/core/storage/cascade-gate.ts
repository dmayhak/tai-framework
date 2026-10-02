/**
 * TAI Framework — parent-status cascade gate for WorkTracker.transition() (TAI-220/221/222,
 * extended TAI-247/266 with the downward/terminal counterpart)
 *
 * UPWARD (TAI-220/221/222): when a Subtask starts real work (transitions into In Progress or
 * In Review), its parent Story should genuinely move to In Progress in Jira too -- not just
 * via the existing read-time Epic derivation (brief §5.3, ready.ts), which never writes
 * anything. Same one level up, Story to Epic. Decided in full (ADR, Confluence page 29753345,
 * linked to TAI-221/222):
 *
 * - Real writes, parent-first, best-effort (a rejected parent-cascade transition never
 *   blocks the child's own transition).
 * - `shouldCascadeTransitionParent` does double duty as both the idempotency check (a
 *   parent already In Progress/In Review is left alone) and the never-regress guard (a
 *   Done parent is never moved backward) -- both collapse to the same one rule: only a
 *   ToDo/Backlog parent is eligible.
 *
 * DOWNWARD (TAI-247 ADR, Confluence page 30900225, implemented TAI-267): when a
 * parent Story/Bug/Epic reaches Done/Canceled, its own open children (and grandchildren) get
 * cascade-canceled -- the terminal counterpart to the upward cascade, motivated by TAI-133
 * sitting open under an already-Done TAI-132 for a day with zero signal. Same best-effort
 * posture, but runs AFTER the parent's own transition already succeeded (not before) --
 * canceling children on behalf of a close that itself got rejected would be a real bug, the
 * reverse of the upward cascade's "parent-first" ordering.
 *
 * BOTH directions: the actual walk mechanism is recursion through `WorkTracker.transition()`
 * itself (see each backend's own `transition()`), not implemented here -- this module is pure
 * logic, no I/O, same posture as `assignment-gate.ts`/`review-gate.ts`. Deliberately NOT a
 * single shared orchestration function either (TAI-247 ADR's own Consequences are explicit
 * about this) -- each backend duplicates its own walk around these shared predicates, same
 * shape the upward cascade already established.
 */

import { Status, StoryType, type SubtaskType } from "../schema/story-schema.js";

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

/**
 * TAI-374/387 (ADR page 47349832 rev 4): the ONE upward-cascade rule both backends apply, replacing
 * the earlier pair of predicates for the In Progress case and adding the To Do case.
 *
 * Returns the status to write on `parent` because `child` just moved to `target`, or `null` for no
 * cascade.
 *
 * - **Started** (`In Progress`/`In Review`): a Backlog or To Do parent becomes `In Progress` -- the
 *   existing TAI-220/221/222 behavior; a parent already started, Done or Canceled is left alone.
 * - **Scheduled** (`To Do`): a BACKLOG parent becomes `To Do`, so the board never shows a Backlog
 *   Story with scheduled subtasks, nor a Backlog Epic with scheduled Stories. Only a Backlog parent
 *   moves: a parent already To Do or later is left alone, so this can never regress anything.
 * - **The one exception, for both cascades:** a Kickoff Story never moves its parent Epic. An epic's
 *   Kickoff is refinement, not building: an Epic in Backlog may have its Kickoff in progress, and
 *   the Epic only becomes To Do when it is approved to build. A subtask of a Kickoff still moves the
 *   Kickoff itself.
 *
 * Pure logic, no I/O, like the other predicates here.
 */
export function upwardCascadeTarget(
    child: { readonly issueType: StoryType | SubtaskType | "epic" },
    parent: { readonly issueType: StoryType | SubtaskType | "epic"; readonly status: Status },
    target: Status
): Status | null {
    if (child.issueType === StoryType.Kickoff && parent.issueType === "epic") return null;
    if (cascadeTriggersOn(target)) {
        return shouldCascadeTransitionParent(parent.status) ? Status.InProgress : null;
    }
    if (target === Status.ToDo) {
        return parent.status === Status.Backlog ? Status.ToDo : null;
    }
    return null;
}

/** True if `target` is a status that should trigger the downward/terminal cascade (TAI-247
 *  ADR decision #1) -- either terminal status closes the loop on open children, not just
 *  Done; a Canceled parent shouldn't leave its children dangling any more than a Done one. */
export function cascadeTriggersOnClose(target: Status): boolean {
    return target === Status.Done || target === Status.Canceled;
}

/** True if `childStatus` is eligible for the cascade-cancel write -- any NON-terminal status.
 *  A child already Done or Canceled is left exactly as it is (idempotency: re-closing an
 *  already-closed parent doesn't touch a child a second time; and a child that finished
 *  legitimately before the parent closed must never be regressed to Canceled). */
export function shouldCascadeCancelChild(childStatus: Status): boolean {
    return childStatus !== Status.Done && childStatus !== Status.Canceled;
}
