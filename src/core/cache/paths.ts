/**
 * TAI Framework — `.tai/` path builders (TAI-56 ADR decision 1)
 *
 * Single source of truth for the layout brief §7 already fixes: a `cache/` tree (raw
 * mirrored Jira/Confluence data, disposable, always rebuildable) and a `work/` tree (active
 * work-in-progress state, keyed by subtask). Both `cache/*.ts` and `workspace/*.ts` import
 * from here rather than reconstructing paths independently.
 *
 * Also holds two tiny JSON read/write helpers — every other module in `cache/`/`workspace/`
 * needs "read a JSON file, treat ENOENT as absent" / "write a JSON file, creating parent
 * dirs," so it lives beside the paths those helpers are always called with rather than
 * duplicated per module.
 *
 * `roster.ts` (TAI-14) predates this Epic and used its own narrower `cacheRoot` convention
 * (defaulting to `.tai/cache`, one level deeper than the `taiRoot` used here). Left
 * untouched deliberately — retrofitting it is out of scope for this Story (TAI-56 ADR
 * context: "built ahead of this Epic, for TAI-14's narrower need").
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function defaultTaiRoot(): string {
    return path.join(process.cwd(), ".tai");
}

// ---------- cache/ tree ----------

export function cacheDir(taiRoot: string, projectKey: string): string {
    return path.join(taiRoot, "cache", projectKey);
}

export function issueCachePath(taiRoot: string, projectKey: string, issueKey: string): string {
    return path.join(cacheDir(taiRoot, projectKey), "issues", `${issueKey}.json`);
}

export function issueAttachmentsDir(taiRoot: string, projectKey: string, issueKey: string): string {
    return path.join(cacheDir(taiRoot, projectKey), "issues", issueKey, "attachments");
}

// Brief §7's own diagram shows confluence/<PAGE-ID>.md (raw markdown, "+ cachedAt"), but
// that section is explicitly titled "(concept)" — not a binding file-extension spec. Both
// issues/ and confluence/ use the same JSON envelope here ({cachedAt, <entity>}, including
// comments) deliberately: one shape, one pair of read/write helpers, rather than inventing
// a second on-disk format (e.g. YAML frontmatter) just to preserve a raw .md extension that
// still needs to carry the same cachedAt/comments metadata somehow either way.
export function pageCachePath(taiRoot: string, projectKey: string, pageId: string): string {
    return path.join(cacheDir(taiRoot, projectKey), "confluence", `${pageId}.json`);
}

export function pageAttachmentsDir(taiRoot: string, projectKey: string, pageId: string): string {
    return path.join(cacheDir(taiRoot, projectKey), "confluence", pageId, "attachments");
}

export function linksDir(taiRoot: string, projectKey: string): string {
    return path.join(cacheDir(taiRoot, projectKey), "links");
}

export function lastSyncPath(taiRoot: string, projectKey: string): string {
    return path.join(cacheDir(taiRoot, projectKey), "last-sync.json");
}

export function personasCacheDir(taiRoot: string, projectKey: string): string {
    return path.join(cacheDir(taiRoot, projectKey), "personas");
}

export function configCacheDir(taiRoot: string, projectKey: string): string {
    return path.join(cacheDir(taiRoot, projectKey), "config");
}

// TAI-302/319: the last-captured structured summary a living doc (project-home,
// architecture-overview) was written from — see workspace/living-doc-staleness.ts. Keyed by
// output type, not a specific Confluence page id, deliberately (that module never reads the
// page itself).
export function livingDocSnapshotPath(taiRoot: string, projectKey: string, outputType: string): string {
    return path.join(cacheDir(taiRoot, projectKey), "living-docs", `${outputType}.json`);
}

// ---------- work/ tree ----------

export function workRootDir(taiRoot: string): string {
    return path.join(taiRoot, "work");
}

export function workProjectDir(taiRoot: string, projectKey: string): string {
    return path.join(workRootDir(taiRoot), projectKey);
}

export function workItemDir(taiRoot: string, projectKey: string, subtaskKey: string): string {
    return path.join(workProjectDir(taiRoot, projectKey), subtaskKey);
}

export function briefingPath(taiRoot: string, projectKey: string, subtaskKey: string): string {
    return path.join(workItemDir(taiRoot, projectKey, subtaskKey), "briefing.md");
}

export function journalPath(taiRoot: string, projectKey: string, subtaskKey: string): string {
    return path.join(workItemDir(taiRoot, projectKey, subtaskKey), "journal.md");
}

export function workStatusPath(taiRoot: string, projectKey: string, subtaskKey: string): string {
    return path.join(workItemDir(taiRoot, projectKey, subtaskKey), "status.json");
}

export function rootStatusPath(taiRoot: string): string {
    return path.join(taiRoot, "status.json");
}

// ---------- shared JSON I/O ----------

/** Reads and JSON-parses a file; returns null (not an error) if it doesn't exist yet — a
 *  missing cache entry is an ordinary, expected state, not a failure. */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(filePath, "utf8")) as T;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
    }
}

/** Writes a value as pretty-printed JSON, creating parent directories as needed. */
export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}
