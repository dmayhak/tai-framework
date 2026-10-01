/**
 * TAI Framework — `init run`: one idempotent setup flow for a new OR already-onboarded
 * project (TAI-367)
 *
 * The ADR for TAI-360 (Confluence page 45449217, rev 3, decisions 2-6) replaces "export a pile
 * of env vars, then run five separate `init` steps in the right order" with one command a user
 * runs in their own terminal on a fresh clone:
 *
 *   site URL prompt -> `.env` skeleton -> editor for the secret lines -> live discovery
 *   (project, space, repo) -> write only what changed -> verify jira, confluence, bitbucket
 *   (or record N/A) -> `CLAUDE.md` pointer -> unpushed-changes reminder.
 *
 * New project vs. joining one needs no separate mode: every step is verified LIVE, so a project
 * that is already provisioned simply passes each one and a new one stops at the first failure
 * with that step's to-do list; re-running continues from there. `init-state.json` stops being
 * something a user moves between clones -- it is a cache this run rebuilds from real API
 * results (a step that now fails is cleared, not left reading as done).
 *
 * Everything with a side effect on the outside world (prompts, the editor, the Atlassian and
 * Bitbucket calls, `git status`) is injected via `InitRunDeps`, so the orchestration order, the
 * N/A Bitbucket record, the reminder and the non-TTY path are all unit-tested with fakes; the
 * real terminal wiring lives in `init-run-io.ts` and `cli.ts`. This file never prompts for or
 * echoes a secret: those lines are filled by the human in their own editor, never through chat
 * or a prompt.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
    clearStep,
    isInitComplete,
    markStepDone,
    parseEnvContent,
    requiredEnvSecretKeys,
    writeClaudeMdPointer,
    writeEnvSkeleton,
    writeEnvValues,
    type BitbucketVerifyInput,
    type BitbucketVerifyResult,
    type ConfluenceSetupInput,
    type ConfluenceSetupResult,
    type InitStep,
    type JiraVerifyInput,
    type JiraVerifyResult,
} from "./target-init.js";
import {
    decidePick,
    planCoordinate,
    projectChoices,
    spaceChoices,
    type Choice,
    type DiscoveredProject,
    type DiscoveredSpace,
    type Listing,
} from "./discovery.js";

// ---------- Pure helpers ----------

/** Files `init` generates or edits that a teammate or a fresh clone only gets once they are
 *  committed and pushed -- the EXA case where `CLAUDE.md` sat in a local commit and a clean
 *  clone simply lacked it. */
const SHARED_INIT_FILES = ["CLAUDE.md", ".gitignore"] as const;

/** A plain reminder (never an action: TAI does not commit or push for you) when
 *  `git status --porcelain` shows a shared init file modified, staged, renamed-to or untracked.
 *  Only repo-root files count. `null` = nothing to say, including "not a git repo". */
export function unpushedChangesReminder(porcelain: string | null): string | null {
    if (porcelain === null) return null;
    const changed = new Set<string>();
    for (const line of porcelain.split("\n")) {
        if (line.length < 4) continue;
        let file = line.slice(3).trim();
        const arrow = file.indexOf(" -> ");
        if (arrow !== -1) file = file.slice(arrow + 4);
        file = file.replace(/^"(.*)"$/, "$1");
        if ((SHARED_INIT_FILES as readonly string[]).includes(file)) changed.add(file);
    }
    if (changed.size === 0) return null;
    const files = SHARED_INIT_FILES.filter((f) => changed.has(f));
    const list = files.join(" and ");
    return (
        `Reminder: ${list} ${files.length === 1 ? "has" : "have"} changes that aren't committed yet. TAI never ` +
        `commits or pushes for you -- commit and push ${files.length === 1 ? "it" : "them"} so teammates and ` +
        `fresh clones get ${files.length === 1 ? "it" : "them"}.`
    );
}

/** `$VISUAL`, then `$EDITOR`; empty strings count as unset. No default on POSIX (the caller
 *  prints the path and waits instead); `notepad` on Windows, where nothing else is a given. */
export function chooseEditor(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
    const configured = env["VISUAL"]?.trim() || env["EDITOR"]?.trim();
    if (configured) return configured;
    return platform === "win32" ? "notepad" : undefined;
}

/** A shell command line that opens `filePath` in `editor`. `editor` may carry arguments
 *  (`code --wait`), so this is meant to run through a shell; only the path is quoted. */
