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

import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import type { Comment, Issue, IssueKey, WorkTracker } from "./interface.js";

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

/**
 * The Stories and Bugs among `issues` that are ready to verify (TAI-546, TAI-548, TAI-550): a Dev subtask exists, every
 * non-canceled one is Done, and there is no `Verified:` / `Not verified:` comment. One copy, used by `/tai-ready` and
 * `/tai-groom`, so the two lists cannot disagree. One read of each candidate's Dev subtasks.
 */
export async function findNotVerified(
    workTracker: Pick<WorkTracker, "search">,
    projectKey: string,
    issues: readonly Issue[]
): Promise<Set<IssueKey>> {
    const notVerified = new Set<IssueKey>();
    for (const issue of issues) {
        if (issue.issueType !== StoryType.Story && issue.issueType !== StoryType.Bug) continue;
        if (hasVerification(issue.comments)) continue;
        const devs = (await workTracker.search({ projectKey, parentKey: issue.key, issueTypes: [SubtaskType.Dev], exhaustive: true })).filter(
            (d) => d.status !== Status.Canceled
        );
        if (devs.length > 0 && devs.every((d) => d.status === Status.Done)) notVerified.add(issue.key);
    }
    return notVerified;
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
