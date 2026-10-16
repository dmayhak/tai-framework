/**
 * TAI Framework — the retrospective briefing (TAI-491; TAI-461 decision, human, 2026-10-08)
 *
 * `/tai-retro [EPIC-KEY | since=<date>]` loads Perry (PM) with her "Retrospective" behavior (personas/pm.md) and
 * this READ-ONLY summary of what went wrong or was sent back in a window: tickets cancelled, Bugs raised, tiers
 * sent back, stamped merge-gate overrides and stale approvals. Shaped like `/tai-kickoff` and `/tai-groom`: no
 * ticket needed, persona heading + her instructions + `---` + briefing. Perry asks a few questions and writes the
 * page and the tickets; nothing here writes anything.
 *
 * Two halves, so the rules can be tested without a tracker or a git host: `computeRetro` is pure over tickets and
 * PRs already read; `findRetroSummary` does the reading.
 *
 * What each signal means, and what it cannot tell:
 *  - Cancelled: a ticket now Canceled whose last update is in the window. The tracker keeps no cancel date, so a
 *    ticket edited after it was cancelled can show up in a later window than the one it was cancelled in.
 *  - Bugs raised: a Bug created in the window.
 *  - Tiers sent back: a `Not verified:` or `Rejected:` comment dated in the window (the two markers a verifier and a
 *    human reviewer use to send work back).
 *  - Stamped overrides: a `Merge-gate override:` comment on a PR (`git-pr merge … force=true` leaves it).
 *  - Stale approvals: a PR (open, or merged in the window) with an approval cast before its latest commit — the
 *    same rule as the merge gate, which this reuses.
 */

import { Status } from "../schema/story-schema.js";
import { evaluateMergeGate } from "../git/merge-gate.js";
import type { GitHost, PullRequestActivity, PullRequestRef, RepoId } from "../git/interface.js";
import type { Comment, HumanRef, Issue, IssueKey, WorkTracker } from "../storage/interface.js";
import { mapWithLimit } from "./groom.js";

/** The prefix `mergeOverrideComment` writes (git/merge-gate.ts). */
const OVERRIDE_PREFIX = "Merge-gate override:";
const SENT_BACK = /^(Not verified|Rejected):/;
const DEFAULT_DAYS = 30;
const DAY_MS = 86_400_000;
const PR_FETCH_LIMIT = 4;

export interface RetroPullRequest {
    readonly pr: PullRequestRef;
    readonly comments: readonly Comment[];
    readonly activity: readonly PullRequestActivity[];
}

export interface RetroInput {
    /** Every ticket in scope, any status. */
    readonly issues: readonly Issue[];
    /** The PRs in scope, or `null` when no git host could be read. */
    readonly pullRequests: readonly RetroPullRequest[] | null;
    readonly from: Date;
}

export interface RetroSummary {
    readonly cancelled: readonly { readonly issue: Issue; readonly reason: string | null }[];
    readonly bugs: readonly Issue[];
    readonly sentBack: readonly { readonly issue: Issue; readonly line: string; readonly at: string }[];
    /** `null` when no git host was read: the section says so rather than claiming there were none. */
    readonly overrides: readonly { readonly pr: PullRequestRef; readonly line: string }[] | null;
    readonly staleApprovals: readonly { readonly pr: PullRequestRef; readonly humans: readonly HumanRef[] }[] | null;
}

const atOrAfter = (iso: string, from: Date): boolean => new Date(iso).getTime() >= from.getTime();
const firstLine = (text: string): string => text.split(/\r\n|[\r\n]/)[0]!.trim();
const keyNumber = (key: string): number => Number(/-(\d+)$/.exec(key)?.[1] ?? 0);

export function computeRetro(input: RetroInput): RetroSummary {
    const { issues, pullRequests, from } = input;
    const byKey = (a: Issue, b: Issue): number => keyNumber(a.key) - keyNumber(b.key);
    const sorted = [...issues].sort(byKey);

    const cancelled = sorted
        .filter((i) => i.status === Status.Canceled && atOrAfter(i.updatedAt, from))
        .map((issue) => {
            const last = issue.comments[issue.comments.length - 1];
            return { issue, reason: last ? firstLine(last.body) : null };
        });

    const bugs = sorted.filter((i) => i.issueType === "bug" && atOrAfter(i.createdAt, from));

    const sentBack = sorted.flatMap((issue) =>
        issue.comments
            .filter((c) => SENT_BACK.test(c.body.trimStart()) && atOrAfter(c.createdAt, from))
            .map((c) => ({ issue, line: firstLine(c.body), at: c.createdAt }))
    );

    if (pullRequests === null) return { cancelled, bugs, sentBack, overrides: null, staleApprovals: null };

    const inWindow = pullRequests.filter((p) => atOrAfter(p.pr.updatedAt, from));
    const overrides = inWindow.flatMap((p) =>
        p.comments.filter((c) => c.body.trimStart().startsWith(OVERRIDE_PREFIX) && atOrAfter(c.createdAt, from)).map((c) => ({ pr: p.pr, line: firstLine(c.body) }))
    );
    const staleApprovals = inWindow
        .map((p) => ({
            pr: p.pr,
            // The merge gate's own rule for which approvals count; the tiers and UAT are not part of this question.
            humans: evaluateMergeGate({ pullRequest: p.pr, activity: p.activity, requiredApprovals: 1, testTiers: [], uat: [] }).staleApprovals,
        }))
        .filter((s) => s.humans.length > 0);
    return { cancelled, bugs, sentBack, overrides, staleApprovals };
}

