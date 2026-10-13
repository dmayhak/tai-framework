/**
 * TAI Framework — the journal file that stores the offline write queue (brief §7; TAI-56 ADR
 * decision 6, narrowed by TAI-490)
 *
 * Nothing writes it as a record of a session's steps; a later session picks work up from the
 * ticket's `Handoff:` comment (brief §3.9). It exists to hold the queued writes below.
 *
 * One `## <ISO-8601 timestamp> — <description>` entry per queued write or replay, optional
 * freeform detail below. `connectivity-queue.ts`'s `QUEUED:`/`REPLAYED:` entries are just this same shape with a
 * recognisable description prefix, parsed back out by `parseJournalEntries` — not a
 * separate file or format (ADR decision 3: "the journal is already the append-only ...
 * record ... so queuing pending writes there is the same mechanism, not a new one").
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { journalPath } from "../cache/paths.js";

export interface JournalEntry {
    readonly timestamp: string;
    readonly description: string;
    readonly detail: string;
}

// Restricted to the exact shape `new Date().toISOString()` always produces (millisecond
// precision, "Z" suffix) rather than a loose `\S+` — an unrestricted pattern would also
// match an ordinary "## Step — Setup"-style markdown sub-heading a persona writes into an
// entry's own detail body, splitting one entry into two (Gemini CLI review, PR #8).
const ENTRY_HEADER = /^## (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) — (.+)$/;

export async function appendJournalEntry(
    taiRoot: string,
    projectKey: string,
    subtaskKey: string,
    description: string,
    detail = ""
): Promise<void> {
    const filePath = journalPath(taiRoot, projectKey, subtaskKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    const exists = await readJournalRaw(filePath);
    const header = `## ${new Date().toISOString()} — ${description}\n`;
    const body = detail ? `${detail.trim()}\n` : "";
    await appendFile(filePath, (exists !== null ? "\n" : "") + header + body, "utf8");
}

/** Raw journal text, or null if nothing has been journaled yet for this subtask. */
export async function readJournal(taiRoot: string, projectKey: string, subtaskKey: string): Promise<string | null> {
    return readJournalRaw(journalPath(taiRoot, projectKey, subtaskKey));
}

async function readJournalRaw(filePath: string): Promise<string | null> {
    try {
        return await readFile(filePath, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
    }
}

/** Parses raw journal text into its individual entries, in file (chronological) order. */
export function parseJournalEntries(journalText: string): JournalEntry[] {
    const entries: JournalEntry[] = [];
    let current: { timestamp: string; description: string; detailLines: string[] } | null = null;

    for (const line of journalText.split("\n")) {
        const match = ENTRY_HEADER.exec(line);
        if (match) {
            if (current) entries.push(finalize(current));
            current = { timestamp: match[1]!, description: match[2]!, detailLines: [] };
        } else if (current) {
            current.detailLines.push(line);
        }
    }
    if (current) entries.push(finalize(current));
    return entries;
}

function finalize(current: { timestamp: string; description: string; detailLines: string[] }): JournalEntry {
    return { timestamp: current.timestamp, description: current.description, detail: current.detailLines.join("\n").trim() };
}
