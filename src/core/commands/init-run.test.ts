import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    runInit,
    unpushedChangesReminder,
    chooseEditor,
    buildEditorCommand,
    normalizeSiteUrl,
    renderFillInstructions,
    renderRunInstructions,
    SPACE_NOT_FOUND,
    type InitRunDeps,
} from "./init-run.js";
import { parseEnvContent, readInitState, markStepDone, isInitComplete } from "./target-init.js";
import { RestClient, apiTokenAuth } from "../storage/jira/rest-client.js";
import { createConfluenceDocStore } from "../storage/jira/doc-store.js";
import type { Listing, DiscoveredProject, DiscoveredSpace } from "./discovery.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-init-run-"));
    try {
        await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

// ---------- pure helpers ----------

describe("unpushedChangesReminder", () => {
    it("is null for no git repo, a clean tree, and unrelated files", () => {
        assert.equal(unpushedChangesReminder(null), null);
        assert.equal(unpushedChangesReminder(""), null);
        assert.equal(unpushedChangesReminder(" M README.md\n?? src/x.ts\n"), null);
    });

    it("names CLAUDE.md and/or .gitignore when they are modified, untracked, staged or renamed", () => {
        const one = unpushedChangesReminder(" M CLAUDE.md\n");
        assert.ok(one?.includes("CLAUDE.md") && !one.includes(".gitignore"));
        const both = unpushedChangesReminder("?? CLAUDE.md\n M .gitignore\n");
        assert.ok(both?.includes("CLAUDE.md") && both.includes(".gitignore"));
        assert.ok(unpushedChangesReminder("A  CLAUDE.md\n")?.includes("CLAUDE.md"));
        assert.ok(unpushedChangesReminder("R  old.md -> CLAUDE.md\n")?.includes("CLAUDE.md"));
        assert.ok(unpushedChangesReminder('?? ".gitignore"\n')?.includes(".gitignore"));
    });

    it("also names GEMINI.md, listing three files readably (TAI-376)", () => {
        assert.ok(unpushedChangesReminder("?? GEMINI.md\n")?.includes("GEMINI.md"));
        const all = unpushedChangesReminder("?? CLAUDE.md\n?? GEMINI.md\n M .gitignore\n") ?? "";
        assert.match(all, /CLAUDE\.md, GEMINI\.md and \.gitignore have changes/);
    });

    it("only repo-root files count, and the text says to commit and push (TAI never does)", () => {
        assert.equal(unpushedChangesReminder("?? sub/CLAUDE.md\n"), null);
        const msg = unpushedChangesReminder(" M CLAUDE.md\n") ?? "";
        assert.match(msg, /commit and push/i);
    });
});

describe("chooseEditor", () => {
    it("prefers VISUAL, then EDITOR; empty strings count as unset", () => {
        assert.equal(chooseEditor({ VISUAL: "vim", EDITOR: "nano" }, "linux"), "vim");
        assert.equal(chooseEditor({ EDITOR: "nano" }, "linux"), "nano");
        assert.equal(chooseEditor({ VISUAL: "", EDITOR: "nano" }, "linux"), "nano");
    });

    it("has no default on POSIX but falls back to notepad on win32", () => {
        assert.equal(chooseEditor({}, "linux"), undefined);
        assert.equal(chooseEditor({}, "darwin"), undefined);
        assert.equal(chooseEditor({}, "win32"), "notepad");
    });
});

describe("buildEditorCommand", () => {
    it("quotes the path for a POSIX shell so editor strings with arguments still work", () => {
        assert.equal(buildEditorCommand("code --wait", "/a b/.env", "linux"), "code --wait '/a b/.env'");
        assert.equal(buildEditorCommand("vim", "/x/it's/.env", "linux"), `vim '/x/it'\\''s/.env'`);
    });

    it("double-quotes the path on win32", () => {
        assert.equal(buildEditorCommand("notepad", "C:\\a b\\.env", "win32"), 'notepad "C:\\a b\\.env"');
    });
});

describe("normalizeSiteUrl", () => {
    it("accepts a bare host, trims, drops a trailing slash or pasted path", () => {
        assert.equal(normalizeSiteUrl("x.atlassian.net"), "https://x.atlassian.net");
        assert.equal(normalizeSiteUrl("  https://x.atlassian.net/  "), "https://x.atlassian.net");
        assert.equal(normalizeSiteUrl("https://x.atlassian.net/jira/software/projects/TAI/boards/1"), "https://x.atlassian.net");
    });

    it("rejects empty, non-URL and plain-http input", () => {
        assert.equal(normalizeSiteUrl(""), null);
        assert.equal(normalizeSiteUrl("not a url"), null);
        assert.equal(normalizeSiteUrl("http://x.atlassian.net"), null);
    });
});

describe("renderRunInstructions", () => {
    it("gives a copy-paste command for a separate terminal: cd into the project, run init run from TAI's install", () => {
        const text = renderRunInstructions("/projects/my app", "/home/u/.tai-framework");
        assert.match(text, /separate terminal/i);
        assert.ok(text.includes("cd '/projects/my app'"), "a path with a space is quoted");
        assert.ok(text.includes("npx --prefix /home/u/.tai-framework tsx /home/u/.tai-framework/src/hosts/cli.ts init run"));
    });

    it("leaves a plain path unquoted, and warns that piping or redirecting disables the prompts", () => {
        const text = renderRunInstructions("/work/proj", "/opt/tai");
        assert.ok(text.includes("cd /work/proj"));
        assert.match(text, /pip|redirect/i);
    });
});

describe("renderFillInstructions", () => {
    it("lists every key still to fill, the file, and says to save and close", () => {
        const text = renderFillInstructions(["TAI_JIRA_EMAIL", "TAI_JIRA_API_TOKEN"], "/p/.env");
        for (const needle of ["TAI_JIRA_EMAIL", "TAI_JIRA_API_TOKEN", "/p/.env"]) assert.ok(text.includes(needle), needle);
        assert.match(text, /save/i);
    });
});

// ---------- engine ----------

const PROJECTS: Listing<DiscoveredProject> = {
    items: [
        { key: "EXA", name: "EXA" },
        { key: "TAI", name: "TAI" },
    ],
    truncated: false,
};
const SPACES: Listing<DiscoveredSpace> = {
    items: [
        { key: "TA", alias: "TAI", name: "TAI", type: "global", value: "TAI" },
        { key: "EXA", alias: "EXA", name: "EXA", type: "knowledge_base", value: "EXA" },
    ],
    truncated: false,
};

const COMPLETE_ENV =
    "TAI_BACKEND=jira\nTAI_JIRA_SITE_URL=https://x.atlassian.net\nTAI_PROJECT_KEY=TAI\nTAI_SPACE_KEY=TAI\n" +
    "TAI_JIRA_EMAIL=a@b.c\nTAI_JIRA_API_TOKEN=tok\n";

interface HarnessOptions {
    interactive?: boolean;
    envFile?: string;
    answers?: string[];
    projects?: Listing<DiscoveredProject>;
    spaces?: Listing<DiscoveredSpace>;
    repo?: string | null;
    jiraOk?: boolean;
    listProjectsThrows?: string;
    listSpacesThrows?: string;
    /** verifyBitbucket succeeds only for this repo (default: any). */
    goodRepo?: string;
    /** verifyJira reports the project as not found unless projectKey equals this. */
    goodProject?: string;
    /** verifyJira throws the doc-store's space-not-found error unless spaceKey equals this. */
    goodSpace?: string;
    porcelain?: string | null;
    /** Edits the .env the way a human would in the editor. */
    editor?: (envPath: string) => Promise<void>;
    noEditor?: boolean;
    /** Ambient env (as after loadDotEnv); defaults to the parsed `envFile`. */
    env?: Record<string, string>;
}

async function harness(dir: string, opts: HarnessOptions = {}) {
    const calls: string[] = [];
    const said: string[] = [];
    const asked: string[] = [];
    const answers = [...(opts.answers ?? [])];
    const envPath = path.join(dir, ".env");
    if (opts.envFile !== undefined) await writeFile(envPath, opts.envFile, "utf-8");
    const processEnv = opts.env ?? (opts.envFile !== undefined ? parseEnvContent(opts.envFile) : {});
    let jiraInput: unknown;
    let bitbucketInput: unknown;
    const bitbucketRepos: unknown[] = [];

    const deps: InitRunDeps = {
        cwd: dir,
        taiRoot: path.join(dir, ".tai"),
        taiHome: "/opt/tai",
        env: processEnv,
        interactive: opts.interactive ?? false,
        io: {
            say: (text) => said.push(text),
            ask: async (question) => {
                asked.push(question);
                const next = answers.shift();
                if (next === undefined) throw new Error(`Unexpected prompt: ${question}`);
                return next;
            },
            editFile: async (filePath) => {
                calls.push("editFile");
                await opts.editor?.(filePath);
                return opts.noEditor ? "no-editor" : "edited";
            },
        },
        renderStepResult: (step, ok, detail, full) => `[${ok ? "ok" : "FAIL"}] ${step}: ${detail}${full ? " (fully initialized)" : ""}`,
        services: {
            listProjects: async () => {
                calls.push("listProjects");
                if (opts.listProjectsThrows) throw new Error(opts.listProjectsThrows);
                return opts.projects ?? PROJECTS;
            },
            listSpaces: async () => {
                calls.push("listSpaces");
                if (opts.listSpacesThrows) throw new Error(opts.listSpacesThrows);
                return opts.spaces ?? SPACES;
            },
            detectBitbucketRepo: async () => opts.repo ?? null,
            verifyJira: async (input) => {
                calls.push("verifyJira");
                jiraInput = input;
                if (opts.goodSpace !== undefined && input.spaceKey !== opts.goodSpace) {
                    throw new Error(
                        `Confluence space "${input.spaceKey}" not found (checked by system key and by current alias). Space key and Jira project key are never safely derivable from each other.`
                    );
                }
                if (opts.goodProject !== undefined && input.projectKey !== opts.goodProject) {
                    return {
                        ok: false,
                        projectFound: false,
                        missingIssueTypes: [],
                        personaFieldFound: false,
                        detail: `Project "${input.projectKey}" not found (or this API token can't see it) at ${input.siteUrl}.`,
                    };
                }
                return opts.jiraOk === false
                    ? { ok: false, projectFound: true, missingIssueTypes: ["Dev"], personaFieldFound: true, detail: "Missing issue type(s): Dev." }
                    : { ok: true, projectFound: true, missingIssueTypes: [], personaFieldFound: true, detail: "All required issue types present." };
            },
            setupConfluence: async () => {
                calls.push("setupConfluence");
                return { ok: true, detail: "Config and roster ready." };
            },
            verifyBitbucket: async (input) => {
                calls.push("verifyBitbucket");
                bitbucketInput = input;
                bitbucketRepos.push(input.repo);
                const ok = opts.goodRepo === undefined || input.repo === opts.goodRepo;
                return ok
                    ? { ok: true, detail: "Repository reachable." }
                    : { ok: false, detail: `Repository "${input.repo}" not found (or these credentials can't see it).` };
            },
            gitStatusPorcelain: async () => opts.porcelain ?? null,
        },
    };
    return { deps, calls, said, asked, bitbucketRepos, envPath, jiraInput: () => jiraInput, bitbucketInput: () => bitbucketInput, all: () => said.join("\n") };
}

const STEP_CALLS = ["listProjects", "listSpaces", "verifyJira", "setupConfluence", "verifyBitbucket"];
const stepCalls = (calls: string[]) => calls.filter((c) => STEP_CALLS.includes(c));

/** The editor a human uses: fills the empty secret lines in place. */
const fillSecrets = (values: Record<string, string>) => async (envPath: string) => {
    let content = await readFile(envPath, "utf-8");
    for (const [key, value] of Object.entries(values)) content = content.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
    await writeFile(envPath, content, "utf-8");
};

describe("runInit — non-interactive (no TTY)", () => {
    it("writes the skeleton, says exactly what is left, makes no network calls, and exits 2", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir);
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 2);
            assert.equal(result.ok, false);
            assert.deepEqual(stepCalls(h.calls), []);
            const env = await readFile(h.envPath, "utf-8");
            assert.match(env, /^TAI_JIRA_EMAIL=$/m);
            assert.match(h.all(), /needs a human at a terminal/i);
            assert.ok(h.all().includes(`cd ${dir}`) && h.all().includes("/opt/tai/src/hosts/cli.ts init run"), "the exact command to run is printed");
            for (const key of ["TAI_JIRA_SITE_URL", "TAI_JIRA_EMAIL", "TAI_JIRA_API_TOKEN"]) assert.ok(h.all().includes(key), key);
            assert.deepEqual((await readInitState(h.deps.taiRoot)).steps, {});
        });
    });

    it("joins an already-onboarded project from a complete .env: verifies every step live in order and finishes", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { envFile: COMPLETE_ENV, porcelain: null });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.deepEqual(stepCalls(h.calls), ["listProjects", "listSpaces", "verifyJira", "setupConfluence"]);
            const state = await readInitState(h.deps.taiRoot);
            assert.ok(isInitComplete(state), "init-state.json is rebuilt from the live results");
            assert.match(await readFile(path.join(dir, "CLAUDE.md"), "utf-8"), /Team AI \(TAI\)/);
            assert.match(await readFile(path.join(dir, "GEMINI.md"), "utf-8"), /Team AI \(TAI\)/);
            assert.ok(!("gemini-md" in state.steps), "no new init-state step: isInitComplete is unchanged (TAI-375)");
            assert.deepEqual(h.asked, [], "nothing to ask: every value was already present and confirmed live");
            assert.match(h.all(), /fully initialized/);
        });
    });

    it("writes GEMINI.md idempotently and keeps the project's own text in an existing one (TAI-376)", async () => {
        await withTempDir(async (dir) => {
            await writeFile(path.join(dir, "GEMINI.md"), "# Mine\n\nKeep me.\n", "utf-8");
            const h = await harness(dir, { envFile: COMPLETE_ENV, porcelain: null });
            assert.equal((await runInit(h.deps)).exitCode, 0, h.all());
            const first = await readFile(path.join(dir, "GEMINI.md"), "utf-8");
            assert.match(first, /Keep me\./);
            const h2 = await harness(dir, { envFile: COMPLETE_ENV, porcelain: null });
            assert.equal((await runInit(h2.deps)).exitCode, 0, h2.all());
            assert.equal(await readFile(path.join(dir, "GEMINI.md"), "utf-8"), first, "re-run changes nothing");
        });
    });

    it("keeps a working alias (TAI) even though the live space list's real key is TA", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { envFile: COMPLETE_ENV });
            await runInit(h.deps);
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_SPACE_KEY"], "TAI");
            assert.equal((h.jiraInput() as { spaceKey: string }).spaceKey, "TAI");
        });
    });

    it("records bitbucket as done with an N/A detail when no repo/credentials are configured (TAI-350)", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { envFile: COMPLETE_ENV });
            await runInit(h.deps);
            const state = await readInitState(h.deps.taiRoot);
            assert.match(state.steps.bitbucket?.detail ?? "", /^N\/A/);
            assert.ok(!h.calls.includes("verifyBitbucket"));
        });
    });

    it("verifies Bitbucket for real when a repo and credentials are configured", async () => {
        await withTempDir(async (dir) => {
            const env = COMPLETE_ENV + "BITBUCKET_EMAIL=a@b.c\nBITBUCKET_API_TOKEN=btok\nTAI_GIT_REPOS=dmayhak/x,dmayhak/y\n";
            const h = await harness(dir, { envFile: env });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.deepEqual(h.bitbucketInput(), { email: "a@b.c", apiToken: "btok", repo: "dmayhak/x" });
            const state = await readInitState(h.deps.taiRoot);
            assert.ok(!/^N\/A/.test(state.steps.bitbucket?.detail ?? "N/A"));
        });
    });

    it("a Bitbucket remote alone does not block a non-interactive join: it says so and records N/A", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { envFile: COMPLETE_ENV, repo: "dmayhak/x" });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.match(h.all(), /dmayhak\/x[^\n]*no Bitbucket credentials/i);
            assert.match((await readInitState(h.deps.taiRoot)).steps.bitbucket?.detail ?? "", /^N\/A.*dmayhak\/x/);
            assert.ok(!/BITBUCKET_EMAIL=/.test(await readFile(h.envPath, "utf-8")), "no empty Bitbucket lines forced on a user who did not ask");
        });
    });

    it("already-configured Bitbucket credentials that are still empty DO need a human", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { envFile: COMPLETE_ENV + "TAI_GIT_REPOS=dmayhak/x\n" });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 2);
            assert.ok(h.all().includes("BITBUCKET_API_TOKEN"));
            assert.match(await readFile(h.envPath, "utf-8"), /^BITBUCKET_EMAIL=$/m, "empty secret lines were added for the user to fill");
        });
    });

    it("needs a human when the project key is absent and cannot be picked without a prompt", async () => {
        await withTempDir(async (dir) => {
            const env = COMPLETE_ENV.replace("TAI_PROJECT_KEY=TAI\n", "");
            const h = await harness(dir, { envFile: env });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 2);
            assert.ok(h.all().includes("TAI_PROJECT_KEY"));
            assert.ok(!h.calls.includes("verifyJira"));
            assert.deepEqual(h.asked, []);
        });
    });

    it("warns when a required secret exists only in the shell environment, since a new terminal would lose it", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                envFile: COMPLETE_ENV.replace("TAI_JIRA_API_TOKEN=tok", "TAI_JIRA_API_TOKEN="),
                env: { ...parseEnvContent(COMPLETE_ENV), TAI_JIRA_API_TOKEN: "from-shell" },
            });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.match(h.all(), /TAI_JIRA_API_TOKEN is set in your shell but empty in .*\.env/);
            assert.ok(!(await readFile(h.envPath, "utf-8")).includes("from-shell"), "a secret is never written by init run");
        });
    });

    it("warns when TAI_BACKEND is set to something other than jira, since init run sets up the Jira backend", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { envFile: COMPLETE_ENV.replace("TAI_BACKEND=jira", "TAI_BACKEND=filesystem") });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.match(h.all(), /TAI_BACKEND is set to "filesystem"/);
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_BACKEND"], "filesystem", "the user's value is never overridden");
        });
    });

    it("says nothing about TAI_BACKEND when it is jira or unset", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { envFile: COMPLETE_ENV });
            await runInit(h.deps);
            assert.doesNotMatch(h.all(), /TAI_BACKEND/);
        });
    });

    it("is idempotent: a second run on the same clone changes nothing and still succeeds", async () => {
        await withTempDir(async (dir) => {
            const h1 = await harness(dir, { envFile: COMPLETE_ENV });
            await runInit(h1.deps);
            const envAfterFirst = await readFile(h1.envPath, "utf-8");
            const h2 = await harness(dir, { env: parseEnvContent(envAfterFirst) });
            const result = await runInit(h2.deps);
            assert.equal(result.exitCode, 0);
            assert.equal(await readFile(h2.envPath, "utf-8"), envAfterFirst);
        });
    });
});

