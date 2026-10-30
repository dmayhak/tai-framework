import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { revisionProblems } from "./revisions.js";

const log = (...revs: number[]) => revs.map((r) => `## rev ${r} (2026-10-30)\n\ntext\n`).join("\n");
const brief = (rev: number) => `> **Last updated:** 2026-10-30 (rev ${rev}). The revision history is in \`CHANGELOG.md\`.\n`;

describe("revisionProblems (TAI-731)", () => {
    it("is clear for entries that run newest first with no number skipped, and a header that names the newest", () => {
        assert.deepEqual(revisionProblems(log(160, 159, 158), brief(160)), []);
    });

    it("names a rev that two changes both took", () => {
        assert.deepEqual(revisionProblems(log(159, 159, 158), brief(159)), ["rev 159 appears more than once in CHANGELOG.md"]);
    });

    it("names a skipped number and an entry out of order", () => {
        assert.match(revisionProblems(log(160, 158), brief(160)).join("\n"), /goes from rev 160 to rev 158/);
        assert.match(revisionProblems(log(158, 159), brief(158)).join("\n"), /goes from rev 158 to rev 159/);
    });

    it("names a header that is not the newest entry, or that names no rev", () => {
        assert.match(revisionProblems(log(160, 159), brief(159)).join("\n"), /header says rev 159, but the newest CHANGELOG.md entry is rev 160/);
        assert.match(revisionProblems(log(160), "> **Last updated:** 2026-10-30.\n").join("\n"), /names no `\(rev N\)`/);
        assert.match(revisionProblems("no entries", brief(1)).join("\n"), /no `## rev N` entry/);
    });

    it("leaves the old entries' gap alone: a gap below rev 81 is not reported", () => {
        assert.deepEqual(revisionProblems(log(82, 81, 80, 15, 13), brief(82)), []);
    });

    it("finds nothing wrong with this repository's CHANGELOG.md and brief", async () => {
        const root = path.resolve(import.meta.dirname, "../../..");
        const [changelog, theBrief] = await Promise.all([readFile(path.join(root, "CHANGELOG.md"), "utf8"), readFile(path.join(root, "PROJECT_BRIEF.md"), "utf8")]);
        assert.deepEqual(revisionProblems(changelog, theBrief), [], "renumber your entry to the next number after the newest one on main, in CHANGELOG.md and the brief's header");
    });
});
