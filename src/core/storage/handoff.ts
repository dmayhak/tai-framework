/**
 * TAI Framework — the `Handoff:` comment (brief §3.9; TAI-489, deciding TAI-460)
 *
 * One living hand-off comment per ticket: what is done, what is in flight, the next step and
 * the assumptions made, written by whoever stops with the ticket still In Progress. It replaces
 * the never-written work journal and status file as the way a later session picks the work up,
 * and lives on the ticket so a human and every host see the same thing. The briefing shows it
 * first (`workspace/briefing.ts`, TAI-464).
 *
 * "One, edited in place" is a rule with no judgment in it, so it is kept by the code rather
 * than left to each persona: posting a hand-off through `postIssueComment` replaces the
 * ticket's latest one. Older `Handoff:` comments from before this rule are left alone.
 *
 * Kept apart from `comment-markers.ts`: those markers are scanned to decide gates and hints;
 * this one is only ever shown.
 */

import type { Comment, IssueKey, WorkTracker } from "./interface.js";

const HANDOFF_MARKER = /^\s*Handoff\s*:/i;

/** True if `body`'s FIRST line opens with the marker — same first-line rule as every other marker. */
export function isHandoff(body: string): boolean {
    return HANDOFF_MARKER.test(body.split("\n", 1)[0] ?? "");
}

/** The most recently created hand-off comment, or null. `comments` is oldest first. */
export function latestHandoff(comments: readonly Comment[]): Comment | null {
    for (let i = comments.length - 1; i >= 0; i--) {
        const comment = comments[i]!;
        if (isHandoff(comment.body)) return comment;
    }
    return null;
}

export interface PostIssueCommentResult {
    readonly comment: Comment;
    /** True when an existing hand-off comment was edited rather than a new comment added. */
    readonly replaced: boolean;
    /** Why the existing hand-off could not be edited (so a new one was added), when that happened. */
    readonly editFailure?: string;
}

/**
 * Posts `body` on `key`. A hand-off replaces the ticket's latest hand-off comment; anything
 * else, and a ticket's first hand-off, is added. If the old hand-off cannot be edited (on Jira,
 * typically because another account wrote it) the new one is added instead and the reason is
 * returned — a hand-off that is not saved is worse than two of them.
 */
export async function postIssueComment(
    workTracker: Pick<WorkTracker, "getIssue" | "addComment" | "editComment">,
    key: IssueKey,
    body: string
): Promise<PostIssueCommentResult> {
    if (!isHandoff(body)) return { comment: await workTracker.addComment(key, body), replaced: false };

    const issue = await workTracker.getIssue(key);
    if (!issue) throw new Error(`${key}: no such issue.`);
    const existing = latestHandoff(issue.comments);
    if (!existing) return { comment: await workTracker.addComment(key, body), replaced: false };

    try {
        return { comment: await workTracker.editComment(key, existing.id, body), replaced: true };
    } catch (error) {
        const editFailure = error instanceof Error ? error.message : String(error);
        return { comment: await workTracker.addComment(key, body), replaced: false, editFailure };
    }
}
