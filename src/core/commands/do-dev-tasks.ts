/**
 * TAI Framework — "Do all dev tasks" (TAI-633, Story TAI-628; ADR page 64782337 decision 8).
 *
 * Takes every In Progress and To Do `Dev` subtask assigned to the current user, on Stories and Bugs, and works through
 * them one at a time. Each ticket gets its own run, so one failing leaves a hand-off on that ticket and the rest go on.
 * With `dev-yolo` off a run builds the change, opens the PR and records the check, and leaves review and merge to people.
 * With it on the ticket goes to the full run (TAI-634), which this module only calls through `yoloRun`.
 *
 * Pure orchestration: the work tracker is read here, and everything that touches a shell, the git host or Claude is a
 * dependency, so the order, the skips and the reporting are tested without any of them.
 */

import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { sameHuman } from "../personas/roster.js";
import type { HumanRef, Issue, IssueKey, WorkTracker } from "../storage/interface.js";
import { openPrerequisites } from "../storage/precedence-gate.js";
import { findOpenDependsOnBlockers, priorityRank } from "./ready.js";

export interface DevTask {
    readonly issue: Issue;
    readonly parent: Issue;
}

export interface SkippedDevTask {
    readonly issue: Issue;
    readonly reason: string;
}

export interface FoundDevTasks {
    readonly tasks: readonly DevTask[];
    readonly skipped: readonly SkippedDevTask[];
}

export interface FindDevTasksDeps {
    readonly workTracker: WorkTracker;
    readonly projectKey: string;
    readonly currentHuman: HumanRef | null;
}

/**
 * The current user's In Progress and To Do `Dev` subtasks, most urgent first, and the ones left out with the reason.
 * A To Do subtask that precedence still holds is skipped (an In Progress one has started, so precedence no longer
 * gates it), and so is any whose Story, or itself, has an open `DependsOn` blocker.
 */
export async function findDevTasks(deps: FindDevTasksDeps): Promise<FoundDevTasks> {
    if (!deps.currentHuman) {
        throw new Error("No user is configured for this session (TAI_JIRA_EMAIL, or TAI_HUMAN_EMAIL on the filesystem backend), so there is no one whose Dev tasks to do.");
    }
    const me = deps.currentHuman;
    const candidates = await deps.workTracker.search({
        projectKey: deps.projectKey,
        statuses: [Status.ToDo, Status.InProgress],
        exhaustive: true,
    });
    const mine = candidates.filter((i) => i.issueType === SubtaskType.Dev && i.assignee !== null && sameHuman(i.assignee, me));

    const tasks: DevTask[] = [];
    const skipped: SkippedDevTask[] = [];
    const siblingsOf = new Map<IssueKey, readonly Issue[]>();
    for (const issue of mine) {
        if (!issue.parentKey) {
            skipped.push({ issue, reason: "it has no parent Story or Bug" });
            continue;
        }
        const parent = await deps.workTracker.getIssue(issue.parentKey);
        if (!parent || (parent.issueType !== StoryType.Story && parent.issueType !== StoryType.Bug)) {
            skipped.push({ issue, reason: `its parent ${issue.parentKey} is not a Story or a Bug` });
            continue;
        }
        if (issue.status === Status.ToDo) {
            let siblings = siblingsOf.get(parent.key);
            if (!siblings) {
                siblings = await deps.workTracker.search({ projectKey: deps.projectKey, parentKey: parent.key, exhaustive: true });
                siblingsOf.set(parent.key, siblings);
            }
            const open = openPrerequisites(issue, parent, siblings);
            if (open.length > 0) {
                skipped.push({ issue, reason: `precedence holds it until ${open.map((s) => `${s.key} (${s.issueType}, ${s.status})`).join(", ")} is done` });
                continue;
            }
        }
        const blockers = [...(await findOpenDependsOnBlockers(deps.workTracker, issue)), ...(await findOpenDependsOnBlockers(deps.workTracker, parent))];
        if (blockers.length > 0) {
            skipped.push({ issue, reason: `${[...new Set(blockers)].join(", ")} must finish first (DependsOn)` });
            continue;
        }
        tasks.push({ issue: issue.priority !== undefined ? issue : { ...issue, priority: parent.priority }, parent });
    }
    tasks.sort((a, b) => priorityRank(a.issue.priority) - priorityRank(b.issue.priority) || a.issue.key.localeCompare(b.issue.key));
    return { tasks, skipped };
}

export type DevTaskOutcome =
    | { readonly state: "pr-opened"; readonly prUrl: string; readonly checkRecorded: boolean | null }
    | { readonly state: "handed-on"; readonly note: string }
    | { readonly state: "waiting"; readonly reason: string }
    | { readonly state: "failed"; readonly reason: string };

