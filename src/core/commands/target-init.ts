/**
 * TAI Framework — `/tai-init` target-project setup (TAI-116 piece 3, TAI-130)
 *
 * TAI-90's ADR scoped `/tai-init`'s remaining job as: walk a human through the genuinely
 * manual Jira/Confluence/Bitbucket admin checklist (full provisioning automation is an
 * explicit v1 non-goal), then generate the target project's `.env` and a `CLAUDE.md`
 * pointer. This module is that "then" half, plus the two firm requirements added while
 * TAI-128 was in flight (see that ticket's own "Not yet done" note):
 *
 *   1. **Resumability** — each step below is independently re-runnable and records its own
 *      completion in a small local state file (`<taiRoot>/init-state.json`, e.g.
 *      `.tai/init-state.json`), so an interrupted/failed `/tai-init` run picks up where it
 *      left off rather than restarting. `INIT_STEPS`' order is the intended run order, but
 *      nothing here enforces it beyond `env`/`claude-md` refusing to run ahead of their own
 *      prerequisites (see `writeEnvFile`/`writeClaudeMdPointer`) — re-running an
 *      already-done step is always safe (every step here is idempotent).
 *   2. **Init-completion detection** — `checkInitCompletion` lets `cli.ts`'s other
 *      subcommands (`work`/`ready`/`git-pr`/`issue`/`page`/`link-precedence`) distinguish
 *      "no `.env` at all" (already caught by `resolveConfig()`'s own catch, TAI-128) from
 *      "`.env` exists but `/tai-init` never finished." A project with NO state file at all
 *      is deliberately treated as fully initialized (not flagged) — that's the grandfather
 *      case for any project (including `tai-framework` itself) whose `.env` predates this
 *      state-tracking mechanism; only a state file that exists but is incomplete is a real
 *      signal something was left unfinished.
 *
 * Each verify/setup step below IS its own verification: there's no separate "check without
 * doing" mode, because the do-it call already fails loudly (a real API rejection) or
 * succeeds — running it again once problems are fixed is what "verification call after
 * each step" (TAI-116's comment) means in practice here.
 *
 * Deliberately reuses existing source-of-truth constants rather than hand-copying a
 * checklist that could drift: `JIRA_ISSUE_TYPE` (mappers.ts) for which issue types a
 * project must have provisioned, `discoverPersonaFieldId` (work-tracker.ts) for the
 * `Persona` custom field, `PERSONA_ROLE_LABEL` (story-schema.ts) for the Persona Roster
 * template's rows.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { RestClient as JiraRestClient, apiTokenAuth as jiraApiTokenAuth } from "../storage/jira/rest-client.js";
import { discoverPersonaFieldId } from "../storage/jira/work-tracker.js";
import { JIRA_ISSUE_TYPE, toJiraIssueType, EMPTY_TYPE_ALIAS_MAP, type IssueType } from "../storage/jira/mappers.js";
import { createConfluenceDocStore } from "../storage/jira/doc-store.js";
import { loadTypeAliasMap } from "../storage/jira/type-alias-config.js";
import { createBitbucketBackend, apiTokenAuth as bitbucketApiTokenAuth } from "../git/bitbucket/bitbucket-backend.js";
import { toRepoId } from "../git/interface.js";
import { PERSONA_ROLE_LABEL } from "../schema/story-schema.js";

// ---------- Resumable state ----------

export const INIT_STEPS = ["jira", "confluence", "bitbucket", "env", "claude-md"] as const;
export type InitStep = (typeof INIT_STEPS)[number];

export interface InitState {
    readonly version: 1;
    readonly steps: Partial<Record<InitStep, { readonly at: string; readonly detail: string }>>;
}

const EMPTY_STATE: InitState = { version: 1, steps: {} };

function statePath(taiRoot: string): string {
    return path.join(taiRoot, "init-state.json");
}

export async function readInitState(taiRoot: string): Promise<InitState> {
    try {
        const raw = await readFile(statePath(taiRoot), "utf-8");
        return JSON.parse(raw) as InitState;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
        throw err;
    }
}

export async function markStepDone(taiRoot: string, step: InitStep, detail: string): Promise<InitState> {
    const current = await readInitState(taiRoot);
    const next: InitState = {
        version: 1,
        steps: { ...current.steps, [step]: { at: new Date().toISOString(), detail } },
    };
    await mkdir(taiRoot, { recursive: true });
    await writeFile(statePath(taiRoot), JSON.stringify(next, null, 2) + "\n", "utf-8");
    return next;
}

export function isInitComplete(state: InitState): boolean {
    return INIT_STEPS.every((s) => state.steps[s] !== undefined);
}

/**
 * Returns a human-readable warning if `taiRoot` has a state file that's present but
 * incomplete, else `null` (either fully complete, or no state file — the grandfather
 * case documented in this file's header comment).
 */
