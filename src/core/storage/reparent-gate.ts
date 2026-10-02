/**
 * TAI Framework — re-parent validity gate for `updateIssue({ parentKey })` (TAI-372/379)
 *
 * A SINGLE shared implementation imported by every backend's `updateIssue`, same posture as
 * `duplicate-subtask-gate.ts`/`assignment-gate.ts`: one copy, so the Jira and filesystem
 * backends can't drift apart on what a legal re-parent is.
 *
 * Decided (human, 2026-10-02, on TAI-372):
 * - Only Stories/Bugs move, and only under an Epic. A subtask is rejected outright --
 *   precedence links and the one-subtask-per-type duplicate guard both depend on the parent,
 *   so moving one silently would break them. It can still be moved in the Jira UI.
 * - No new permission gate; this is validity, not authorization.
 */

import { isSubtaskIssueType } from "../schema/story-schema.js";
import type { Issue } from "./interface.js";

/** A rejection reason, or `null` when moving `issue` under `newParent` is legal. `newParent`
 *  is `null` when the caller looked it up and found nothing. */
export function reparentViolation(issue: Issue, newParent: Issue | null): string | null {
    if (isSubtaskIssueType(issue.issueType)) {
        return (
            `Cannot re-parent ${issue.key}: it is a ${issue.issueType} subtask, and a subtask's parent ` +
            `drives its precedence links and one-per-type guard. Move it in the Jira UI if you really mean to.`
        );
    }
    if (issue.issueType === "epic") {
        return `Cannot re-parent ${issue.key}: an Epic has no parent.`;
    }
    if (newParent === null) {
        return `Cannot re-parent ${issue.key}: the new parent was not found.`;
    }
    if (newParent.issueType !== "epic") {
        return `Cannot re-parent ${issue.key} under ${newParent.key}: the new parent must be an Epic, not a ${newParent.issueType}.`;
    }
    if (newParent.projectKey !== issue.projectKey) {
        return `Cannot re-parent ${issue.key} under ${newParent.key}: it must be in the same project (${issue.projectKey}).`;
    }
    return null;
}
