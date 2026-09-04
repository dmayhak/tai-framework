/**
 * TAI Framework — read-through cache for `DocStore.getPage` (TAI-56 ADR decisions 1/2)
 *
 * Symmetric with `issue-cache.ts` — see that module's doc comment for the refresh/compare
 * rationale, identical here for `Page` instead of `Issue`. Severity (TAI-285 ADR) is
 * simpler for a Page than an Issue: there's no status/priority/type/assignee equivalent to
 * compare, only `title`/`content` — so a Page's severity is always "none" or "content",
 * never "structural".
 */

import { StorageConnectivityError, type DocStore, type Page, type PageRef } from "../storage/interface.js";
import { pageCachePath, readJsonFile, writeJsonFile } from "./paths.js";
import type { FieldChange } from "./issue-cache.js";

export interface CachedPageEnvelope {
    readonly cachedAt: string;
    readonly page: Page;
}

const NO_CHANGE: FieldChange = { severity: "none", fields: [] };

/** Pure field comparison — no I/O. */
export function classifyPageChange(oldPage: Page, freshPage: Page): FieldChange {
    const fields: string[] = [];
    if (oldPage.title !== freshPage.title) fields.push("title");
    if (oldPage.content !== freshPage.content) fields.push("content");
    return fields.length > 0 ? { severity: "content", fields } : NO_CHANGE;
}

/** Reads the on-disk cache only — no network call. Null if never cached. */
export async function readCachedPage(taiRoot: string, projectKey: string, pageId: string): Promise<Page | null> {
    const envelope = await readJsonFile<CachedPageEnvelope>(pageCachePath(taiRoot, projectKey, pageId));
    return envelope?.page ?? null;
}

/** Writes `page` to the disk cache only if it's new or its `updatedAt` changed. Returns the
 *  classified change (TAI-285 ADR) — see `classifyPageChange`. */
export async function cachePage(taiRoot: string, projectKey: string, page: Page): Promise<FieldChange> {
    const filePath = pageCachePath(taiRoot, projectKey, page.id);
    const existing = await readJsonFile<CachedPageEnvelope>(filePath);
    if (existing && existing.page.updatedAt === page.updatedAt) return NO_CHANGE;

    const change = existing ? classifyPageChange(existing.page, page) : NO_CHANGE;
    await writeJsonFile(filePath, { cachedAt: new Date().toISOString(), page } satisfies CachedPageEnvelope);
    return change;
}

export interface RefreshPageResult {
    readonly page: Page | null;
    readonly change: FieldChange;
}

/**
 * A refresh point (brief §3.6): fetches `ref` from `docStore`, caches it, and returns the
 * fresh `Page` plus its change classification (TAI-285 ADR) — or null if it doesn't exist.
 *
 * **Degrades to the cached copy on `StorageConnectivityError`**, same as `refreshIssue`
 * (issue-cache.ts) — only possible when `ref` is id-shaped, since the cache is keyed by
 * page id and a title-based ref offline has no id to look one up by. A connectivity
 * failure on a title-based ref, or with no prior cache entry, still throws/returns null.
 */
export async function refreshPage(
    docStore: DocStore,
    taiRoot: string,
    projectKey: string,
    ref: PageRef
): Promise<RefreshPageResult> {
    let page: Page | null;
    try {
        page = await docStore.getPage(ref);
    } catch (err) {
        if (!(err instanceof StorageConnectivityError) || !("id" in ref)) throw err;
        return { page: await readCachedPage(taiRoot, projectKey, ref.id), change: NO_CHANGE };
    }
    if (!page) return { page: null, change: NO_CHANGE };
    const change = await cachePage(taiRoot, projectKey, page);
    return { page, change };
}