describe("runInit — failures stop at the failing step", () => {
    it("a failed Jira verification stops there, prints the to-do list, and clears the stale 'done' record", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { envFile: COMPLETE_ENV, jiraOk: false });
            await markStepDone(h.deps.taiRoot, "jira", "old success");
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 1);
            assert.equal(result.stoppedAt, "jira");
            assert.ok(!h.calls.includes("setupConfluence"));
            assert.match(h.all(), /\[FAIL\] jira: Missing issue type\(s\): Dev\./);
            assert.equal((await readInitState(h.deps.taiRoot)).steps.jira, undefined);
        });
    });

    it("a failed discovery call stops before verification when the value it would have found is MISSING, and says why", async () => {
        await withTempDir(async (dir) => {
            const env = COMPLETE_ENV.replace("TAI_PROJECT_KEY=TAI\n", "");
            const h = await harness(dir, { envFile: env, listProjectsThrows: "401 Unauthorized" });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 1);
            assert.equal(result.stoppedAt, "discovery");
            assert.match(h.all(), /401 Unauthorized/);
            assert.match(h.all(), /TAI_PROJECT_KEY/, "tells the user which value to set themselves");
            assert.ok(!h.calls.includes("verifyJira"));
        });
    });

    it("a failed LIST call does not block a join whose value is already in .env: it warns and lets verification decide", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { envFile: COMPLETE_ENV, listSpacesThrows: "403 Forbidden: scope missing read:space" });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.match(h.all(), /couldn't list Confluence spaces[^\n]*403 Forbidden[^\n]*keeping TAI/);
            assert.ok(h.calls.includes("verifyJira") && h.calls.includes("setupConfluence"), "live verification still runs");
        });
    });

    it("interactive: a failed list for a MISSING value falls back to typing the key by hand", async () => {
        await withTempDir(async (dir) => {
            const env = COMPLETE_ENV.replace("TAI_PROJECT_KEY=TAI\n", "");
            const h = await harness(dir, {
                interactive: true,
                envFile: env,
                listProjectsThrows: "403 Forbidden",
                answers: ["", "TAI", "y"],
            });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_PROJECT_KEY"], "TAI");
            assert.match(h.all(), /403 Forbidden/);
        });
    });

    it("a TRUNCATED list is not proof an existing key is stale: it is kept and verification decides (non-interactive)", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { envFile: COMPLETE_ENV, projects: { items: [{ key: "OTHER", name: "o" }], truncated: true } });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.match(h.all(), /incomplete/i);
            assert.equal((h.jiraInput() as { projectKey: string }).projectKey, "TAI");
            assert.deepEqual(h.asked, []);
        });
    });

    it("a truncated list also does not nag an interactive user about an existing value", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                interactive: true,
                envFile: COMPLETE_ENV,
                projects: { items: [{ key: "OTHER", name: "o" }], truncated: true },
                answers: [""],
            });
            assert.equal((await runInit(h.deps)).exitCode, 0, h.all());
            assert.deepEqual(h.asked.length, 1, "only the site URL was asked");
        });
    });
});