export async function checkInitCompletion(taiRoot: string): Promise<string | null> {
    const state = await readInitState(taiRoot);
    if (Object.keys(state.steps).length === 0) return null;
    if (isInitComplete(state)) return null;
    const missing = INIT_STEPS.filter((s) => state.steps[s] === undefined);
    return (
        `This project's /tai-init run looks incomplete (missing: ${missing.join(", ")}) -- ` +
        `run /tai-init to finish it.`
    );
}

// ---------- Step: Jira verify ----------

export interface JiraVerifyInput {
    readonly siteUrl: string;
    readonly email: string;
    readonly apiToken: string;
    readonly projectKey: string;
    /**
     * Optional (TAI-116 piece 4, TAI-178 ADR): when given, also loads the "Type Aliases"
     * Confluence page from this space and treats a project's aliased native issue-type
     * name as satisfying the corresponding `IssueType`'s provisioning requirement below,
     * instead of demanding TAI's own bundled display name verbatim. Absent on a fresh
     * target project's first `init jira` run, before `init confluence` has anywhere to put
     * the page -- re-run `init jira` once the page exists (or `TAI_SPACE_KEY` is set) to
     * re-verify with aliases applied.
     */
    readonly spaceKey?: string;
    readonly fetchImpl?: typeof fetch;
}

export interface JiraVerifyResult {
    readonly ok: boolean;
    readonly missingIssueTypes: readonly string[];
    readonly personaFieldFound: boolean;
    readonly detail: string;
}

interface CreateMetaResponse {
    readonly projects: readonly { readonly issuetypes: readonly { readonly name: string }[] }[];
}

/**
 * Real GET against Jira's createmeta endpoint for the target project — the same
 * provisioning surface a human just finished configuring by hand in the admin UI (issue
 * type scheme for company-managed, or project-level issue types for team-managed; both
 * surface identically here). `JIRA_ISSUE_TYPE`'s values are the single source of truth for
 * which display names TAI actually needs, so this can't silently drift from what
 * `fromJiraIssueType` accepts at runtime. When `input.spaceKey` is given, a required name
 * may instead be satisfied by an aliased native name from the "Type Aliases" Confluence
 * page (TAI-116 piece 4, TAI-178 ADR).
 */
export async function verifyJiraSetup(input: JiraVerifyInput): Promise<JiraVerifyResult> {
    const client = new JiraRestClient({
        siteUrl: input.siteUrl,
        auth: jiraApiTokenAuth(input.email, input.apiToken),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });

    const createmeta = await client.getOrNull<CreateMetaResponse>(
        `/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(input.projectKey)}&expand=projects.issuetypes`
    );
    const project = createmeta?.projects[0];
    if (!project) {
        return {
            ok: false,
            missingIssueTypes: [],
            personaFieldFound: false,
            detail: `Project "${input.projectKey}" not found (or this API token can't see it) at ${input.siteUrl}.`,
        };
    }

    const aliases = input.spaceKey
        ? await loadTypeAliasMap(createConfluenceDocStore(client, { spaceKey: input.spaceKey }), input.spaceKey)
        : EMPTY_TYPE_ALIAS_MAP;

    const provisioned = new Set(project.issuetypes.map((t) => t.name));
    // Resolved through the alias map: an aliased native name satisfies the requirement in
    // place of TAI's own bundled display name (TAI-178 ADR) -- still the same full
    // IssueType coverage JIRA_ISSUE_TYPE's keys already guarantee at compile time.
    const required = (Object.keys(JIRA_ISSUE_TYPE) as IssueType[]).map((t) => toJiraIssueType(t, aliases));
    const missingIssueTypes = required.filter((name) => !provisioned.has(name));

    let personaFieldFound = true;
    try {
        await discoverPersonaFieldId(client);
    } catch {
        personaFieldFound = false;
    }

    const ok = missingIssueTypes.length === 0 && personaFieldFound;
    const detail = ok
        ? `All ${required.length} required issue types are provisioned on "${input.projectKey}"; the "Persona" custom field was found.`
        : [
              missingIssueTypes.length > 0
                  ? `Missing issue type(s) on "${input.projectKey}": ${missingIssueTypes.join(", ")}.`
                  : null,
              personaFieldFound
                  ? null
                  : `No "Persona" single-select custom field found on this Jira site (brief §5.6).`,
          ]
              .filter((s): s is string => s !== null)
              .join(" ");

    return { ok, missingIssueTypes, personaFieldFound, detail };
}

