import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Persona, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, type HumanRef } from "../storage/interface.js";
import type { GitHost, PullRequestActivity } from "../git/interface.js";
import { recordAttestation } from "../settings/attestation.js";
import { changeAdmin, setSetting } from "./settings.js";
import type { DevTask } from "./do-dev-tasks.js";
import { yoloGate, yoloRun, type YoloWiring } from "./dev-yolo-wiring.js";

const ME: HumanRef = { id: toHumanId("a@b.co"), displayName: "A", email: "a@b.co" };

const REVIEWERS = "| Reviewer | GitHub | Marker |\n| --- | --- | --- |\n| a@b.co | me | |\n| bot@b.co | bot | automated |\n| human@b.co | h | |";

const FINDINGS = (sev: string): string =>
    JSON.stringify({
        reviewOf: { repo: "o/r", pr: "7", commit: "abc1234" },
        overview: "ok",
        coverage: { filesRead: ["a.ts"], commandsRun: [], claimsVerified: [], notChecked: "tests" },
        findings: sev ? [{ severity: sev, category: "Logic", title: "T", file: "a.ts", issue: "i" }] : [],
        leaning: "approve",
        leaningReason: "fine",
    });

async function world(run: (w: { wiring: YoloWiring; task: DevTask; handoffs: string[]; prompts: string[] }) => Promise<void>, over: { runClaude?: YoloWiring["runClaude"]; activity?: PullRequestActivity[] } = {}): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-yolo-wire-"));
    try {
        const backend = createFilesystemBackend(dir, ME);
        const mk = (o: Record<string, unknown>) => backend.workTracker.createIssue({ projectKey: "TAI", persona: Persona.Developer, summary: "s", ...o } as never);
        const story = await mk({ issueType: StoryType.Story });
        const dev = await mk({ issueType: SubtaskType.Dev, parentKey: story.key, assignee: ME });
        await backend.docStore.createPage({ spaceKey: "TAIT", title: "PR Reviewers", content: REVIEWERS });
        const taiDir = path.join(dir, ".tai");
        const ctx = { docStore: backend.docStore, spaceKey: "TAIT", email: "a@b.co", aiSession: false };
        await changeAdmin(ctx, "add", "a@b.co");
        await setSetting({ ...ctx, attest: (e, k, v) => recordAttestation(taiDir, e, k, v) }, "dev-yolo", "true");
        const pr = { id: 7, repo: "o/r", title: `${story.key} - ${dev.key} - x`, sourceBranch: "b", sourceCommit: "c1", url: "https://pr/7" };
        const gitHost = {
            listPullRequests: async () => [pr],
            getPullRequest: async () => pr,
            getCommitStatuses: async () => [],
            listPullRequestActivity: async () => over.activity ?? [{ kind: "update", at: "t", sourceCommit: "c1" as never }, { kind: "approval", at: "t", human: ME }],
        } as unknown as GitHost;
        const handoffs: string[] = [];
        const prompts: string[] = [];
        const wiring: YoloWiring = {
            gitHost, repos: ["o/r"] as never, workTracker: backend.workTracker, docStore: backend.docStore, spaceKey: "TAIT", projectKey: "TAI", taiDir, email: "a@b.co",
            cli: "tai", cwd: dir, timeoutMs: 1000, rounds: 4, checkConfigured: false,
            reviewer: { token: "tok-reviewer-123", email: "bot@b.co" },
            handoff: async (_k, b) => void handoffs.push(b),
            runClaude: over.runClaude ?? (async (p) => (prompts.push(p), { ok: true, summary: "" })),
        };
        await run({ wiring, task: { issue: dev, parent: story }, handoffs, prompts });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("yoloGate (TAI-634)", () => {
    it("is clear with the stop checks met and an automated reviewer on the page", () =>
        world(async ({ wiring, task }) => {
            assert.deepEqual(await yoloGate(wiring)(task), []);
        }));

    it("names a missing reviewer account, one not on the page, one without the marker, and one that is the same person", () =>
        world(async ({ wiring, task }) => {
            const gate = (reviewer: YoloWiring["reviewer"], email = "a@b.co") => yoloGate({ ...wiring, reviewer, email })(task).then((r) => r.join("\n"));
            assert.match(await gate({ token: undefined, email: undefined }), /no automated reviewer account is configured/);
            assert.match(await gate({ token: "t", email: "ghost@b.co" }), /ghost@b.co is not on the PR Reviewers page/);
            assert.match(await gate({ token: "t", email: "human@b.co" }), /without the automated marker/);
            assert.match(await gate({ token: "t", email: "bot@b.co" }, "bot@b.co"), /different account from yours/);
        }));
});

describe("yoloRun wiring (TAI-634)", () => {
    it("runs the reviewer with its own credentials and reads the findings it left", () => {
        const seen: { prompt: string; env?: Readonly<Record<string, string>> }[] = [];
        return world(
            async ({ wiring, task, handoffs }) => {
                const out = await yoloRun({ ...wiring, afterApproved: async () => ({ state: "handed-on", note: "merged" }) })(task);
                assert.equal(out.state, "handed-on");
                assert.deepEqual(handoffs, []);
                const reviewer = seen.find((s) => /automated Code Reviewer/.test(s.prompt))!;
                assert.deepEqual(reviewer.env, { GITHUB_TOKEN: "tok-reviewer-123", TAI_JIRA_EMAIL: "bot@b.co" });
                assert.equal(seen.find((s) => /You are working Jira ticket/.test(s.prompt))!.env, undefined);
            },
            {
                runClaude: async (prompt, options) => {
                    seen.push({ prompt, ...(options.env ? { env: options.env } : {}) });
                    const file = /to (\S+findings\.json)/.exec(prompt)?.[1];
                    if (file) await writeFile(file, FINDINGS(""));
                    return { ok: true, summary: "" };
                },
            }
        );
    });

    it("stops with a hand-off when the reviewer left no findings file", () =>
        world(async ({ wiring, task, handoffs }) => {
            const out = await yoloRun(wiring)(task);
            assert.equal(out.state, "waiting");
            assert.match(handoffs[0]!, /left no findings file/);
        }));

    it("stops when the reviewer cast no approval on the current head", () =>
        world(
            async ({ wiring, task, handoffs }) => {
                await yoloRun(wiring)(task);
                assert.match(handoffs[0]!, /cast no approval/);
            },
            {
                activity: [{ kind: "update", at: "t", sourceCommit: "c1" as never }],
                runClaude: async (prompt) => {
                    const file = /to (\S+findings\.json)/.exec(prompt)?.[1];
                    if (file) await writeFile(file, FINDINGS(""));
                    return { ok: true, summary: "" };
                },
            }
        ));
    it("gives the fix run the PR's branch and the findings, and keeps the approval when it pushed nothing", () => {
        const fixes: string[] = [];
        return world(
            async ({ wiring, task }) => {
                const out = await yoloRun({ ...wiring, afterApproved: async () => ({ state: "handed-on", note: "merged" }) })(task);
                assert.equal(out.state, "handed-on");
                assert.equal(fixes.length, 1);
                assert.match(fixes[0]!, /branch b\)/);
                assert.match(fixes[0]!, /"title": "T"/);
            },
            {
                runClaude: async (prompt) => {
                    const file = /to (\S+findings\.json)/.exec(prompt)?.[1];
                    if (file) await writeFile(file, FINDINGS("suggestion"));
                    if (/You are the Developer for ticket/.test(prompt)) fixes.push(prompt);
                    return { ok: true, summary: "" };
                },
            }
        );
    });
});
