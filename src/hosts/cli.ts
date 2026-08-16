#!/usr/bin/env node
/**
 * TAI Framework — host-agnostic command-layer entry point (TAI-61 ADR decision 4;
 * generalized from a Claude-Code-only location by TAI-68/TAI-67's feasibility finding
 * that nothing here was ever actually Claude-Code-specific)
 *
 * The core design insight this file implements: "invoke the owning persona" (brief §3.8)
 * is NOT a separate LLM API call — the calling host IS the LLM already running the
 * session. This CLI's whole job is to print an assembled prompt (persona instructions +
 * briefing, or the ready-work list) to stdout; each host's own thin wrapper is what turns
 * that stdout into the session's next turn — no new invocation mechanism on top of that,
 * and no host-specific logic in this file itself:
 *   - Claude Code: `.claude/commands/tai_work.md`/`tai_ready.md` — markdown instructing
 *     the agent to run this script via its own `Bash` tool and read the output.
 *   - Gemini CLI: `.gemini/commands/tai_work.toml`/`tai_ready.toml` — `!{...}` shell
 *     injection, where the harness itself pre-executes this script and substitutes its
 *     stdout into the prompt before the model sees it (TAI-67 feasibility assessment,
 *     Confluence TA space page 18317313).
 *
 * Backend construction (which storage backend, from what credentials) is deliberately
 * minimal and env-var driven — nothing in the brief or either ADR (TAI-51/TAI-56/TAI-61)
 * specifies a project-config-resolution mechanism yet, so this is a first-pass convention,
 * not a settled design; revisit if a real multi-project/multi-backend need shows up.
 */

import { toHumanId, toIssueKey, type StorageBackend } from "../core/storage/interface.js";
import { createFilesystemBackend } from "../core/storage/filesystem-backend.js";
import { createJiraBackend } from "../core/storage/jira/jira-backend.js";
import { apiTokenAuth } from "../core/storage/jira/rest-client.js";
import { prepareWorkTurn, NoOwningPersonaError } from "../core/commands/work.js";
import { findReadyWork } from "../core/commands/ready.js";
import { loadPersonaConfig } from "../core/persona/config.js";
import { PersonaPermissionError } from "../core/persona/scoped-work-tracker.js";
import { PersonaScopedGitHost } from "../core/persona/scoped-git-host.js";
import { createBitbucketBackend, apiTokenAuth as bitbucketApiTokenAuth } from "../core/git/bitbucket/bitbucket-backend.js";
import { toRepoId, toPullRequestId, type GitMutationResult, type PullRequestRef } from "../core/git/interface.js";
import type { Persona } from "../core/schema/story-schema.js";

interface ResolvedConfig {
    readonly backend: StorageBackend;
    readonly taiRoot: string;
    readonly projectKey: string;
    readonly spaceKey: string;
}

