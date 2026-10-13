/**
 * TAI Framework — the grooming briefing (TAI-389/395; ADR Confluence page 48463873, rev 5)
 *
 * `/tai-groom` loads Perry (PM) with this computed, READ-ONLY view of the board so a grooming conversation is
 * about the board as a whole and needs no ticket (decision 1). It composes reads the work tracker already
 * offers, like `findReadyWork`, and changes nothing; every Backlog -> To Do move, epic approval, flag/unflag,
 * Cancel and assignment is something Perry PROPOSES and the human confirms (decision 3).
 *
 * Sections (decision 2, numbered 1-8 when rendered): (a) epics with nothing under them, (b) Backlog Kickoff
 * Stories awaiting sequencing, (c) Backlog tickets with no open blocker (TAI-472: a Story, Bug or Spike with readiness warnings), (d) flagged tickets,
 * (e) approved epics with nothing scheduled, (f) Backlog tickets untouched past the stale threshold, (g) tickets
 * TAI cannot read (unmapped Jira type, decision 13), (h) tickets that need an assignee (decision 14). TAI-373's
 * unblocked-but-uncreated Kickoff subtasks shipped as a `/tai-ready` section instead ("Subtasks ready to create"),
 * not a ninth section here.
 *
 * Sections (d) and (f) have no search filter to lean on (no flagged filter; `updatedSince` only means "since"),
 * so they read every open ticket once, exhaustively, and filter in memory (ADR Consequences).
 */

import { DependencyRelation, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { findClarificationQuestions } from "../storage/review-gate.js";
import { isFlagged, type Issue, type IssueKey, type WorkTracker } from "../storage/interface.js";
import { UnreadableIssueError, reportUnreadableIssue, takeUnreadableIssues, type UnreadableIssue } from "../storage/unreadable-issues.js";

export type GroomingReader = Pick<WorkTracker, "search" | "getIssue" | "getLinkedIssues" | "getLinkedPages">;

export interface GroomingDeps {
    readonly workTracker: GroomingReader;
    readonly projectKey: string;
    /** Optional epic key: narrow every section to that epic's children, their subtasks and the epic itself (decision 10). */
    readonly epicKey?: string;
    /** Days a Backlog ticket may sit untouched before it shows up in section 6 (decision 9; default 60). */
    readonly staleBacklogDays?: number;
    readonly now?: Date;
    /** The full ranked list for one ticket (the TAI-416 ranking); omit and section 8 stays empty. */
    readonly needsAssigneeList?: (issue: Issue) => Promise<string>;
}

export interface GroomingKickoffRow {
    readonly issue: Issue;
    readonly epic: Issue | null;
    readonly openBlockers: readonly IssueKey[];
    readonly flagged: boolean;
}

/** TAI-472: a promotion candidate and what is missing from it. Warnings are advice for the conversation, never a block. */
export interface PromotionCandidate {
    readonly issue: Issue;
    /** Empty when nothing is missing, and always empty for a subtask (the check is for story-level tickets). */
    readonly warnings: readonly string[];
}

export interface GroomingResult {
    readonly scope: IssueKey | null;
    readonly childlessEpics: readonly Issue[];
    readonly backlogKickoffs: readonly GroomingKickoffRow[];
    readonly promotionCandidates: readonly PromotionCandidate[];
    readonly flagged: readonly Issue[];
    readonly idleEpics: readonly Issue[];
    readonly stale: readonly { readonly issue: Issue; readonly idleDays: number }[];
    readonly unreadable: readonly UnreadableIssue[];
    readonly needsAssignee: readonly { readonly issue: Issue; readonly list: string }[];
    readonly needsAssigneeOverflow: number;
    readonly staleThresholdDays: number;
}

/** An acceptance criterion is a description line that starts with `AC-<number>` (TAI-472), ignoring list or emphasis marks. */
const ACCEPTANCE_CRITERION_LINE = /^[\s>*_\-•]*(?:\*\*|__)?AC-\d+\b/m;

/** Story, Bug and Spike are the tickets the readiness check is for (TAI-472, human decision 2026-10-13). */
const READINESS_TYPES: readonly string[] = [StoryType.Story, StoryType.Bug, StoryType.Spike];

export const DEFAULT_STALE_BACKLOG_DAYS = 60;
export const MAX_NEEDS_ASSIGNEE = 15;
const OPEN: readonly Status[] = [Status.Backlog, Status.ToDo, Status.InProgress, Status.InReview];
const SCHEDULED_OR_LATER: readonly Status[] = [Status.ToDo, Status.InProgress, Status.InReview, Status.Done];
const DAY_MS = 86_400_000;

/** TAI_STALE_BACKLOG_DAYS from a project's .env (ADR decision 9); anything unusable falls back to the default. */
export function staleBacklogDaysFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): number {
    const n = Number(env["TAI_STALE_BACKLOG_DAYS"]);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_BACKLOG_DAYS;
}

