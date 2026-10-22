/**
 * TAI-601/602: a Done design subtask with nothing implementing it.
 *
 * A `Database` or `ArchitectureDesign` subtask that is Done while no `Dev` subtask exists under its Story, or
 * under any Story of that Story's Epic, leaves the next step invisible: `/tai-ready` reads tickets only, so a
 * comment or a Confluence page never surfaces it (found in the homeschooling project, 2026-10-22). One copy of the
 * check, used by `/tai-ready` and the `/tai-audit` pattern, so the two cannot disagree. Read-only.
 *
 * A Story that is itself Done or Canceled is skipped: it is history, and listing it would nag forever.
 */

import { Status, SubtaskType } from "../schema/story-schema.js";
import type { Issue, IssueKey, WorkTracker } from "./interface.js";

/** The heading `/tai-ready` prints this list under; the `/tai-audit` check tells the reader to look for it. */
export const DESIGN_WITHOUT_DEV_HEADING = "Design done, nothing implements it";

export interface DesignWithoutDev {
    /** The Done `Database` / `ArchitectureDesign` subtask. */
    readonly design: Issue;
    /** The Story or Bug it belongs to, still open. */
    readonly story: Issue;
}

const DESIGN_TYPES = [SubtaskType.Database, SubtaskType.ArchitectureDesign] as const;

export async function findDesignWithoutDev(
    workTracker: Pick<WorkTracker, "search" | "getIssue">,
    projectKey: string
): Promise<readonly DesignWithoutDev[]> {
    const designs = await workTracker.search({ projectKey, issueTypes: [...DESIGN_TYPES], statuses: [Status.Done], exhaustive: true });
    if (designs.length === 0) return [];

    const devs = await workTracker.search({ projectKey, issueTypes: [SubtaskType.Dev], exhaustive: true });
    const hasDev = new Set<IssueKey>(devs.filter((d) => d.status !== Status.Canceled && d.parentKey).map((d) => d.parentKey!));

    const epicHasDev = new Map<IssueKey, boolean>();
    const found: DesignWithoutDev[] = [];
    for (const design of designs) {
        if (!design.parentKey || hasDev.has(design.parentKey)) continue;
        const story = await workTracker.getIssue(design.parentKey);
        if (!story || story.status === Status.Done || story.status === Status.Canceled) continue;
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
