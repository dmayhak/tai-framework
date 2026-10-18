/**
 * TAI Framework — real-terminal wiring for `init run` (TAI-367)
 *
 * The thin, deliberately untested-by-fakes half of `init-run.ts`: readline prompts, spawning the
 * user's editor, the real Atlassian/Bitbucket calls, and `git status`. Everything with logic in
 * it (the editor command line, the reminder, the picker) lives in `init-run.ts` /
 * `discovery.ts` and is unit-tested there.
 */

import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

import { RestClient, apiTokenAuth } from "../storage/jira/rest-client.js";
import { detectGitRemote, listConfluenceSpaces, listJiraProjects } from "./discovery.js";
import { buildEditorCommand, chooseEditor, type InitRunIO, type InitRunServices } from "./init-run.js";
import { setupConfluence, verifyBitbucketSetup, verifyGitHubSetup, verifyJiraSetup } from "./target-init.js";

const execFileAsync = promisify(execFile);

/** `git status --porcelain`, or `null` when this isn't a git repo (or git isn't available). */
export async function gitStatusPorcelain(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd, env });
        return stdout;
    } catch {
        return null;
    }
}

/** Prompts via a fresh readline interface PER question and closes it straight after, so
 *  stdin is free for the editor child process (which inherits it) between questions. */
export function createTerminalIO(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): InitRunIO {
    return {
        say: (text) => console.log(text),
        ask: async (question, defaultValue) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
                const answer = await rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ""}: `);
                return answer.trim();
            } finally {
                rl.close();
            }
        },
        editFile: (filePath) =>
            new Promise((resolve) => {
                const editor = chooseEditor(env, platform);
                if (!editor) return resolve("no-editor");
                // Through a shell: $EDITOR is often a command with arguments ("code --wait").
                const child = spawn(buildEditorCommand(editor, filePath, platform), { shell: true, stdio: "inherit", env });
                child.on("error", () => resolve("no-editor"));
                // Whatever the exit code, the engine re-reads the file and decides.
                child.on("close", () => resolve("edited"));
            }),
    };
}

export function createRealServices(): InitRunServices {
    const client = (siteUrl: string, email: string, apiToken: string): RestClient =>
        new RestClient({ siteUrl, auth: apiTokenAuth(email, apiToken) });
    return {
        listProjects: (siteUrl, email, apiToken) => listJiraProjects(client(siteUrl, email, apiToken)),
        listSpaces: (siteUrl, email, apiToken) => listConfluenceSpaces(client(siteUrl, email, apiToken)),
        detectGitRemote: (cwd) => detectGitRemote(cwd),
        verifyJira: verifyJiraSetup,
        setupConfluence,
        verifyBitbucket: verifyBitbucketSetup,
        verifyGitHub: verifyGitHubSetup,
        gitStatusPorcelain: (cwd) => gitStatusPorcelain(cwd),
    };
}