export function buildEditorCommand(editor: string, filePath: string, platform: NodeJS.Platform): string {
    if (platform === "win32") return `${editor} "${filePath}"`;
    return `${editor} '${filePath.replace(/'/g, `'\\''`)}'`;
}

/** `https://<host>` from whatever the user typed: a bare host gets `https://`, a trailing
 *  slash or a pasted board/page path is dropped. `null` for empty, unparseable or plain http
 *  (Atlassian Cloud is https-only). */
export function normalizeSiteUrl(input: string): string | null {
    const text = input.trim();
    if (text === "" || /\s/.test(text)) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
    try {
        const url = new URL(withScheme);
        if (url.protocol !== "https:" || !url.hostname.includes(".")) return null;
        return url.origin;
    } catch {
        return null;
    }
}

export function renderFillInstructions(missingKeys: readonly string[], envPath: string): string {
    return [
        `Almost there -- these lines in ${envPath} still need your own values:`,
        "",
        ...missingKeys.map((k) => `  - ${k}`),
        "",
        "Each one has a comment above it saying what belongs there. Save the file and close your editor when you're done.",
    ].join("\n");
}

// ---------- Engine ----------

export interface InitRunIO {
    say(text: string): void;
    /** Only ever called when `interactive`. Returns the raw (trimmed) line; the engine applies defaults. */
    ask(question: string, defaultValue?: string): Promise<string>;
    /** Only ever called when `interactive`. `no-editor` = none is configured / could not be started. */
    editFile(filePath: string): Promise<"edited" | "no-editor">;
}

export interface InitRunServices {
    listProjects(siteUrl: string, email: string, apiToken: string): Promise<Listing<DiscoveredProject>>;
    listSpaces(siteUrl: string, email: string, apiToken: string): Promise<Listing<DiscoveredSpace>>;
    detectBitbucketRepo(cwd: string): Promise<string | null>;
    verifyJira(input: JiraVerifyInput): Promise<JiraVerifyResult>;
    setupConfluence(input: ConfluenceSetupInput): Promise<ConfluenceSetupResult>;
    verifyBitbucket(input: BitbucketVerifyInput): Promise<BitbucketVerifyResult>;
    gitStatusPorcelain(cwd: string): Promise<string | null>;
}

export interface InitRunDeps {
    readonly cwd: string;
    readonly taiRoot: string;
    readonly taiHome: string;
    /** `process.env` after `.env` was loaded (shell exports win over `.env`, as at runtime). */
    readonly env: NodeJS.ProcessEnv;
    /** A real terminal on both ends. When false the engine never prompts or opens an editor. */
    readonly interactive: boolean;
    readonly io: InitRunIO;
    /** The CLI's own step-result renderer, injected so the core stays free of host imports. */
    readonly renderStepResult: (step: InitStep, ok: boolean, detail: string, fullyInitialized?: boolean) => string;
    readonly services: InitRunServices;
}

export interface InitRunResult {
    readonly ok: boolean;
    /** 0 = done, 1 = a step failed or the user quit, 2 = needs a human at a terminal. */
    readonly exitCode: 0 | 1 | 2;
    readonly stoppedAt?: string;
}

const MAX_LOOPS = 25;
const MAX_ROWS_SHOWN = 20;

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

async function readEnvFile(envPath: string): Promise<string> {
    try {
        return await readFile(envPath, "utf-8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return "";
    }
}

/** Shell exports win over `.env` at runtime, but the file the user just edited must win for
 *  this run's secrets, so: ambient values first, then every NON-EMPTY value from the file. */
function mergedEnv(ambient: NodeJS.ProcessEnv, fileContent: string): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(ambient)) if (typeof v === "string") merged[k] = v;
    for (const [k, v] of Object.entries(parseEnvContent(fileContent))) if (v !== "") merged[k] = v;
    return merged;
}

function showChoices(io: InitRunIO, choices: readonly Choice[]): void {
    choices.slice(0, MAX_ROWS_SHOWN).forEach((c, i) => io.say(`  ${i + 1}. ${c.label}`));
    if (choices.length > MAX_ROWS_SHOWN) {
        io.say(`  ... and ${choices.length - MAX_ROWS_SHOWN} more -- type part of a name to filter.`);
    }
}

/** Interactive picker over `decidePick`. Returns the value to write, or `null` if the loop
 *  ran out (never silently picks). */
