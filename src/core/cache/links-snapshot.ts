/**
 * TAI Framework — outgoing-link snapshot cache (TAI-285 ADR decision 3b)
 *
 * Brief §7 already reserved `.tai/cache/<project>/links/` for a "cached Jira<->Confluence
 * link index," but nothing populated it until now. Fills that reserved slot with exactly
 * what TAI-285's out-of-band-change-detection ADR needs: a snapshot of an issue's own
 * outgoing linked-issue keys, so a later refresh can tell whether a relationship was added
 * or removed since the last read — unlike `Issue`/`Page`, `WorkTracker.getLinkedIssues()`
 * has no cache/diff layer of its own at all (confirmed: `briefing.ts` calls it directly,
 * always a fresh, uncompared fetch).
 *
 * `snapshotLinkedKeys` deliberately takes an ALREADY-FETCHED `getLinkedIssues()` result
 * rather than calling it itself — `generateBriefing` already fetches the subtask's and
 * parent's outgoing links for its own "Linked Tickets" section (TAI-77 ADR), so this reuses
 * that same call rather than paying for a second one just for the snapshot diff (the exact
 * duplicate-fetch mistake PR #82's review caught and fixed elsewhere this session).
 */

import path from "node:path";
import type { IssueKey, IssueLink } from "../storage/interface.js";
import { linksDir, readJsonFile, writeJsonFile } from "./paths.js";

export interface LinkedKeysSnapshot {
    readonly cachedAt: string;
    readonly linkedKeys: readonly IssueKey[];
}

export function linkedKeysCachePath(taiRoot: string, projectKey: string, key: IssueKey): string {
    return path.join(linksDir(taiRoot, projectKey), `${key}.json`);
}

/** Reads the on-disk snapshot only — no network call. Null if never cached. */
export async function readLinkedKeysSnapshot(
    taiRoot: string,
    projectKey: string,
    key: IssueKey
): Promise<readonly IssueKey[] | null> {
    const envelope = await readJsonFile<LinkedKeysSnapshot>(linkedKeysCachePath(taiRoot, projectKey, key));
    return envelope?.linkedKeys ?? null;
}

function sameKeys(a: readonly IssueKey[], b: readonly IssueKey[]): boolean {
    return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Diffs `freshLinks` against the last-cached outgoing-key set for `key`, then re-caches the
 * fresh set. Returns `true` iff a prior snapshot existed and the (deduped, sorted) key set
 * actually differs — an added OR removed relationship, either direction counts as changed.
 * `false` (not an error) when there was no prior snapshot — nothing to have changed from.
 */
export async function snapshotLinkedKeys(
    taiRoot: string,
    projectKey: string,
    key: IssueKey,
    freshLinks: readonly IssueLink[]
): Promise<boolean> {
    const freshKeys = [...new Set(freshLinks.map((l) => l.key))].sort();
    const filePath = linkedKeysCachePath(taiRoot, projectKey, key);
    const existing = await readJsonFile<LinkedKeysSnapshot>(filePath);
    const changed = existing !== null && !sameKeys(existing.linkedKeys, freshKeys);
    await writeJsonFile(filePath, { cachedAt: new Date().toISOString(), linkedKeys: freshKeys } satisfies LinkedKeysSnapshot);
    return changed;
}
