/**
 * TAI Framework — read-through cache for `WorkTracker.getIssue` (TAI-56 ADR decisions 1/2)
 *
 * Refresh = full fetch + compare, not a cheaper partial fetch: `WorkTracker.getIssue`
 * exposes no lightweight metadata-only variant, so `refreshIssue` always does the full
 * fetch (at a refresh point — brief §3.6 — never live) and only writes to disk when the
 * returned `updatedAt` actually changed. The network round-trip already happened either
 * way; this is a disk-write optimization, not a network one.
 *
 * `cacheIssue` is exported separately from `refreshIssue` so `cache/sync.ts`'s bulk sync
 * (which already has fresh `Issue` objects from a `search()` call) can reuse the same
 * compare-and-write logic without re-fetching each one individually.
 *
 * `ChangeSeverity` (TAI-285 ADR, decisions 2/3): out-of-band change detection. `cacheIssue`
 * already has the OLD cached `Issue` and the NEW fetched one in hand at compare time — this
 * classifies WHICH fields actually changed, not just whether `updatedAt` moved, so a caller
 * (`generateBriefing`) can render a mild note for content-only edits vs. a prominent warning
 * for structural ones, per the ADR's Tier 1/Tier 2 split. `fields` (added PR #85 review —
 * TAI-290) names exactly which field(s) triggered that severity, so the rendered warning
 * doesn't have to fall back to listing every possible cause generically.
 */

import { StorageConnectivityError, type Issue, type IssueKey, type WorkTracker } from "../storage/interface.js";
import { issueCachePath, readJsonFile, writeJsonFile } from "./paths.js";

export interface CachedIssueEnvelope {
    readonly cachedAt: string;
    readonly issue: Issue;
}

/**
 * TAI-285 ADR decision 3: "none" (nothing worth reporting — includes both "no prior cache"
 * and "updatedAt changed but only an untracked field, e.g. a comment, did"), "content"
 * (`summary`/`description` changed, nothing else), or "structural" (`status`/`priority`/
 * `issueType`/`assignee`, or — via `links-snapshot.ts` — a relationship changed). Ordered
 * least-to-most severe; `combineSeverity` picks the more severe of two.
 */
export type ChangeSeverity = "none" | "content" | "structural";

const SEVERITY_RANK: Record<ChangeSeverity, number> = { none: 0, content: 1, structural: 2 };

/** The more severe of two signals — e.g. combining an `Issue` field change with a
 *  `links-snapshot.ts` relationship change into one signal for the same issue. */
export function combineSeverity(a: ChangeSeverity, b: ChangeSeverity): ChangeSeverity {
    return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** A severity tier plus exactly which field(s) triggered it — empty `fields` iff
 *  `severity` is "none". Shared shape between issues and pages (`page-cache.ts`). */
export interface FieldChange {
    readonly severity: ChangeSeverity;
    readonly fields: readonly string[];
}

/** Combines two `FieldChange`s into one — the more severe severity, with both sides'
 *  fields unioned (deduplicated, order preserved: `a`'s fields first). Used to merge an
 *  `Issue`'s own field change with `links-snapshot.ts`'s relationship-change signal. */
export function combineFieldChange(a: FieldChange, b: FieldChange): FieldChange {
    return {
        severity: combineSeverity(a.severity, b.severity),
        fields: [...new Set([...a.fields, ...b.fields])],
    };
}

const NO_CHANGE: FieldChange = { severity: "none", fields: [] };

/** Pure field comparison — no I/O. Exported for direct unit testing without needing a
 *  cache envelope round-trip. */
export function classifyIssueChange(oldIssue: Issue, freshIssue: Issue): FieldChange {
    const structuralFields: string[] = [];
    if (oldIssue.status !== freshIssue.status) structuralFields.push("status");
    if (oldIssue.priority !== freshIssue.priority) structuralFields.push("priority");
    if (oldIssue.issueType !== freshIssue.issueType) structuralFields.push("issueType");
    if ((oldIssue.assignee?.id ?? null) !== (freshIssue.assignee?.id ?? null)) structuralFields.push("assignee");
    if (structuralFields.length > 0) return { severity: "structural", fields: structuralFields };

    const contentFields: string[] = [];
    if (oldIssue.summary !== freshIssue.summary) contentFields.push("summary");
    if (oldIssue.description !== freshIssue.description) contentFields.push("description");
    if (contentFields.length > 0) return { severity: "content", fields: contentFields };

    return NO_CHANGE;
}

/** Reads the on-disk cache only — no network call. Null if never cached. */
export async function readCachedIssue(taiRoot: string, projectKey: string, key: string): Promise<Issue | null> {
    const envelope = await readJsonFile<CachedIssueEnvelope>(issueCachePath(taiRoot, projectKey, key));
    return envelope?.issue ?? null;
}

/** Writes `issue` to the disk cache only if it's new or its `updatedAt` changed since the
 *  last cached copy — the compare-and-write half of "refresh" (ADR decision 2). Returns
 *  the classified change (TAI-285 ADR) — "none"/`[]` when there was no prior cache entry,
 *  or `updatedAt` didn't move, or it moved but no tracked field did. */
export async function cacheIssue(taiRoot: string, projectKey: string, issue: Issue): Promise<FieldChange> {
    const filePath = issueCachePath(taiRoot, projectKey, issue.key);
    const existing = await readJsonFile<CachedIssueEnvelope>(filePath);
    if (existing && existing.issue.updatedAt === issue.updatedAt) return NO_CHANGE;

    const change = existing ? classifyIssueChange(existing.issue, issue) : NO_CHANGE;
    await writeJsonFile(filePath, { cachedAt: new Date().toISOString(), issue } satisfies CachedIssueEnvelope);
    return change;
}

export interface RefreshIssueResult {
    readonly issue: Issue | null;
    /** "none"/`[]` whenever `issue` is null (nothing to have changed) or on a connectivity
     *  degrade-to-cache (no fresh fetch happened to compare against). */
    readonly change: FieldChange;
}

/**
 * A refresh point (brief §3.6): fetches `key` from `workTracker`, caches it (only writing
 * to disk if changed), and returns the fresh `Issue` plus its change classification
 * (TAI-285 ADR) — or null if the issue doesn't exist (brief's existing "absent is opted
 * into, not assumed" convention; a prior cache entry, if any, is left as-is rather than
 * deleted, since a 404 could be transient).
 *
 * **Degrades to the cached copy on `StorageConnectivityError`** (brief §3.6: "degrade to
 * cache reads" is the read-side counterpart of `ConnectivityQueuedWorkTracker`'s
 * queue-writes — TAI does not attempt live sync). A connectivity failure with no prior
 * cache entry still returns null, same as a genuine 404 — there's nothing to degrade to.
 * Found missing entirely (PR #9 code review): offline meant a hard crash, not a fallback.
 */
export async function refreshIssue(
    workTracker: WorkTracker,
    taiRoot: string,
    projectKey: string,
    key: IssueKey
): Promise<RefreshIssueResult> {
    let issue: Issue | null;
    try {
        issue = await workTracker.getIssue(key);
    } catch (err) {
        if (!(err instanceof StorageConnectivityError)) throw err;
        return { issue: await readCachedIssue(taiRoot, projectKey, key), change: NO_CHANGE };
    }
    if (!issue) return { issue: null, change: NO_CHANGE };
    const change = await cacheIssue(taiRoot, projectKey, issue);
    return { issue, change };
}
