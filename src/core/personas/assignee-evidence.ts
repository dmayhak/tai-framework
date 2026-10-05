/**
 * TAI Framework — the evidence loader for ranked assignee suggestions (TAI-416/419; ADR page 50692097)
 *
 * The I/O half of the ranking: it reads ticket data through the WorkTracker only and hands
 * `assignee-ranking.ts` one `CandidateEvidence` per roster candidate. Version 1 uses ticket data alone
 * (ADR decision 8); git-history signals are a separate, later ticket.
 *
 * Reads, bounded (ADR consequences): the ticket's Story siblings (1 search) and the Story itself (1 read)
 * and its Epic's children (1 search); each linked ticket (1 read each, at most `MAX_LINKED`) plus, for a
 * Bug, the Dev subtasks of a linked Story (1 search per linked Story); one search per area signal
 * (Component, then at most `MAX_AREA_LABELS` labels); and ONE exhaustive search of every open ticket,
 * grouped by assignee, for the load. Nothing is stored; every call computes fresh.
 *
 * A failed read never blocks the list: that signal is skipped with a warning and the ranking uses what it
 * has (a ticket is never lost because assignment was unclear).
 */

import { isSubtaskIssueType, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import type { HumanRef, Issue, IssueKey, WorkTracker } from "../storage/interface.js";
import { UnreadableIssueError } from "../storage/unreadable-issues.js";
import type { AreaEvidence, CandidateEvidence, ContinuityEvidence } from "./assignee-ranking.js";

export type EvidenceReader = Pick<WorkTracker, "search" | "getIssue" | "getLinkedIssues" | "resolveHuman">;

export const DEFAULT_AREA_WINDOW_DAYS = 90;
const MAX_LINKED = 10;
const MAX_AREA_LABELS = 2;
const OPEN: readonly Status[] = [Status.Backlog, Status.ToDo, Status.InProgress, Status.InReview];

/** Review-type subtask -> the subtask type whose author it must not default to (ADR decision 10). */
const REVIEW_OF: Partial<Record<SubtaskType, SubtaskType>> = {
    [SubtaskType.DesignReview]: SubtaskType.ArchitectureDesign,
};

export interface EvidenceOptions {
    readonly areaWindowDays?: number;
    readonly now?: Date;
    readonly onWarning?: (message: string) => void;
}

/** TAI_AREA_WINDOW_DAYS from a project's .env (ADR decision 8); anything unusable falls back to the default. */
export function areaWindowDaysFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): number {
    const n = Number(env["TAI_AREA_WINDOW_DAYS"]);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_AREA_WINDOW_DAYS;
}

interface ContinuityEntry {
    readonly tier: 1 | 2 | 3;
    readonly reason: string;
    readonly id: string;
}

