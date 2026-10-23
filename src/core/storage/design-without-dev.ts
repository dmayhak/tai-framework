/**
 * TAI-601/602: a Done design subtask with nothing implementing it.
 *
 * A `Database`, `ArchitectureDesign` or `UxDesign` subtask that is Done while no `Dev` subtask exists under its Story, or
 * under any Story of that Story's Epic, leaves the next step invisible: `/tai-ready` reads tickets only, so a
 * comment or a Confluence page never surfaces it (found in a real target project, 2026-10-22). One copy of the
 * check, used by `/tai-ready` and the `/tai-audit` pattern, so the two cannot disagree. Read-only.
 *
 * A Story that is itself Done or Canceled is skipped: it is history, and listing it would nag forever. A design
 * subtask carrying a `No Dev needed:` comment (a decision-only ADR, say) is skipped too: that is the dismissal.
 */

import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import type { Comment, Issue, IssueKey, WorkTracker } from "./interface.js";

/** The heading `/tai-ready` prints this list under; the `/tai-audit` check tells the reader to look for it. */
export const DESIGN_WITHOUT_DEV_HEADING = "Design done, nothing implements it";

export interface DesignWithoutDev {
    /** The Done `Database` / `ArchitectureDesign` / `UxDesign` subtask. */
    readonly design: Issue;
    /** The Story or Bug it belongs to, still open. */
    readonly story: Issue;
}

const DESIGN_TYPES = [SubtaskType.Database, SubtaskType.ArchitectureDesign, SubtaskType.UxDesign] as const;

const OPEN_STATUSES = [Status.Backlog, Status.ToDo, Status.InProgress, Status.InReview] as const;

const DISMISSAL_MARKER = /^\s*No\s+Dev\s+needed\s*:/i;

/** True when a comment's FIRST line opens with `No Dev needed:`: the dismissal, followed by the reason. */
export function isDevDismissal(comments: readonly Comment[]): boolean {
    return comments.some((c) => DISMISSAL_MARKER.test(c.body.split("\n", 1)[0] ?? ""));
}

export async function findDesignWithoutDev(
    workTracker: Pick<WorkTracker, "search">,
    projectKey: string
): Promise<readonly DesignWithoutDev[]> {
    const designs = (await workTracker.search({ projectKey, issueTypes: [...DESIGN_TYPES], statuses: [Status.Done], exhaustive: true })).filter(
        (d) => !isDevDismissal(d.comments)
    );
    if (designs.length === 0) return [];

    // One search for the open Stories and Bugs replaces a read per design subtask: the cost follows open work,
    // not the project's whole design history.
    const openStories = new Map<IssueKey, Issue>(
        (await workTracker.search({ projectKey, issueTypes: [StoryType.Story, StoryType.Bug], statuses: [...OPEN_STATUSES], exhaustive: true })).map((s) => [s.key, s])
    );
    const candidates = designs.filter((d) => d.parentKey && openStories.has(d.parentKey));
    if (candidates.length === 0) return [];

    const devs = await workTracker.search({ projectKey, issueTypes: [SubtaskType.Dev], exhaustive: true });
    const hasDev = new Set<IssueKey>(devs.filter((d) => d.status !== Status.Canceled && d.parentKey).map((d) => d.parentKey!));

    const epicHasDev = new Map<IssueKey, boolean>();
    const found: DesignWithoutDev[] = [];
    for (const design of candidates) {
        const story = openStories.get(design.parentKey!)!;
        if (hasDev.has(story.key)) continue;
        if (story.parentKey) {
            let covered = epicHasDev.get(story.parentKey);
            if (covered === undefined) {
                const siblings = await workTracker.search({ projectKey, parentKey: story.parentKey, exhaustive: true });
                covered = siblings.some((s) => hasDev.has(s.key));
                epicHasDev.set(story.parentKey, covered);
            }
            if (covered) continue;
        }
        found.push({ design, story });
    }
    return found;
}
