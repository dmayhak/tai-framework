/**
 * TAI Framework — live discovery of a target project's coordinates (TAI-364)
 *
 * The ADR for TAI-360 (Confluence page 45449217, rev 3, decision 1) replaced a committed
 * `tai.json` with discovery: a user joining an already-onboarded project supplies only the
 * Atlassian site URL and their own credentials, and `init run` (TAI-367) finds the rest
 * from things that are always current — the Jira project list, the Confluence space list,
 * and the clone's own `git remote`. Nothing discovered here is stored anywhere but the
 * user's own `.env`, so there is no second source of truth to go stale when a project moves.
 *
 * This module is the non-interactive half: the two list calls, remote parsing, and PURE
 * picker logic (filter / decide / plan). The prompts themselves, and writing the chosen
 * values into `.env`, belong to the `init run` orchestration (TAI-367), same thin-IO-wrapper
 * over pure-tested-functions split `target-init.ts` already uses.
 *
 * **Discovery never overrides a working value** (the DesignReview's third required change):
 * `planCoordinate` keeps an existing `.env` value that matches the live list, and the
 * Confluence list is matched on the real key OR its alias, because this repo's own working
 * `TAI_SPACE_KEY=TAI` is an alias of the space whose real key is `TA` — a picker that
 * blindly offered `TA` (or replaced `TAI` with it) would break a working setup.
 *
 * **Why the alias is what gets written (human decision, 2026-09-30):** both forms resolve
 * today — verified live, `?keys=TA` and `?keys=TAI` return the same space — so this is a
 * readability choice, not a technical necessity. The alias is the space's common name (what
 * a person sees and types, and what a working setup already holds), so a user is never left
 * working out that `TA` and `TAI` are the same place. Trade-off, stated plainly: an alias can
 * be changed in Confluence while a real key cannot; that is caught, not silent — a stored
 * alias that later stops appearing in the live list makes `planCoordinate` return `pick`
 * with the stale value surfaced, so re-running `init run` fixes it.
 *
 * Endpoints verified live against a real site (2026-09-30): Jira `GET
 * /rest/api/2/project/search` (paginated by `startAt`/`isLast`; `/rest/api/2` like the rest
 * of the Jira backend, rest-client.ts) and Confluence `GET /wiki/api/v2/spaces` (cursor
 * pagination via `_links.next`; each space carries `currentActiveAlias`).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { RestClient } from "../storage/jira/rest-client.js";

const execFileAsync = promisify(execFile);

/** Hard stop on pagination so a misbehaving endpoint can never loop forever. */
const MAX_PAGES = 100;

/** A list result that says whether it is the WHOLE list. `truncated` is true when paging
 *  stopped early (page cap, or a cursor that pointed back at a page already read), so a
 *  caller can tell the user a project may be missing instead of silently showing a partial
 *  list. Manual entry stays the escape hatch either way. */
export interface Listing<T> {
    readonly items: T[];
    readonly truncated: boolean;
}

export interface ListOptions {
    /** Page size requested from the API. Injectable so tests (and live probes) can force
     *  multiple pages from a small tenant. */
    readonly pageSize?: number;
    /** Page cap. Injectable for the same reason; defaults to `MAX_PAGES`. */
    readonly maxPages?: number;
}

// ---------- Jira projects ----------

export interface DiscoveredProject {
    readonly key: string;
    readonly name: string;
}

interface ProjectSearchResponse {
    readonly isLast?: boolean;
    readonly values?: readonly { readonly key: string; readonly name: string }[];
}

const JIRA_PAGE_SIZE = 50;

/** Every project the token can browse, across all pages. */
export async function listJiraProjects(client: RestClient, opts: ListOptions = {}): Promise<Listing<DiscoveredProject>> {
    const pageSize = opts.pageSize ?? JIRA_PAGE_SIZE;
    const maxPages = opts.maxPages ?? MAX_PAGES;
    const items: DiscoveredProject[] = [];
    let startAt = 0;
    for (let page = 0; page < maxPages; page++) {
        const res = await client.request<ProjectSearchResponse>(
            "GET",
            `/rest/api/2/project/search?startAt=${startAt}&maxResults=${pageSize}`
        );
        const values = res.values ?? [];
        for (const v of values) items.push({ key: v.key, name: v.name });
        // An empty page ends it even when `isLast` is absent — never loop on a stuck cursor.
        if (res.isLast === true || values.length === 0) return { items, truncated: false };
        startAt += values.length;
    }
    return { items, truncated: true };
}

// ---------- Confluence spaces ----------

