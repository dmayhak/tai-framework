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
 */

import { StorageConnectivityError, type Issue, type IssueKey, type WorkTracker } from "../storage/interface.js";
import { issueCachePath, readJsonFile, writeJsonFile } from "./paths.js";

export interface CachedIssueEnvelope {
    readonly cachedAt: string;
    readonly issue: Issue;
}

/** Reads the on-disk cache only — no network call. Null if never cached. */
export async function readCachedIssue(taiRoot: string, projectKey: string, key: string): Promise<Issue | null> {
    const envelope = await readJsonFile<CachedIssueEnvelope>(issueCachePath(taiRoot, projectKey, key));
    return envelope?.issue ?? null;
}

/** Writes `issue` to the disk cache only if it's new or its `updatedAt` changed since the
 *  last cached copy — the compare-and-write half of "refresh" (ADR decision 2). */
export async function cacheIssue(taiRoot: string, projectKey: string, issue: Issue): Promise<void> {
    const filePath = issueCachePath(taiRoot, projectKey, issue.key);
    const existing = await readJsonFile<CachedIssueEnvelope>(filePath);
    if (existing && existing.issue.updatedAt === issue.updatedAt) return;
    await writeJsonFile(filePath, { cachedAt: new Date().toISOString(), issue } satisfies CachedIssueEnvelope);
}

/**
 * A refresh point (brief §3.6): fetches `key` from `workTracker`, caches it (only writing
 * to disk if changed), and returns the fresh `Issue` — or null if the issue doesn't exist
 * (brief's existing "absent is opted into, not assumed" convention; a prior cache entry, if
 * any, is left as-is rather than deleted, since a 404 could be transient).
 *
 * **Degrades to the cached copy on `StorageConnectivityError`** (brief §3.6: "degrade to
 * cache reads" is the read-side counterpart of `ConnectivityQueuedWorkTracker`'s
 * queue-writes — TAI does not attempt live sync). A connectivity failure with no prior
 * cache entry still returns null, same as a genuine 404 — there's nothing to degrade to.
 * Found missing entirely (PR #9 code review): offline meant a hard crash, not a fallback.
 */
export async function refreshIssue(workTracker: WorkTracker, taiRoot: string, projectKey: string, key: IssueKey): Promise<Issue | null> {
    let issue: Issue | null;
    try {
        issue = await workTracker.getIssue(key);
    } catch (err) {
        if (!(err instanceof StorageConnectivityError)) throw err;
        return readCachedIssue(taiRoot, projectKey, key);
    }
    if (!issue) return null;
    await cacheIssue(taiRoot, projectKey, issue);
    return issue;
}