// Loads `.env` from the current working directory into `process.env`, if present —
// optional (a real shell profile export works just as well; see `.env.example`), so a
// missing file is not an error. Node's own `process.loadEnvFile` (stable since v21.7,
// this repo runs v24+) rather than the `dotenv` package — keeps the repo at the zero
// runtime dependencies both the TAI-12 and TAI-33 ADRs deliberately committed to for
// exactly this class of "small, native-platform-covered" need.
function loadDotEnv(): void {
    try {
        process.loadEnvFile();
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable ${name}.`);
    }
    return value;
}

async function resolveConfig(): Promise<ResolvedConfig> {
    const taiRoot = process.env["TAI_ROOT"] ?? ".tai";
    const projectKey = requireEnv("TAI_PROJECT_KEY");
    const backendKind = process.env["TAI_BACKEND"] ?? "filesystem";

    if (backendKind === "jira") {
        const spaceKey = requireEnv("TAI_SPACE_KEY");
        const backend = await createJiraBackend({
            siteUrl: requireEnv("TAI_JIRA_SITE_URL"),
            spaceKey,
            auth: apiTokenAuth(requireEnv("TAI_JIRA_EMAIL"), requireEnv("TAI_JIRA_API_TOKEN")),
        });
        return { backend, taiRoot, projectKey, spaceKey };
    }

    if (backendKind === "filesystem") {
        // spaceKey === projectKey by convention — the filesystem backend has no
        // independent Confluence-space concept (brief §4 rev 18; see its own header comment).
        const backend = createFilesystemBackend(taiRoot, {
            id: toHumanId(requireEnv("TAI_HUMAN_ID")),
            displayName: process.env["TAI_HUMAN_NAME"] ?? requireEnv("TAI_HUMAN_ID"),
            ...(process.env["TAI_HUMAN_EMAIL"] ? { email: process.env["TAI_HUMAN_EMAIL"] } : {}),
        });
        return { backend, taiRoot, projectKey, spaceKey: projectKey };
    }

    throw new Error(`Unknown TAI_BACKEND "${backendKind}" — expected "jira" or "filesystem".`);
}

/**
 * Resolves a `PersonaScopedGitHost` for `issueKey`'s owning persona (TAI-73) — same
 * identity-resolution shape `prepareWorkTurn` already uses for `WorkTracker` (the issue's
 * own `persona` field, brief §5.6), applied to the git-hosting sibling interface. Requires
 * `BITBUCKET_EMAIL`/`BITBUCKET_API_TOKEN` — only demanded here, not in `resolveConfig`, so
 * `work`/`ready` never need Bitbucket credentials at all.
 */
async function resolveGitHost(
    config: ResolvedConfig,
    issueKey: string
): Promise<{ readonly gitHost: PersonaScopedGitHost; readonly personaId: string }> {
    const key = toIssueKey(issueKey);
    const issue = await config.backend.workTracker.getIssue(key);
    if (!issue) throw new Error(`${key}: no such issue.`);
    if (!issue.persona) throw new NoOwningPersonaError(key);

    const personaConfig = await loadPersonaConfig(config.backend.docStore, issue.persona, {
        spaceKey: config.spaceKey,
    });

    const backend = createBitbucketBackend({
        auth: bitbucketApiTokenAuth(requireEnv("BITBUCKET_EMAIL"), requireEnv("BITBUCKET_API_TOKEN")),
    });

    return { gitHost: new PersonaScopedGitHost(backend.gitHost, personaConfig), personaId: personaConfig.id };
}

function renderPullRequestRef(pr: PullRequestRef, personaId: string): string {
    return [
        `# PR ${pr.id} (as ${personaId})`,
        "",
        `**${pr.title}**`,
        `${pr.sourceBranch} → ${pr.destinationBranch} · ${pr.state}`,
        pr.url,
    ].join("\n");
}

function renderGitMutationResult(result: GitMutationResult, personaId: string): string {
    if (result.ok) return renderPullRequestRef(result.pullRequest, personaId);
    return `# Merge denied (as ${personaId})\n\n${result.reason}`;
}

function renderWorkTurn(turn: Awaited<ReturnType<typeof prepareWorkTurn>>): string {
    const lines = [`# Persona: ${turn.personaDisplayName} (${turn.personaId})`, ""];

    const { replayed, stillQueued, escalated } = turn.replayOutcome;
    if (replayed > 0 || stillQueued > 0 || escalated.length > 0) {
        lines.push(`_Offline write replay: ${replayed} replayed, ${stillQueued} still queued._`, "");
        for (const e of escalated) {
            lines.push(`**Escalation:** queued ${e.method} from ${e.timestamp} failed to replay: ${e.reason}`, "");
        }
    }

    lines.push(turn.personaPrompt, "", "---", "", turn.briefingMarkdown);
    return lines.join("\n");
}

function renderReadyWork(result: Awaited<ReturnType<typeof findReadyWork>>, persona?: string): string {
    const lines: string[] = [`# Ready work${persona ? ` for ${persona}` : ""}`, ""];
    if (result.ready.length === 0) {
        lines.push("Nothing is currently ready.");
    } else {
        for (const issue of result.ready) {
            lines.push(`- **${issue.key}** [${issue.issueType}] ${issue.summary} (persona: ${issue.persona ?? "none"})`);
        }
    }
    if (result.inFlight.items.length > 0) {
        lines.push("", "## Already in flight", "");
        for (const item of result.inFlight.items) {
            lines.push(`- ${item.subtaskKey}: ${item.currentStep} (${item.state})`);
        }
    }
    return lines.join("\n");
}