export interface DiscoveredSpace {
    /** The space's real system key (e.g. `TA`). */
    readonly key: string;
    /** `currentActiveAlias`, or the key itself when the space has none. */
    readonly alias: string;
    readonly name: string;
    readonly type: string;
    /** What to write into `TAI_SPACE_KEY`: the alias (falling back to the key). The alias is
     *  what a working setup already uses and what Confluence's `?keys=` lookup accepts — see
     *  the module header. */
    readonly value: string;
}

interface SpacesResponse {
    readonly results?: readonly {
        readonly key: string;
        readonly name: string;
        readonly type: string;
        readonly currentActiveAlias?: string;
    }[];
    readonly _links?: { readonly next?: string };
}

/** `RestClient.request` prepends the site URL to whatever it is given, so an ABSOLUTE
 *  `_links.next` (Confluence documents a site-relative path, but don't rely on it) would
 *  produce a garbage URL. Keep only the path and query. */
function toSitePath(next: string): string {
    if (!/^https?:\/\//i.test(next)) return next;
    const url = new URL(next);
    return `${url.pathname}${url.search}`;
}

const CONFLUENCE_PAGE_SIZE = 250;

/** Every current, non-personal space the token can see, across all pages. Personal spaces
 *  (`type: "personal"`, keyed `~<hash>`) are never a project's space, so they are dropped
 *  rather than cluttering the picker. */
export async function listConfluenceSpaces(client: RestClient, opts: ListOptions = {}): Promise<Listing<DiscoveredSpace>> {
    const pageSize = opts.pageSize ?? CONFLUENCE_PAGE_SIZE;
    const maxPages = opts.maxPages ?? MAX_PAGES;
    const items: DiscoveredSpace[] = [];
    const seen = new Set<string>();
    let next: string | undefined = `/wiki/api/v2/spaces?limit=${pageSize}&status=current`;
    for (let page = 0; page < maxPages; page++) {
        if (next === undefined) return { items, truncated: false };
        // A cursor that points back at a page already read is a stuck cursor: stop, and say so.
        if (seen.has(next)) return { items, truncated: true };
        seen.add(next);
        const res: SpacesResponse = await client.request<SpacesResponse>("GET", next);
        for (const s of res.results ?? []) {
            if (s.type === "personal") continue;
            const alias = s.currentActiveAlias && s.currentActiveAlias.length > 0 ? s.currentActiveAlias : s.key;
            items.push({ key: s.key, alias, name: s.name, type: s.type, value: alias });
        }
        next = res._links?.next !== undefined ? toSitePath(res._links.next) : undefined;
    }
    return { items, truncated: next !== undefined };
}

// ---------- Bitbucket remote ----------

// scp-like:  git@bitbucket.org:workspace/repo(.git)
const SCP_REMOTE = /^(?:[\w.-]+@)?bitbucket\.org:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;
// URL form:  https|ssh|git://[user@]bitbucket.org[:port]/workspace/repo(.git)
const URL_REMOTE = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?bitbucket\.org(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

/** `workspace/repo` from a git remote URL on bitbucket.org, or `null` for any other host
 *  (or something unparseable) — a non-Bitbucket remote simply means no Bitbucket setup. */
export function parseBitbucketRemote(url: string): string | null {
    const trimmed = url.trim();
    const m = SCP_REMOTE.exec(trimmed) ?? URL_REMOTE.exec(trimmed);
    return m ? `${m[1]}/${m[2]}` : null;
}

// ---------- GitHub remote (TAI-583 ADR) ----------

const GITHUB_SCP_REMOTE = /^(?:[\w.-]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;
const GITHUB_URL_REMOTE = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/;

/** `owner/repo` from a git remote URL on github.com, or `null` for any other host. */
export function parseGitHubRemote(url: string): string | null {
    const trimmed = url.trim();
    const m = GITHUB_SCP_REMOTE.exec(trimmed) ?? GITHUB_URL_REMOTE.exec(trimmed);
    return m ? `${m[1]}/${m[2]}` : null;
}

/** Which git host a remote URL is on, and its `owner/repo` there; `null` for any other host. */
export function parseGitRemote(url: string): { readonly kind: "bitbucket" | "github"; readonly repo: string } | null {
    const bitbucket = parseBitbucketRemote(url);
    if (bitbucket) return { kind: "bitbucket", repo: bitbucket };
    const github = parseGitHubRemote(url);
    return github ? { kind: "github", repo: github } : null;
}

/** The clone's own git host and repo, read from `origin`'s configured URL, or `null` (not a
 *  repo, no origin, an unknown host). Uses `git config` for the RAW value, not
 *  `git remote get-url`, which would apply the user's own `url.<base>.insteadOf` rewrites. */
export async function detectGitRemote(
    cwd: string,
    env: NodeJS.ProcessEnv = process.env
): Promise<{ readonly kind: "bitbucket" | "github"; readonly repo: string } | null> {
    try {
        const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], { cwd, env });
        return parseGitRemote(stdout);
    } catch {
        return null;
    }
}

/** The clone's own Bitbucket `workspace/repo`, or `null` (not a repo, no origin, not Bitbucket). */
export async function detectBitbucketRepo(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
    const remote = await detectGitRemote(cwd, env);
    return remote?.kind === "bitbucket" ? remote.repo : null;
}

// ---------- Picker (pure) ----------

/** One selectable entry. `keys` are the exact identifiers a user may type for it (a
 *  space's real key AND its alias); `value` is what gets written to `.env` if chosen. */
export interface Choice {
    readonly value: string;
    readonly keys: readonly string[];
    readonly label: string;
}

export function projectChoices(projects: readonly DiscoveredProject[]): Choice[] {
    return projects.map((p) => ({ value: p.key, keys: [p.key], label: `${p.key} — ${p.name}` }));
}

export function spaceChoices(spaces: readonly DiscoveredSpace[]): Choice[] {
    return spaces.map((s) => ({
        value: s.value,
        keys: s.alias === s.key ? [s.key] : [s.key, s.alias],
        label: `${s.alias}${s.alias === s.key ? "" : ` (real key ${s.key})`} — ${s.name}`,
    }));
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Case-insensitive substring match on any key or the label. Entries whose key STARTS with
 *  the query come first; input order is otherwise preserved. An empty query matches all. */
export function filterChoices(choices: readonly Choice[], query: string): Choice[] {
    const q = query.trim().toLowerCase();
    if (q === "") return [...choices];
    const matches = choices.filter(
        (c) => c.keys.some((k) => k.toLowerCase().includes(q)) || c.label.toLowerCase().includes(q)
    );
    const prefix = (c: Choice): boolean => c.keys.some((k) => k.toLowerCase().startsWith(q));
    return [...matches.filter(prefix), ...matches.filter((c) => !prefix(c))];
}

export type PickDecision =
    /** A single entry was identified. */
    | { readonly kind: "chosen"; readonly value: string }
    /** Partial text: show these and ask again — never guess. */
    | { readonly kind: "narrowed"; readonly matches: readonly Choice[] }
    /** Nothing listed matches: offer the typed text as a manual entry (the path for a
     *  project that doesn't exist yet). */
    | { readonly kind: "not-listed"; readonly typed: string }
    /** Empty input with no default. */
    | { readonly kind: "reprompt" };

/** Interprets one line of user input against the picker. `all` is the full list, `shown` is
 *  what is currently on screen (a number indexes `shown`; text always searches `all`).
 *  Order: empty → default; in-range number → that row; exact key/alias → that entry;
 *  otherwise a substring filter, or a manual entry if nothing matches. */
export function decidePick(
    input: string,
    all: readonly Choice[],
    shown: readonly Choice[],
    defaultValue?: string
): PickDecision {
    const text = input.trim();
    if (text === "") return defaultValue !== undefined ? { kind: "chosen", value: defaultValue } : { kind: "reprompt" };

    if (/^\d+$/.test(text)) {
        const n = Number(text);
        const row = shown[n - 1];
        if (n >= 1 && row) return { kind: "chosen", value: row.value };
    }

    const exact = all.find((c) => c.keys.some((k) => same(k, text)));
    if (exact) return { kind: "chosen", value: exact.value };

    const matches = filterChoices(all, text);
    return matches.length > 0 ? { kind: "narrowed", matches } : { kind: "not-listed", typed: text };
}

export type CoordinatePlan =
    /** The existing value is confirmed by the live list — keep it exactly as written. */
    | { readonly kind: "keep"; readonly value: string }
    /** Ask the user. `unverifiedExisting` is an existing value the live list did NOT
     *  confirm (shown as a default to accept, never silently replaced). */
    | { readonly kind: "pick"; readonly unverifiedExisting?: string };

/** "Discovery never overrides a working value": an existing `.env` value that matches any
 *  live choice (by real key or alias) is kept verbatim; the picker only runs for a value
 *  that is absent, or present but not found in the live list. */
export function planCoordinate(existing: string | undefined, choices: readonly Choice[]): CoordinatePlan {
    const value = existing?.trim() ?? "";
    if (value === "") return { kind: "pick" };
    return choices.some((c) => c.keys.some((k) => same(k, value)))
        ? { kind: "keep", value }
        : { kind: "pick", unverifiedExisting: value };
}