export interface RunDevTasksDeps {
    /** Called before each ticket: the working tree must be clean and on the default branch. Throws to fail the ticket. */
    readonly prepare: (task: DevTask) => Promise<void>;
    /** Runs the build for one ticket (`dev-yolo` off). `ok: false` fails the ticket. */
    readonly build: (task: DevTask) => Promise<{ readonly ok: boolean; readonly summary: string }>;
    /** What the build left: the open PR for the ticket, and whether a check result is on its head commit. */
    readonly inspect: (task: DevTask) => Promise<{ readonly prUrl: string | null; readonly checkRecorded: boolean | null }>;
    /** The full unattended run (`dev-yolo` on), when this version has one. */
    readonly yoloRun?: (task: DevTask) => Promise<DevTaskOutcome>;
    /** Posts the ticket's `Handoff:` comment. */
    readonly handoff: (key: IssueKey, body: string) => Promise<void>;
    readonly yolo: boolean;
}

export interface DevTaskResult {
    readonly task: DevTask;
    readonly outcome: DevTaskOutcome;
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function failureHandoff(reason: string): string {
    return (
        `Handoff: "Do all dev tasks" stopped on this ticket. ${reason}\n\n` +
        "Nothing was reviewed, merged or closed. Next: read the reason, fix what it names, and run the ticket again with /tai-work, or put it right by hand."
    );
}

/** Works through `tasks` one at a time. One ticket failing never stops the others. */
export async function runDevTasks(tasks: readonly DevTask[], deps: RunDevTasksDeps): Promise<readonly DevTaskResult[]> {
    const results: DevTaskResult[] = [];
    for (const task of tasks) {
        let outcome: DevTaskOutcome;
        try {
            await deps.prepare(task);
            if (deps.yolo) {
                outcome = deps.yoloRun
                    ? await deps.yoloRun(task)
                    : { state: "waiting", reason: "DEV-YOLO is on, but the full unattended run is not in this version (TAI-634), so nothing was built" };
            } else {
                const built = await deps.build(task);
                if (!built.ok) throw new Error(built.summary);
                const found = await deps.inspect(task);
                if (!found.prUrl) throw new Error("The run finished but no open PR for this ticket was found.");
                outcome = { state: "pr-opened", prUrl: found.prUrl, checkRecorded: found.checkRecorded };
            }
        } catch (err) {
            const reason = errorText(err);
            outcome = { state: "failed", reason };
            try {
                await deps.handoff(task.issue.key, failureHandoff(reason));
            } catch (handoffErr) {
                outcome = { state: "failed", reason: `${reason} (and the hand-off comment could not be posted: ${errorText(handoffErr)})` };
            }
        }
        results.push({ task, outcome });
    }
    return results;
}

function line(issue: Issue): string {
    return `**${issue.key}** ${issue.summary}`;
}

export function renderDevTasksReport(found: FoundDevTasks, results: readonly DevTaskResult[] | null, options: { readonly yolo: boolean }): string {
    const out = ["# Do all dev tasks", "", `DEV-YOLO is ${options.yolo ? "on" : "off"}.`, ""];
    if (results === null) {
        out.push(`## Would work (${found.tasks.length})`, "");
        out.push(...(found.tasks.length ? found.tasks.map((t) => `- ${line(t.issue)} [${t.issue.status}] under ${t.parent.key}`) : ["None."]));
    } else {
        const opened = results.filter((r) => r.outcome.state === "pr-opened");
        const failed = results.filter((r) => r.outcome.state === "failed");
        const other = results.filter((r) => r.outcome.state === "waiting" || r.outcome.state === "handed-on");
        out.push(`## Done (${opened.length})`, "");
        out.push(
            ...(opened.length
                ? opened.map((r) => {
                      const o = r.outcome as Extract<DevTaskOutcome, { state: "pr-opened" }>;
                      const check = o.checkRecorded === null ? "check not looked up" : o.checkRecorded ? "check recorded" : "no check result on the PR";
                      return `- ${line(r.task.issue)}: PR opened, ${check} — ${o.prUrl}`;
                  })
                : ["None."])
        );
        out.push("", `## Failed (${failed.length})`, "");
        out.push(...(failed.length ? failed.map((r) => `- ${line(r.task.issue)}: ${(r.outcome as { reason: string }).reason} (hand-off left on the ticket)`) : ["None."]));
        if (other.length) {
            out.push("", `## Not run (${other.length})`, "");
            out.push(...other.map((r) => `- ${line(r.task.issue)}: ${r.outcome.state === "waiting" ? r.outcome.reason : (r.outcome as { note: string }).note}`));
        }
        const waiting = opened.map((r) => r.task.issue.key);
        out.push("", "## Waiting for a person", "");
        out.push(...(waiting.length ? [`- Review, approval and merge of the PRs for ${waiting.join(", ")}.`] : ["Nothing."]));
    }
    out.push("", `## Skipped (${found.skipped.length})`, "");
    out.push(...(found.skipped.length ? found.skipped.map((s) => `- ${line(s.issue)}: ${s.reason}`) : ["None."]));
    return out.join("\n");
}