/** Bounded concurrency for the per-ticket link reads (a big Backlog must not mean hundreds of sequential round trips). */
const READ_CONCURRENCY = 5;

/** Maps `items` through `fn` with at most `limit` in flight, returning results in INPUT order. */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i]!);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

const keyNumber = (key: string): number => Number(/-(\d+)$/.exec(key)?.[1] ?? 0);
const byKey = (a: Issue, b: Issue): number => keyNumber(a.key) - keyNumber(b.key);

export async function findGroomingWork(deps: GroomingDeps): Promise<GroomingResult> {
    const { workTracker, projectKey } = deps;
    const now = deps.now ?? new Date();
    const staleThresholdDays = deps.staleBacklogDays ?? DEFAULT_STALE_BACKLOG_DAYS;

    const allOpen = await workTracker.search({ projectKey, statuses: OPEN, exhaustive: true });

    // --- scope: one epic's children, their subtasks, and the epic itself ---
    let open: readonly Issue[] = allOpen;
    if (deps.epicKey) {
        const childKeys = new Set(allOpen.filter((i) => i.parentKey === deps.epicKey).map((i) => i.key as string));
        open = allOpen.filter(
            (i) => i.key === deps.epicKey || i.parentKey === deps.epicKey || (i.parentKey !== undefined && childKeys.has(i.parentKey))
        );
    }

    const issueMemo = new Map<string, Promise<Issue | null>>();
    const readIssue = (key: IssueKey): Promise<Issue | null> => {
        let hit = issueMemo.get(key);
        if (!hit) {
            hit = workTracker.getIssue(key).catch((e: unknown) => {
                if (e instanceof UnreadableIssueError) {
                    reportUnreadableIssue({ key: e.key, typeName: e.typeName });
                    return null;
                }
                throw e;
            });
            issueMemo.set(key, hit);
        }
        return hit;
    };

    /** Blockers (depends-on, outgoing) of one ticket that are NOT yet Done or Canceled; unreadable counts as open. */
    const blockersOf = async (issue: Issue): Promise<{ readonly all: readonly IssueKey[]; readonly open: readonly IssueKey[] }> => {
        const links = await workTracker.getLinkedIssues(issue.key, DependencyRelation.DependsOn, "outgoing");
        const all = links.map((l) => l.key);
        const blockers = await Promise.all(all.map((key) => readIssue(key)));
        const openOnes = all.filter((_, i) => {
            const blocker = blockers[i];
            return !blocker || (blocker.status !== Status.Done && blocker.status !== Status.Canceled);
        });
        return { all, open: openOnes };
    };

    // --- (a) and (e): per epic, one read of its children ---
    const childlessEpics: Issue[] = [];
    const idleEpics: Issue[] = [];
    for (const epic of open.filter((i) => i.issueType === "epic").sort(byKey)) {
        const kids = await workTracker.search({ projectKey, parentKey: epic.key, exhaustive: true });
        if (kids.length === 0) {
            childlessEpics.push(epic);
        } else if (
            (epic.status === Status.ToDo || epic.status === Status.InProgress) &&
            !kids.some((k) => SCHEDULED_OR_LATER.includes(k.status))
        ) {
            idleEpics.push(epic);
        }
    }

    const backlog = open.filter((i) => i.status === Status.Backlog).sort(byKey);

    // --- (b) Backlog Kickoff Stories awaiting sequencing ---
    const backlogKickoffs: GroomingKickoffRow[] = await mapWithLimit(
        backlog.filter((i) => i.issueType === StoryType.Kickoff),
        READ_CONCURRENCY,
        async (issue) => {
            const epic = issue.parentKey ? await readIssue(issue.parentKey) : null;
            return { issue, epic, openBlockers: (await blockersOf(issue)).open, flagged: isFlagged(issue) };
        }
    );

    // --- (c) Backlog tickets whose depends-on blockers are all done: promotion candidates ---
    const checked = await mapWithLimit(
        backlog.filter((i) => i.issueType !== StoryType.Kickoff && i.issueType !== "epic"),
        READ_CONCURRENCY,
        async (issue) => ({ issue, ...(await blockersOf(issue)) })
    );
    // TAI-472: no open blocker is enough for a Story, Bug or Spike, with or without depends-on links; a subtask
    // (a front-loaded chain sits in Backlog by design) is a candidate only when its links say it has been unblocked.
    const unblocked = checked.filter((c) => c.open.length === 0 && (c.all.length > 0 || READINESS_TYPES.includes(c.issue.issueType)));

    /** What a story-level candidate is missing. Reads its children and links; a subtask is not checked. */
    const readinessOf = async (issue: Issue): Promise<string[]> => {
        if (!READINESS_TYPES.includes(issue.issueType)) return [];
        const warnings: string[] = [];
        const description = issue.description ?? "";
        if (!ACCEPTANCE_CRITERION_LINE.test(description)) warnings.push("no numbered acceptance criteria (lines starting AC-1, AC-2, …)");
        const open = findClarificationQuestions(description).length;
        if (open > 0) warnings.push(`${open} NEEDS CLARIFICATION marker${open === 1 ? "" : "s"} in the description`);
        if (issue.issueType !== StoryType.Spike) {
            const devs = await workTracker.search({ projectKey, parentKey: issue.key, issueTypes: [SubtaskType.Dev] });
            if (devs.length === 0) warnings.push("no Dev subtask");
        }
        const issueLinks = await workTracker.getLinkedIssues(issue.key);
        if (issueLinks.length === 0 && (await workTracker.getLinkedPages(issue.key)).length === 0) warnings.push("no issue link and no linked page");
        return warnings;
    };
    const promotionCandidates: PromotionCandidate[] = await mapWithLimit(unblocked, READ_CONCURRENCY, async (c) => ({
        issue: c.issue,
        warnings: await readinessOf(c.issue),
    }));

    // --- (d) flagged, every open status ---
    const flagged = [...open].filter(isFlagged).sort(byKey);

    // --- (f) Backlog tickets untouched past the threshold ---
    const stale = backlog
        .map((issue) => ({ issue, idleDays: (now.getTime() - Date.parse(issue.updatedAt)) / DAY_MS }))
        .filter((r) => r.idleDays > staleThresholdDays)
        .map((r) => ({ issue: r.issue, idleDays: Math.floor(r.idleDays) }));

    // --- (h) tickets that need an assignee ---
    const needs = open
        .filter((i) => !i.assignee && i.persona && i.issueType !== "epic" && (i.status === Status.Backlog || i.status === Status.ToDo))
        .sort((a, b) => byKey(b, a)); // newest first: the overflow is the OLDER tickets
    const needsAssignee: { issue: Issue; list: string }[] = [];
    if (deps.needsAssigneeList) {
        for (const issue of needs.slice(0, MAX_NEEDS_ASSIGNEE)) {
            needsAssignee.push({ issue, list: await deps.needsAssigneeList(issue) });
        }
    }

    // --- (g) whatever the reads above skipped: drained last so every read had its chance to report ---
    const unreadable = takeUnreadableIssues();

    return {
        scope: (deps.epicKey as IssueKey | undefined) ?? null,
        childlessEpics,
        backlogKickoffs,
        promotionCandidates,
        flagged,
        idleEpics,
        stale,
        unreadable,
        needsAssignee,
        needsAssigneeOverflow: deps.needsAssigneeList ? Math.max(0, needs.length - MAX_NEEDS_ASSIGNEE) : 0,
        staleThresholdDays,
    };
}

