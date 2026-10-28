/**
 * TAI Framework — "Do all dev tasks" (TAI-633, Story TAI-628; ADR page 64782337 decision 8).
 *
 * Takes every In Progress and To Do `Dev` subtask assigned to the current user, on Stories and Bugs, and works through
 * them one at a time. Each ticket gets its own run, so one failing leaves a hand-off on that ticket and the rest go on.
 * With `dev-yolo` off a run builds the change, opens the PR and records the check, and leaves review and merge to people.
 * With it on the ticket goes to the unattended run (`dev-yolo.ts`), which this module only calls through `yoloRun`.
 *
 * Pure orchestration: the work tracker is read here, and everything that touches a shell, the git host or Claude is a
 * dependency, so the order, the skips and the reporting are tested without any of them.
 */

import { CHECK_STATUS_KEY } from "../git/local-check.js";
import { Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { DirtyTreeError, PrepareStopError } from "./dev-tasks-git.js";
import { sameHuman } from "../personas/roster.js";
import type { GitHost, PullRequestRef, RepoId } from "../git/interface.js";
import type { HumanRef, Issue, IssueKey, WorkTracker } from "../storage/interface.js";
import { openPrerequisites } from "../storage/precedence-gate.js";
import { findOpenDependsOnBlockers, priorityRank } from "./ready.js";

/**
 * Does a PR title name `key` as the ticket it is for? The project's title is `TAI-<STORY> - TAI-<SUBTASK> - what changed`
 * (`validatePrTitle`), so the key must open one of the first two slots, as a whole key: TAI-10 is not TAI-100, and a key
 * that only appears later in the words ("fix the TAI-10 regression") does not count.
 */
export function titleNamesKey(title: string, key: string): boolean {
    const safe = key.replace(/[^A-Za-z0-9-]/g, "");
    return title
        .split(" - ")
        .slice(0, 2)
        .some((slot) => new RegExp(`^\\s*${safe}(?![A-Za-z0-9])`).test(slot));
}

export type OpenPullRequests = ReadonlyMap<RepoId, readonly PullRequestRef[]>;

/** Every open PR in `repos`, listed once so a look at many tickets asks the git host once and not once per ticket. */
export async function listOpenPullRequests(gitHost: Pick<GitHost, "listPullRequests">, repos: readonly RepoId[]): Promise<OpenPullRequests> {
    const listed = new Map<RepoId, readonly PullRequestRef[]>();
    for (const repo of repos) listed.set(repo, await gitHost.listPullRequests(repo, "open"));
    return listed;
}

/** The git host's side of "does this ticket have a PR": the open PR whose title names the Dev key, and its check result. */
export async function findOpenPullRequest(
    gitHost: Pick<GitHost, "listPullRequests" | "getCommitStatuses">,
    repos: readonly RepoId[],
    key: string,
    options: { readonly checkConfigured: boolean; readonly listed?: OpenPullRequests }
): Promise<{ readonly prUrl: string | null; readonly checkRecorded: boolean | null }> {
    const listed = options.listed ?? (await listOpenPullRequests(gitHost, repos));
    for (const [repo, prs] of listed) {
        const open = prs.find((pr) => titleNamesKey(pr.title, key));
        if (!open) continue;
        const statuses = options.checkConfigured ? await gitHost.getCommitStatuses(repo, open.sourceCommit) : null;
        return { prUrl: open.url, checkRecorded: statuses === null ? null : statuses.some((st) => st.key === CHECK_STATUS_KEY) };
    }
    return { prUrl: null, checkRecorded: null };
}

export interface DevTask {
    readonly issue: Issue;
    readonly parent: Issue;
}

export interface SkippedDevTask {
    readonly issue: Issue;
    readonly reason: string;
    /** The tickets it waits on, so the report can say when one of them is a ticket this run worked. */
    readonly waitingOn?: readonly IssueKey[];
}

export interface FoundDevTasks {
    readonly tasks: readonly DevTask[];
    readonly skipped: readonly SkippedDevTask[];
}

export interface FindDevTasksDeps {
    readonly workTracker: WorkTracker;
    readonly projectKey: string;
    readonly currentHuman: HumanRef | null;
    /** Called once at the start of each look; returns the open PR URL for a ticket, when it has one. A ticket with its PR
     *  already open is waiting for review and is not built again. */
    readonly openPullRequests?: () => Promise<(issue: Issue) => string | null>;
    /** `only=<KEY>` (TAI-695): work this one ticket. Every other ticket is listed as skipped, "not selected". */
    readonly only?: IssueKey;
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
    const openPrFor = deps.openPullRequests ? await deps.openPullRequests() : null;
    const mine = candidates.filter((i) => i.issueType === SubtaskType.Dev && i.assignee !== null && sameHuman(i.assignee, me));

    const tasks: DevTask[] = [];
    const skipped: SkippedDevTask[] = [];
    const siblingsOf = new Map<IssueKey, readonly Issue[]>();
    for (const issue of mine) {
        if (deps.only && issue.key !== deps.only) {
            skipped.push({ issue, reason: `not selected (only=${deps.only})` });
            continue;
        }
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
                skipped.push({ issue, reason: `precedence holds it until ${open.map((s) => `${s.key} (${s.issueType}, ${s.status})`).join(", ")} is done`, waitingOn: open.map((s) => s.key) });
                continue;
            }
        }
        const openPr = openPrFor ? openPrFor(issue) : null;
        if (openPr) {
            skipped.push({ issue, reason: `it has an open PR, so this command leaves it to review, merge or rework by a person (it does not pick up a PR sent back for changes): ${openPr}` });
            continue;
        }
        const blockers = [...(await findOpenDependsOnBlockers(deps.workTracker, issue)), ...(await findOpenDependsOnBlockers(deps.workTracker, parent))];
        if (blockers.length > 0) {
            const waitingOn = [...new Set(blockers)];
            skipped.push({ issue, reason: `${waitingOn.join(", ")} must finish first (DependsOn)`, waitingOn });
            continue;
        }
        tasks.push({ issue: issue.priority !== undefined ? issue : { ...issue, priority: parent.priority }, parent });
    }
    tasks.sort((a, b) => priorityRank(a.issue.priority) - priorityRank(b.issue.priority) || a.issue.key.localeCompare(b.issue.key));
    return { tasks, skipped };
}