describe("runInit — interactive", () => {
    it("brand-new clone: prompts, hands the secrets to the editor, discovers, writes only what is new, keeps typed secrets", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                interactive: true,
                answers: ["example.atlassian.net", "tai", "TA"],
                editor: fillSecrets({ TAI_JIRA_EMAIL: "me@x.com", TAI_JIRA_API_TOKEN: "secret-token" }),
            });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            const env = parseEnvContent(await readFile(h.envPath, "utf-8"));
            assert.equal(env["TAI_JIRA_SITE_URL"], "https://example.atlassian.net");
            assert.equal(env["TAI_JIRA_EMAIL"], "me@x.com");
            assert.equal(env["TAI_JIRA_API_TOKEN"], "secret-token");
            assert.equal(env["TAI_PROJECT_KEY"], "TAI");
            assert.equal(env["TAI_SPACE_KEY"], "TAI", "typing the real key TA writes the alias");
            assert.match(h.all(), /TAI \(real key TA\)/, "the value that will be written is shown, not just what was typed");
            assert.deepEqual(stepCalls(h.calls), ["listProjects", "listSpaces", "verifyJira", "setupConfluence"]);
            assert.equal((h.jiraInput() as { email: string }).email, "me@x.com");
            if (process.platform !== "win32") assert.equal((await stat(h.envPath)).mode & 0o777, 0o600);
        });
    });

    it("offers Bitbucket when the clone's remote is on Bitbucket, and declining leaves it N/A", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                interactive: true,
                repo: "dmayhak/proj",
                answers: ["x.atlassian.net", "n", "TAI", "TAI"],
                editor: fillSecrets({ TAI_JIRA_EMAIL: "me@x.com", TAI_JIRA_API_TOKEN: "t" }),
            });
            assert.equal((await runInit(h.deps)).exitCode, 0, h.all());
            assert.ok(h.asked.some((q) => q.includes("dmayhak/proj")));
            assert.match((await readInitState(h.deps.taiRoot)).steps.bitbucket?.detail ?? "", /^N\/A/);
        });
    });

    it("an editor that leaves secrets empty re-checks, and quitting stops cleanly with no network calls", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { interactive: true, answers: ["x.atlassian.net", "q"] });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 1);
            assert.equal(result.stoppedAt, "env");
            assert.ok(h.asked.some((q) => /still empty/i.test(q) && q.includes("TAI_JIRA_API_TOKEN")));
            assert.deepEqual(stepCalls(h.calls), []);
        });
    });

    it("with no editor configured it prints the path and waits for the user to save, then re-checks", async () => {
        await withTempDir(async (dir) => {
            let saved = false;
            const h = await harness(dir, {
                interactive: true,
                noEditor: true,
                answers: ["x.atlassian.net", "", "TAI", "TAI"],
            });
            const originalAsk = h.deps.io.ask;
            h.deps.io.ask = async (q, d) => {
                // The user fills the file by hand while the engine waits for them.
                if (!saved && /still empty|saved|re-check/i.test(q)) {
                    await fillSecrets({ TAI_JIRA_EMAIL: "me@x.com", TAI_JIRA_API_TOKEN: "t" })(h.envPath);
                    saved = true;
                }
                return originalAsk(q, d);
            };
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.ok(h.all().includes(h.envPath), "the path is printed for the user to open");
        });
    });

    it("an empty or truncated project list warns that it may be incomplete and accepts a typed key after confirmation", async () => {
        await withTempDir(async (dir) => {
            const env = COMPLETE_ENV.replace("TAI_PROJECT_KEY=TAI\n", "");
            const h = await harness(dir, {
                interactive: true,
                envFile: env,
                projects: { items: [], truncated: true },
                answers: ["", "NEWPROJ", "y"],
            });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.match(h.all(), /incomplete/i);
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_PROJECT_KEY"], "NEWPROJ");
            assert.equal((h.jiraInput() as { projectKey: string }).projectKey, "NEWPROJ");
        });
    });

    it("an existing project key that Jira does not list is offered as the default, never silently replaced", async () => {
        await withTempDir(async (dir) => {
            const env = COMPLETE_ENV.replace("TAI_PROJECT_KEY=TAI", "TAI_PROJECT_KEY=GONE");
            const h = await harness(dir, { interactive: true, envFile: env, answers: ["", ""] });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.match(h.all(), /GONE is set in \.env but wasn't found/, "the stale value is surfaced to the user");
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_PROJECT_KEY"], "GONE", "Enter accepted it unchanged");
        });
    });
});

