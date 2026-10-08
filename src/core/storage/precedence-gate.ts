/**
 * TAI Framework — subtask precedence gate for WorkTracker.transition() (TAI-476)
 *
 * `SUBTASK_PRECEDENCE` used to decide only what `/tai-ready` lists; nothing stopped a blocked
 * subtask being started. This is the gate: starting a subtask (moving it into In Progress or
 * In Review) is refused while a present sibling upstream of it is still open.
 *
 * A SINGLE shared implementation, imported by every backend's `transition()` — same "one copy,
 * both backends import it" discipline as assignment-gate.ts and review-gate.ts. Pure logic, no
 * I/O: the backend supplies the parent and the siblings.
 *
 * Deliberately the same type-level reading `/tai-ready` uses (`loadParentPrecedenceContext`,
 * ready.ts): a type counts as done once any sibling of that type is Done or Canceled, so a
 * subtask `/tai-ready` lists as ready is never refused here.
 *
 * ONE rule differs from the static graph (human decision on TAI-476): a test tier or UAT may
 * start once `Dev` has STARTED. `Dev` stays In Progress until its PR merges and testing happens
 * before the merge, so requiring `Dev` to be Done would refuse every test tier.
 *
 * The gate can be overridden per call (`TransitionOptions.overridePrecedence`, interface.ts); the backend then
 * leaves `precedenceOverrideComment` on the ticket so the bypass is visible.
 */

import { Status, SubtaskType, isStoryIssueType, isSubtaskIssueType, isSubtaskReady, upstreamSubtaskTypes } from "../schema/story-schema.js";
import type { Issue, IssueKey } from "./interface.js";

const STARTED: ReadonlySet<Status> = new Set([Status.InProgress, Status.InReview]);
const FINISHED: ReadonlySet<Status> = new Set([Status.Done, Status.Canceled]);
const STARTS_ONCE_DEV_HAS: ReadonlySet<string> = new Set([
    SubtaskType.IntegrationTest,
    SubtaskType.SystemTest,
    SubtaskType.E2ETest,
    SubtaskType.Uat,
]);

/** True if moving `issue` to `target` is STARTING a subtask. Resuming one that is already
 *  In Progress/In Review is not gated (precedence gates offering new work, not resuming it). */
export function precedenceGateApplies(issue: Pick<Issue, "issueType" | "status" | "parentKey">, target: Status): boolean {
    return isSubtaskIssueType(issue.issueType) && issue.parentKey !== null && STARTED.has(target) && !STARTED.has(issue.status);
}

/** The open siblings that must finish before `issue` may start. Empty when it may start. */
export function openPrerequisites(issue: Issue, parent: Pick<Issue, "issueType">, siblings: readonly Issue[]): readonly Issue[] {
    if (!isSubtaskIssueType(issue.issueType) || !isStoryIssueType(parent.issueType)) return [];
    const subtasks = siblings.filter((s) => s.key !== issue.key && isSubtaskIssueType(s.issueType));
    const present = [issue.issueType, ...subtasks.map((s) => s.issueType as SubtaskType)];
    const done = new Set(subtasks.filter((s) => FINISHED.has(s.status)).map((s) => s.issueType as SubtaskType));
    if (STARTS_ONCE_DEV_HAS.has(issue.issueType) && subtasks.some((s) => s.issueType === SubtaskType.Dev && STARTED.has(s.status))) {
        done.add(SubtaskType.Dev);
    }
    if (isSubtaskReady(issue.issueType, parent.issueType, present, done)) return [];

    const upstream = upstreamSubtaskTypes(parent.issueType, issue.issueType);
    return subtasks.filter((s) => upstream.has(s.issueType as SubtaskType) && !done.has(s.issueType as SubtaskType) && !FINISHED.has(s.status));
}

function describe(open: readonly Issue[]): string {
    return open.map((s) => `${s.key} (${s.issueType}, ${s.status})`).join(", ");
}

export function precedenceGateReason(key: IssueKey, target: Status, open: readonly Issue[]): string {
    return (
        `${key} cannot move to "${target}" yet: it waits on ${describe(open)} (subtask precedence, workflows/dependencies.md). ` +
        `Finish or cancel ${open.length === 1 ? "that subtask" : "those subtasks"} first. To start it anyway, ` +
        `the human may override: issue transition ${key} "${target}" force=true (a comment records the bypass).`
    );
}

/** The comment a backend leaves on the ticket when the gate was overridden. Jira wiki markup:
 *  a blank line is a paragraph break. */
export function precedenceOverrideComment(target: Status, open: readonly Issue[]): string {
    return `Precedence override: moved to "${target}" while ${describe(open)} ${open.length === 1 ? "was" : "were"} still open.\n\nRecorded by TAI.`;
}
