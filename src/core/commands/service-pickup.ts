/**
 * TAI Framework — the pickup rule of the unattended Dev service (Epic TAI-763, Story TAI-773, Dev subtask TAI-777).
 *
 * The service runs as the same Jira user as the person, so an In Progress Dev subtask looks the same whether the service paused it on
 * a usage limit or the person started it by hand. In the service mode `do-dev-tasks` resumes an In Progress ticket only when it is
 * plainly the service's own: its newest comment is the usage-limit pause note, and nothing has been committed to its branch from
 * outside the clone since. Every other In Progress ticket is left alone, with the reason. A person's own `do-dev-tasks` run does not use this.
 */

import type { WorkTracker } from "../storage/interface.js";
import { Status } from "../schema/story-schema.js";
import type { Issue } from "../storage/interface.js";
import { newestCommentIsOwnPause } from "./usage-limit.js";

export interface ServicePickupDeps {
    readonly workTracker: Pick<WorkTracker, "getIssue">;
    /** Whether `branch` on origin has commits beyond `commit` (see `branchHasCommitsBeyond`); null when it cannot be told. */
    readonly branchHasCommitsBeyond: (branch: string, commit: string) => Promise<boolean | null>;
}

/** Why the service must leave this In Progress ticket alone; null when it is the service's own paused ticket and may be resumed. */
export async function servicePickupReason(deps: ServicePickupDeps, issue: Pick<Issue, "key">): Promise<string | null> {
    const fresh = await deps.workTracker.getIssue(issue.key);
    if (!fresh) return "it cannot be read, so it is not known to be the service's";
    const note = newestCommentIsOwnPause(fresh.comments);
    if (!note.ok) return note.reason;
    const at = note.position ? /^(.+)@([0-9a-f]+)$/.exec(note.position) : null;
    if (!at) return "its pause note records no checkout position, so it cannot be told whether a person has committed since";
    const beyond = await deps.branchHasCommitsBeyond(at[1]!, at[2]!);
    if (beyond === true) return `a commit on ${at[1]} came from outside the service's clone after the pause, so a person is working it`;
    if (beyond === null) return `its recorded position (${note.position}) is not in this clone, so it cannot be told whether a person has committed since`;
    return null;
}

/**
 * A To Do ticket's status read again just before the run starts it: a person may have started it by hand since the search.
 * Returns why it must be skipped, or null when it is still To Do.
 */
export async function stillToDoReason(workTracker: Pick<WorkTracker, "getIssue">, issue: Pick<Issue, "key">): Promise<string | null> {
    const fresh = await workTracker.getIssue(issue.key);
    if (!fresh) return "it cannot be read, so it is not known to still be To Do";
    return fresh.status === Status.ToDo ? null : `it is no longer To Do (it is ${fresh.status}), so a person has started it`;
}