async function pickCoordinate(
    io: InitRunIO,
    opts: { noun: string; choices: readonly Choice[]; truncated: boolean; unverifiedExisting?: string }
): Promise<string | null> {
    const { noun, choices, truncated, unverifiedExisting } = opts;
    if (truncated) {
        io.say(`Note: the ${noun} list may be incomplete (it hit the page limit), so one you expect might be missing -- you can still type its key.`);
    }
    if (unverifiedExisting !== undefined) {
        io.say(`${unverifiedExisting} is set in .env but wasn't found in the live ${noun} list. Press Enter to keep it, or pick another.`);
    }
    if (choices.length === 0) io.say(`No ${noun}s were listed for these credentials -- type the key to use.`);
    else showChoices(io, choices);

    let shown: readonly Choice[] = choices;
    for (let i = 0; i < MAX_LOOPS; i++) {
        const answer = await io.ask(`${noun} (number, key, or text to filter)`, unverifiedExisting);
        const decision = decidePick(answer, choices, shown, unverifiedExisting);
        switch (decision.kind) {
            case "chosen": {
                const picked = choices.find((c) => c.value === decision.value);
                io.say(`Selected: ${picked ? picked.label : decision.value}`);
                return decision.value;
            }
            case "narrowed":
                shown = decision.matches;
                showChoices(io, shown);
                break;
            case "not-listed": {
                const ok = await io.ask(
                    `'${decision.typed}' is not in the list. Use it anyway (for example a ${noun} you are about to create)? [y/N]`
                );
                if (/^y/i.test(ok.trim())) return decision.typed;
                break;
            }
            case "reprompt":
                break;
        }
    }
    return null;
}

