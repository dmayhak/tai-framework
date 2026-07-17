/**
 * TAI Framework — per-item and root-rollup status.json (brief §7; TAI-56 ADR decision 6)
 *
 * Root `status.json` is purely a rollup/index, never authoritative — brief §7's own words,
 * carried through unchanged: `rollupStatus` just scans every `.tai/work/<project>/<subtask>/
 * status.json` it can find and re-derives the aggregate each time, rather than being
 * incrementally maintained.
 */

import { readdir } from "node:fs/promises";
import { readJsonFile, rootStatusPath, workRootDir, workStatusPath, writeJsonFile } from "../cache/paths.js";
import path from "node:path";

export type WorkItemState = "in-progress" | "blocked" | "done";

export interface WorkItemStatus {
    readonly subtaskKey: string;
    readonly currentStep: string;
    readonly state: WorkItemState;
    readonly updatedAt: string;
}

export async function writeWorkStatus(taiRoot: string, projectKey: string, status: WorkItemStatus): Promise<void> {
    await writeJsonFile(workStatusPath(taiRoot, projectKey, status.subtaskKey), status);
}

export async function readWorkStatus(taiRoot: string, projectKey: string, subtaskKey: string): Promise<WorkItemStatus | null> {
    return readJsonFile<WorkItemStatus>(workStatusPath(taiRoot, projectKey, subtaskKey));
}

export interface RootStatusRollup {
    readonly generatedAt: string;
    readonly items: readonly WorkItemStatus[];
}

/** Scans every project/subtask under `.tai/work/`, rebuilds the root rollup, and writes it
 *  to `.tai/status.json`. Missing directories are treated as "nothing in flight," not an
 *  error — a fresh checkout has no `.tai/work/` yet. */
export async function rollupStatus(taiRoot: string): Promise<RootStatusRollup> {
    const items: WorkItemStatus[] = [];

    for (const projectKey of await listSubdirs(workRootDir(taiRoot))) {
        for (const subtaskKey of await listSubdirs(path.join(workRootDir(taiRoot), projectKey))) {
            const status = await readWorkStatus(taiRoot, projectKey, subtaskKey);
            if (status) items.push(status);
        }
    }

    const rollup: RootStatusRollup = { generatedAt: new Date().toISOString(), items };
    await writeJsonFile(rootStatusPath(taiRoot), rollup);
    return rollup;
}

async function listSubdirs(dir: string): Promise<string[]> {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
    }
}