// ---------- Step: Confluence setup ----------

export interface ConfluenceSetupInput {
    readonly siteUrl: string;
    readonly email: string;
    readonly apiToken: string;
    readonly spaceKey: string;
    readonly fetchImpl?: typeof fetch;
}

export interface ConfluenceSetupResult {
    readonly ok: boolean;
    readonly configPageId?: string;
    readonly personaRosterPageId?: string;
    readonly detail: string;
}

/** Seeded from `PERSONA_ROLE_LABEL` — the same labels `roster.ts` parses back out — rather
 *  than a hand-copied list that could drift from the 9 built-in personas. */
function personaRosterTemplate(): string {
    const rows = Object.values(PERSONA_ROLE_LABEL)
        .map((label) => `| ${label} | you@example.com |`)
        .join("\n");
    return (
        `Maps each persona to the human(s) authorized to act as it (brief §5.6) — a human may ` +
        `appear under multiple personas, normal for a solo developer or a small team. Edit the ` +
        `right-hand column; add more emails/names comma-separated per row as needed.\n\n` +
        `| Persona | Authorized humans |\n|---|---|\n${rows}\n`
    );
}

/**
 * Creates the `Config` folder page and the `Persona Roster` page beneath it (brief §4 rev
 * 13) — eager, per TAI-116's comment thread, unlike the ~21 `confluenceOutputs` doc-type
 * folders (created lazily on first write). Idempotent: a page that already exists is left
 * as-is, not overwritten (a human may already have started filling in the roster).
 */
