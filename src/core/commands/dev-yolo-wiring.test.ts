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

const BOT = { id: "bot", displayName: "Bot" } as unknown as HumanRef;
const HEAD = "abc1234def";

const REVIEWERS = "| Reviewer | GitHub | Marker |\n| --- | --- | --- |\n| a@b.co | me | |\n| bot@b.co | bot | automated |\n| human@b.co | h | |\n| nologin@b.co | | automated |";

const FINDINGS = (sev: string): string =>
    JSON.stringify({
        reviewOf: { repo: "o/r", pr: "7", commit: "abc1234def" },
        overview: "ok",
        coverage: { filesRead: ["a.ts"], commandsRun: [], claimsVerified: [], notChecked: "tests" },
        findings: sev ? [{ severity: sev, category: "Logic", title: "T", file: "a.ts", issue: "i" }] : [],
        leaning: "approve",
        leaningReason: "fine",
    });

async function world(run: (w: { wiring: YoloWiring; task: DevTask; handoffs: string[]; prompts: string[] }) => Promise<void>, over: { runClaude?: YoloWiring["runClaude"]; activity?: PullRequestActivity[]; heads?: string[]; reviewerId?: string; before?: PullRequestActivity[]; storyDescription?: string; approved?: boolean; mergeResult?: { ok: false; reason: string } } = {}): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-yolo-wire-"));
    try {
        const backend = createFilesystemBackend(dir, ME);
        const mk = (o: Record<string, unknown>) => backend.workTracker.createIssue({ projectKey: "TAI", persona: Persona.Developer, summary: "s", ...o } as never);
        const story = await mk({ issueType: StoryType.Story, ...(over.storyDescription !== undefined ? { description: over.storyDescription } : {}) });
        const dev = await mk({ issueType: SubtaskType.Dev, parentKey: story.key, assignee: ME });
        await backend.docStore.createPage({ spaceKey: "TAIT", title: "PR Reviewers", content: REVIEWERS });
        const taiDir = path.join(dir, ".tai");
        const ctx = { docStore: backend.docStore, spaceKey: "TAIT", email: "a@b.co", aiSession: false };
        await changeAdmin(ctx, "add", "a@b.co");
        await setSetting({ ...ctx, attest: (e, k, v) => recordAttestation(taiDir, e, k, v) }, "dev-yolo", "true");
        const pr = { id: 7, repo: "o/r", title: `${story.key} - ${dev.key} - x`, sourceBranch: "b", destinationBranch: "main", sourceCommit: HEAD, state: "open", reviewers: [], url: "https://pr/7" };
        const heads = [...(over.heads ?? [])];
        let activityReads = 0;
        const gitHost = {
            listPullRequests: async () => [pr],
            getPullRequest: async () => ({ ...pr, sourceCommit: heads.shift() ?? HEAD, ...(over.approved ? { reviewers: [{ human: BOT, status: "approved" }] } : {}) }),
            mergePullRequest: async () => over.mergeResult ?? { ok: true, pullRequest: pr },
            getCurrentUser: async () => ME,
            getCommitStatuses: async () => [],
            // The first read is before the reviewer run, the later ones after it.
            listPullRequestActivity: async () =>
                activityReads++ === 0
                    ? (over.before ?? [{ kind: "update", at: "t", sourceCommit: HEAD as never }])
                    : (over.activity ?? [{ kind: "update", at: "t", sourceCommit: HEAD as never }, { kind: "approval", at: "t", human: BOT }]),
        } as unknown as GitHost;
        const handoffs: string[] = [];
        const prompts: string[] = [];
        const wiring: YoloWiring = {
            gitHost, repos: ["o/r"] as never, workTracker: backend.workTracker, docStore: backend.docStore, spaceKey: "TAIT", projectKey: "TAI", taiDir, email: "a@b.co",
            cli: "tai", cwd: dir, timeoutMs: 1000, rounds: 4, checkConfigured: false,
            reviewer: { token: "tok-reviewer-123", email: "bot@b.co" },
            reviewerHost: { getCurrentUser: async () => ({ ...BOT, id: over.reviewerId ?? "bot" }) as HumanRef },
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

describe("yoloGate account identity (TAI-634)", () => {
    it("stops when the reviewer token is the person's own account", () =>
        world(async ({ wiring, task }) => {
            const asMe = { ...wiring, reviewerHost: { getCurrentUser: async () => ME } };
            assert.match((await yoloGate(asMe)(task)).join("\n"), /belongs to your own account/);
        }));

    it("stops when the reviewer token belongs to a different account than the page lists", () =>
        world(
            async ({ wiring, task }) => {
                assert.match((await yoloGate(wiring)(task)).join("\n"), /belongs to someone-else, but bot@b.co is listed on PR Reviewers as bot/);
            },
            { reviewerId: "someone-else" }
        ));
});

describe("yoloGate reviewer login (TAI-634)", () => {
    it("stops when the reviewer's row has no GitHub login, since that is how the account is recognised", () =>
        world(async ({ wiring, task }) => {
            const gate = await yoloGate({ ...wiring, reviewer: { token: "t", email: "nologin@b.co" } })(task);
            assert.match(gate.join("\n"), /nologin@b.co has no GitHub login on PR Reviewers/);
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
                assert.deepEqual(reviewer.env, { GITHUB_TOKEN: "tok-reviewer-123" });
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

    it("gives the reviewer the Story's numbered criteria, and says so when there are none (TAI-691)", async () => {
        const reviewerPrompt = async (storyDescription: string | undefined): Promise<string> => {
            let seen = "";
            await world(
                async ({ wiring, task }) => {
                    await yoloRun({ ...wiring, afterApproved: async () => ({ state: "handed-on", note: "merged" }) })(task);
                },
                {
                    ...(storyDescription !== undefined ? { storyDescription } : {}),
                    runClaude: async (prompt) => {
                        const file = /to (\S+findings\.json)/.exec(prompt)?.[1];
                        if (file) {
                            seen = prompt;
                            await writeFile(file, FINDINGS(""));
                        }
                        return { ok: true, summary: "" };
                    },
                }
            );
            return seen;
        };
        const withCriteria = await reviewerPrompt("Intro.\n\nAC-1: the report lists it.\nAC-2: a test covers it.");
        assert.match(withCriteria, /AC-1: the report lists it\.\nAC-2: a test covers it\./);
        assert.match(withCriteria, /does not meet is a "critical" finding/);
        assert.match(await reviewerPrompt("No criteria here."), /has no numbered acceptance criteria: review the diff as usual/);
    });

    it("tells the reviewer the criteria could not be read when the Story comes back empty (PR 31 review)", () => {
        let seen = "";
        return world(
            async ({ wiring, task }) => {
                const getIssue = wiring.workTracker.getIssue.bind(wiring.workTracker);
                const tracker = { ...wiring.workTracker, getIssue: async (key: string) => (key === task.parent.key ? null : getIssue(key as never)) } as unknown as YoloWiring["workTracker"];
                await yoloRun({ ...wiring, workTracker: tracker, afterApproved: async () => ({ state: "handed-on", note: "merged" }) })(task);
                assert.match(seen, /acceptance criteria could not be read: review the diff as usual/);
            },
            {
                runClaude: async (prompt) => {
                    const file = /to (\S+findings\.json)/.exec(prompt)?.[1];
                    if (file) {
                        seen = prompt;
                        await writeFile(file, FINDINGS(""));
                    }
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
                activity: [{ kind: "update", at: "t", sourceCommit: HEAD as never }],
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
    const findingsRun = (sev: string, commit = HEAD): NonNullable<YoloWiring["runClaude"]> => async (prompt) => {
        const file = /to (\S+findings\.json)/.exec(prompt)?.[1];
        if (file) await writeFile(file, FINDINGS(sev).replace(HEAD, commit));
        return { ok: true, summary: "" };
    };

    it("does not take an approval from another account as the reviewer's", () =>
        world(
            async ({ wiring, task, handoffs }) => {
                await yoloRun(wiring)(task);
                assert.match(handoffs[0]!, /cast no approval/);
            },
            { activity: [{ kind: "update", at: "t", sourceCommit: HEAD as never }, { kind: "approval", at: "t", human: ME }], runClaude: findingsRun("") }
        ));

    it("stops when the findings are of another commit than the PR's head", () =>
        world(
            async ({ wiring, task, handoffs }) => {
                await yoloRun(wiring)(task);
                assert.match(handoffs[0]!, /review is of commit 9999999aaa, but the PR is at abc1234def/);
            },
            { runClaude: findingsRun("", "9999999aaa") }
        ));

    it("stops when the PR moved during the review", () =>
        world(
            async ({ wiring, task, handoffs }) => {
                await yoloRun(wiring)(task);
                assert.match(handoffs[0]!, /moved from abc1234def to eeeeeee111 during the review/);
            },
            { heads: [HEAD, "eeeeeee111"], runClaude: findingsRun("") }
        ));

    it("writes the findings file under the .tai directory, where the run may write", () => {
        const paths: string[] = [];
        return world(
            async ({ wiring, task }) => {
                await yoloRun(wiring)(task);
                assert.ok(paths[0]!.startsWith(wiring.taiDir + path.sep), paths[0]);
            },
            {
                runClaude: async (prompt) => {
                    const file = /to (\S+findings\.json)/.exec(prompt)?.[1];
                    if (file) paths.push(file);
                    return { ok: true, summary: "" };
                },
            }
        );
    });
    it("stops when the findings are of another PR", () =>
        world(
            async ({ wiring, task, handoffs }) => {
                await yoloRun(wiring)(task);
                assert.match(handoffs[0]!, /review is of o\/r PR 99, not o\/r PR 7/);
            },
            {
                runClaude: async (prompt) => {
                    const file = /to (\S+findings\.json)/.exec(prompt)?.[1];
                    if (file) await writeFile(file, FINDINGS("").replace('"pr":"7"', '"pr":"99"'));
                    return { ok: true, summary: "" };
                },
            }
        ));
    it("does not take an approval the reviewer cast in an earlier, abandoned run as this run's decision", () =>
        world(
            async ({ wiring, task, handoffs }) => {
                await yoloRun(wiring)(task);
                assert.match(handoffs[0]!, /cast no approval/);
            },
            {
                before: [{ kind: "update", at: "t", sourceCommit: HEAD as never }, { kind: "approval", at: "t", human: BOT }],
                activity: [{ kind: "update", at: "t", sourceCommit: HEAD as never }, { kind: "approval", at: "t", human: BOT }],
                runClaude: findingsRun(""),
            }
        ));
    const FINISH = { checkCommand: null, stamp: (b: string) => b, assertClean: async () => undefined, prepare: async () => undefined };

    it("hands an approved PR to the merge, verify and close step when finish is configured", () =>
        world(
            async ({ wiring, task, handoffs }) => {
                const out = await yoloRun({ ...wiring, finish: FINISH })(task);
                assert.equal(out.state, "waiting");
                // The fake PR has no approvals, so the real gate refuses: the step ran, and nothing says the merge is out of this version.
                assert.match(handoffs[0]!, /the merge gate refused/);
                assert.doesNotMatch(handoffs[0]!, /not in this version/);
            },
            { runClaude: findingsRun("") }
        ));

    // TAI-736: the conflict resolver is wired through the real merge step, not a stub.
    // The resolver's prompt, told apart from the build, review and fix prompts by this phrase of buildConflictPrompt.
    const RESOLVER_PROMPT = /cannot merge because it conflicts/;
    const conflictRefusal = { ok: false as const, reason: "Pull Request has merge conflicts" };
    const reviewAndRecord = (seen: string[]): NonNullable<YoloWiring["runClaude"]> => async (prompt, options) => {
        seen.push(prompt);
        return findingsRun("")(prompt, options);
    };

    it("runs the conflict resolver with the PR's branch and the default branch when the merge is refused for a conflict (TAI-736)", async () => {
        const seen: string[] = [];
        await world(
            async ({ wiring, task, handoffs }) => {
                const out = await yoloRun({ ...wiring, finish: FINISH })(task);
                const resolver = seen.filter((p) => RESOLVER_PROMPT.test(p));
                assert.equal(resolver.length, 1);
                assert.match(resolver[0]!, new RegExp(`PR 7 of o/r \\(branch b\\)[^]*conflicts with main`));
                assert.match(resolver[0]!, /git merge origin\/main/);
                assert.match(resolver[0]!, /`tai git-pr check o\/r 7`/);
                // The resolver pushed nothing here (the head never moved), so the run stops for a person and does not call it a plain refusal.
                assert.equal(out.state, "waiting");
                assert.match(handoffs[0]!, /nothing was pushed \(the refusal was "Pull Request has merge conflicts"/);
                assert.doesNotMatch(handoffs[0]!, /the merge was refused/);
            },
            { approved: true, mergeResult: conflictRefusal, runClaude: reviewAndRecord(seen) }
        );
    });

    it("stops with a hand-off naming the failure when the resolver run dies, as it can mid-merge (TAI-736)", async () => {
        const dying: NonNullable<YoloWiring["runClaude"]> = async (prompt, options) =>
            RESOLVER_PROMPT.test(prompt) ? { ok: false, summary: "timed out in the middle of the merge" } : findingsRun("")(prompt, options);
        await world(
            async ({ wiring, task, handoffs }) => {
                const out = await yoloRun({ ...wiring, finish: FINISH })(task);
                assert.equal(out.state, "waiting");
                assert.match(handoffs[0]!, /the conflict could not be resolved[^]*timed out in the middle of the merge/);
            },
            { approved: true, mergeResult: conflictRefusal, runClaude: dying }
        );
    });

    it("does not wire the resolver when afterApproved is supplied: a conflict it reports stops for a person (TAI-736)", async () => {
        const seen: string[] = [];
        await world(
            async ({ wiring, task, handoffs }) => {
                const out = await yoloRun({ ...wiring, finish: FINISH, afterApproved: async () => ({ state: "conflict", reason: "x conflicts" }) })(task);
                assert.equal(out.state, "waiting");
                assert.equal(seen.filter((p) => RESOLVER_PROMPT.test(p)).length, 0);
                assert.match(handoffs[0]!, /resolve the conflict, then merge it through the gate/);
            },
            { runClaude: reviewAndRecord(seen) }
        );
    });

    it("leaves a refusal that is not a conflict as a plain refusal, with no resolver run (TAI-736)", async () => {
        const seen: string[] = [];
        await world(
            async ({ wiring, task, handoffs }) => {
                const out = await yoloRun({ ...wiring, finish: FINISH })(task);
                assert.equal(out.state, "waiting");
                assert.equal(seen.filter((p) => RESOLVER_PROMPT.test(p)).length, 0);
                assert.match(handoffs[0]!, /the merge was refused: Branch protection blocks it/);
            },
            { approved: true, mergeResult: { ok: false, reason: "Branch protection blocks it" }, runClaude: reviewAndRecord(seen) }
        );
    });

    it("uses afterApproved over finish when both are given, and ends at the approval with neither", async () => {
        await world(
            async ({ wiring, task, handoffs }) => {
                const out = await yoloRun({ ...wiring, finish: FINISH, afterApproved: async () => ({ state: "handed-on", note: "custom" }) })(task);
                assert.deepEqual(out, { state: "handed-on", note: "custom" });
                assert.deepEqual(handoffs, []);
            },
            { runClaude: findingsRun("") }
        );
        await world(
            async ({ wiring, task, handoffs }) => {
                await yoloRun(wiring)(task);
                assert.match(handoffs[0]!, /not in this version/);
            },
            { runClaude: findingsRun("") }
        );
    });
});