export async function gatherAssigneeEvidence(
    workTracker: EvidenceReader,
    issue: Issue,
    candidates: readonly HumanRef[],
    options: EvidenceOptions = {}
): Promise<readonly CandidateEvidence[]> {
    const windowDays = options.areaWindowDays ?? DEFAULT_AREA_WINDOW_DAYS;
    const now = options.now ?? new Date();
    const warn = options.onWarning ?? ((m: string) => void process.stderr.write(`${m}\n`));
    const projectKey = issue.projectKey;

    async function attempt<T>(what: string, read: () => Promise<T>, fallback: T): Promise<T> {
        try {
            return await read();
        } catch (e) {
            if (!(e instanceof UnreadableIssueError)) warn(`Assignee suggestions: could not read ${what} (${(e as Error).message}); ranking without it.`);
            return fallback;
        }
    }

    // The roster knows names and emails; ticket data holds real Jira identities. Match on the real id.
    const real = await Promise.all(
        candidates.map((c) => (c.email ? workTracker.resolveHuman(c.email).catch(() => null) : Promise.resolve(null)))
    );

    const continuity: ContinuityEntry[] = [];
    const authored = new Set<string>();
    const add = (tier: 1 | 2 | 3, reason: string, human: HumanRef | null | undefined) => {
        if (human) continuity.push({ tier, reason, id: human.id });
    };

    // --- continuity: same Story, same Epic ---
    const parentKey = issue.parentKey;
    if (parentKey) {
        if (isSubtaskIssueType(issue.issueType)) {
            const siblings = await attempt("the Story's other subtasks", () => workTracker.search({ projectKey, parentKey, exhaustive: true }), []);
            for (const s of siblings) if (s.key !== issue.key) add(1, `worked on this Story (${s.key})`, s.assignee);
            const reviewed = REVIEW_OF[issue.issueType];
            if (reviewed) for (const s of siblings) if (s.issueType === reviewed && s.assignee) authored.add(s.assignee.id);

            const story = await attempt("the parent Story", () => workTracker.getIssue(parentKey), null);
            if (story?.parentKey) {
                const epicKey = story.parentKey;
                const kids = await attempt("the Epic's tickets", () => workTracker.search({ projectKey, parentKey: epicKey, exhaustive: true }), []);
                for (const k of kids) if (k.key !== story.key) add(3, `worked on this Epic (${k.key})`, k.assignee);
            }
        } else {
            const kids = await attempt("the Epic's tickets", () => workTracker.search({ projectKey, parentKey, exhaustive: true }), []);
            for (const k of kids) if (k.key !== issue.key) add(3, `worked on this Epic (${k.key})`, k.assignee);
        }
    }

    // --- continuity: linked tickets (and, for a Bug, who built the feature) ---
    const linkedKeys = await attempt(
        "linked tickets",
        async () => {
            const [out, inc] = await Promise.all([
                workTracker.getLinkedIssues(issue.key, undefined, "outgoing"),
                workTracker.getLinkedIssues(issue.key, undefined, "incoming"),
            ]);
            return [...new Set([...out, ...inc].map((l) => l.key as string))].slice(0, MAX_LINKED) as IssueKey[];
        },
        [] as IssueKey[]
    );
    for (const key of linkedKeys) {
        const linked = await attempt(`linked ticket ${key}`, () => workTracker.getIssue(key), null);
        if (!linked) continue;
        add(2, `worked on related ticket ${linked.key}`, linked.assignee);
        if (issue.issueType === StoryType.Bug && linked.issueType === StoryType.Story) {
            const devs = await attempt(
                `the Dev work on ${linked.key}`,
                () => workTracker.search({ projectKey, parentKey: linked.key, issueTypes: [SubtaskType.Dev], exhaustive: true }),
                []
            );
            for (const d of devs) add(1, `caused the bug (delivered in ${linked.key})`, d.assignee);
        }
    }

    // --- area knowledge: Done tickets with the same Component / labels in the window ---
    const area = new Map<string, { count: number; reasons: string[] }>();
    const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
    const countClosed = async (what: string, filter: { component?: string; labels?: readonly string[] }, label: string) => {
        const done = await attempt(
            what,
            () => workTracker.search({ projectKey, statuses: [Status.Done], updatedSince: since, exhaustive: true, ...filter }),
            []
        );
        const perPerson = new Map<string, number>();
        for (const t of done) if (t.key !== issue.key && t.assignee) perPerson.set(t.assignee.id, (perPerson.get(t.assignee.id) ?? 0) + 1);
        for (const [id, n] of perPerson) {
            const entry = area.get(id) ?? { count: 0, reasons: [] };
            entry.count += n;
            entry.reasons.push(`closed ${n} ticket${n === 1 ? "" : "s"} ${label} in the last ${windowDays} days`);
            area.set(id, entry);
        }
    };
    if (issue.component) await countClosed("past tickets by Component", { component: issue.component }, `under component ${issue.component}`);
    for (const label of issue.labels.slice(0, MAX_AREA_LABELS)) await countClosed(`past tickets labelled ${label}`, { labels: [label] }, `labelled ${label}`);

    // --- load: every open ticket, one search, grouped by assignee ---
    const open = await attempt("open tickets", async () => {
        const all = await workTracker.search({ projectKey, statuses: OPEN, exhaustive: true });
        const counts = new Map<string, number>();
        for (const t of all) if (t.assignee) counts.set(t.assignee.id, (counts.get(t.assignee.id) ?? 0) + 1);
        return counts;
    }, null);

    return candidates.map((candidate, i): CandidateEvidence => {
        const id = real[i]?.id;
        if (!id) return { candidate, continuity: null, area: null, openCount: null, authoredWorkUnderReview: false };

        const mine = continuity.filter((e) => e.id === id);
        const tier = mine.length > 0 ? (Math.min(...mine.map((e) => e.tier)) as 1 | 2 | 3) : null;
        const continuityEvidence: ContinuityEvidence | null =
            tier === null
                ? null
                : {
                      tier,
                      // At most one reason per tier, strongest tier first, so a busy Story does not flood the line.
                      reasons: ([1, 2, 3] as const)
                          .map((t) => mine.find((e) => e.tier === t)?.reason)
                          .filter((r): r is string => r !== undefined),
                  };
        const a = area.get(id);
        const areaEvidence: AreaEvidence | null = a ? { count: a.count, reasons: a.reasons } : null;
        return {
            candidate,
            continuity: continuityEvidence,
            area: areaEvidence,
            openCount: open ? (open.get(id) ?? 0) : null,
            authoredWorkUnderReview: authored.has(id),
        };
    });
}
