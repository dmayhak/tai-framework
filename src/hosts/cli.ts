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

import {
    toHumanId,
    toIssueKey,
    toPageId,
    type CreateIssueInput,
    type CreatePageInput,
    type Issue,
    type StorageBackend,
} from "../core/storage/interface.js";
import { createFilesystemBackend } from "../core/storage/filesystem-backend.js";
import { createJiraBackend } from "../core/storage/jira/jira-backend.js";
import { apiTokenAuth } from "../core/storage/jira/rest-client.js";
import { prepareWorkTurn, NoOwningPersonaError } from "../core/commands/work.js";
import { findReadyWork } from "../core/commands/ready.js";
import { materializePrecedenceLinks } from "../core/commands/link-precedence.js";
import {
    resolvePullRequestId,
    parseReviewArgs,
    parseMergeArgs,
    isGreen,
    findCodeReviewSiblingForLink,
    validateBranchName,
    validatePrTitle,
} from "../core/commands/git-pr.js";
import { loadPersonaConfig } from "../core/persona/config.js";
import { PersonaPermissionError } from "../core/persona/scoped-work-tracker.js";
import { PersonaScopedGitHost } from "../core/persona/scoped-git-host.js";
import { createBitbucketBackend, apiTokenAuth as bitbucketApiTokenAuth } from "../core/git/bitbucket/bitbucket-backend.js";
import { toRepoId, type GitHost, type GitMutationResult, type PullRequestRef, type RepoId } from "../core/git/interface.js";
import { DependencyRelation, type Persona, type Status, type StoryType, type SubtaskType } from "../core/schema/story-schema.js";

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
): Promise<{ readonly gitHost: PersonaScopedGitHost; readonly personaId: string; readonly issue: Issue }> {
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

    return { gitHost: new PersonaScopedGitHost(backend.gitHost, personaConfig), personaId: personaConfig.id, issue };
}

/**
 * Best-effort GitHost + repo list for `/tai-ready`'s PR-awareness path (TAI-107/108) —
 * `undefined` (never a throw) when Bitbucket credentials or `TAI_GIT_REPOS` aren't
 * configured, so `/tai-ready` keeps working with zero GitHost awareness exactly as it
 * always has (same "only demanded where actually needed" posture as `resolveGitHost`).
 *
 * `TAI_GIT_REPOS` (comma-separated `workspace/repo` entries) rather than deriving repos
 * from Jira's Component field: no Component->RepoId mapping exists anywhere in this
 * codebase yet, and this project itself is single-repo — building that mapping is a
 * separate need to solve if/when a real multi-repo project actually hits it (brief's own
 * repeated "don't build ahead of an observed need" stance).
 */
function tryResolveReadyGitDeps(): { readonly gitHost: GitHost; readonly repos: readonly RepoId[] } | undefined {
    const email = process.env["BITBUCKET_EMAIL"];
    const token = process.env["BITBUCKET_API_TOKEN"];
    const reposEnv = process.env["TAI_GIT_REPOS"];
    if (!email || !token || !reposEnv) return undefined;

    const repos = reposEnv
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r.length > 0)
        .map(toRepoId);
    if (repos.length === 0) return undefined;

    const backend = createBitbucketBackend({ auth: bitbucketApiTokenAuth(email, token) });
    return { gitHost: backend.gitHost, repos };
}

