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
 *   (or record N/A) -> `CLAUDE.md` + `GEMINI.md` pointers -> unpushed-changes reminder.
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
    writeGeminiMdPointer,
    writeEnvSkeleton,
    writeEnvValues,
    type BitbucketVerifyInput,
    type BitbucketVerifyResult,
    type GitHubVerifyInput,
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
import { GIT_HOST_SECRET_KEYS, parseGitHostKind, type GitHostKind } from "../git/host-factory.js";

const GIT_HOST_LABEL: Record<GitHostKind, string> = { bitbucket: "Bitbucket", github: "GitHub" };

// ---------- Pure helpers ----------

/** Files `init` generates or edits that a teammate or a fresh clone only gets once they are
 *  committed and pushed -- the EXA case where `CLAUDE.md` sat in a local commit and a clean
 *  clone simply lacked it. */
const SHARED_INIT_FILES = ["CLAUDE.md", "GEMINI.md", ".gitignore"] as const;

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
    const list = files.length > 1 ? `${files.slice(0, -1).join(", ")} and ${files[files.length - 1]}` : files.join("");
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

/** Quotes a path for a POSIX shell only when it needs it, so the common case stays readable. */
function shellQuote(value: string): string {
    return /^[\w@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** What to tell a human whose assistant's shell can't prompt or open an editor: a command to
 *  paste into a separate terminal. `init run` needs a real TTY, and neither host's
 *  assistant shell reliably has one (Claude Code's `!` has none; Gemini CLI's has one but the
 *  editor hand-off there is unverified), so the safe default is always a separate terminal. */
export function renderRunInstructions(cwd: string, taiHome: string): string {
    return [
        "Open a separate terminal and run:",
        "",
        `  cd ${shellQuote(cwd)}`,
        `  npx --prefix ${shellQuote(taiHome)} tsx ${shellQuote(`${taiHome}/src/hosts/cli.ts`)} init run`,
        "",
        "Run it directly in the terminal -- piping or redirecting its output also disables the prompts. Then come back and carry on.",
    ].join("\n");
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
    /** `origin`'s git host and repo (TAI-583), or null. */
    detectGitRemote(cwd: string): Promise<{ readonly kind: GitHostKind; readonly repo: string } | null>;
    verifyJira(input: JiraVerifyInput): Promise<JiraVerifyResult>;
    setupConfluence(input: ConfluenceSetupInput): Promise<ConfluenceSetupResult>;
    verifyBitbucket(input: BitbucketVerifyInput): Promise<BitbucketVerifyResult>;
    verifyGitHub(input: GitHubVerifyInput): Promise<BitbucketVerifyResult>;
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
    readonly renderStepResult: (
        step: InitStep,
        ok: boolean,
        detail: string,
        fullyInitialized?: boolean,
        /** Display-only heading override (TAI-377); never changes the step key. */
        label?: string
    ) => string;
    readonly services: InitRunServices;
}

export interface InitRunResult {
    readonly ok: boolean;
    /** 0 = done, 1 = a step failed or the user quit, 2 = needs a human at a terminal. */
    readonly exitCode: 0 | 1 | 2;
    readonly stoppedAt?: string;
}

/** The message `createConfluenceDocStore` throws for a space key it cannot resolve (doc-store.ts,
 *  `resolveSpaceId`). A wrong space key surfaces at the JIRA step, not the Confluence one,
 *  because Jira verification loads the Type Aliases page from that space. Guarded against
 *  drifting from the real message by a test that runs the real doc store. */
export const SPACE_NOT_FOUND = /Confluence space ".*?" not found/;

const MAX_LOOPS = 25;
const MAX_ROWS_SHOWN = 20;
const MAX_REPO_TRIES = 3;
const MAX_KEY_TRIES = 3;

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

/** `typed` as the live list spells it (matched case-insensitively on any key or alias), or `typed`
 *  unchanged when there is no usable list or no match. */
function canonicalFromList(typed: string, listed: Listing<unknown> | { error: string }, choices: () => Choice[]): string {
    if ("error" in listed) return typed;
    const wanted = typed.toLowerCase();
    const hit = choices().find((c) => c.keys.some((k) => k.toLowerCase() === wanted));
    return hit ? hit.value : typed;
}

/** The whole flow. Never throws for an expected failure -- those come back as `exitCode`. */
export async function runInit(deps: InitRunDeps): Promise<InitRunResult> {
    const { cwd, taiRoot, taiHome, io, services, renderStepResult } = deps;
    const envPath = path.join(cwd, ".env");
    const stop = (exitCode: 1 | 2, stoppedAt: string): InitRunResult => ({ ok: false, exitCode, stoppedAt });
    const needsHuman = (stoppedAt: string): InitRunResult => {
        io.say(
            "This step needs a human at a terminal -- an assistant's shell can't prompt you or open your editor.\n\n" +
                renderRunInstructions(cwd, taiHome)
        );
        return stop(2, stoppedAt);
    };

    const detected = await services.detectGitRemote(cwd);
    let env = mergedEnv(deps.env, await readEnvFile(envPath));
    // TAI-583: the host is TAI_GIT_HOST when set, else origin's, else Bitbucket. A remote on the
    // other host is not offered as this host's repository.
    const gitHost: GitHostKind = parseGitHostKind(env["TAI_GIT_HOST"] ?? "") ?? detected?.kind ?? "bitbucket";
    const hostLabel = GIT_HOST_LABEL[gitHost];
    const detectedRepo = detected !== null && detected.kind === gitHost ? detected.repo : null;

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

    // ----- 2. Is the git host (git-pr) in scope? -----
    const gitHostConfigured = Boolean(GIT_HOST_SECRET_KEYS[gitHost].some((key) => env[key]) || env["TAI_GIT_REPOS"]);
    let includeGitHost = gitHostConfigured;
    if (!gitHostConfigured && detectedRepo !== null) {
        if (deps.interactive) {
            const answer = await io.ask(
                `This clone's remote is on ${hostLabel} (${detectedRepo}). Set up git-pr support too? [Y/n]`
            );
            includeGitHost = !/^n/i.test(answer.trim());
        } else {
            io.say(
                `Note: this clone's remote is on ${hostLabel} (${detectedRepo}) but no ${hostLabel} credentials are configured, ` +
                    `so git-pr setup is skipped. Run \`init run\` in a terminal to add them.`
            );
        }
    }

    // ----- 3. .env skeleton, then the human fills the secrets -----
    await writeEnvSkeleton(cwd, {
        siteUrl,
        ...(env["TAI_PROJECT_KEY"] ? { projectKey: env["TAI_PROJECT_KEY"] } : {}),
        ...(env["TAI_SPACE_KEY"] ? { spaceKey: env["TAI_SPACE_KEY"] } : {}),
        includeGitHost,
        gitHost,
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
            ...requiredEnvSecretKeys(includeGitHost, gitHost).filter((k) => (env[k] ?? "").trim() === ""),
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

    // A secret supplied only by a shell `export` satisfies this run but leaves the .env line
    // empty -- a new terminal without the export would have no credentials. Never copied in
    // (init run writes no secrets), so say so.
    const fileOnly = parseEnvContent(await readEnvFile(envPath));
    for (const key of requiredEnvSecretKeys(includeGitHost, gitHost)) {
        if ((fileOnly[key] ?? "").trim() === "" && (env[key] ?? "").trim() !== "") {
            io.say(`Note: ${key} is set in your shell but empty in ${envPath}, so a new terminal without that export won't have it. Fill it in the file to make it permanent.`);
        }
    }

    const email = env["TAI_JIRA_EMAIL"] as string;
    const apiToken = env["TAI_JIRA_API_TOKEN"] as string;
    siteUrl = normalizeSiteUrl(env["TAI_JIRA_SITE_URL"] ?? "") as string;

    // ----- 4. Discovery: keep what works, ask only about what's missing or stale -----
    // A list call is a convenience for FINDING a missing value, not a precondition for using one
    // already in .env: a token without list scope can still pass the live verification below
    // (TAI-367 review). So a failed list is carried as data, not thrown.
    const tryList = async <T,>(run: () => Promise<Listing<T>>): Promise<Listing<T> | { error: string }> => {
        try {
            return await run();
        } catch (err) {
            return { error: errorMessage(err) };
        }
    };
    const projectsListed = await tryList(() => services.listProjects(siteUrl, email, apiToken));
    const spacesListed = await tryList(() => services.listSpaces(siteUrl, email, apiToken));

    type Resolved = { readonly kind: "value"; readonly value: string } | { readonly kind: "needs-human" } | { readonly kind: "abandoned" };
    const resolve = async (
        noun: string,
        envKey: string,
        listed: Listing<unknown> | { error: string },
        toChoices: () => Choice[]
    ): Promise<Resolved> => {
        const existing = (env[envKey] ?? "").trim();
        let choices: Choice[] = [];
        let truncated = false;
        if ("error" in listed) {
            if (existing !== "") {
                io.say(`Note: couldn't list ${noun}s to cross-check ${envKey} (${listed.error}) -- keeping ${existing}; live verification below will confirm it.`);
                return { kind: "value", value: existing };
            }
            io.say(
                `Could not list your ${noun}s: ${listed.error}\n` +
                    `Check TAI_JIRA_EMAIL and TAI_JIRA_API_TOKEN in ${envPath}${deps.interactive ? "" : `, or set ${envKey} there yourself`}, then run \`init run\` again.`
            );
            if (!deps.interactive) return { kind: "abandoned" };
            // Interactive: nothing to pick from, so fall through to typing the key by hand.
        } else {
            choices = toChoices();
            truncated = listed.truncated;
        }

        const plan = planCoordinate(existing, choices);
        if (plan.kind === "keep") {
            io.say(`${noun}: ${plan.value} (confirmed live)`);
            return { kind: "value", value: plan.value };
        }
        if (plan.unverifiedExisting !== undefined && truncated) {
            // Not found in a list we know is partial: absence is not evidence, verification decides.
            io.say(`Note: the ${noun} list was incomplete, so ${plan.unverifiedExisting} couldn't be cross-checked -- keeping it; live verification below will confirm it.`);
            return { kind: "value", value: plan.unverifiedExisting };
        }
        if (!deps.interactive) {
            io.say(`${envKey} is ${plan.unverifiedExisting ? `set to ${plan.unverifiedExisting} but not found in the live ${noun} list` : "not set"}.`);
            return { kind: "needs-human" };
        }
        const picked = await pickCoordinate(io, {
            noun,
            choices,
            truncated,
            ...(plan.unverifiedExisting !== undefined ? { unverifiedExisting: plan.unverifiedExisting } : {}),
        });
        return picked === null ? { kind: "abandoned" } : { kind: "value", value: picked };
    };

    const resolvedProject = await resolve("Jira project", "TAI_PROJECT_KEY", projectsListed, () =>
        projectChoices((projectsListed as Listing<DiscoveredProject>).items)
    );
    if (resolvedProject.kind === "needs-human") return needsHuman("discovery");
    if (resolvedProject.kind === "abandoned") return stop(1, "discovery");
    const resolvedSpace = await resolve("Confluence space", "TAI_SPACE_KEY", spacesListed, () =>
        spaceChoices((spacesListed as Listing<DiscoveredSpace>).items)
    );
    if (resolvedSpace.kind === "needs-human") return needsHuman("discovery");
    if (resolvedSpace.kind === "abandoned") return stop(1, "discovery");
    let projectKey = resolvedProject.value;
    let spaceKey = resolvedSpace.value;

    // Bitbucket repository
    let repos = (env["TAI_GIT_REPOS"] ?? "").trim();
    if (includeGitHost && repos === "") {
        if (deps.interactive) {
            const answer = await io.ask(`${hostLabel} repository (${gitHost === "github" ? "owner/repo" : "workspace/repo"})`, detectedRepo ?? undefined);
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
    if (includeGitHost && repos !== "" && onDisk["TAI_GIT_REPOS"] !== repos) toWrite["TAI_GIT_REPOS"] = repos;
    // TAI-583 ADR decision 2: written explicitly, so the host never depends on origin at run time.
    if (includeGitHost && onDisk["TAI_GIT_HOST"] !== gitHost) toWrite["TAI_GIT_HOST"] = gitHost;
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

    // A wrong project key or space key is most often a typo -- and a value kept because the list
    // could not confirm it (failed or truncated list) would otherwise fail identically on every
    // re-run. So in a terminal, offer the retype right here, as for the Bitbucket repo.
    for (let tries = 1; ; tries++) {
        let jira: { ok: boolean; detail: string; projectFound?: boolean };
        try {
            const result = await services.verifyJira({ siteUrl, email, apiToken, projectKey, spaceKey });
            jira = { ok: result.ok, detail: result.detail, projectFound: result.projectFound };
        } catch (err) {
            jira = { ok: false, detail: `Could not verify: ${errorMessage(err)}` };
        }
        if (jira.ok) {
            await record("jira", true, jira.detail);
            break;
        }
        await record("jira", false, jira.detail);
        const wrong: "project" | "space" | null =
            jira.projectFound === false ? "project" : SPACE_NOT_FOUND.test(jira.detail) ? "space" : null;
        if (wrong === null) return stop(1, "jira");
        const keyName = wrong === "project" ? "TAI_PROJECT_KEY" : "TAI_SPACE_KEY";
        io.say(`Check ${keyName} (and TAI_PROJECT_KEY / TAI_SPACE_KEY generally) in ${envPath}.`);
        if (!deps.interactive || tries >= MAX_KEY_TRIES) return stop(1, "jira");
        const noun = wrong === "project" ? "Jira project" : "Confluence space";
        const answer = await io.ask(`${noun} key to try instead (it is ${wrong === "project" ? projectKey : spaceKey} now), or q to stop`);
        const typedKey = answer.trim();
        if (typedKey === "" || /^q$/i.test(typedKey)) return stop(1, "jira");
        // Where a list is available, take ITS spelling: tai -> TAI, and a space's real key TA ->
        // its alias TAI (the common name, per the human's decision). With no list, as typed.
        const replacement = canonicalFromList(
            typedKey,
            wrong === "project" ? projectsListed : spacesListed,
            () =>
                wrong === "project"
                    ? projectChoices((projectsListed as Listing<DiscoveredProject>).items)
                    : spaceChoices((spacesListed as Listing<DiscoveredSpace>).items)
        );
        await writeEnvValues(cwd, { [keyName]: replacement });
        if (wrong === "project") projectKey = replacement;
        else spaceKey = replacement;
    }

    const confluence = await attempt(() => services.setupConfluence({ siteUrl, email, apiToken, spaceKey: spaceKey as string }));
    await record("confluence", confluence.ok, confluence.detail);
    if (!confluence.ok) return stop(1, "confluence");

    const bitbucketEmail = (env["BITBUCKET_EMAIL"] ?? "").trim();
    const bitbucketToken = (env["BITBUCKET_API_TOKEN"] ?? "").trim();
    const githubToken = (env["GITHUB_TOKEN"] ?? "").trim();
    const hasCredentials = gitHost === "github" ? githubToken !== "" : bitbucketEmail !== "" && bitbucketToken !== "";
    const repo = repos.split(",")[0]?.trim() ?? "";
    // The `bitbucket` step records the git host's check, whichever host it is: renaming it would
    // orphan the step already recorded in existing projects' init state.
    if (includeGitHost && repo !== "" && hasCredentials) {
        // The repo is hand-typed (or saved by an earlier run), so a failure here is most often a
        // typo -- and because the value is already in .env, a plain re-run would skip the prompt
        // and fail identically. So in a terminal, offer the correction right here (TAI-367 review).
        let repoList = repos.split(",").map((r) => r.trim()).filter((r) => r !== "");
        let currentRepo = repo;
        for (let tries = 1; ; tries++) {
            const bitbucket = await attempt(() =>
                gitHost === "github"
                    ? services.verifyGitHub({ token: githubToken, repo: currentRepo })
                    : services.verifyBitbucket({ email: bitbucketEmail, apiToken: bitbucketToken, repo: currentRepo })
            );
            if (bitbucket.ok) {
                await record("bitbucket", true, bitbucket.detail);
                break;
            }
            await record("bitbucket", false, bitbucket.detail);
            const hint = `Check TAI_GIT_REPOS, ${GIT_HOST_SECRET_KEYS[gitHost].join(" and ")} in ${envPath}.`;
            if (!deps.interactive || tries >= MAX_REPO_TRIES) {
                io.say(hint);
                return stop(1, "bitbucket");
            }
            io.say(hint);
            // An answer must contain at least one repository once parsed: a lone "," or blanks mean
            // nothing, and must never reach .env (it would wipe the rest of the list).
            let typed: string[] = [];
            for (let ask = 0; ask < MAX_LOOPS && typed.length === 0; ask++) {
                const answer = await io.ask(
                    `${hostLabel} repository (${gitHost === "github" ? "owner/repo" : "workspace/repo"}) to use instead of ${currentRepo}, or q to stop`,
                    detectedRepo ?? currentRepo
                );
                if (/^q/i.test(answer.trim())) return stop(1, "bitbucket");
                const replacement = (answer === "" ? (detectedRepo ?? currentRepo) : answer).trim();
                typed = replacement.split(",").map((r) => r.trim()).filter((r) => r !== "");
                if (typed.length === 0) io.say("That didn't contain a repository -- type workspace/repo (or a comma-separated list), or q to stop.");
            }
            if (typed.length === 0) return stop(1, "bitbucket");
            // One repo (stray commas and spaces ignored) replaces only the failing FIRST entry and
            // keeps the rest of the list; typing MORE than one is an explicit full replacement.
            // Never silently drop the user's others.
            const next = typed.length > 1 ? typed : [typed[0] as string, ...repoList.slice(1)];
            repoList = [...new Set(next)];
            await writeEnvValues(cwd, { TAI_GIT_REPOS: repoList.join(",") });
            currentRepo = repoList[0] as string;
        }
    } else {
        // TAI-350: a project that never uses git-pr must still be able to reach "fully
        // initialized", without isInitComplete having to know whether Bitbucket was needed.
        const why = !includeGitHost
            ? detectedRepo !== null && !deps.interactive
                ? `no ${hostLabel} credentials configured (this clone's remote is ${detectedRepo})`
                : "git-pr support not set up for this project"
            : `no ${hostLabel} repository or credentials configured`;
        await record("bitbucket", true, `N/A -- ${why}`);
    }

    await markStepDone(taiRoot, "env", `.env verified by init run (${envPath}).`);
    await writeClaudeMdPointer(cwd, taiRoot, taiHome);
    // TAI-376: Gemini CLI reads GEMINI.md, so write the same pointer there. Not a recorded step.
    await writeGeminiMdPointer(cwd, taiRoot, taiHome);
    const finalState = await markStepDone(taiRoot, "claude-md", `Wrote ${path.join(cwd, "CLAUDE.md")}.`);
    io.say(
        renderStepResult(
            "claude-md",
            true,
            `Wrote ${path.join(cwd, "CLAUDE.md")} and ${path.join(cwd, "GEMINI.md")}.`,
            isInitComplete(finalState),
            "claude-md + gemini-md"
        )
    );

    // ----- 6. Plain reminder, never an action -----
    const reminder = unpushedChangesReminder(await services.gitStatusPorcelain(cwd));
    if (reminder !== null) io.say(`\n${reminder}`);

    return { ok: true, exitCode: 0 };
}