// ---------- the arguments ----------

const RETRO_USAGE = "Usage: retro [EPIC-KEY | since=<date>] (an epic key and since=<date> may be given together, each once).";

/** The words after `retro`: an epic key and/or `since=<date>`, each at most once. Anything else is the usage text. */
export function parseRetroArgs(words: readonly string[]): { readonly epicKey?: string; readonly since?: string } {
    let epicKey: string | undefined;
    let since: string | undefined;
    for (const word of words) {
        if (word.startsWith("since=")) {
            if (since !== undefined) throw new Error(`${RETRO_USAGE} since= was given twice.`);
            since = word.slice("since=".length);
        } else if (/^[A-Z][A-Z0-9]*-\d+$/.test(word)) {
            if (epicKey !== undefined) throw new Error(`${RETRO_USAGE} Only one epic key.`);
            epicKey = word;
        } else {
            throw new Error(`${RETRO_USAGE} "${word}" is neither an epic key nor since=<date> (write since=2026-10-01, with no space).`);
        }
    }
    return { ...(epicKey !== undefined ? { epicKey } : {}), ...(since !== undefined ? { since } : {}) };
}

// ---------- the window ----------

export interface RetroWindow {
    readonly from: Date;
    /** Says how the window was chosen, for the briefing. */
    readonly label: string;
}

/** `since=` takes a date (2026-10-01) or a date-time with a timezone; anything else is rejected. */
export function parseRetroSince(value: string): Date {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const withZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value);
    const parsed = new Date(dateOnly ? `${value}T00:00:00Z` : value);
    if ((!dateOnly && !withZone) || Number.isNaN(parsed.getTime())) {
        throw new Error(`since= takes an ISO 8601 date (2026-10-01) or a date-time with a timezone (2026-10-01T09:00:00Z), got "${value}".`);
    }
    return parsed;
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

export function retroWindow(opts: { readonly now: Date; readonly epic?: Issue; readonly since?: string }): RetroWindow {
    if (opts.since !== undefined) {
        const from = parseRetroSince(opts.since);
        return { from, label: `from ${ymd(from)} (given as since=)` };
    }
    if (opts.epic) {
        const from = new Date(opts.epic.createdAt);
        return { from, label: `from ${ymd(from)}, when ${opts.epic.key} was created (its whole life)` };
    }
    const from = new Date(opts.now.getTime() - DEFAULT_DAYS * DAY_MS);
    return { from, label: `from ${ymd(from)} (the last ${DEFAULT_DAYS} days, the default)` };
}

// ---------- reading ----------

export interface RetroDeps {
    readonly workTracker: Pick<WorkTracker, "search" | "getIssue">;
    readonly projectKey: string;
    readonly epicKey?: IssueKey;
    readonly since?: string;
    readonly now?: Date;
    /** Absent when Bitbucket is not configured: the PR sections then say they were not read. */
    readonly git?: { readonly gitHost: Pick<GitHost, "listPullRequests" | "listPullRequestComments" | "listPullRequestActivity">; readonly repos: readonly RepoId[] };
}

export interface RetroReport {
    readonly summary: RetroSummary;
    readonly window: RetroWindow;
    /** "the whole board" or the epic, for the briefing's Scope line. */
    readonly scope: string;
}

/** The first ticket key in a PR title (`TAI-469 - TAI-557 - …`), the Story the title convention puts first. */
const titleKey = (title: string): string | null => /^\s*([A-Z][A-Z0-9]*-\d+)/.exec(title)?.[1] ?? null;

