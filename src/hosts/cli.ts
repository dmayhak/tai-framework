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
import { PersonaPermissionError } from "../core/persona/scoped-work-tracker.js";
import type { Persona } from "../core/schema/story-schema.js";

interface ResolvedConfig {
    readonly backend: StorageBackend;
    readonly taiRoot: string;
    readonly projectKey: string;
    readonly spaceKey: string;
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
    const [, , subcommand, arg] = process.argv;
    const config = await resolveConfig();

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

    throw new Error(`Usage: tai_work <ISSUE-KEY> | tai_ready [persona]`);
}

main().catch((err: unknown) => {
    if (err instanceof NoOwningPersonaError || err instanceof PersonaPermissionError) {
        console.error(err.message);
    } else {
        console.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
});