/**
 * Why `only=<KEY>` cannot be worked (TAI-695), or null when `found` has it to work. Run on the first look, before anything starts:
 * the ticket is not found, is not a Dev subtask, is not assigned to the person or is not To Do or In Progress, or `findDevTasks`
 * skipped it (precedence, a blocker, an open PR) and says why.
 */
export async function onlyRefusal(found: FoundDevTasks, only: IssueKey, deps: Pick<FindDevTasksDeps, "workTracker" | "currentHuman">): Promise<string | null> {
    if (found.tasks.some((t) => t.issue.key === only)) return null;
    const skipped = found.skipped.find((s) => s.issue.key === only);
    if (skipped) return `${only} cannot be worked now: ${skipped.reason}.`;
    const issue = await deps.workTracker.getIssue(only);
    if (!issue) return `${only} was not found.`;
    if (issue.issueType !== SubtaskType.Dev) return `${only} is a ${issue.issueType}, not a Dev subtask.`;
    if (!issue.assignee || !deps.currentHuman || !sameHuman(issue.assignee, deps.currentHuman)) return `${only} is not assigned to you.`;
    return `${only} is ${issue.status}; only an In Progress or To Do Dev subtask can be worked.`;
}

export type DevTaskOutcome =
    | { readonly state: "pr-opened"; readonly prUrl: string; readonly checkRecorded: boolean | null }
    | { readonly state: "handed-on"; readonly note: string }
    | { readonly state: "waiting"; readonly reason: string }
    | { readonly state: "failed"; readonly reason: string }
    | { readonly state: "stopped"; readonly reason: string; readonly dirtyTree?: boolean };

