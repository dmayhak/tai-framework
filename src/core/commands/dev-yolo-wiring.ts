/**
 * TAI Framework — connects the unattended Dev run to the real parts (TAI-634): the git host, the reviewer's own account and
 * the headless Claude runs. The order of the steps is in `dev-yolo.ts`; this file only finds the PR, starts the runs and reads
 * what they left.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { DocStore, WorkTracker } from "../storage/interface.js";
import type { GitHost, PullRequestRef, RepoId } from "../git/interface.js";
import { isEligibleReviewer, loadPrReviewers } from "../git/pr-reviewers.js";
import { parseReviewFindings, sameCommitHash } from "../git/review-findings.js";
import { buildDevPrompt, buildFixPrompt, buildReviewerPrompt, buildVerifyPrompt, runHeadlessClaude, type HeadlessRunOptions, type HeadlessRunResult } from "./headless-claude.js";
import { findOpenPullRequest, listOpenPullRequests, titleNamesKey, type DevTask, type DevTaskOutcome } from "./do-dev-tasks.js";
import { runYolo, reviewDecisionOnHead, ownDecisionCount, type YoloDeps } from "./dev-yolo.js";
import { yoloStopReasons } from "./yolo-checks.js";
import { finishApproved } from "./dev-yolo-finish.js";

export interface YoloWiring {
    readonly gitHost: GitHost;
    readonly repos: readonly RepoId[];
    readonly workTracker: Pick<WorkTracker, "search" | "getRemoteLinks" | "getIssue" | "transition">;
    readonly docStore: DocStore;
    readonly spaceKey: string;
    readonly projectKey: string;
    /** The resolved `.tai` directory, the same one `settings set` writes its record to. */
    readonly taiDir: string;
    readonly email: string | null;
    readonly cli: string;
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly rounds: number;
    readonly checkConfigured: boolean;
    /** The automated reviewer's own git host account and the email the PR Reviewers page lists it under. */
    readonly reviewer: { readonly token: string | undefined; readonly email: string | undefined };
    /** The git host as the reviewer's own token, so who it is can be asked of the host and not taken from a setting. Null when no token. */
    readonly reviewerHost: Pick<GitHost, "getCurrentUser"> | null;
    readonly handoff: (key: string, body: string) => Promise<void>;
    readonly afterApproved?: YoloDeps["afterApproved"];
    /** The merge, verification and close of an approved PR (part 3). Without it, and without `afterApproved`, the run ends at the approval. */
    readonly finish?: {
        readonly checkCommand: string | null;
        readonly requiredApprovals?: number;
        readonly stamp: (body: string) => string;
        readonly assertClean: () => Promise<void>;
        readonly prepare: () => Promise<void>;
    };
    readonly runClaude?: (prompt: string, options: HeadlessRunOptions) => Promise<HeadlessRunResult>;
}

/** Why the ticket needs a person before anything runs: the stop checks, and a reviewer account that is not set up. */
export function yoloGate(w: YoloWiring): (task: DevTask) => Promise<readonly string[]> {
    return async (task) => {
        const reasons = [...(await yoloStopReasons({ workTracker: w.workTracker, docStore: w.docStore, spaceKey: w.spaceKey, projectKey: w.projectKey, taiDir: w.taiDir, email: w.email }, task))];
        if (!w.reviewer.token || !w.reviewer.email || !w.reviewerHost) {
            reasons.push("no automated reviewer account is configured (set TAI_REVIEWER_GITHUB_TOKEN and TAI_REVIEWER_EMAIL)");
        } else {
            const listed = await loadPrReviewers(w.docStore, { spaceKey: w.spaceKey, projectKey: w.projectKey, cacheRoot: null });
            const entry = listed.find((r) => r.email?.toLowerCase() === w.reviewer.email!.toLowerCase());
            if (!entry || !isEligibleReviewer(listed, entry)) reasons.push(`${w.reviewer.email} is not on the PR Reviewers page`);
            else if (!entry.automated) reasons.push(`${w.reviewer.email} is on the PR Reviewers page without the automated marker`);
            if (w.email && w.reviewer.email.toLowerCase() === w.email.toLowerCase()) reasons.push("the automated reviewer must be a different account from yours");
            // The token decides who posts the review, so ask the host whose it is, and compare that with the page and with the person.
            const account = await w.reviewerHost.getCurrentUser();
            const mine = await w.gitHost.getCurrentUser();
            if (sameAccount(account, mine)) reasons.push("TAI_REVIEWER_GITHUB_TOKEN belongs to your own account, so the reviewer would be you");
            else if (!entry?.githubLogin) {
                reasons.push(`${w.reviewer.email} has no GitHub login on PR Reviewers, which is how the reviewer account is recognised`);
            } else if (entry.githubLogin.toLowerCase() !== String(account.id).toLowerCase()) {
                reasons.push(`TAI_REVIEWER_GITHUB_TOKEN belongs to ${account.id}, but ${w.reviewer.email} is listed on PR Reviewers as ${entry.githubLogin}`);
            }
        }
        return reasons;
    };
}

function sameAccount(a: { readonly id: unknown }, b: { readonly id: unknown }): boolean {
    return String(a.id).toLowerCase() === String(b.id).toLowerCase();
}

async function locate(w: YoloWiring, task: DevTask): Promise<PullRequestRef | null> {
    const listed = await listOpenPullRequests(w.gitHost, w.repos);
    for (const prs of listed.values()) {
        const pr = prs.find((p) => titleNamesKey(p.title, task.issue.key));
        if (pr) return pr;
    }
    return null;
}

