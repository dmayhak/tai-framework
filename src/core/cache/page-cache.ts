/**
 * TAI Framework — read-through cache for `DocStore.getPage` (TAI-56 ADR decisions 1/2)
 *
 * Symmetric with `issue-cache.ts` — see that module's doc comment for the refresh/compare
 * rationale, identical here for `Page` instead of `Issue`.
 */

import type { DocStore, Page, PageRef } from "../storage/interface.js";
import { pageCachePath, readJsonFile, writeJsonFile } from "./paths.js";

export interface CachedPageEnvelope {
    readonly cachedAt: string;
    readonly page: Page;
}

/** Reads the on-disk cache only — no network call. Null if never cached. */
export async function readCachedPage(taiRoot: string, projectKey: string, pageId: string): Promise<Page | null> {
    const envelope = await readJsonFile<CachedPageEnvelope>(pageCachePath(taiRoot, projectKey, pageId));
    return envelope?.page ?? null;
}

/** Writes `page` to the disk cache only if it's new or its `updatedAt` changed. */
export async function cachePage(taiRoot: string, projectKey: string, page: Page): Promise<void> {
    const filePath = pageCachePath(taiRoot, projectKey, page.id);
    const existing = await readJsonFile<CachedPageEnvelope>(filePath);
    if (existing && existing.page.updatedAt === page.updatedAt) return;
    await writeJsonFile(filePath, { cachedAt: new Date().toISOString(), page } satisfies CachedPageEnvelope);
}

/** A refresh point (brief §3.6): fetches `ref` from `docStore`, caches it, and returns the
 *  fresh `Page` — or null if it doesn't exist. */
export async function refreshPage(docStore: DocStore, taiRoot: string, projectKey: string, ref: PageRef): Promise<Page | null> {
    const page = await docStore.getPage(ref);
    if (!page) return null;
    await cachePage(taiRoot, projectKey, page);
    return page;
}
