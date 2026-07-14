/**
 * TAI Framework — brief §5.5's "no unassigned work in progress" gate
 *
 * A SINGLE shared implementation, imported by every backend's `transition`/`assignIssue`/
 * `updateIssue`. Brief §5.5 says the gate is "enforced... in the storage plugin's transition
 * operation" — meaning every backend's, not a rule each one hand-copies.
 *
 * REGRESSION this module fixes (TAI-15 code review, found twice):
 * 1. The gate originally existed only inside jira/work-tracker.ts; filesystem-backend.ts's
 *    transition() had no equivalent check at all, so an unassigned issue could reach
 *    In Progress on the filesystem backend while the identical call was correctly rejected
 *    on Jira — a behavioral divergence types can't catch, caught by the conformance suite.
 * 2. Once both backends had their OWN copy of the fix, the two rejection-message strings had
 *    already drifted apart (the Jira version carried an extra clause the filesystem version
 *    lacked) — concrete, realized evidence that "keep two copies in sync by hand" doesn't
 *    work. This module is the fix: one copy, both backends import it.
 *
 * The gate has two directions, both covered here:
 * - ENTRY: transition() may not move an issue INTO In Progress/In Review without an assignee.
 * - EXIT: assignIssue()/updateIssue() may not clear the assignee while an issue is ALREADY in
 *   In Progress/In Review. Only the entry side existed originally — nothing stopped stripping
 *   the assignee back off an issue already there, reaching the same forbidden state from the
 *   other direction.
 * Terminal states (Done/Canceled) are exempt from both directions: once work has stopped, an
 * owner no longer matters.
 */

import { Status, type Status as StatusType } from "../schema/story-schema.js";
import type { HumanRef, IssueKey } from "./interface.js";

/** True if `status` is a gated (non-terminal, non-To-Do) status and `nextAssignee` is null. */
export function violatesAssignmentGate(status: StatusType, nextAssignee: HumanRef | null): boolean {
    return (status === Status.InProgress || status === Status.InReview) && nextAssignee === null;
}

/** Entry-side: rejecting a transition INTO a gated status with no assignee. */
export function entryGateReason(key: IssueKey, target: StatusType): string {
    return `${key} has no Assignee. A ticket must be assigned to a human before it can move to "${target}" (brief §5.5). Assign it, or let the assignment-helper surface candidates for its persona.`;
}

/** Exit-side: rejecting an attempt to clear the assignee while already in a gated status. */
export function exitGateReason(key: IssueKey, status: StatusType): string {
    return `${key} is "${status}" and has no Assignee. A ticket may not be unassigned while in a non-terminal, non-To-Do status (brief §5.5).`;
}