export async function setupConfluence(input: ConfluenceSetupInput): Promise<ConfluenceSetupResult> {
    const client = new JiraRestClient({
        siteUrl: input.siteUrl,
        auth: jiraApiTokenAuth(input.email, input.apiToken),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    const docStore = createConfluenceDocStore(client, { spaceKey: input.spaceKey });

    let configPage = await docStore.getPage({ spaceKey: input.spaceKey, title: "Config" });
    if (!configPage) {
        configPage = await docStore.createPage({
            spaceKey: input.spaceKey,
            title: "Config",
            content:
                "Configuration pages for TAI: the Persona Roster, and any persona overrides/extensions " +
                "(brief §3.1, §4 rev 13). Sibling to the doc-type folders, which are created lazily on first write.",
        });
    }

    let rosterPage = await docStore.getPage({ spaceKey: input.spaceKey, title: "Persona Roster" });
    if (!rosterPage) {
        rosterPage = await docStore.createPage({
            spaceKey: input.spaceKey,
            title: "Persona Roster",
            parentId: configPage.id,
            content: personaRosterTemplate(),
        });
    }

    return {
        ok: true,
        configPageId: configPage.id,
        personaRosterPageId: rosterPage.id,
        detail: `"Config" folder and "Persona Roster" ready in space "${input.spaceKey}" -- fill in the roster's Authorized humans column before relying on review-gate checks.`,
    };
}

// ---------- Step: Bitbucket verify ----------

export interface BitbucketVerifyInput {
    readonly email: string;
    readonly apiToken: string;
    /** `workspace/repo`, e.g. `dmayhak/tai-framework`. */
    readonly repo: string;
    readonly fetchImpl?: typeof fetch;
}

export interface BitbucketVerifyResult {
    readonly ok: boolean;
    readonly detail: string;
}

export async function verifyBitbucketSetup(input: BitbucketVerifyInput): Promise<BitbucketVerifyResult> {
    const backend = createBitbucketBackend({
        auth: bitbucketApiTokenAuth(input.email, input.apiToken),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
    const repo = await backend.gitHost.getRepository(toRepoId(input.repo));
    return repo
        ? { ok: true, detail: `Repository "${input.repo}" reachable.` }
        : { ok: false, detail: `Repository "${input.repo}" not found (or these credentials can't see it).` };
}

// ---------- Step: .env generation ----------

export interface EnvInput {
    readonly projectKey: string;
    readonly spaceKey: string;
    readonly siteUrl: string;
    readonly email: string;
    readonly apiToken: string;
    readonly bitbucketEmail?: string;
    readonly bitbucketApiToken?: string;
    readonly gitRepos?: string;
}

/** Pure — matches `.env.example`'s own field set/ordering. Kept separate from the `write`
 *  wrapper so its output is directly testable without touching the filesystem. */
export function renderEnvFile(input: EnvInput): string {
    const lines = [
        "# Generated by /tai-init (TAI-130) -- see .env.example for the full annotated template.",
        `TAI_PROJECT_KEY=${input.projectKey}`,
        `TAI_BACKEND=jira`,
        `TAI_SPACE_KEY=${input.spaceKey}`,
        `TAI_JIRA_SITE_URL=${input.siteUrl}`,
        `TAI_JIRA_EMAIL=${input.email}`,
        `TAI_JIRA_API_TOKEN=${input.apiToken}`,
    ];
    if (input.bitbucketEmail && input.bitbucketApiToken) {
        lines.push("", `BITBUCKET_EMAIL=${input.bitbucketEmail}`, `BITBUCKET_API_TOKEN=${input.bitbucketApiToken}`);
        if (input.gitRepos) lines.push(`TAI_GIT_REPOS=${input.gitRepos}`);
    }
    return lines.join("\n") + "\n";
}

/** Refuses to run ahead of the `jira`/`confluence` steps (and `bitbucket`, if Bitbucket
 *  fields are supplied) — this is what makes the step sequence self-enforcing rather than
 *  relying on the skill prose alone to get the order right. */
export async function writeEnvFile(cwd: string, taiRoot: string, input: EnvInput): Promise<string> {
    const state = await readInitState(taiRoot);
    const needsBitbucket = Boolean(input.bitbucketEmail && input.bitbucketApiToken);
    const missing = (["jira", "confluence", ...(needsBitbucket ? (["bitbucket"] as const) : [])] as const).filter(
        (s) => state.steps[s] === undefined
    );
    if (missing.length > 0) {
        throw new Error(`Run these /tai-init steps first: ${missing.join(", ")}.`);
    }

    const filePath = path.join(cwd, ".env");
    await writeFile(filePath, renderEnvFile(input), "utf-8");
    return filePath;
}

// ---------- Step: CLAUDE.md pointer ----------

const CLAUDE_MD_BEGIN = "<!-- TAI-INIT:BEGIN -->";
const CLAUDE_MD_END = "<!-- TAI-INIT:END -->";

function claudeMdSection(taiHome: string): string {
    return (
        `${CLAUDE_MD_BEGIN}\n` +
        `## Team AI (TAI)\n\n` +
        `This project uses [TAI](${taiHome}) (Team AI) for Jira/Confluence-driven persona ` +
        `workflows. Global skills (\`tai-work\`, \`tai-ready\`, \`tai-pr\`, \`tai-init\`) are ` +
        `installed at \`~/.claude/skills/tai-*/\` and \`~/.gemini/skills/tai-*/\`, referencing ` +
        `TAI's fixed install at \`${taiHome}\`. See \`${taiHome}/PROJECT_BRIEF.md\` for the ` +
        `framework's own design reference.\n` +
        `${CLAUDE_MD_END}\n`
    );
}

/** Idempotent: re-running replaces the existing TAI section (found by its markers) rather
 *  than duplicating it, and leaves the rest of a project's own `CLAUDE.md` untouched.
 *  Refuses to run ahead of `env` — a CLAUDE.md pointer with no working `.env` behind it
 *  would be actively misleading. */
export async function writeClaudeMdPointer(cwd: string, taiRoot: string, taiHome: string): Promise<string> {
    const state = await readInitState(taiRoot);
    if (state.steps["env"] === undefined) {
        throw new Error(`Run the /tai-init "env" step first.`);
    }

    const filePath = path.join(cwd, "CLAUDE.md");
    let existing = "";
    try {
        existing = await readFile(filePath, "utf-8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const section = claudeMdSection(taiHome);
    const beginIdx = existing.indexOf(CLAUDE_MD_BEGIN);
    const endIdx = existing.indexOf(CLAUDE_MD_END);
    const next =
        beginIdx !== -1 && endIdx !== -1
            ? existing.slice(0, beginIdx) + section + existing.slice(endIdx + CLAUDE_MD_END.length)
            : existing.trim().length > 0
              ? `${existing.trim()}\n\n${section}`
              : section;

    await writeFile(filePath, next, "utf-8");
    return filePath;
}