export interface RunDevTasksDeps {
    /** Called before each ticket: the working tree must be clean and on the default branch. Throws to fail the ticket. */
    readonly prepare: (task: DevTask) => Promise<void>;
    /** Runs the build for one ticket (`dev-yolo` off). `ok: false` fails the ticket. */
    readonly build: (task: DevTask) => Promise<{ readonly ok: boolean; readonly summary: string }>;
    /** What the build left: the open PR for the ticket, and whether a check result is on its head commit. */
    readonly inspect: (task: DevTask) => Promise<{ readonly prUrl: string | null; readonly checkRecorded: boolean | null }>;
    /** The full unattended run (`dev-yolo` on), when this version has one. */
    readonly yoloRun?: (task: DevTask) => Promise<DevTaskOutcome>;
    /** Why a ticket needs a person even with `dev-yolo` on (empty when it may run). Asked before anything is prepared or built. */
    readonly yoloGate?: (task: DevTask) => Promise<readonly string[]>;
    /** Posts the ticket's `Handoff:` comment. */
    readonly handoff: (key: IssueKey, body: string) => Promise<void>;
    readonly yolo: boolean;
    /** True once the command has been interrupted: nothing new is looked up, prepared or started. */
    readonly interrupted?: () => boolean;
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

/** Runs one ticket. It never throws: a failure becomes a `failed` outcome with a hand-off comment on the ticket. */
export async function runDevTask(task: DevTask, deps: RunDevTasksDeps): Promise<DevTaskResult> {
    let outcome: DevTaskOutcome;
    try {
        if (deps.yolo && deps.yoloGate) {
            const reasons = await deps.yoloGate(task);
            if (reasons.length > 0) {
                const reason = `needs a person: ${reasons.join("; ")}`;
                await deps.handoff(task.issue.key, `Handoff: DEV-YOLO did not start on this ticket. ${reason}.\n\nNothing was built, reviewed, merged or closed. Next: put right what is named, or do the ticket by hand.`);
                return { task, outcome: { state: "waiting", reason } };
            }
        }
        try {
            // Until the full run exists (TAI-634), DEV-YOLO on builds nothing, so it does not move the person's checkout either.
            if (!(deps.yolo && !deps.yoloRun)) await deps.prepare(task);
        } catch (err) {
            // A dirty tree or a branch that will not update is not this ticket's fault: it is not marked failed and gets no hand-off (workDevTasks stops the run).
            if (err instanceof PrepareStopError) return { task, outcome: { state: "stopped", reason: err.message, dirtyTree: err instanceof DirtyTreeError } };
            throw err;
        }
        if (deps.yolo) {
            outcome = deps.yoloRun
                ? await deps.yoloRun(task)
                : { state: "waiting", reason: "DEV-YOLO is on, but the full unattended run is not in this version (TAI-634), so nothing was built" };
        } else {
            const built = await deps.build(task);
            if (!built.ok) throw new Error(built.summary);
            const found = await deps.inspect(task);
            if (!found.prUrl) throw new Error(noPrReason(built.summary));
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
    return { task, outcome };
}

/** What a run that exited cleanly left behind when it opened no PR: the end of its own output, on one line, says why it stopped. */
export function noPrDetail(runOutput: string): string {
    const tail = runOutput.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" / ");
    return tail === "" ? "no open PR for this ticket was found." : `no open PR for this ticket was found. The end of the run's output: ${tail}`;
}

/** The failure reason for that run. */
export function noPrReason(runOutput: string): string {
    return `The run finished but ${noPrDetail(runOutput)}`;
}

export interface WorkedDevTasks {
    readonly results: readonly DevTaskResult[];
    /** What `find` last returned: the tickets still held back once the run is over, with what each waits on. */
    readonly found: FoundDevTasks;
}

/**
 * Works the tickets one at a time and looks again after each. A ticket that one of ours unblocks (its blocker finished
 * while this run was going) was skipped at the start but is found by the next look, so it is not dropped. A ticket is
 * attempted once per run, so a failed one is never retried in a loop and one whose PR is still open is not rebuilt.
 */
export async function workDevTasks(find: () => Promise<FoundDevTasks>, deps: RunDevTasksDeps, firstLook?: FoundDevTasks): Promise<WorkedDevTasks> {
    const attempted = new Set<IssueKey>();
    const results: DevTaskResult[] = [];
    let pending = firstLook;
    let last: FoundDevTasks = firstLook ?? { tasks: [], skipped: [] };
    for (;;) {
        // An interrupt ends the run with what it has: no new look, which would only add calls on the way out.
        if (deps.interrupted?.()) return { results, found: last };
        const found = pending ?? (await find());
        pending = undefined;
        last = found;
        const next = found.tasks.find((t) => !attempted.has(t.issue.key));
        if (!next) return { results, found };
        attempted.add(next.issue.key);
        const result = await runDevTask(next, deps);
        results.push(result);
        if (result.outcome.state === "stopped") {
            // Do not go on to fail the rest. A dirty tree is the previous ticket's run's doing, so say so on that ticket,
            // keeping the reason it already failed for (one current Handoff: per ticket); a branch that will not update is not.
            const previous = results.length > 1 ? results[results.length - 2]! : null;
            if (previous && result.outcome.dirtyTree) {
                const earlier = previous.outcome.state === "failed" ? `${previous.outcome.reason} ` : "";
                // Only a ticket that failed gets a replacement Handoff:. One that opened its PR, or whose own run left a hand-off, keeps it: the note is a plain comment.
                const note = `Its run also left uncommitted changes in the working tree, so "Do all dev tasks" stopped before the next ticket. ${result.outcome.reason}`;
                try {
                    await deps.handoff(previous.task.issue.key, previous.outcome.state === "failed" ? failureHandoff(`${earlier}${note}`) : `Note: ${note}\n\nThe outcome recorded for this ticket is unaffected.`);
                } catch {
                    // the report below still says it
                }
            }
            return { results, found };
        }
    }
}

function line(issue: Issue): string {
    return `**${issue.key}** ${issue.summary}`;
}

function waitingNote(skipped: SkippedDevTask, worked: ReadonlySet<IssueKey>): string {
    const mine = (skipped.waitingOn ?? []).filter((k) => worked.has(k));
    return mine.length ? ` Waiting on ${mine.join(", ")}, which this run worked on: it starts once that is merged and done.` : "";
}

export function renderDevTasksReport(found: FoundDevTasks, results: readonly DevTaskResult[] | null, options: { readonly yolo: boolean; readonly openPullRequestsChecked?: boolean; readonly yoloThisRunOnly?: boolean; readonly only?: IssueKey }): string {
    const worked = new Set((results ?? []).flatMap((r) => [r.task.issue.key, r.task.parent.key]));
    const out = ["# Do all dev tasks", "", `DEV-YOLO is ${options.yolo ? "on" : "off"}${options.yoloThisRunOnly ? " for this run only (yolo=" + options.yolo + "); the stored setting is unchanged" : ""}.`, ""];
    if (options.only) out.push(`Only ${options.only} was selected (only=${options.only}); every other ticket is listed under Skipped as not selected.`, "");
    if (results === null) {
        if (options.openPullRequestsChecked === false) {
            out.push("_The git host is not configured here, so a ticket that already has an open PR could not be left out of this list._", "");
        }
        out.push(`## Would work (${found.tasks.length})`, "");
        out.push(...(found.tasks.length ? found.tasks.map((t) => `- ${line(t.issue)} [${t.issue.status}] under ${t.parent.key}`) : ["None."]));
    } else {
        const allOpened = results.filter((r) => r.outcome.state === "pr-opened");
        const noCheck = allOpened.filter((r) => (r.outcome as Extract<DevTaskOutcome, { state: "pr-opened" }>).checkRecorded === false);
        const opened = allOpened.filter((r) => !noCheck.includes(r));
        const failed = results.filter((r) => r.outcome.state === "failed");
        const finished = results.filter((r) => r.outcome.state === "handed-on");
        const waitingOnPerson = results.filter((r) => r.outcome.state === "waiting");
        out.push(`## Done (${opened.length + finished.length})`, "");
        const doneLines = [
            ...opened.map((r) => {
                const o = r.outcome as Extract<DevTaskOutcome, { state: "pr-opened" }>;
                const check = o.checkRecorded === null ? "check not looked up" : o.checkRecorded ? "check recorded" : "no check result on the PR";
                return `- ${line(r.task.issue)}: PR opened, ${check} — ${o.prUrl}`;
            }),
            ...finished.map((r) => `- ${line(r.task.issue)}: ${(r.outcome as { note: string }).note}`),
        ];
        out.push(...(doneLines.length ? doneLines : ["None."]));
        if (noCheck.length) {
            out.push("", `## PR opened, no check result (${noCheck.length})`, "");
            out.push(...noCheck.map((r) => `- ${line(r.task.issue)}: ${(r.outcome as { prUrl: string }).prUrl} — the run did not record its check, so the merge gate will not pass until it is run`));
        }
        out.push("", `## Failed (${failed.length})`, "");
        out.push(...(failed.length ? failed.map((r) => `- ${line(r.task.issue)}: ${(r.outcome as { reason: string }).reason} (hand-off left on the ticket)`) : ["None."]));
        const stopped = results.filter((r) => r.outcome.state === "stopped");
        if (stopped.length) {
            out.push("", "## Stopped", "");
            out.push(...stopped.map((r) => `- Before ${r.task.issue.key}: ${(r.outcome as { reason: string }).reason}`));
        }
        const waiting = allOpened.map((r) => r.task.issue.key);
        out.push("", "## Waiting for a person", "");
        const waitingLines = [
            ...(waiting.length ? [`- Review, approval and merge of the PRs for ${waiting.join(", ")}.`] : []),
            ...waitingOnPerson.map((r) => `- ${line(r.task.issue)}: ${(r.outcome as { reason: string }).reason}`),
        ];
        out.push(...(waitingLines.length ? waitingLines : ["Nothing."]));
    }
    // A ticket this run worked is listed above; the look after it skips it for its now-open PR, which is not news.
    const ran = new Set((results ?? []).map((r) => r.task.issue.key));
    const skipped = found.skipped.filter((s) => !ran.has(s.issue.key));
    out.push("", `## Skipped (${skipped.length})`, "");
    out.push(...(skipped.length ? skipped.map((s) => `- ${line(s.issue)}: ${s.reason}.${waitingNote(s, worked)}`) : ["None."]));
    return out.join("\n");
}

/**
 * The command's arguments: `dryrun=true`, `yolo=true` or `yolo=false` for this run only (TAI-693), and `only=<DEV-KEY>` to work one
 * ticket (TAI-695). Anything else is refused, because a mistyped flag must not start real builds. After `rules` (which prints a rule set
 * and runs nothing) only `yolo=` is taken, and `only=` is accepted and has no effect, since the set does not depend on the ticket.
 */
export function parseDevTasksArgs(
    args: readonly (string | undefined)[],
    options: { readonly rules?: boolean } = {}
): { readonly dryRun: boolean; readonly yolo?: boolean; readonly only?: IssueKey } {
    const given = args.filter((a): a is string => a !== undefined && a !== "");
    const known = options.rules ? ["yolo=true", "yolo=false"] : ["dryrun=true", "yolo=true", "yolo=false"];
    const onlyArgs = given.filter((a) => a.startsWith("only="));
    const unknown = given.filter((a) => !known.includes(a) && !a.startsWith("only="));
    if (unknown.length > 0) {
        throw new Error(
            `do-dev-tasks ${options.rules ? "rules takes only yolo=true, yolo=false and only=<DEV-KEY>" : "takes only dryrun=true, yolo=true, yolo=false and only=<DEV-KEY>"} (got: ${unknown.join(" ")}).`
        );
    }
    if (onlyArgs.length > 1) throw new Error(`do-dev-tasks takes only one only=<DEV-KEY> (got: ${onlyArgs.join(" ")}).`);
    let only: IssueKey | undefined;
    if (onlyArgs.length === 1) {
        const value = onlyArgs[0]!.slice("only=".length);
        if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(value)) throw new Error(`only= takes one ticket key such as TAI-12 (got: ${value === "" ? "nothing" : value}).`);
        only = value as IssueKey;
    }
    const wantsOn = given.includes("yolo=true");
    const wantsOff = given.includes("yolo=false");
    if (wantsOn && wantsOff) throw new Error("do-dev-tasks takes yolo=true or yolo=false, not both.");
    let yolo: boolean | undefined;
    if (wantsOn) yolo = true;
    else if (wantsOff) yolo = false;
    return { dryRun: given.includes("dryrun=true"), ...(yolo === undefined ? {} : { yolo }), ...(only === undefined ? {} : { only }) };
}

/**
 * Whether DEV-YOLO is on for this run (TAI-693): the `yolo=` argument when given, otherwise the stored setting. The argument wins in
 * both directions and is never written back; the setting is read only when no argument is given. `oneRun` is `yolo=true`, the case
 * that has to pass the guards the setting does.
 */
export async function resolveYolo(arg: boolean | undefined, stored: () => Promise<boolean>): Promise<{ readonly yolo: boolean; readonly oneRun: boolean; readonly thisRunOnly: boolean }> {
    return { yolo: arg ?? (await stored()), oneRun: arg === true, thisRunOnly: arg !== undefined };
}