// ---------- rendering ----------

function row(issue: Issue, detail = "", flagged = isFlagged(issue)): string {
    const priority = issue.priority ? `, ${issue.priority}` : "";
    return `- **${issue.key}** [${issue.issueType}] ${issue.summary} (${issue.status}${priority})${flagged ? " 🚩" : ""}${detail}`;
}

export function renderGroomingBriefing(result: GroomingResult): string {
    const out: string[] = [
        "# Grooming briefing",
        "",
        result.scope ? `Scope: epic ${result.scope} — its children, their subtasks, and the epic itself.` : "Scope: the whole board.",
        "",
    ];
    const section = (n: number, title: string, lines: readonly string[]) => {
        out.push(`## ${n}. ${title}`, "", ...(lines.length > 0 ? lines : ["None."]), "");
    };

    section(1, "Epics with nothing under them (each needs its Kickoff Story and the Stories already known)", result.childlessEpics.map((e) => row(e)));
    section(
        2,
        "Backlog Kickoff Stories awaiting sequencing",
        result.backlogKickoffs.map((k) =>
            row(
                k.issue,
                ` — epic ${k.epic ? `${k.epic.key} (${k.epic.status})` : "none"}` +
                    (k.openBlockers.length > 0 ? `, blocked by ${k.openBlockers.join(", ")}` : ", no open blockers"),
                k.flagged
            )
        )
    );
    section(
        3,
        "Backlog tickets with no open blocker (promotion candidates — check the description is actionable first)",
        result.promotionCandidates.map((c) =>
            row(c.issue, c.warnings.length > 0 ? `\n  ⚠ not ready: ${c.warnings.join("; ")}` : READINESS_TYPES.includes(c.issue.issueType) ? " — ready" : "")
        )
    );
    section(4, "Flagged tickets (does the impediment still stand?)", result.flagged.map((i) => row(i)));
    section(5, "Epics approved to build with nothing scheduled", result.idleEpics.map((e) => row(e)));
    section(
        6,
        `Backlog tickets untouched for more than ${result.staleThresholdDays} days (keep, schedule or cancel?)`,
        result.stale.map((s) => row(s.issue, ` — idle ${s.idleDays} days`))
    );
    section(
        7,
        "Tickets TAI cannot read (Jira issue type not mapped)",
        result.unreadable.map((u) => `- ${u.key} ("${u.typeName}") — alias the type on the Type Aliases page, or leave it unmanaged.`)
    );

    // Each list ends with the same two instruction lines; show them once for the whole section, not per ticket.
    const assignLines: string[] = [];
    for (const n of result.needsAssignee) {
        const body = n.list.split("\n").filter((l) => !l.startsWith("To assign:") && !l.startsWith("Interactive session:"));
        assignLines.push(row(n.issue), ...body.map((l) => `  ${l}`), "");
    }
    if (assignLines[assignLines.length - 1] === "") assignLines.pop();
    if (result.needsAssignee.length > 0) {
        assignLines.push(
            "",
            "To assign any of these: `issue assign <KEY> <EMAIL>`. Offer each list to the human, including \"Leave unassigned\", " +
                "with your question tool, as ONE batch; otherwise leave the tickets unassigned."
        );
    }
    if (result.needsAssigneeOverflow > 0) {
        assignLines.push("", `…and ${result.needsAssigneeOverflow} older tickets without an assignee; run \`issue suggest <KEY>\` for any of them.`);
    }
    section(8, "Tickets that need an assignee", assignLines);

    out.push(
        "---",
        "",
        "Perry creates Backlog tickets, depends-on links and phase labels on her own; every Backlog → To Do move, epic approval " +
            "(scheduling a first wave counts), flag/unflag, Cancel and assignment she proposes as a batch and applies only after " +
            "the human confirms."
    );
    return out.join("\n");
}