function renderPullRequestRef(pr: PullRequestRef, personaId: string, linkedCodeReviewKey?: string | null): string {
    const lines = [
        `# PR ${pr.id} (as ${personaId})`,
        "",
        `**${pr.title}**`,
        `${pr.sourceBranch} → ${pr.destinationBranch} · ${pr.state}`,
        pr.url,
    ];
    if (linkedCodeReviewKey !== undefined) {
        lines.push(
            "",
            linkedCodeReviewKey
                ? `Linked to ${linkedCodeReviewKey} (CodeReview).`
                : "Not linked to a CodeReview subtask — none could be confidently identified among this issue's siblings."
        );
    }
    return lines.join("\n");
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
    if (result.readyToMerge.length > 0) {
        lines.push("", "## Approved PRs ready to merge", "");
        for (const c of result.readyToMerge) {
            lines.push(`- **${c.codeReviewKey}** — ${c.pullRequest.url} (\`git-pr merge <ISSUE-KEY> <REPO>\` to land it)`);
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

function renderPrecedenceLinkResults({ results, warning }: Awaited<ReturnType<typeof materializePrecedenceLinks>>): string {
    const lines: string[] = ["# Precedence links", ""];
    if (results.length === 0) {
        lines.push("No applicable precedence edges — either this story has fewer than two of the " +
            "subtask types SUBTASK_PRECEDENCE gates against each other, or none are present yet.");
    } else {
        for (const r of results) {
            const verb = r.created ? "created" : "already existed";
            lines.push(`- ${r.afterKey} depends on ${r.beforeKey} (${r.after} after ${r.before}) — ${verb}`);
        }
    }
    if (warning) {
        lines.push("", `**Warning:** ${warning}`);
    }
    return lines.join("\n");
}

// ---------- issue/page subcommands (TAI-126, piece 0) ----------
//
// Thin wrappers around WorkTracker/DocStore methods that already exist, are already
// implemented against direct REST for both backends, and are already covered by the
// conformance suite — cli.ts simply never exposed them as subcommands before this,
// which meant creating/transitioning/commenting/linking tickets and Confluence pages
// required going through a separate MCP server. These wrappers close that gap so no
// MCP server is required for TAI to work end-to-end (brief §3.2's own "direct REST,
// not through mcp-atlassian" decision, extended to cover ticket/page CRUD too).

/** Parses trailing `key=value` arguments (e.g. `parent=TAI-116 persona=developer`) into a
 *  plain object — used by `issue create`/`page create` for their many optional fields,
 *  rather than a long fixed positional list. */
function parseKeyValueArgs(args: readonly string[]): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const raw of args) {
        const eq = raw.indexOf("=");
        if (eq === -1) throw new Error(`Expected key=value, got "${raw}".`);
        fields[raw.slice(0, eq)] = raw.slice(eq + 1);
    }
    return fields;
}

function renderIssueRef(issue: Issue): string {
    return [
        `# Issue ${issue.key}`,
        "",
        `**${issue.summary}**`,
        `${issue.issueType} · ${issue.status}${issue.parentKey ? ` · parent: ${issue.parentKey}` : ""}`,
    ].join("\n");
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
                    "     | git-pr review <ISSUE-KEY> <REPO> [PR-ID] <approve|requestChanges> [COMMENT]\n" +
                    "     | git-pr merge <ISSUE-KEY> <REPO> [PR-ID] [mergeCommit|squash|fastForward]\n" +
                    "  [PR-ID] is optional on review/merge — omit it to resolve against REPO's sole open PR; " +
                    "if more than one is open, the error lists them so you can pass one explicitly."
            );
        }
        const { gitHost, personaId, issue } = await resolveGitHost(config, issueKey);
        const repo = toRepoId(repoArg);

        if (action === "create") {
            const [sourceBranch, destinationBranch, title, description] = gitArgs;
            if (!sourceBranch || !destinationBranch || !title) {
                throw new Error(
                    "Usage: git-pr create <ISSUE-KEY> <REPO> <SOURCE_BRANCH> <DEST_BRANCH> <TITLE> [DESCRIPTION]"
                );
            }
            // Brief §6: a branch is named after the parent Story/Bug, not the subtask
            // opening the PR — TAI-107 found this session's own branches had deviated.
            validateBranchName(sourceBranch, issue.parentKey ?? issue.key);
            // TAI-112: the PR title is tied to the parent Story/Bug first, subtask second —
            // the 10 PRs preceding this ticket used neither convention consistently.
            validatePrTitle(title, issue.parentKey ?? issue.key, issue.parentKey ? issue.key : null);

            const pr = await gitHost.createPullRequest({
                repo,
                title,
                sourceBranch,
                destinationBranch,
                ...(description ? { description } : {}),
            });

            // TAI-107/108: close brief §5.4's "links the PR to the CodeReview subtask via a
            // Jira remote issue link" step in code — previously a fully manual persona
            // action every time. Best-effort: a PR that can't be confidently correlated to
            // one CodeReview subtask still gets created; only the link is skipped.
            const codeReviewKey = await findCodeReviewSiblingForLink(config.backend.workTracker, issue);
            if (codeReviewKey) {
                await config.backend.workTracker.createRemoteLink(codeReviewKey, pr.url, pr.title);
            }

            console.log(renderPullRequestRef(pr, personaId, codeReviewKey));
            return;
        }

        if (action === "review") {
            const { prIdArg, decision, comment } = parseReviewArgs(gitArgs);
            const prId = await resolvePullRequestId(gitHost, repo, prIdArg);
            await gitHost.reviewPullRequest(repo, prId, decision, comment);
            console.log(`# Review posted (as ${personaId})\n\n${decision} on PR ${prId}.`);
            return;
        }

        if (action === "merge") {
            const { prIdArg, strategy } = parseMergeArgs(gitArgs);
            const prId = await resolvePullRequestId(gitHost, repo, prIdArg);

            // Brief §5.4: merge is "gated on GitHost.getCommitStatuses being green first" —
            // confirmed live (TAI-107) this was never actually checked anywhere; both this
            // session's real merges (PR #16, #17) went through with zero CI check.
            const pr = await gitHost.getPullRequest(repo, prId);
            if (!pr) throw new Error(`PR ${prId} not found on ${repo}.`);
            const statuses = await gitHost.getCommitStatuses(repo, pr.sourceCommit);
            if (!isGreen(statuses)) {
                const result: GitMutationResult = {
                    ok: false,
                    reason: `CI status not green for ${pr.sourceCommit} — ${
                        statuses.length === 0
                            ? "no commit statuses found (pipeline never ran, or wrong commit)"
                            : statuses.map((s) => `${s.key}: ${s.state}`).join(", ")
                    }.`,
                };
                console.log(renderGitMutationResult(result, personaId));
                return;
            }

            const result = await gitHost.mergePullRequest(repo, prId, strategy);
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
        const gitDeps = tryResolveReadyGitDeps();
        const result = await findReadyWork(
            {
                workTracker: config.backend.workTracker,
                taiRoot: config.taiRoot,
                projectKey: config.projectKey,
                ...(gitDeps ?? {}),
            },
            persona
        );
        console.log(renderReadyWork(result, arg));
        return;
    }

    if (subcommand === "link-precedence") {
        if (!arg) throw new Error("Usage: link-precedence <STORY-KEY>");
        // TAI-118: link-precedence is explicitly meant to be run immediately after
        // front-loading a story's subtask set — exactly the window where Jira Cloud's
        // eventually-consistent search index can still be missing a just-created subtask.
        // Opt into the retry here (unit tests exercising materializePrecedenceLinks
        // directly still default to the original one-shot behavior).
        const result = await materializePrecedenceLinks(config.backend.workTracker, toIssueKey(arg), {
            attempts: 4,
            delayMs: 3000,
        });
        console.log(renderPrecedenceLinkResults(result));
        return;
    }

    if (subcommand === "issue") {
        const [action, ...issueArgs] = [arg, ...rest];

        if (action === "create") {
            const [projectKey, issueType, summary, ...kv] = issueArgs;
            if (!projectKey || !issueType || !summary) {
                throw new Error(
                    "Usage: issue create <PROJECT-KEY> <ISSUE-TYPE> <SUMMARY> " +
                        "[parent=<KEY>] [persona=<PERSONA>] [description=<TEXT>] [priority=<PRIORITY>] [labels=<a,b,c>]\n" +
                        '  <ISSUE-TYPE> is TAI\'s own internal value (e.g. "bug", "dev", "code-review", ' +
                        '"integration-test") -- see StoryType/SubtaskType in story-schema.ts -- NOT the raw Jira ' +
                        'display name ("Bug", "Dev", "CodeReview").'
                );
            }
            const fields = parseKeyValueArgs(kv);
            const input: CreateIssueInput = {
                projectKey,
                issueType: issueType as StoryType | SubtaskType | "epic",
                summary,
                ...(fields["description"] !== undefined ? { description: fields["description"] } : {}),
                ...(fields["persona"] !== undefined ? { persona: fields["persona"] as Persona } : {}),
                ...(fields["parent"] !== undefined ? { parentKey: toIssueKey(fields["parent"]) } : {}),
                ...(fields["priority"] !== undefined ? { priority: fields["priority"] } : {}),
                ...(fields["labels"] !== undefined ? { labels: fields["labels"].split(",") } : {}),
            };
            const issue = await config.backend.workTracker.createIssue(input);
            console.log(renderIssueRef(issue));
            return;
        }

        if (action === "transition") {
            const [issueKey, status] = issueArgs;
            if (!issueKey || !status) throw new Error("Usage: issue transition <ISSUE-KEY> <STATUS>");
            const result = await config.backend.workTracker.transition(toIssueKey(issueKey), status as Status);
            console.log(
                result.ok
                    ? renderIssueRef(result.issue)
                    : `# Transition denied\n\n${issueKey} -> "${status}": ${result.reason}`
            );
            return;
        }

        if (action === "comment") {
            const [issueKey, body] = issueArgs;
            if (!issueKey || !body) throw new Error("Usage: issue comment <ISSUE-KEY> <BODY>");
            const comment = await config.backend.workTracker.addComment(toIssueKey(issueKey), body);
            console.log(`# Comment added to ${issueKey}\n\n${comment.body}`);
            return;
        }

        if (action === "link") {
            const [relation, fromKey, toKey] = issueArgs;
            if (!relation || !fromKey || !toKey) {
                throw new Error(
                    "Usage: issue link <depends-on|relates-to> <FROM-KEY> <TO-KEY>\n" +
                        '  Means "FROM-KEY <relation> TO-KEY" -- for depends-on, TO-KEY is the BLOCKER ' +
                        "(TO-KEY blocks FROM-KEY). Getting this backwards silently inverts the edge."
                );
            }
            if (relation !== DependencyRelation.DependsOn && relation !== DependencyRelation.RelatesTo) {
                throw new Error(`Unknown relation "${relation}" -- expected "depends-on" or "relates-to".`);
            }
            await config.backend.workTracker.createLink(toIssueKey(fromKey), relation, toIssueKey(toKey));
            const note = relation === DependencyRelation.DependsOn ? ` (${toKey} blocks ${fromKey})` : "";
            console.log(`# Link created\n\n${fromKey} ${relation} ${toKey}${note}.`);
            return;
        }

        throw new Error(`Unknown issue action "${action}" -- expected "create", "transition", "comment", or "link".`);
    }

    if (subcommand === "page") {
        const [action, ...pageArgs] = [arg, ...rest];

        if (action === "create") {
            const [spaceKey, title, content, ...kv] = pageArgs;
            if (!spaceKey || !title || !content) {
                throw new Error("Usage: page create <SPACE-KEY> <TITLE> <CONTENT> [parent=<PAGE-ID>]");
            }
            const fields = parseKeyValueArgs(kv);
            const input: CreatePageInput = {
                spaceKey,
                title,
                content,
                ...(fields["parent"] !== undefined ? { parentId: toPageId(fields["parent"]) } : {}),
            };
            const page = await config.backend.docStore.createPage(input);
            console.log(`# Page created\n\n**${page.title}**\nid: ${page.id}\nspace: ${page.spaceKey}`);
            return;
        }

        if (action === "link") {
            const [issueKey, pageId] = pageArgs;
            if (!issueKey || !pageId) throw new Error("Usage: page link <ISSUE-KEY> <PAGE-ID>");
            await config.backend.workTracker.linkPage(toIssueKey(issueKey), toPageId(pageId));
            console.log(`# Page linked\n\n${pageId} linked to ${issueKey}.`);
            return;
        }

        throw new Error(`Unknown page action "${action}" -- expected "create" or "link".`);
    }

    throw new Error(
        `Usage: tai_work <ISSUE-KEY> | tai_ready [persona] | link-precedence <STORY-KEY> | git-pr create|review|merge ... ` +
            `| issue create|transition|comment|link ... | page create|link ...`
    );
}

main().catch((err: unknown) => {
    if (err instanceof NoOwningPersonaError || err instanceof PersonaPermissionError) {
        console.error(err.message);
    } else {
        console.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
});