/** The run for one ticket: build, review by a fresh reviewer run, decide, fix. */
export function yoloRun(w: YoloWiring): (task: DevTask) => Promise<DevTaskOutcome> {
    const run = w.runClaude ?? runHeadlessClaude;
    // The PR is listed once per ticket; every later read of it is by id, and the head is always read the same way.
    const found = new Map<string, PullRequestRef>();
    const pullRequest = async (task: DevTask): Promise<PullRequestRef> => {
        const known = found.get(task.issue.key);
        if (known) return known;
        const pr = await locate(w, task);
        if (!pr) throw new Error("the PR is no longer open");
        found.set(task.issue.key, pr);
        return pr;
    };
    const liveHead = async (pr: PullRequestRef): Promise<string> => {
        const live = await w.gitHost.getPullRequest(pr.repo, pr.id);
        if (!live || live.state !== "open") throw new Error("the PR is no longer open");
        return live.sourceCommit;
    };
    const deps: YoloDeps = {
        rounds: w.rounds,
        build: (task) => run(buildDevPrompt(task.issue.key, w.cli), { cwd: w.cwd, timeoutMs: w.timeoutMs }),
        findPullRequest: (task) => findOpenPullRequest(w.gitHost, w.repos, task.issue.key, { checkConfigured: w.checkConfigured }),
        review: async (task) => {
            const pr = await pullRequest(task);
            const headBefore = await liveHead(pr);
            const reviewerAccount = await w.reviewerHost!.getCurrentUser();
            // A decision the reviewer cast on this commit in an earlier, abandoned run is not this run's: this run must add one.
            const decisionsBefore = ownDecisionCount(await w.gitHost.listPullRequestActivity(pr.repo, pr.id), reviewerAccount);
            // Under the .tai directory, which is inside the run's working area and ignored by git, so the run may write it.
            await mkdir(w.taiDir, { recursive: true });
            const dir = await mkdtemp(path.join(w.taiDir, "yolo-review-"));
            const findingsPath = path.join(dir, "findings.json");
            try {
                const ran = await run(buildReviewerPrompt({ repo: pr.repo, prId: String(pr.id), cli: w.cli, findingsPath }), {
                    cwd: w.cwd,
                    timeoutMs: w.timeoutMs,
                    // Only the git host identity is the reviewer's; the tracker and page reads stay on the person's own Jira email and token, a pair that matches.
                    env: { GITHUB_TOKEN: w.reviewer.token! },
                });
                if (!ran.ok) return { ok: false, reason: `the reviewer run did not finish: ${ran.summary}` };
                let raw: string;
                try {
                    raw = await readFile(findingsPath, "utf8");
                } catch {
                    return { ok: false, reason: `the reviewer run left no findings file. Last output:\n${ran.summary}` };
                }
                let findings;
                try {
                    findings = parseReviewFindings(raw);
                } catch (err) {
                    return { ok: false, reason: `the reviewer's findings could not be read: ${err instanceof Error ? err.message : String(err)}` };
                }
                // The findings, the decision and the PR must all be of the same commit: a push during the review, or a reviewer that read an older one, is not a review of this code.
                const head = await liveHead(pr);
                if (!sameCommitHash(head, headBefore)) return { ok: false, reason: `the PR moved from ${headBefore} to ${head} during the review` };
                if (!sameCommitHash(findings.reviewOf.commit, head)) return { ok: false, reason: `the review is of commit ${findings.reviewOf.commit}, but the PR is at ${head}` };
                if (findings.reviewOf.repo !== String(pr.repo) || findings.reviewOf.pr !== String(pr.id)) {
                    return { ok: false, reason: `the review is of ${findings.reviewOf.repo} PR ${findings.reviewOf.pr}, not ${pr.repo} PR ${pr.id}` };
                }
                const activity = await w.gitHost.listPullRequestActivity(pr.repo, pr.id);
                const decision = ownDecisionCount(activity, reviewerAccount) > decisionsBefore ? reviewDecisionOnHead(activity, reviewerAccount) : "none";
                return { ok: true, review: { findings, decision, head } };
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        },
        fix: async (task, _prUrl, findings) => {
            const pr = await pullRequest(task);
            const slim = findings.map((f) => ({ severity: f.severity, title: f.title, file: f.file, ...(f.line !== undefined ? { line: f.line } : {}), issue: f.issue }));
            return run(buildFixPrompt({ key: task.issue.key, repo: pr.repo, prId: String(pr.id), branch: pr.sourceBranch, cli: w.cli, findings: slim }), { cwd: w.cwd, timeoutMs: w.timeoutMs });
        },
        head: async (task) => liveHead(await pullRequest(task)),
        handoff: w.handoff,
        ...(w.afterApproved
            ? { afterApproved: w.afterApproved }
            : w.finish
              ? {
                    afterApproved: finishApproved({
                        gitHost: w.gitHost,
                        workTracker: w.workTracker,
                        projectKey: w.projectKey,
                        pullRequest,
                        checkCommand: w.finish.checkCommand,
                        ...(w.finish.requiredApprovals !== undefined ? { requiredApprovals: w.finish.requiredApprovals } : {}),
                        reviewer: () => w.reviewerHost!.getCurrentUser(),
                        stamp: w.finish.stamp,
                        assertClean: w.finish.assertClean,
                        prepare: w.finish.prepare,
                        verify: (task) => run(buildVerifyPrompt({ key: task.parent.key, cli: w.cli }), { cwd: w.cwd, timeoutMs: w.timeoutMs }),
                        handoff: w.handoff,
                    }),
                }
              : {}),
    };
    return (task) => runYolo(task, deps);
}