async function main(): Promise<void> {
    loadDotEnv();
    const [, , subcommand, arg, ...rest] = process.argv;
    const config = await resolveConfig();

    if (subcommand === "git-pr") {
        const [action, issueKey, repoArg, ...gitArgs] = [arg, ...rest];
        if (!action || !issueKey || !repoArg) {
            throw new Error(
                "Usage: git-pr create <ISSUE-KEY> <REPO> <SOURCE_BRANCH> <DEST_BRANCH> <TITLE> [DESCRIPTION]\n" +
                    "     | git-pr review <ISSUE-KEY> <REPO> <PR-ID> <approve|requestChanges> [COMMENT]\n" +
                    "     | git-pr merge <ISSUE-KEY> <REPO> <PR-ID> [mergeCommit|squash|fastForward]"
            );
        }
        const { gitHost, personaId } = await resolveGitHost(config, issueKey);
        const repo = toRepoId(repoArg);

        if (action === "create") {
            const [sourceBranch, destinationBranch, title, description] = gitArgs;
            if (!sourceBranch || !destinationBranch || !title) {
                throw new Error(
                    "Usage: git-pr create <ISSUE-KEY> <REPO> <SOURCE_BRANCH> <DEST_BRANCH> <TITLE> [DESCRIPTION]"
                );
            }
            const pr = await gitHost.createPullRequest({
                repo,
                title,
                sourceBranch,
                destinationBranch,
                ...(description ? { description } : {}),
            });
            console.log(renderPullRequestRef(pr, personaId));
            return;
        }

        if (action === "review") {
            const [prId, decision, comment] = gitArgs;
            if (!prId || (decision !== "approve" && decision !== "requestChanges")) {
                throw new Error("Usage: git-pr review <ISSUE-KEY> <REPO> <PR-ID> <approve|requestChanges> [COMMENT]");
            }
            await gitHost.reviewPullRequest(repo, toPullRequestId(prId), decision, comment);
            console.log(`# Review posted (as ${personaId})\n\n${decision} on PR ${prId}.`);
            return;
        }

        if (action === "merge") {
            const [prId, strategyArg] = gitArgs;
            if (!prId) {
                throw new Error("Usage: git-pr merge <ISSUE-KEY> <REPO> <PR-ID> [mergeCommit|squash|fastForward]");
            }
            const strategy =
                strategyArg === "squash" || strategyArg === "fastForward" ? strategyArg : "mergeCommit";
            const result = await gitHost.mergePullRequest(repo, toPullRequestId(prId), strategy);
            console.log(renderGitMutationResult(result, personaId));
            return;
        }

        throw new Error(`Unknown git-pr action "${action}" — expected "create", "review", or "merge".`);
    }

    if (subcommand === "work") {
        if (!arg) throw new Error("Usage: tai_work <ISSUE-KEY>");
        const turn = await prepareWorkTurn(
            {
                backend: config.backend,
                taiRoot: config.taiRoot,
                projectKey: config.projectKey,
                spaceKey: config.spaceKey,
            },
            toIssueKey(arg)
        );
        console.log(renderWorkTurn(turn));
        return;
    }

    if (subcommand === "ready") {
        const persona = arg as Persona | undefined;
        const result = await findReadyWork(
            { workTracker: config.backend.workTracker, taiRoot: config.taiRoot, projectKey: config.projectKey },
            persona
        );
        console.log(renderReadyWork(result, arg));
        return;
    }

    throw new Error(`Usage: tai_work <ISSUE-KEY> | tai_ready [persona] | git-pr create|review|merge ...`);
}

main().catch((err: unknown) => {
    if (err instanceof NoOwningPersonaError || err instanceof PersonaPermissionError) {
        console.error(err.message);
    } else {
        console.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
});
