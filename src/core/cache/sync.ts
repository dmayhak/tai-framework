/**
 * TAI Framework — bulk incremental sync (TAI-56 ADR decision 5)
 *
 * Reads the `last-sync.json` checkpoint, calls `WorkTracker.search` with
 * `updatedSince` (the exact case that field was added for — `storage/interface.ts`'s own
 * comment: "powers brief §7's bulk incremental-sync case"), caches every returned issue,
 * and advances the checkpoint to the MAX `updatedAt` seen in the batch — not the client's
 * current time, which would risk missing an issue updated between the request and the
 * response due to client/server clock skew. An empty batch leaves the checkpoint untouched.
 */

import type { Issue, WorkTracker } from "../storage/interface.js";
import { cacheIssue } from "./issue-cache.js";
import { lastSyncPath, readJsonFile, writeJsonFile } from "./paths.js";

export interface SyncCheckpoint {
    readonly lastSyncAt: string;
}

export async function readSyncCheckpoint(taiRoot: string, projectKey: string): Promise<SyncCheckpoint | null> {
    return readJsonFile<SyncCheckpoint>(lastSyncPath(taiRoot, projectKey));
}

/** Runs one incremental sync pass. Returns the issues fetched (possibly empty). */
export async function bulkSync(workTracker: WorkTracker, taiRoot: string, projectKey: string): Promise<readonly Issue[]> {
    const checkpoint = await readSyncCheckpoint(taiRoot, projectKey);
    const issues = await workTracker.search({
        projectKey,
        ...(checkpoint ? { updatedSince: checkpoint.lastSyncAt } : {}),
    });

    for (const issue of issues) {
        await cacheIssue(taiRoot, projectKey, issue);
    }

    if (issues.length > 0) {
        const maxUpdatedAt = issues.reduce((max, i) => (i.updatedAt > max ? i.updatedAt : max), issues[0]!.updatedAt);
        await writeJsonFile(lastSyncPath(taiRoot, projectKey), { lastSyncAt: maxUpdatedAt } satisfies SyncCheckpoint);
    }

    return issues;
}
