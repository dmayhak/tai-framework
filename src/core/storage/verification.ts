/**
 * TAI Framework — the `Verified:` / `Not verified:` comment (brief §3.9; TAI-468, TAI-546)
 *
 * Tessa checks a Story's finished work against its numbered acceptance criteria (`verify <STORY-KEY>`)
 * and posts one stamped comment on the Story. Its FIRST line opens with `Verified:` when every
 * criterion is met, or `Not verified:` when any is not. `/tai-ready` and the close warning only look
 * for either marker; which one it is, and the per-criterion evidence, are for the human to read.
 *
 * A later Dev commit does not invalidate an earlier comment (decided 2026-10-13): showing, never blocking.
 */

import { StoryType } from "../schema/story-schema.js";
import type { Comment, Issue } from "./interface.js";

const VERIFICATION_MARKER = /^\s*(?:Not\s+verified|Verified)\s*:/i;

/** One numbered acceptance criterion line: `AC-1 …`, as a list item or bold (TAI-472). Shared with grooming. */
export const ACCEPTANCE_CRITERION_LINE = /^[\s>*_\-•]*(?:\*\*|__)?AC-\d+\b/m;

/** True if `body`'s FIRST line opens with either marker — same first-line rule as every other marker. */
export function isVerification(body: string): boolean {
    return VERIFICATION_MARKER.test(body.split("\n", 1)[0] ?? "");
}

/** True when any comment is a verification. */
export function hasVerification(comments: readonly Comment[]): boolean {
    return comments.some((c) => isVerification(c.body));
}

/** The numbered acceptance-criterion lines of a description, in order, each trimmed. */
export function acceptanceCriteria(description: string | undefined): string[] {
    if (!description) return [];
    return description
        .split("\n")
        .filter((line) => ACCEPTANCE_CRITERION_LINE.test(line))
        .map((line) => line.trim());
}

/** The most recent verification comment, or null. `comments` is oldest first. */
export function latestVerification(comments: readonly Comment[]): Comment | null {
    for (let i = comments.length - 1; i >= 0; i--) {
        if (isVerification(comments[i]!.body)) return comments[i]!;
    }
    return null;
}

/**
 * The note printed when a Story or Bug is closed with no verification comment, or `null`. Show-only:
 * the close has already happened (TAI-468, human decision 2026-10-13: nothing blocks).
 */
export function unverifiedCloseNote(issue: Pick<Issue, "key" | "issueType" | "comments">): string | null {
    if (issue.issueType !== StoryType.Story && issue.issueType !== StoryType.Bug) return null;
    if (hasVerification(issue.comments)) return null;
    return `Not verified: ${issue.key} has no Verified: or Not verified: comment. Run \`verify ${issue.key}\` to check its finished work against its acceptance criteria.`;
}