export async function findRetroSummary(deps: RetroDeps): Promise<RetroReport> {
    const { workTracker, projectKey } = deps;
    const now = deps.now ?? new Date();

    let epic: Issue | undefined;
    if (deps.epicKey) {
        const found = await workTracker.getIssue(deps.epicKey);
        if (!found) throw new Error(`${deps.epicKey} was not found.`);
        if (found.issueType !== "epic") throw new Error(`${deps.epicKey} is a ${found.issueType}, not an epic -- /tai-retro takes an epic key (or none, for the whole board).`);
        epic = found;
    }
    const window = retroWindow({ now, ...(epic ? { epic } : {}), ...(deps.since !== undefined ? { since: deps.since } : {}) });

    let issues: readonly Issue[];
    if (epic) {
        const children = await workTracker.search({ projectKey, parentKey: epic.key, exhaustive: true });
        const subtasks = await mapWithLimit(children, PR_FETCH_LIMIT, (c) => workTracker.search({ projectKey, parentKey: c.key, exhaustive: true }));
        issues = [epic, ...children, ...subtasks.flat()];
    } else {
        issues = await workTracker.search({ projectKey, updatedSince: window.from.toISOString(), exhaustive: true });
    }

    let pullRequests: RetroPullRequest[] | null = null;
    if (deps.git) {
        const { gitHost, repos } = deps.git;
        const inScope = new Set<string>(issues.map((i) => i.key));
        const listed = (
            await Promise.all(repos.flatMap((repo) => (["open", "merged"] as const).map((state) => gitHost.listPullRequests(repo, state, { updatedSince: window.from.toISOString() }))))
        ).flat();
        const wanted = listed.filter((pr) => atOrAfter(pr.updatedAt, window.from) && (!epic || inScope.has(titleKey(pr.title) ?? "")));
        pullRequests = await mapWithLimit(wanted, PR_FETCH_LIMIT, async (pr) => ({
            pr,
            comments: await gitHost.listPullRequestComments(pr.repo, pr.id),
            activity: await gitHost.listPullRequestActivity(pr.repo, pr.id),
        }));
    }

    return {
        summary: computeRetro({ issues, pullRequests, from: window.from }),
        window,
        scope: epic ? `epic ${epic.key} (${epic.summary})` : "the whole board",
    };
}

// ---------- rendering ----------

const NOT_READ =
    "Not read: no git host is configured for this session (BITBUCKET_EMAIL, BITBUCKET_API_TOKEN and TAI_GIT_REPOS or TAI_GIT_WORKSPACE). Ask the human whether to go without it.";

const prLabel = (pr: PullRequestRef): string => `PR ${pr.id} (${pr.repo}) ${pr.title} — ${pr.url}`;

export function renderRetroBriefing(input: { readonly summary: RetroSummary; readonly window: RetroWindow; readonly scope: string }): string {
    const { summary, window, scope } = input;
    const out: string[] = ["# Retro briefing", "", `Scope: ${scope}.`, `Window: ${window.label}.`, ""];

    const section = (n: number, title: string, rows: readonly string[] | null): void => {
        out.push(`## ${n}. ${title}`, "");
        if (rows === null) out.push(NOT_READ, "");
        else if (rows.length === 0) out.push("None.", "");
        else out.push(...rows, "");
    };

    section(
        1,
        "Tickets cancelled",
        summary.cancelled.map((c) => `- **${c.issue.key}** [${c.issue.issueType}] ${c.issue.summary}${c.reason ? ` — last comment: ${c.reason}` : ""}`)
    );
    section(2, "Bugs raised", summary.bugs.map((b) => `- **${b.key}** ${b.summary}${b.parentKey ? ` — under ${b.parentKey}` : ""} (${b.status})`));
    section(
        3,
        "Tiers sent back",
        summary.sentBack.map((s) => `- **${s.issue.key}** [${s.issue.issueType}] ${s.at.slice(0, 10)}: ${s.line}`)
    );
    section(4, "Stamped overrides", summary.overrides?.map((o) => `- ${prLabel(o.pr)} — ${o.line}`) ?? null);
    section(
        5,
        "Stale approvals",
        summary.staleApprovals?.map((s) => `- ${prLabel(s.pr)} — approval by ${s.humans.map((h) => h.displayName).join(", ")} was cast before the latest commit`) ?? null
    );

    out.push(
        "---",
        "",
        "These are signals, not verdicts: a cancelled ticket may have been right to cancel, and an override may have been the " +
            "right call. Present this briefing to the human first (verbatim, from the `# Retro briefing` heading down), then " +
            "follow your Retrospective behavior: ask the human a few questions about what the signals do not show, write the " +
            "retro page, and file the action items as Backlog tickets. Put no question in the same turn as the briefing: end " +
            "your turn after it and wait for the human's own next message."
    );
    return out.join("\n");
}

/** The line `issue transition` prints when an Epic moves to Done, or `null` for anything else. */
export function retroEpicCloseHint(issue: Pick<Issue, "key" | "issueType" | "status">): string | null {
    if (issue.issueType !== "epic" || issue.status !== Status.Done) return null;
    return `Consider a retrospective on this epic: /tai-retro ${issue.key}`;
}