describe("runInit — a wrong Bitbucket repo can always be corrected (TAI-367 review)", () => {
    const BB_ENV = COMPLETE_ENV + "BITBUCKET_EMAIL=a@b.c\nBITBUCKET_API_TOKEN=bt\n";

    it("a typo at the prompt is offered for correction on the spot, and the fix is written", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                interactive: true,
                envFile: BB_ENV,
                repo: "dmayhak/proj",
                goodRepo: "dmayhak/proj",
                answers: ["", "dmayhak/typo", "dmayhak/proj"],
            });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.match(h.all(), /\[FAIL\] bitbucket: Repository "dmayhak\/typo" not found/);
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_GIT_REPOS"], "dmayhak/proj");
            assert.ok(!/^N\/A/.test((await readInitState(h.deps.taiRoot)).steps.bitbucket?.detail ?? "N/A"));
        });
    });

    it("a wrong repo ALREADY saved in .env from an earlier run is also offered for correction (the re-run case)", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                interactive: true,
                envFile: BB_ENV + "TAI_GIT_REPOS=dmayhak/typo\n",
                repo: "dmayhak/proj",
                goodRepo: "dmayhak/proj",
                answers: ["", "dmayhak/proj"],
            });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_GIT_REPOS"], "dmayhak/proj");
        });
    });

    it("quitting at the correction prompt stops cleanly and clears the stale 'done' record", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                interactive: true,
                envFile: BB_ENV + "TAI_GIT_REPOS=dmayhak/typo\n",
                goodRepo: "dmayhak/proj",
                answers: ["", "q"],
            });
            await markStepDone(h.deps.taiRoot, "bitbucket", "old success");
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 1);
            assert.equal(result.stoppedAt, "bitbucket");
            assert.equal((await readInitState(h.deps.taiRoot)).steps.bitbucket, undefined);
        });
    });

    it("gives up after a few wrong answers instead of looping forever", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                interactive: true,
                envFile: BB_ENV + "TAI_GIT_REPOS=dmayhak/typo\n",
                goodRepo: "dmayhak/proj",
                answers: ["", "dmayhak/a", "dmayhak/b", "dmayhak/c", "dmayhak/d"],
            });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 1);
            assert.equal(result.stoppedAt, "bitbucket");
        });
    });

    it("non-interactive: fails, and the message says where the value lives and that credentials can cause it too", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { envFile: BB_ENV + "TAI_GIT_REPOS=dmayhak/typo\n", goodRepo: "dmayhak/proj" });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 1);
            assert.equal(result.stoppedAt, "bitbucket");
            assert.match(h.all(), /TAI_GIT_REPOS[^\n]*BITBUCKET_EMAIL[^\n]*BITBUCKET_API_TOKEN/);
            assert.ok(h.all().includes(h.envPath));
        });
    });
});

