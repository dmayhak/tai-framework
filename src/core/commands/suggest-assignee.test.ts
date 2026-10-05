import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Persona, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, type HumanRef, type WorkTracker } from "../storage/interface.js";
import { parseRoster } from "../personas/roster.js";
import { suggestAssignees } from "./suggest-assignee.js";

const person = (name: string): HumanRef => ({ id: toHumanId(`acct-${name}`), displayName: name, email: `${name.toLowerCase()}@example.com` });
const ANN = person("Ann");
const BO = person("Bo");
const DIRECTORY = new Map([ANN, BO].map((h) => [h.email!, h]));
const ROSTER = parseRoster("| Persona | Humans |\n| --- | --- |\n| Developer | Ann (ann@example.com), Bo (bo@example.com) |");

async function withTracker(fn: (wt: WorkTracker) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-suggest-"));
    try {
        const backend = createFilesystemBackend(dir, ANN);
        await fn(Object.assign(Object.create(backend.workTracker), { resolveHuman: async (e: string) => DIRECTORY.get(e) ?? null }) as WorkTracker);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("suggestAssignees (TAI-419)", () => {
    it("ranks the persona's roster candidates by the ticket's own signals and renders the list with reasons", async () => {
        await withTracker(async (wt) => {
            const story = await wt.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "s", persona: Persona.Pm });
            await wt.createIssue({ projectKey: "TAI", issueType: SubtaskType.Dev, parentKey: story.key, summary: "d", assignee: BO });
            const test = await wt.createIssue({ projectKey: "TAI", issueType: SubtaskType.IntegrationTest, parentKey: story.key, summary: "t", persona: Persona.Developer });
            const result = await suggestAssignees({ workTracker: wt, roster: ROSTER }, test, {});
            assert.deepEqual(result.ranked.map((r) => r.candidate.displayName), ["Bo", "Ann"]);
            assert.match(result.text, /Needs an assignee: .* — candidates for Developer, best first:/);
            assert.match(result.text, /1\. Bo \(bo@example\.com\) — worked on this Story/);
            assert.match(result.text, /Leave unassigned/);
        });
    });

    it("pins the session's human first with 'you are creating it' when asked to", async () => {
        await withTracker(async (wt) => {
            const issue = await wt.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "s", persona: Persona.Developer });
            const result = await suggestAssignees({ workTracker: wt, roster: ROSTER }, issue, { pin: BO });
            assert.equal(result.ranked[0]!.candidate.displayName, "Bo");
            assert.deepEqual(result.ranked[0]!.reasons, ["you are creating it"]);
        });
    });

    it("a ticket with no persona says so instead of guessing", async () => {
        await withTracker(async (wt) => {
            const issue = await wt.createIssue({ projectKey: "TAI", issueType: StoryType.Story, summary: "s" });
            const none = await wt.updateIssue(issue.key, { persona: null });
            const result = await suggestAssignees({ workTracker: wt, roster: ROSTER }, none, {});
            assert.deepEqual(result.ranked, []);
            assert.match(result.text, /has no persona/);
        });
    });
});
