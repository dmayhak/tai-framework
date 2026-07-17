import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { appendJournalEntry, parseJournalEntries, readJournal } from "./journal.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-journal-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("appendJournalEntry / readJournal", () => {
    it("returns null when nothing has been journaled yet", async () => {
        await withTempDir(async (dir) => {
            assert.equal(await readJournal(dir, "TAI", "TAI-1"), null);
        });
    });

    it("appends entries in order, creating the file and parent dirs on first write", async () => {
        await withTempDir(async (dir) => {
            await appendJournalEntry(dir, "TAI", "TAI-1", "Started work");
            await appendJournalEntry(dir, "TAI", "TAI-1", "Ran tests", "268/268 passing");
            const text = await readJournal(dir, "TAI", "TAI-1");
            assert.match(text ?? "", /Started work/);
            assert.match(text ?? "", /Ran tests/);
            assert.match(text ?? "", /268\/268 passing/);
            // "Started work" appears before "Ran tests" in the raw text
            assert.ok((text ?? "").indexOf("Started work") < (text ?? "").indexOf("Ran tests"));
        });
    });
});

describe("parseJournalEntries", () => {
    it("parses multiple entries with their detail bodies", () => {
        const text = [
            "## 2026-01-01T00:00:00.000Z — Started work",
            "",
            "## 2026-01-01T00:01:00.000Z — Ran tests",
            "268/268 passing",
            "typecheck clean",
        ].join("\n");
        const entries = parseJournalEntries(text);
        assert.equal(entries.length, 2);
        assert.equal(entries[0]?.description, "Started work");
        assert.equal(entries[0]?.detail, "");
        assert.equal(entries[1]?.description, "Ran tests");
        assert.equal(entries[1]?.detail, "268/268 passing\ntypecheck clean");
    });

    it("returns an empty array for an empty journal", () => {
        assert.deepEqual(parseJournalEntries(""), []);
    });

    it("does not split on a detail line that looks like a loose '## word — text' heading (Gemini CLI review, PR #8)", () => {
        const text = [
            "## 2026-01-01T00:00:00.000Z — Started work",
            "## Step — Setup",
            "some notes about the step",
            "## 2026-01-01T00:01:00.000Z — Ran tests",
        ].join("\n");
        const entries = parseJournalEntries(text);
        assert.equal(entries.length, 2);
        assert.equal(entries[0]?.description, "Started work");
        assert.match(entries[0]?.detail ?? "", /## Step — Setup/);
        assert.match(entries[0]?.detail ?? "", /some notes about the step/);
        assert.equal(entries[1]?.description, "Ran tests");
    });
});
