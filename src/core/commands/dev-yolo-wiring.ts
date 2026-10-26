/**
 * TAI Framework — connects the unattended Dev run to the real parts (TAI-634): the git host, the reviewer's own account and
 * the headless Claude runs. The order of the steps is in `dev-yolo.ts`; this file only finds the PR, starts the runs and reads
 * what they left.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DocStore, WorkTracker } from "../storage/interface.js";
import type { GitHost, PullRequestRef, RepoId } from "../git/interface.js";
import { isEligibleReviewer, loadPrReviewers } from "../git/pr-reviewers.js";
import { parseReviewFindings } from "../git/review-findings.js";
import { buildDevPrompt, buildFixPrompt, buildReviewerPrompt, runHeadlessClaude, type HeadlessRunOptions, type HeadlessRunResult } from "./headless-claude.js";
import { findOpenPullRequest, listOpenPullRequests, titleNamesKey, type DevTask, type DevTaskOutcome } from "./do-dev-tasks.js";
import { runYolo, reviewDecisionOnHead, type YoloDeps } from "./dev-yolo.js";
import { yoloStopReasons } from "./yolo-checks.js";

export interface YoloWiring {
    readonly gitHost: GitHost;
    readonly repos: readonly RepoId[];
    readonly workTracker: Pick<WorkTracker, "search">;
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
    readonly handoff: (key: string, body: string) => Promise<void>;
    readonly afterApproved?: YoloDeps["afterApproved"];
    readonly runClaude?: (prompt: string, options: HeadlessRunOptions) => Promise<HeadlessRunResult>;
}

/** Why the ticket needs a person before anything runs: the stop checks, and a reviewer account that is not set up. */
export function yoloGate(w: YoloWiring): (task: DevTask) => Promise<readonly string[]> {
    return async (task) => {
        const reasons = [...(await yoloStopReasons({ workTracker: w.workTracker, docStore: w.docStore, spaceKey: w.spaceKey, projectKey: w.projectKey, taiDir: w.taiDir, email: w.email }, task))];
        if (!w.reviewer.token || !w.reviewer.email) {
            reasons.push("no automated reviewer account is configured (set TAI_REVIEWER_GITHUB_TOKEN and TAI_REVIEWER_EMAIL)");
        } else {
            const listed = await loadPrReviewers(w.docStore, { spaceKey: w.spaceKey, projectKey: w.projectKey, cacheRoot: null });
            const entry = listed.find((r) => r.email?.toLowerCase() === w.reviewer.email!.toLowerCase());
            if (!entry || !isEligibleReviewer(listed, entry)) reasons.push(`${w.reviewer.email} is not on the PR Reviewers page`);
            else if (!entry.automated) reasons.push(`${w.reviewer.email} is on the PR Reviewers page without the automated marker`);
            if (w.email && w.reviewer.email.toLowerCase() === w.email.toLowerCase()) reasons.push("the automated reviewer must be a different account from yours");
        }
        return reasons;
    };
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
    const deps: YoloDeps = {
        rounds: w.rounds,
        build: (task) => run(buildDevPrompt(task.issue.key, w.cli), { cwd: w.cwd, timeoutMs: w.timeoutMs }),
        findPullRequest: (task) => findOpenPullRequest(w.gitHost, w.repos, task.issue.key, { checkConfigured: w.checkConfigured }),
        review: async (task, _prUrl) => {
            const pr = await locate(w, task);
            if (!pr) return { ok: false, reason: "the PR is no longer open" };
            const dir = await mkdtemp(path.join(tmpdir(), "tai-review-"));
            const findingsPath = path.join(dir, "findings.json");
            try {
                const ran = await run(buildReviewerPrompt({ repo: pr.repo, prId: String(pr.id), cli: w.cli, findingsPath }), {
                    cwd: w.cwd,
                    timeoutMs: w.timeoutMs,
                    env: { GITHUB_TOKEN: w.reviewer.token!, TAI_JIRA_EMAIL: w.reviewer.email! },
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
                const live = await w.gitHost.getPullRequest(pr.repo, pr.id);
                const decision = reviewDecisionOnHead(await w.gitHost.listPullRequestActivity(pr.repo, pr.id));
                return { ok: true, review: { findings, decision, head: live?.sourceCommit ?? pr.sourceCommit } };
            } finally {
                await rm(dir, { recursive: true, force: true });
            }
        },
        fix: async (task, _prUrl, findings) => {
            const pr = await locate(w, task);
            if (!pr) return { ok: false, summary: "the PR is no longer open" };
            const slim = findings.map((f) => ({ severity: f.severity, title: f.title, file: f.file, ...(f.line !== undefined ? { line: f.line } : {}), issue: f.issue }));
            return run(buildFixPrompt({ key: task.issue.key, repo: pr.repo, prId: String(pr.id), branch: pr.sourceBranch, cli: w.cli, findings: slim }), { cwd: w.cwd, timeoutMs: w.timeoutMs });
        },
        head: async (task) => {
            const pr = await locate(w, task);
            if (!pr) throw new Error("the PR is no longer open");
            return pr.sourceCommit;
        },
        handoff: w.handoff,
        ...(w.afterApproved ? { afterApproved: w.afterApproved } : {}),
    };
    return (task) => runYolo(task, deps);
}