describe("SPACE_NOT_FOUND drift guard (TAI-367 review)", () => {
    it("matches the error the real Confluence doc store throws for an unknown space", async () => {
        const fetchImpl = (async (input: string | URL | Request) => {
            const url = new URL(String(input));
            if (url.pathname === "/wiki/api/v2/spaces") return new Response(JSON.stringify({ results: [] }), { status: 200 });
            throw new Error(`Unstubbed request: ${url.pathname}`);
        }) as unknown as typeof fetch;
        const client = new RestClient({ siteUrl: "https://x.atlassian.net", auth: apiTokenAuth("a@b.c", "t"), fetchImpl });
        const store = createConfluenceDocStore(client, { spaceKey: "NOPE" });
        await assert.rejects(
            () => store.getPage({ spaceKey: "NOPE", title: "Config" }),
            (err: Error) => SPACE_NOT_FOUND.test(err.message)
        );
    });
});

describe("runInit — a wrong project or space key can always be corrected (TAI-367 review)", () => {
    const TRUNC: Listing<DiscoveredProject> = { items: [{ key: "OTHER", name: "o" }], truncated: true };

    it("a stale project key the list could not confirm (truncated) is offered for retyping when verification fails", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                interactive: true,
                envFile: COMPLETE_ENV.replace("TAI_PROJECT_KEY=TAI", "TAI_PROJECT_KEY=GONE"),
                projects: TRUNC,
                goodProject: "TAI",
                answers: ["", "TAI"],
            });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.match(h.all(), /\[FAIL\] jira: Project "GONE" not found/);
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_PROJECT_KEY"], "TAI");
        });
    });

    it("a wrong space key, with a list that could not confirm it, surfaces at the Jira step and is offered for retyping", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                interactive: true,
                envFile: COMPLETE_ENV.replace("TAI_SPACE_KEY=TAI", "TAI_SPACE_KEY=WRONG"),
                listSpacesThrows: "403 Forbidden",
                goodSpace: "TAI",
                answers: ["", "TAI"],
            });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_SPACE_KEY"], "TAI");
        });
    });

    it("non-interactive: fails with the key names and the .env path, and no prompt", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                envFile: COMPLETE_ENV.replace("TAI_PROJECT_KEY=TAI", "TAI_PROJECT_KEY=GONE"),
                projects: TRUNC,
                goodProject: "TAI",
            });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 1);
            assert.equal(result.stoppedAt, "jira");
            assert.match(h.all(), /TAI_PROJECT_KEY[^\n]*TAI_SPACE_KEY/);
            assert.ok(h.all().includes(h.envPath));
            assert.deepEqual(h.asked, []);
        });
    });

    it("a failure that is NOT a key problem (missing issue types) does not prompt for a key", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { interactive: true, envFile: COMPLETE_ENV, jiraOk: false, answers: [""] });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 1);
            assert.equal(h.asked.length, 1, "only the site URL was asked");
        });
    });

    it("quitting at the retype prompt stops cleanly and clears the stale record; repeated wrong keys give up", async () => {
        await withTempDir(async (dir) => {
            const quit = await harness(dir, {
                interactive: true,
                envFile: COMPLETE_ENV.replace("TAI_PROJECT_KEY=TAI", "TAI_PROJECT_KEY=GONE"),
                projects: TRUNC,
                goodProject: "TAI",
                answers: ["", "q"],
            });
            await markStepDone(quit.deps.taiRoot, "jira", "old success");
            const r1 = await runInit(quit.deps);
            assert.equal(r1.exitCode, 1);
            assert.equal((await readInitState(quit.deps.taiRoot)).steps.jira, undefined);
        });
        await withTempDir(async (dir) => {
            const loop = await harness(dir, {
                interactive: true,
                envFile: COMPLETE_ENV.replace("TAI_PROJECT_KEY=TAI", "TAI_PROJECT_KEY=GONE"),
                projects: TRUNC,
                goodProject: "TAI",
                answers: ["", "BAD1", "BAD2", "BAD3"],
            });
            const r2 = await runInit(loop.deps);
            assert.equal(r2.exitCode, 1);
            assert.equal(r2.stoppedAt, "jira");
        });
    });
});

