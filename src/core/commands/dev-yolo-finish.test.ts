import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, type HumanRef } from "../storage/interface.js";
import { stampComment } from "../storage/stamp.js";
import type { GitHost, PullRequestRef } from "../git/interface.js";
import type { DevTask } from "./do-dev-tasks.js";
import { automatedMergeComment, finishApproved, verificationVerdict, type FinishDeps } from "./dev-yolo-finish.js";

const TESTER = { id: "tester", displayName: "Tessa" };
const ME: HumanRef = { id: toHumanId("a@b.co"), displayName: "A", email: "a@b.co" };
const BOT = { id: toHumanId("bot"), displayName: "Bot" } as HumanRef;
const HEAD = "abc1234def";

interface Run {
    deps: FinishDeps;
    task: DevTask;
    log: string[];
    handoffs: string[];
    keys: string[];
    pr: { sourceCommit: string; state: string; statuses: { key: string; state: string }[]; approvedBy: HumanRef[]; mergeResult: { ok: boolean; reason?: string }; mergeThrows?: boolean; mergedAfterThrow?: boolean; commentFails?: boolean };
    verdict: { text: string | null; ok: boolean };
    tracker: ReturnType<typeof createFilesystemBackend>["workTracker"];
}

async function world(run: (r: Run) => Promise<void>, over: { subtask?: SubtaskType; subtaskStatus?: Status } = {}): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-finish-"));
    try {
        const backend = createFilesystemBackend(dir, ME);
        const mk = (o: Record<string, unknown>) => backend.workTracker.createIssue({ projectKey: "TAI", persona: Persona.Developer, summary: "s", ...o } as never);
        const story = await mk({ issueType: StoryType.Story });
        const dev = await mk({ issueType: SubtaskType.Dev, parentKey: story.key, assignee: ME });
        await backend.workTracker.transition(dev.key, Status.InProgress);
        if (over.subtask) {
            const t = await mk({ issueType: over.subtask, parentKey: story.key });
            if (over.subtaskStatus) await backend.workTracker.transition(t.key, over.subtaskStatus);
        }
        const log: string[] = [];
        const handoffs: string[] = [];
        const keys: string[] = [];
        const state: Run["pr"] = { sourceCommit: HEAD, state: "open", statuses: [{ key: "tai-check", state: "successful" }], approvedBy: [BOT], mergeResult: { ok: true } };
        const verdict: Run["verdict"] = { text: "Verified: all 1 criteria met", ok: true };
        const ref = () => ({
            id: 7, repo: "o/r", title: "t", sourceCommit: state.sourceCommit, state: state.state, url: "https://pr/7", sourceBranch: "b", destinationBranch: "main", author: ME, createdAt: "", updatedAt: "",
            reviewers: state.approvedBy.map((human) => ({ human, status: "approved" })),
        }) as unknown as PullRequestRef;
        const gitHost = {
            getPullRequest: async () => ref(),
            getCommitStatuses: async () => state.statuses,
            listPullRequestActivity: async () => [{ kind: "update", at: "t", sourceCommit: state.sourceCommit }, ...state.approvedBy.map((human) => ({ kind: "approval", at: "t", human }))],
            mergePullRequest: async (_r: unknown, _i: unknown, _s: unknown, o: { expectedHead?: string }) => {
                log.push(`merge expected=${o.expectedHead}`);
                if (state.mergeThrows) {
                    if (state.mergedAfterThrow) state.state = "merged";
                    throw new Error("socket hang up");
                }
                return state.mergeResult.ok ? { ok: true, pullRequest: ref() } : { ok: false, reason: state.mergeResult.reason ?? "no" };
            },
            addPullRequestComment: async (_r: unknown, _i: unknown, body: string) => {
                if (state.commentFails) throw new Error("comment refused");
                log.push(`comment: ${body}`);
            },
        } as unknown as GitHost;
        const deps: FinishDeps = {
            gitHost,
            workTracker: backend.workTracker,
            projectKey: "TAI",
            pullRequest: async () => ref(),
            checkCommand: "npm test",
            reviewer: async () => BOT,
            stamp: (b) => `${b}\n\n[stamp]`,
            prepare: async () => void log.push("prepare"),
            verify: async () => {
                log.push("verify");
                if (verdict.text) await backend.workTracker.addComment(story.key, stampComment(verdict.text, TESTER));
                return { ok: verdict.ok, summary: "verify failed" };
            },
            assertClean: async () => void log.push("clean"),
            handoff: async (k, b) => {
                keys.push(k);
                handoffs.push(b);
            },
        };
        await run({ deps, task: { issue: dev, parent: story }, log, handoffs, keys, pr: state, verdict, tracker: backend.workTracker });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("finishApproved (TAI-634)", () => {
    it("merges through the gate on the checked commit, says the approval was automated, verifies, and closes the Story only on Verified:", () =>
        world(async ({ deps, task, log, handoffs, tracker }) => {
            const out = await finishApproved(deps)(task, "https://pr/7");
            assert.equal(out.state, "handed-on");
            assert.match((out as { note: string }).note, /merged https:\/\/pr\/7, verified and closed/);
            assert.deepEqual(handoffs, []);
            assert.deepEqual(log.slice(0, 2), ["clean", `merge expected=${HEAD}`]);
            assert.match(log[2]!, /comment: Merged by an unattended DEV-YOLO run. The approval was automated: it was cast by Bot \(bot\)/);
            assert.deepEqual(log.slice(3), ["prepare", "verify"]);
            assert.equal((await tracker.getIssue(task.issue.key))!.status, Status.Done);
            assert.equal((await tracker.getIssue(task.parent.key))!.status, Status.Done);
        }));

    it("leaves the Story open on Not verified: and says so", () =>
        world(async ({ deps, task, handoffs, tracker, verdict }) => {
            verdict.text = "Not verified: 1 of 2 criteria not met";
            const out = await finishApproved(deps)(task, "u");
            assert.equal(out.state, "waiting");
            assert.match(handoffs[0]!, /was not verified against its criteria, so it stays open/);
            assert.notEqual((await tracker.getIssue(task.parent.key))!.status, Status.Done);
        }));

    it("does not close on an older verdict: only a comment from this verification run counts", () =>
        world(async ({ deps, task, handoffs, tracker, verdict }) => {
            await tracker.addComment(task.parent.key, stampComment("Verified: all 1 criteria met", TESTER));
            verdict.text = null;
            const out = await finishApproved(deps)(task, "u");
            assert.equal(out.state, "waiting");
            assert.match(handoffs[0]!, /left no Verified: or Not verified: comment/);
            assert.notEqual((await tracker.getIssue(task.parent.key))!.status, Status.Done);
        }));

    it("stops, without merging, when the check is not green, the PR is closed, or the gate refuses", async () => {
        await world(async ({ deps, task, log, handoffs, pr }) => {
            pr.statuses = [{ key: "tai-check", state: "failed" }];
            await finishApproved(deps)(task, "u");
            assert.match(handoffs[0]!, /the check is not green/);
            assert.deepEqual(log, []);
        });
        await world(async ({ deps, task, log, handoffs, pr }) => {
            pr.state = "merged";
            await finishApproved(deps)(task, "u");
            assert.match(handoffs[0]!, /no longer open/);
            assert.deepEqual(log, []);
        });
        await world(async ({ deps, task, log, handoffs }) => {
            await finishApproved({ ...deps, checkCommand: "npm test", requiredApprovals: 2 })(task, "u");
            assert.match(handoffs[0]!, /merge gate refused: Needs 2 approvals/);
            assert.deepEqual(log, []);
        });
    });

    it("refuses when an open test tier is on the Story, and when the approval is not the automated reviewer's", async () => {
        await world(
            async ({ deps, task, log, handoffs }) => {
                await finishApproved(deps)(task, "u");
                assert.match(handoffs[0]!, /Test tier .* is Backlog, not Done\.$/m);
                assert.deepEqual(log, []);
            },
            { subtask: SubtaskType.IntegrationTest }
        );
        await world(async ({ deps, task, log, handoffs, pr }) => {
            pr.approvedBy = [ME];
            await finishApproved(deps)(task, "u");
            assert.match(handoffs[0]!, /automated reviewer \(bot\) has no approval on the current commit/);
            assert.deepEqual(log, []);
        });
    });

    it("stops when the merge is refused, never forcing", () =>
        world(async ({ deps, task, handoffs, pr }) => {
            pr.mergeResult = { ok: false, reason: "head moved" };
            const out = await finishApproved(deps)(task, "u");
            assert.equal(out.state, "waiting");
            assert.match(handoffs[0]!, /not merged by this run.*the merge was refused: head moved/s);
        }));

    it("says the PR merged when a later step stops: the checkout cannot be updated, or the verification run fails", async () => {
        await world(async ({ deps, task, handoffs }) => {
            await finishApproved({ ...deps, prepare: async () => { throw new Error("dirty tree"); } })(task, "u");
            assert.match(handoffs[0]!, /Dev ticket TAI-\d+ is Done: its PR was reviewed and approved by the automated reviewer and merged/);
            assert.match(handoffs[0]!, /checkout could not be updated for the verification: dirty tree/);
        });
        await world(async ({ deps, task, handoffs, verdict }) => {
            verdict.ok = false;
            await finishApproved(deps)(task, "u");
            assert.match(handoffs[0]!, /the verification run did not finish: verify failed/);
        });
    });

    it("still reports a stop when the hand-off cannot be posted", () =>
        world(async ({ deps, task, pr }) => {
            pr.statuses = [{ key: "tai-check", state: "failed" }];
            const out = await finishApproved({ ...deps, handoff: async () => { throw new Error("jira down"); } })(task, "u");
            assert.match((out as { reason: string }).reason, /hand-off comment could not be posted: jira down/);
        }));
});

describe("finishApproved hardening (PR 23 review)", () => {
    it("keeps the Story open when any new verdict is Not verified:, even with a Verified: after it", () =>
        world(async ({ deps, task, handoffs, tracker }) => {
            const verify = deps.verify;
            const out = await finishApproved({
                ...deps,
                verify: async (t) => {
                    await tracker.addComment(task.parent.key, stampComment("Not verified: 1 of 2 criteria not met", TESTER));
                    return verify(t);
                },
            })(task, "u");
            assert.equal(out.state, "waiting");
            assert.match(handoffs[0]!, /was not verified against its criteria/);
        }));

    it("ignores a verdict that is not from the Tester, or is not the comment's first line", () =>
        world(async ({ deps, task, handoffs, verdict, tracker }) => {
            verdict.text = null;
            const out = await finishApproved({
                ...deps,
                verify: async () => {
                    await tracker.addComment(task.parent.key, "Verified: all 1 criteria met"); // a person's, unstamped
                    await tracker.addComment(task.parent.key, stampComment("Notes\nVerified: all 1 criteria met", TESTER)); // not the first line
                    return { ok: true, summary: "" };
                },
            })(task, "u");
            assert.equal(out.state, "waiting");
            assert.match(handoffs[0]!, /left no Verified: or Not verified: comment from the Tester/);
        }));

    it("does not close a verified Story while other work on it is open", () =>
        world(
            async ({ deps, task, handoffs, tracker }) => {
                const out = await finishApproved(deps)(task, "u");
                assert.equal(out.state, "waiting");
                assert.match(handoffs[0]!, /was verified, but other work on it is still open \(TAI-\d+\)/);
                assert.notEqual((await tracker.getIssue(task.parent.key))!.status, Status.Done);
            },
            { subtask: SubtaskType.Infra }
        ));

    it("carries the note about a missing merge comment into a later stop", () =>
        world(async ({ deps, task, handoffs, pr }) => {
            pr.commentFails = true;
            await finishApproved({ ...deps, prepare: async () => { throw new Error("dirty tree"); } })(task, "u");
            assert.match(handoffs[0]!, /Note: the merge comment could not be posted: comment refused\./);
        }));

    it("goes on as merged when the merge call threw after the host merged, and stops with the error when it did not", async () => {
        await world(async ({ deps, task, handoffs, pr }) => {
            pr.mergeThrows = true;
            pr.mergedAfterThrow = true;
            const out = await finishApproved(deps)(task, "u");
            assert.equal(out.state, "handed-on");
            assert.match((out as { note: string }).note, /the merge call failed \(socket hang up\) but the host shows the PR merged/);
            assert.deepEqual(handoffs, []);
        });
        await world(async ({ deps, task, handoffs, pr }) => {
            pr.mergeThrows = true;
            await finishApproved(deps)(task, "u");
            assert.match(handoffs[0]!, /not merged by this run.*an error: socket hang up/s);
        });
    });
});

describe("finishApproved hand-off placement (TAI-664)", () => {
    it("posts a stop before the merge on the Dev ticket, and one after the merge on the Story that stays open", async () => {
        await world(async ({ deps, task, keys, pr }) => {
            pr.statuses = [{ key: "tai-check", state: "failed" }];
            await finishApproved(deps)(task, "u");
            assert.deepEqual(keys, [task.issue.key]);
        });
        await world(async ({ deps, task, keys, handoffs }) => {
            await finishApproved({ ...deps, prepare: async () => { throw new Error("pull failed"); } })(task, "u");
            assert.deepEqual(keys, [task.parent.key]);
            assert.match(handoffs[0]!, new RegExp(`Dev ticket ${task.issue.key} is Done`));
        });
        await world(async ({ deps, task, keys, verdict }) => {
            verdict.text = "Not verified: 1 of 2 criteria not met";
            await finishApproved(deps)(task, "u");
            assert.deepEqual(keys, [task.parent.key]);
        });
    });

    it("stops before the merge when the working tree is dirty, with the PR still open", () =>
        world(async ({ deps, task, log, keys, handoffs }) => {
            const out = await finishApproved({ ...deps, assertClean: async () => { throw new Error("M a.ts"); } })(task, "u");
            assert.equal(out.state, "waiting");
            assert.deepEqual(log, []);
            assert.deepEqual(keys, [task.issue.key]);
            assert.match(handoffs[0]!, /not merged by this run.*working tree is not clean.*M a\.ts/s);
        }));

    it("never says the PR is open", () =>
        world(async ({ deps, task, handoffs, pr }) => {
            pr.state = "merged";
            await finishApproved(deps)(task, "u");
            assert.doesNotMatch(handoffs[0]!, /The PR is open/);
        }));
});

describe("verificationVerdict and the merge comment", () => {
    it("reads Verified: and Not verified: as a comment's first line, with or without markup", () => {
        assert.equal(verificationVerdict("Verified: all 3 criteria met\n\n* AC-1 — met"), "verified");
        assert.equal(verificationVerdict("Not verified: 1 of 3 criteria not met"), "not-verified");
        assert.equal(verificationVerdict("*Verified:* ok"), "verified");
        assert.equal(verificationVerdict("\n\nVerified: after blank lines"), "verified");
        assert.equal(verificationVerdict("Intro\nVerified: later line"), null);
        assert.equal(verificationVerdict("Handoff: it was Verified: before"), null);
        assert.equal(verificationVerdict("> Verified: quoted"), "verified");
    });
    it("names the automated reviewer and the commit, and says nothing was forced", () => {
        const c = automatedMergeComment(BOT, HEAD);
        assert.match(c, /approval was automated/);
        assert.match(c, /Bot \(bot\)/);
        assert.match(c, new RegExp(HEAD));
        assert.match(c, /nothing was forced/);
    });
});