/** The whole flow. Never throws for an expected failure -- those come back as `exitCode`. */
export async function runInit(deps: InitRunDeps): Promise<InitRunResult> {
    const { cwd, taiRoot, taiHome, io, services, renderStepResult } = deps;
    const envPath = path.join(cwd, ".env");
    const stop = (exitCode: 1 | 2, stoppedAt: string): InitRunResult => ({ ok: false, exitCode, stoppedAt });
    const needsHuman = (stoppedAt: string): InitRunResult => {
        io.say("This step needs a human at a terminal: run `init run` yourself (not through an assistant's shell) to finish it.");
        return stop(2, stoppedAt);
    };

    const detectedRepo = await services.detectBitbucketRepo(cwd);
    let env = mergedEnv(deps.env, await readEnvFile(envPath));

    // `init run` sets up the Jira backend. A different TAI_BACKEND the user already chose is
    // never overridden (fill-if-empty), but it would silently win at runtime, so say so.
    const backend = (env["TAI_BACKEND"] ?? "").trim();
    if (backend !== "" && backend !== "jira") {
        io.say(
            `Note: TAI_BACKEND is set to "${backend}", so TAI will use that backend instead of Jira at runtime. ` +
                `\`init run\` sets up the Jira backend -- change TAI_BACKEND to jira (or remove it) to use it.`
        );
    }

    // ----- 1. Site URL -----
    let siteUrl = normalizeSiteUrl(env["TAI_JIRA_SITE_URL"] ?? "") ?? "";
    if (deps.interactive) {
        let chosen: string | null = null;
        for (let i = 0; i < MAX_LOOPS && chosen === null; i++) {
            const answer = await io.ask("Atlassian site URL (e.g. https://your-site.atlassian.net)", siteUrl || undefined);
            chosen = normalizeSiteUrl(answer === "" ? siteUrl : answer);
            if (chosen === null) io.say("That doesn't look like an https URL -- try something like your-site.atlassian.net.");
        }
        if (chosen === null) return stop(1, "site-url");
        siteUrl = chosen;
    }

    // ----- 2. Is Bitbucket (git-pr) in scope? -----
    const bitbucketConfigured = Boolean(env["BITBUCKET_EMAIL"] || env["BITBUCKET_API_TOKEN"] || env["TAI_GIT_REPOS"]);
    let includeBitbucket = bitbucketConfigured;
    if (!bitbucketConfigured && detectedRepo !== null) {
        if (deps.interactive) {
            const answer = await io.ask(
                `This clone's remote is on Bitbucket (${detectedRepo}). Set up git-pr support too? [Y/n]`
            );
            includeBitbucket = !/^n/i.test(answer.trim());
        } else {
            io.say(
                `Note: this clone's remote is on Bitbucket (${detectedRepo}) but no Bitbucket credentials are configured, ` +
                    `so git-pr setup is skipped. Run \`init run\` in a terminal to add them.`
            );
        }
    }

    // ----- 3. .env skeleton, then the human fills the secrets -----
    await writeEnvSkeleton(cwd, {
        siteUrl,
        ...(env["TAI_PROJECT_KEY"] ? { projectKey: env["TAI_PROJECT_KEY"] } : {}),
        ...(env["TAI_SPACE_KEY"] ? { spaceKey: env["TAI_SPACE_KEY"] } : {}),
        includeBitbucket,
    });
    // A typed site URL that differs from a non-empty one already in the file is a deliberate
    // change; the skeleton's fill-if-empty mode would (rightly) never make it.
    if (parseEnvContent(await readEnvFile(envPath))["TAI_JIRA_SITE_URL"] !== siteUrl && siteUrl !== "") {
        await writeEnvValues(cwd, { TAI_JIRA_SITE_URL: siteUrl });
    }

    const missingNow = async (): Promise<string[]> => {
        env = mergedEnv(deps.env, await readEnvFile(envPath));
        return [
            ...(normalizeSiteUrl(env["TAI_JIRA_SITE_URL"] ?? "") ? [] : ["TAI_JIRA_SITE_URL"]),
            ...requiredEnvSecretKeys(includeBitbucket).filter((k) => (env[k] ?? "").trim() === ""),
        ];
    };

    let missing = await missingNow();
    if (missing.length > 0) {
        if (!deps.interactive) {
            io.say(renderFillInstructions(missing, envPath));
            return needsHuman("env");
        }
        io.say(renderFillInstructions(missing, envPath));
        for (let i = 0; i < MAX_LOOPS && missing.length > 0; i++) {
            const opened = await io.editFile(envPath);
            if (opened === "no-editor") {
                io.say(`No editor is configured ($VISUAL / $EDITOR). Open ${envPath} yourself, fill in those lines, and save it.`);
            }
            missing = await missingNow();
            if (missing.length === 0) break;
            const answer = await io.ask(
                opened === "no-editor"
                    ? `Press Enter once you have saved the file ('q' to quit)`
                    : `Still empty: ${missing.join(", ")}. Enter = check again after saving, e = reopen the editor, q = quit`
            );
            if (/^q/i.test(answer.trim())) return stop(1, "env");
            // "e" goes round again and reopens the editor; anything else re-checks the file as
            // it is now (the user may have saved from a GUI editor that returned immediately).
            if (!/^e/i.test(answer.trim())) missing = await missingNow();
        }
        if (missing.length > 0) return stop(1, "env");
    }

    const email = env["TAI_JIRA_EMAIL"] as string;
    const apiToken = env["TAI_JIRA_API_TOKEN"] as string;
    siteUrl = normalizeSiteUrl(env["TAI_JIRA_SITE_URL"] ?? "") as string;

    // ----- 4. Discovery: keep what works, ask only about what's missing or stale -----
    let projectKey: string | null;
    let spaceKey: string | null;
    try {
        const projects = await services.listProjects(siteUrl, email, apiToken);
        const spaces = await services.listSpaces(siteUrl, email, apiToken);

        const resolve = async (
            noun: string,
            envKey: string,
            choices: Choice[],
            truncated: boolean
        ): Promise<string | "needs-human" | null> => {
            const plan = planCoordinate(env[envKey], choices);
            if (plan.kind === "keep") {
                io.say(`${noun}: ${plan.value} (confirmed live)`);
                return plan.value;
            }
            if (!deps.interactive) {
                io.say(`${envKey} is ${plan.unverifiedExisting ? `set to ${plan.unverifiedExisting} but not found in the live ${noun} list` : "not set"}.`);
                return "needs-human";
            }
            return pickCoordinate(io, {
                noun,
                choices,
                truncated,
                ...(plan.unverifiedExisting !== undefined ? { unverifiedExisting: plan.unverifiedExisting } : {}),
            });
        };

        const p = await resolve("Jira project", "TAI_PROJECT_KEY", projectChoices(projects.items), projects.truncated);
        if (p === "needs-human") return needsHuman("discovery");
        projectKey = p;
        const s = await resolve("Confluence space", "TAI_SPACE_KEY", spaceChoices(spaces.items), spaces.truncated);
        if (s === "needs-human") return needsHuman("discovery");
        spaceKey = s;
    } catch (err) {
        io.say(
            `Could not list your Jira projects / Confluence spaces: ${errorMessage(err)}\n` +
                `Check TAI_JIRA_EMAIL and TAI_JIRA_API_TOKEN in ${envPath}, then run \`init run\` again.`
        );
        return stop(1, "discovery");
    }
    if (projectKey === null || spaceKey === null) return stop(1, "discovery");

    // Bitbucket repository
    let repos = (env["TAI_GIT_REPOS"] ?? "").trim();
    if (includeBitbucket && repos === "") {
        if (deps.interactive) {
            const answer = await io.ask("Bitbucket repository (workspace/repo)", detectedRepo ?? undefined);
            repos = (answer === "" ? (detectedRepo ?? "") : answer).trim();
        } else {
            repos = detectedRepo ?? "";
        }
    }

    // Write only what's new or different -- never a secret key.
    const onDisk = parseEnvContent(await readEnvFile(envPath));
    const toWrite: Record<string, string> = {};
    if (onDisk["TAI_PROJECT_KEY"] !== projectKey) toWrite["TAI_PROJECT_KEY"] = projectKey;
    if (onDisk["TAI_SPACE_KEY"] !== spaceKey) toWrite["TAI_SPACE_KEY"] = spaceKey;
    if (includeBitbucket && repos !== "" && onDisk["TAI_GIT_REPOS"] !== repos) toWrite["TAI_GIT_REPOS"] = repos;
    if (Object.keys(toWrite).length > 0) await writeEnvValues(cwd, toWrite);

    // ----- 5. Verify every step live, in order; stop at the first failure -----
    const record = async (step: InitStep, ok: boolean, detail: string): Promise<void> => {
        if (ok) await markStepDone(taiRoot, step, detail);
        else await clearStep(taiRoot, step);
        io.say(renderStepResult(step, ok, detail));
    };
    const attempt = async <T extends { ok: boolean; detail: string }>(run: () => Promise<T>): Promise<{ ok: boolean; detail: string }> => {
        try {
            const r = await run();
            return { ok: r.ok, detail: r.detail };
        } catch (err) {
            return { ok: false, detail: `Could not verify: ${errorMessage(err)}` };
        }
    };

    const jira = await attempt(() =>
        services.verifyJira({ siteUrl, email, apiToken, projectKey: projectKey as string, spaceKey: spaceKey as string })
    );
    await record("jira", jira.ok, jira.detail);
    if (!jira.ok) return stop(1, "jira");

    const confluence = await attempt(() => services.setupConfluence({ siteUrl, email, apiToken, spaceKey: spaceKey as string }));
    await record("confluence", confluence.ok, confluence.detail);
    if (!confluence.ok) return stop(1, "confluence");

    const bitbucketEmail = (env["BITBUCKET_EMAIL"] ?? "").trim();
    const bitbucketToken = (env["BITBUCKET_API_TOKEN"] ?? "").trim();
    const repo = repos.split(",")[0]?.trim() ?? "";
    if (includeBitbucket && repo !== "" && bitbucketEmail !== "" && bitbucketToken !== "") {
        const bitbucket = await attempt(() => services.verifyBitbucket({ email: bitbucketEmail, apiToken: bitbucketToken, repo }));
        await record("bitbucket", bitbucket.ok, bitbucket.detail);
        if (!bitbucket.ok) return stop(1, "bitbucket");
    } else {
        // TAI-350: a project that never uses git-pr must still be able to reach "fully
        // initialized", without isInitComplete having to know whether Bitbucket was needed.
        const why = !includeBitbucket
            ? detectedRepo !== null && !deps.interactive
                ? `no Bitbucket credentials configured (this clone's remote is ${detectedRepo})`
                : "git-pr support not set up for this project"
            : "no Bitbucket repository or credentials configured";
        await record("bitbucket", true, `N/A -- ${why}`);
    }

    await markStepDone(taiRoot, "env", `.env verified by init run (${envPath}).`);
    await writeClaudeMdPointer(cwd, taiRoot, taiHome);
    const finalState = await markStepDone(taiRoot, "claude-md", `Wrote ${path.join(cwd, "CLAUDE.md")}.`);
    io.say(renderStepResult("claude-md", true, `Wrote ${path.join(cwd, "CLAUDE.md")}.`, isInitComplete(finalState)));

    // ----- 6. Plain reminder, never an action -----
    const reminder = unpushedChangesReminder(await services.gitStatusPorcelain(cwd));
    if (reminder !== null) io.say(`\n${reminder}`);

    return { ok: true, exitCode: 0 };
}