describe("runInit — correcting one repo keeps the rest of TAI_GIT_REPOS (TAI-367 review)", () => {
    const BB = COMPLETE_ENV + "BITBUCKET_EMAIL=a@b.c\nBITBUCKET_API_TOKEN=bt\nTAI_GIT_REPOS=dmayhak/typo,dmayhak/other\n";

    it("replaces only the failing first entry", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { interactive: true, envFile: BB, goodRepo: "dmayhak/proj", answers: ["", "dmayhak/proj"] });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_GIT_REPOS"], "dmayhak/proj,dmayhak/other");
        });
    });

    it("typing a comma list is an explicit full replacement", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { interactive: true, envFile: BB, goodRepo: "dmayhak/proj", answers: ["", "dmayhak/proj,dmayhak/new"] });
            await runInit(h.deps);
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_GIT_REPOS"], "dmayhak/proj,dmayhak/new");
        });
    });

    it("does not duplicate an entry the list already has", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { interactive: true, envFile: BB, goodRepo: "dmayhak/other", answers: ["", "dmayhak/other"] });
            await runInit(h.deps);
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_GIT_REPOS"], "dmayhak/other");
        });
    });
});

describe("runInit — correction prompts reject answers that mean nothing and name things correctly (TAI-367 review, round 3)", () => {
    const BB = COMPLETE_ENV + "BITBUCKET_EMAIL=a@b.c\nBITBUCKET_API_TOKEN=bt\nTAI_GIT_REPOS=dmayhak/typo,dmayhak/other\n";
    const TRUNC_PROJECTS: Listing<DiscoveredProject> = { items: [{ key: "TAI", name: "TAI" }, { key: "OTHER", name: "o" }], truncated: true };

    it("a lone comma re-prompts instead of wiping the repo list, and nothing is verified for it", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { interactive: true, envFile: BB, goodRepo: "dmayhak/proj", answers: ["", ",", "dmayhak/proj"] });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.match(h.all(), /didn't contain a repository/);
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_GIT_REPOS"], "dmayhak/proj,dmayhak/other");
            assert.deepEqual(h.bitbucketRepos, ["dmayhak/typo", "dmayhak/proj"], "no verification of an empty/undefined repo");
        });
    });

    it("a single repo with a stray comma is still ONE repo: it replaces the first entry and keeps the rest", async () => {
        await withTempDir(async (dir) => {
            for (const typed of ["dmayhak/proj,", ",dmayhak/proj", " dmayhak/proj , "]) {
                const h = await harness(dir, { interactive: true, envFile: BB, goodRepo: "dmayhak/proj", answers: ["", typed] });
                const result = await runInit(h.deps);
                assert.equal(result.exitCode, 0, `${JSON.stringify(typed)}: ${h.all()}`);
                assert.equal(
                    parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_GIT_REPOS"],
                    "dmayhak/proj,dmayhak/other",
                    `${JSON.stringify(typed)} must not drop the rest of the list`
                );
            }
        });
    });

    it("pressing Enter retries the same repo unchanged (the default), q still stops, and the list is never touched", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, { interactive: true, envFile: BB, goodRepo: "dmayhak/proj", answers: ["", "", "q"] });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 1);
            assert.equal(result.stoppedAt, "bitbucket");
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_GIT_REPOS"], "dmayhak/typo,dmayhak/other", "the list was never touched");
        });
    });

    it("the retype prompts name a Jira project and a Confluence space correctly", async () => {
        await withTempDir(async (dir) => {
            const proj = await harness(dir, {
                interactive: true,
                envFile: COMPLETE_ENV.replace("TAI_PROJECT_KEY=TAI", "TAI_PROJECT_KEY=GONE"),
                projects: TRUNC_PROJECTS,
                goodProject: "TAI",
                answers: ["", "q"],
            });
            await runInit(proj.deps);
            assert.ok(proj.asked.some((q) => q.startsWith("Jira project key to try instead")), proj.asked.join(" | "));
        });
        await withTempDir(async (dir) => {
            const space = await harness(dir, {
                interactive: true,
                envFile: COMPLETE_ENV.replace("TAI_SPACE_KEY=TAI", "TAI_SPACE_KEY=WRONG"),
                listSpacesThrows: "403",
                goodSpace: "TAI",
                answers: ["", "q"],
            });
            await runInit(space.deps);
            assert.ok(space.asked.some((q) => q.startsWith("Confluence space key to try instead")), space.asked.join(" | "));
            assert.ok(!space.asked.some((q) => /Jira space/.test(q)));
        });
    });

    it("a retyped space key is resolved against the list when there is one: the real key TA is stored as the alias TAI", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                interactive: true,
                envFile: COMPLETE_ENV.replace("TAI_SPACE_KEY=TAI", "TAI_SPACE_KEY=WRONG"),
                spaces: {
                    items: [{ key: "TA", alias: "TAI", name: "TAI", type: "global", value: "TAI" }],
                    truncated: true,
                },
                goodSpace: "TAI",
                answers: ["", "TA"],
            });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_SPACE_KEY"], "TAI");
        });
    });

    it("a retyped project key takes the list's own spelling (tai -> TAI)", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                interactive: true,
                envFile: COMPLETE_ENV.replace("TAI_PROJECT_KEY=TAI", "TAI_PROJECT_KEY=GONE"),
                projects: TRUNC_PROJECTS,
                goodProject: "TAI",
                answers: ["", "tai"],
            });
            const result = await runInit(h.deps);
            assert.equal(result.exitCode, 0, h.all());
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_PROJECT_KEY"], "TAI");
        });
    });

    it("with NO list available a retyped key is written as typed", async () => {
        await withTempDir(async (dir) => {
            const h = await harness(dir, {
                interactive: true,
                envFile: COMPLETE_ENV.replace("TAI_PROJECT_KEY=TAI", "TAI_PROJECT_KEY=GONE"),
                listProjectsThrows: "403",
                goodProject: "TAI",
                answers: ["", "TAI"],
            });
            assert.equal((await runInit(h.deps)).exitCode, 0, h.all());
            assert.equal(parseEnvContent(await readFile(h.envPath, "utf-8"))["TAI_PROJECT_KEY"], "TAI");
        });
    });
});

describe("runInit — unpushed-changes reminder", () => {
    const run = async (porcelain: string | null) =>
        withTempDirResult(async (dir) => {
            const h = await harness(dir, { envFile: COMPLETE_ENV, porcelain });
            await runInit(h.deps);
            return h.all();
        });

    it("reminds the user to commit and push when CLAUDE.md / .gitignore changed", async () => {
        assert.match(await run(" M CLAUDE.md\n?? .gitignore\n"), /commit and push/i);
    });

    it("stays quiet on a clean tree and outside a git repo", async () => {
        assert.doesNotMatch(await run(""), /commit and push/i);
        assert.doesNotMatch(await run(null), /commit and push/i);
    });
});

async function withTempDirResult<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    let out: T | undefined;
    await withTempDir(async (dir) => {
        out = await fn(dir);
    });
    return out as T;
}
