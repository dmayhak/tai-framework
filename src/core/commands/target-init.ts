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

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
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

/** Removes one step's record -- `init run` (TAI-367) re-verifies every step live, so a step
 *  that now FAILS must stop reading as done: the state file is a cache of the last live
 *  result, not a ratchet. Other steps are left alone (they simply were not re-verified). */
export async function clearStep(taiRoot: string, step: InitStep): Promise<InitState> {
    const current = await readInitState(taiRoot);
    if (current.steps[step] === undefined) return current;
    const { [step]: _removed, ...rest } = current.steps;
    const next: InitState = { version: 1, steps: rest };
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
    /** False only when the project key itself was not found (or is invisible to this token) --
     *  distinct from "found, but not provisioned", so a caller can offer to retype the key. */
    readonly projectFound: boolean;
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
            projectFound: false,
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

    return { ok, projectFound: true, missingIssueTypes, personaFieldFound, detail };
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

/** Matches `renderEnvFile`'s own leading key on a real `KEY=value` line — never comments,
 *  blanks, or a malformed line, so anything TAI doesn't understand is left untouched by
 *  `mergeEnvContent` below rather than risk misinterpreting it as a key to overwrite. */
const ENV_KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** How `mergeEnvContent` treats a key TAI generates that the existing file already has.
 *  `replace` (the original behavior): the generated line wins. `fill-if-empty` (TAI-363,
 *  ADR for TAI-360 decision 2): the generated line only fills an existing EMPTY value and
 *  never replaces a non-empty one, so a re-run can never blank a secret the user typed. */
export type EnvMergeMode = "replace" | "fill-if-empty";

/** The value part of a real `KEY=value` line, trimmed and with one pair of surrounding
 *  quotes removed — so `KEY=`, `KEY=  ` and `KEY=""` all read as empty. */
function envLineValue(line: string): string {
    const raw = line.slice(line.indexOf("=") + 1).trim();
    return raw.replace(/^(["'])(.*)\1$/, "$2").trim();
}

/** TAI-346-adjacent bug (found live 2026-09-24 on a real target project): `writeEnvFile`
 *  used to overwrite `.env` wholesale with `renderEnvFile`'s output, silently destroying
 *  every line TAI's own template doesn't know about — the target app's own config
 *  (`DATABASE_URL`, `HTTP_ADDR`), and even TAI's own optional `TAI_GIT_WORKSPACE`, which
 *  isn't part of `EnvInput`/`renderEnvFile` at all. A real `.env` almost always carries a
 *  target project's own app config alongside whatever TAI adds — this is the normal case
 *  for onboarding an *existing* project, not an edge case. Fixed the same way
 *  `writeClaudeMdPointer` below already handles `CLAUDE.md`: read what's there first,
 *  update TAI's own keys in place (by key, not by line position, since `renderEnvFile`'s
 *  field order doesn't have to match whatever order a human's `.env` happens to be in),
 *  and leave every other line — including ones TAI doesn't recognize — completely
 *  untouched. Genuinely new TAI keys (nothing to update in place) get appended once, under
 *  a fresh header comment, rather than inserted mid-file. Pure and independently testable,
 *  same "kept separate from the `write` wrapper" reasoning as `renderEnvFile` itself. */
export function mergeEnvContent(existing: string, generated: string, mode: EnvMergeMode = "replace"): string {
    if (existing.trim().length === 0) return generated;

    // In fill-if-empty mode a key appended to an existing file carries the comment lines
    // directly above it in `generated` (a blank line detaches a comment, so a file-level
    // header never gets glued onto its first key). Replace mode appends bare lines, as it
    // always has.
    const genEntries: { key: string; line: string; comments: string[] }[] = [];
    let pendingComments: string[] = [];
    for (const line of generated.split("\n")) {
        const match = ENV_KEY_LINE.exec(line);
        if (match) {
            genEntries.push({ key: match[1] as string, line, comments: pendingComments });
            pendingComments = [];
        } else if (line.trimStart().startsWith("#")) {
            pendingComments.push(line);
        } else {
            pendingComments = [];
        }
    }

    const existingLines = existing.split("\n");
    const existingKeyLineIdx = new Map<string, number>();
    existingLines.forEach((line, i) => {
        const m = ENV_KEY_LINE.exec(line);
        if (m) existingKeyLineIdx.set(m[1] as string, i);
    });

    const resultLines = [...existingLines];
    const newEntries: string[] = [];
    for (const { key, line, comments } of genEntries) {
        const idx = existingKeyLineIdx.get(key);
        if (idx !== undefined) {
            if (mode === "replace") {
                resultLines[idx] = line;
            } else if (envLineValue(resultLines[idx] as string) === "" && envLineValue(line) !== "") {
                resultLines[idx] = line;
            }
        } else {
            newEntries.push(...(mode === "fill-if-empty" ? comments : []), line);
        }
    }

    let result = resultLines.join("\n");
    if (newEntries.length > 0) {
        if (!result.endsWith("\n")) result += "\n";
        result += "\n" + newEntries.join("\n") + "\n";
    }
    return result;
}

/** Refuses to run ahead of the `jira`/`confluence` steps (and `bitbucket`, if Bitbucket
 *  fields are supplied) — this is what makes the step sequence self-enforcing rather than
 *  relying on the skill prose alone to get the order right. Merges into any pre-existing
 *  `.env` via `mergeEnvContent` rather than overwriting it — see that function's own
 *  comment for why this matters. */
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
    let existing = "";
    try {
        existing = await readFile(filePath, "utf-8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    await writeFile(filePath, mergeEnvContent(existing, renderEnvFile(input)), "utf-8");
    // TAI-363: this file holds real tokens -- owner-only, including when it already existed
    // (writeFile's mode only applies on creation). Best-effort on Windows, where chmod only
    // toggles the read-only attribute and real protection comes from the profile dir's ACL.
    await chmod(filePath, 0o600);
    return filePath;
}

// ---------- .env primitives for the guided `init run` flow (TAI-363) ----------

const JIRA_SECRET_KEYS = ["TAI_JIRA_EMAIL", "TAI_JIRA_API_TOKEN"] as const;
const BITBUCKET_SECRET_KEYS = ["BITBUCKET_EMAIL", "BITBUCKET_API_TOKEN"] as const;

/** The secret keys a user must fill in by hand; Bitbucket's only when git-pr support is wanted. */
export function requiredEnvSecretKeys(includeBitbucket: boolean): string[] {
    return [...JIRA_SECRET_KEYS, ...(includeBitbucket ? BITBUCKET_SECRET_KEYS : [])];
}

/** `.env` content as a plain `KEY -> value` map (quotes stripped; the last occurrence of a
 *  key wins; comments, blanks and malformed lines ignored). */
export function parseEnvContent(content: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of content.split("\n")) {
        const m = ENV_KEY_LINE.exec(line);
        if (m) out[m[1] as string] = envLineValue(line);
    }
    return out;
}

/** Which required secret keys are absent or empty in `.env` content. A commented-out line
 *  never counts as set (`ENV_KEY_LINE` only matches real `KEY=` lines). */
export function missingEnvSecrets(content: string, includeBitbucket: boolean): string[] {
    const values = new Map<string, string>();
    for (const line of content.split("\n")) {
        const m = ENV_KEY_LINE.exec(line);
        if (m) values.set(m[1] as string, envLineValue(line));
    }
    return requiredEnvSecretKeys(includeBitbucket).filter((key) => (values.get(key) ?? "") === "");
}

export interface EnvSkeletonInput {
    readonly siteUrl: string;
    /** Only written when already known (existing `.env`, or chosen via discovery). */
    readonly projectKey?: string;
    readonly spaceKey?: string;
    readonly includeBitbucket?: boolean;
}

/** Pure: the `.env` a user finishes by hand. Non-secret values are filled in; every secret
 *  line is left EMPTY under a comment saying what belongs there, so the editor step is a
 *  fill-in-the-blanks pass. The blank line after the header keeps it from being attached
 *  to the first key when this is merged into an existing file. */
export function renderEnvSkeleton(input: EnvSkeletonInput): string {
    const lines = [
        "# Generated by /tai-init -- fill in the empty secret lines below, save, and close your editor.",
        "# This file is gitignored; never commit it.",
        "",
        "TAI_BACKEND=jira",
        `TAI_JIRA_SITE_URL=${input.siteUrl}`,
    ];
    if (input.projectKey) lines.push(`TAI_PROJECT_KEY=${input.projectKey}`);
    if (input.spaceKey) lines.push(`TAI_SPACE_KEY=${input.spaceKey}`);
    lines.push(
        "",
        "# Your Atlassian account email (the one you log in to Jira with).",
        "TAI_JIRA_EMAIL=",
        "# An Atlassian API token: create one at https://id.atlassian.com/manage-profile/security/api-tokens",
        "TAI_JIRA_API_TOKEN="
    );
    if (input.includeBitbucket) {
        lines.push(
            "",
            "# Your Bitbucket account email (only needed for git-pr support).",
            "BITBUCKET_EMAIL=",
            "# A Bitbucket API token with repository and pull-request read/write scopes.",
            "BITBUCKET_API_TOKEN="
        );
    }
    return lines.join("\n") + "\n";
}

async function readEnvIfPresent(filePath: string): Promise<string> {
    try {
        return await readFile(filePath, "utf-8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return "";
    }
}

/** Writes the skeleton into `<cwd>/.env` in fill-if-empty mode -- safe to run against an
 *  existing `.env`: typed secrets and unrelated lines survive, only missing keys (with
 *  their comments) and empty values are filled -- then forces mode 0600. */
export async function writeEnvSkeleton(cwd: string, input: EnvSkeletonInput): Promise<string> {
    const filePath = path.join(cwd, ".env");
    const existing = await readEnvIfPresent(filePath);
    await writeFile(filePath, mergeEnvContent(existing, renderEnvSkeleton(input), "fill-if-empty"), "utf-8");
    await chmod(filePath, 0o600);
    return filePath;
}

/** Writes ONLY the given keys into `<cwd>/.env`, replacing their current values (replace
 *  mode) and leaving every other line -- secrets included -- untouched. This is the
 *  post-discovery write: callers pass the newly chosen project/space/repo keys, never the
 *  secret keys. Values must be single-line so one value can never inject another key. */
export async function writeEnvValues(cwd: string, values: Readonly<Record<string, string>>): Promise<string> {
    for (const [key, value] of Object.entries(values)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid .env key "${key}".`);
        if (/[\r\n]/.test(value)) throw new Error(`Value for ${key} must be a single line.`);
    }
    const filePath = path.join(cwd, ".env");
    const existing = await readEnvIfPresent(filePath);
    const generated = Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
    await writeFile(filePath, mergeEnvContent(existing, generated.length > 0 ? generated + "\n" : ""), "utf-8");
    await chmod(filePath, 0o600);
    return filePath;
}

// ---------- Step: CLAUDE.md pointer ----------

const CLAUDE_MD_BEGIN = "<!-- TAI-INIT:BEGIN -->";
const CLAUDE_MD_END = "<!-- TAI-INIT:END -->";

/** TAI-359: `CLAUDE.md` is committed and shared, so it must not embed this machine's home
 *  directory (`/home/<user>/...`). A path under the current home dir is rendered
 *  `~`-relative, which stays true for every teammate/PC that follows the README's fixed
 *  `~/.tai-framework` install location; a path outside home stays absolute (nothing
 *  portable to say about it). */
export function portableTaiHome(taiHome: string, homeDir: string = os.homedir()): string {
    const rel = path.relative(homeDir, taiHome);
    if (rel === "") return "~";
    if (rel.startsWith("..") || path.isAbsolute(rel)) return taiHome;
    return `~/${rel.split(path.sep).join("/")}`;
}

function claudeMdSection(rawTaiHome: string): string {
    const taiHome = portableTaiHome(rawTaiHome);
    return (
        `${CLAUDE_MD_BEGIN}\n` +
        `## Team AI (TAI)\n\n` +
        `This project uses [TAI](${taiHome}) (Team AI) for Jira/Confluence-driven persona ` +
        `workflows. Global skills (\`tai-work\`, \`tai-ready\`, \`tai-pr\`, \`tai-init\`, ` +
        `\`tai-audit\`) are installed at \`~/.claude/skills/tai-*/\` and \`~/.gemini/skills/tai-*/\`, referencing ` +
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

// ---------- .gitignore hygiene ----------

/** Entries every target project needs so `/tai-init` never leaves its own generated files
 *  (or the global `sess-handoff` skill's `.handoff/`, which every project uses the same
 *  way) sitting unignored in the working tree. `.env` and its variants (`.env.local`,
 *  `.env.*`, and editor swap/backup files like `.env.swp`/`.env~`, caught by `.env.*` and
 *  `*~`) are the serious ones -- `writeEnvFile` above writes real Jira/Bitbucket API
 *  tokens there, and an editor can leave a copy next to it. `taiRoot` is passed
 *  through rather than hardcoded ".tai/" since it's overridable via `TAI_ROOT`. */
export function gitignoreEntries(taiRoot: string): string[] {
    const normalized = taiRoot.replace(/^\.\//, "").replace(/\/+$/, "");
    // TAI-366: `.env.*` + `!.env.example` catch every variant (`.env.prod`, editor swap files
    // like `.env.swp`) while keeping the committed template; `*~` catches editor backup files
    // (`.env~`) that can hold the tokens a user just typed. `.env.local` is redundant once
    // `.env.*` is present but stays for projects that already list it. ORDER MATTERS: a
    // later gitignore rule wins, so `!.env.example` must come after `.env.*`
    // (see NEGATION_AFTER_PATTERN).
    return [`/${normalized}/`, ".env", ".env.local", ".env.*", "!.env.example", "*~", "/.handoff/"];
}

/** A negation rule only works if it comes AFTER the pattern it carves an exception out of
 *  (gitignore: the last matching rule wins). Maps each such negation to its pattern. */
const NEGATION_AFTER_PATTERN: Readonly<Record<string, string>> = { "!.env.example": ".env.*" };

/** Pure: which of `entries` a merge has to (re-)append to `existing`. Normally the ones
 *  not already present as an exact line; additionally a negation that IS present but would
 *  not come after its pattern -- because the pattern is being appended below it, or both
 *  were already there in the wrong order -- is re-appended so it follows the pattern. A
 *  duplicate negation line is harmless, and once it is last the next call finds nothing
 *  to do. Order follows `entries`, so a pattern always precedes its negation. */
export function gitignoreEntriesToAppend(existing: string, entries: readonly string[]): string[] {
    const lines = existing.split("\n").map((line) => line.trim());
    const present = new Set(lines.filter((line) => line.length > 0));
    const toAppend = new Set(entries.filter((e) => !present.has(e)));
    for (const [negation, pattern] of Object.entries(NEGATION_AFTER_PATTERN)) {
        if (!entries.includes(negation) || !entries.includes(pattern) || toAppend.has(negation)) continue;
        const patternWillBeAfter = toAppend.has(pattern) || lines.lastIndexOf(pattern) > lines.lastIndexOf(negation);
        if (patternWillBeAfter) toAppend.add(negation);
    }
    return entries.filter((e) => toAppend.has(e));
}

/** Pure, mirrors `mergeEnvContent`'s "read what's there, only append what's missing" shape:
 *  never rewrites or reorders a target project's existing `.gitignore`, and does not
 *  duplicate an entry already present anywhere in the file (matched by exact trimmed
 *  line, same as how git itself matches a plain non-glob ignore entry) -- with one
 *  deliberate exception: a negation (see `NEGATION_AFTER_PATTERN`) is re-appended when it
 *  would not otherwise come after the pattern it carves an exception out of. */
export function mergeGitignoreContent(existing: string, entries: readonly string[]): string {
    const missing = gitignoreEntriesToAppend(existing, entries);
    if (missing.length === 0) return existing;

    const block =
        ["# Added by /tai-init (TAI-358) -- TAI's own local state + credentials, never commit these", ...missing].join(
            "\n"
        ) + "\n";
    if (existing.trim().length === 0) return block;
    return (existing.endsWith("\n") ? existing : existing + "\n") + "\n" + block;
}

/** Idempotent side effect, deliberately NOT a named `InitStep` (design fork resolved with
 *  the human, 2026-09-26, TAI-358): a new required step would change the "fully
 *  initialized" contract and retroactively mark every already-onboarded project (this repo
 *  included) as incomplete until re-run. Called eagerly from every `init <action>`
 *  dispatch instead (`cli.ts`) -- cheap, safe to call every time, and protects `.tai/`
 *  from the very first `init jira`/`init confluence` call, before `.env`/`CLAUDE.md` even
 *  exist. */
export async function ensureGitignore(
    cwd: string,
    taiRoot: string
): Promise<{ path: string; added: readonly string[] }> {
    const filePath = path.join(cwd, ".gitignore");
    let existing = "";
    try {
        existing = await readFile(filePath, "utf-8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const entries = gitignoreEntries(taiRoot);
    const added = gitignoreEntriesToAppend(existing, entries);
    if (added.length === 0) return { path: filePath, added };

    await writeFile(filePath, mergeGitignoreContent(existing, entries), "utf-8");
    return { path: filePath, added };
}
