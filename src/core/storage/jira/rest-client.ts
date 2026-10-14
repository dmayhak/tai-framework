/**
 * TAI Framework — Atlassian REST transport
 *
 * A thin `fetch` wrapper over the Atlassian Cloud REST API, shared by the Jira
 * (WorkTracker) and Confluence (DocStore) halves of the backend.
 *
 * Node built-ins only — native `fetch` (Node 20+). The project has zero runtime
 * dependencies and this backend isn't going to be the thing that adds one.
 *
 * WHY REST AND NOT THE ATLASSIAN REMOTE MCP SERVER (brief §3.2, rev 17):
 * the brief originally specified `mcp.atlassian.com`. Spike TAI-16 tested it live —
 * headless API-token auth authenticates fine, but the tool surface it returns is three
 * read-only Teamwork Graph tools. No createIssue, no transition, no addComment, no
 * createPage. The real Jira/Confluence tools sit behind interactive OAuth 2.1, which
 * would leave CI and the integration tests with no headless path at all. See the ADR
 * linked from Jira TAI-12.
 *
 * WHY /rest/api/2 AND NOT /rest/api/3 FOR JIRA:
 * v3 represents `description` and comment bodies as ADF (a JSON document); v2 represents
 * them as plain strings. `Issue.description` / `Comment.body` are `string` in
 * interface.ts, so v2 round-trips them EXACTLY, with no lossy markdown<->ADF converter in
 * the middle. Verified live against both versions. Trade-off, stated plainly: Jira renders
 * a v2 description as *wiki markup*, so markdown emphasis in a description shows up
 * literally in the Jira UI. That's a presentation concern (a markdown->wiki emitter can be
 * added later without touching the interface), not a data-fidelity one — and data fidelity
 * is what the storage contract actually promises.
 */

import { StorageConnectivityError } from "../interface.js";

// ---------- Auth ----------

/**
 * Auth is INJECTED, never hardcoded — brief §3.2 wants "an AI persona acts with exactly
 * the authority of the human driving it," and today that's the human's own API token.
 * Keeping this an interface is what lets OAuth 2.1 (3LO) drop in later for real per-user
 * delegation without the backend noticing.
 */
export interface AtlassianAuth {
    headers(): Promise<Record<string, string>>;
}

export function apiTokenAuth(email: string, apiToken: string): AtlassianAuth {
    const basic = Buffer.from(`${email}:${apiToken}`).toString("base64");
    return {
        async headers() {
            return { Authorization: `Basic ${basic}` };
        },
    };
}

// ---------- Rejection ----------

/**
 * A genuine backend-side rejection: a validator, a permission gap, a missing required
 * field, a concurrent change. Distinct from StorageConnectivityError, and the distinction
 * is load-bearing — brief §3.3 escalates a rejection to a human immediately with no retry,
 * while §3.6 queues a connectivity failure and replays it on reconnect. Collapsing them
 * would force callers to string-match `reason` to tell them apart (interface.ts:140-151).
 */
export class JiraRejection extends Error {
    constructor(
        readonly reason: string,
        readonly status: number
    ) {
        super(`Atlassian rejected the request (${status}): ${reason}`);
        this.name = "JiraRejection";
    }
}

/**
 * 404 is DELIBERATELY not special-cased here — it is an ordinary JiraRejection.
 *
 * It was, briefly, and that was a bug: driving the backend against live Jira showed that
 * Jira answers `PUT /issue/{key}/assignee` with a 404 when the accountId doesn't exist.
 * Treating 404 as a blanket "no such thing" made that *rejection* throw instead of
 * returning `{ok: false}` — collapsing exactly the §3.3-vs-§3.6 distinction this file
 * exists to preserve. 404's meaning depends entirely on the operation, so only the caller
 * knows whether it means "absent" or "no": `getOrNull()` opts into "absent"; everything
 * else keeps it a rejection.
 */
const NOT_FOUND = 404;

// Jira and Confluence report errors in different shapes. Pull a human-readable reason out
// of whichever we got, and fall back to the raw body rather than inventing a message —
// this string is journaled verbatim and shown to a human (brief §3.3), so it must be true.
/** One error entry as readable text. Jira gives a string; Confluence gives an object such as
 *  `{ message: { translation: "…", args: [] } }` (TAI-497: it printed as `[object Object]`). */
function describeError(entry: unknown): string {
    if (typeof entry === "string") return entry;
    if (entry !== null && typeof entry === "object") {
        const { message, translation } = entry as { message?: unknown; translation?: unknown };
        if (typeof message === "string") return message;
        if (typeof translation === "string") return translation;
        if (message !== null && typeof message === "object") return describeError(message);
    }
    return JSON.stringify(entry);
}

export async function extractReason(res: Response): Promise<string> {
    let raw: string;
    try {
        raw = await res.text();
    } catch {
        return res.statusText || `HTTP ${res.status}`;
    }
    try {
        const body = JSON.parse(raw) as {
            errorMessages?: string[];
            errors?: unknown;
            data?: { errors?: unknown };
            message?: string;
        };
        // `errors` is a field -> message record for Jira, a list of entries for Confluence (also under `data`).
        const listed = (errors: unknown): string[] =>
            Array.isArray(errors)
                ? errors.map(describeError)
                : errors !== null && typeof errors === "object"
                  ? Object.entries(errors).map(([field, msg]) => `${field}: ${describeError(msg)}`)
                  : [];
        const parts = [...(body.errorMessages ?? []), ...listed(body.errors), ...listed(body.data?.errors)];
        // Confluence's error LIST is repeated, class-prefixed, in `message`; Jira's `message` can say something of its
        // own next to its errors, so it is kept there (as before) and dropped only behind a Confluence list.
        const confluenceList = [body.errors, body.data?.errors].some((e) => Array.isArray(e) && e.length > 0);
        if (body.message && !confluenceList) parts.push(body.message);
        if (parts.length > 0) return parts.join("; ");
    } catch {
        // Not JSON — fall through and return the raw body.
    }
    return raw.trim() || res.statusText || `HTTP ${res.status}`;
}

// ---------- Client ----------

export interface RestClientOptions {
    /** e.g. `https://your-site.atlassian.net` (no trailing slash needed). */
    readonly siteUrl: string;
    readonly auth: AtlassianAuth;
    /** Injectable for tests — defaults to global fetch. */
    readonly fetchImpl?: typeof fetch;
}

export class RestClient {
    /**
     * Public: `WorkTracker.linkPage()` needs it to build a real page URL for Jira's
     * remote-link API, which validates `object.url` as an actual URL — a bare page id isn't
     * one, and Jira rejects it with a 400 (found by running the conformance suite, TAI-15).
     */
    readonly siteUrl: string;
    private readonly auth: AtlassianAuth;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: RestClientOptions) {
        this.siteUrl = opts.siteUrl.replace(/\/+$/, "");
        this.auth = opts.auth;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }

    async request<T>(
        method: "GET" | "POST" | "PUT" | "DELETE",
        path: string,
        body?: unknown
    ): Promise<T> {
        const headers: Record<string, string> = {
            ...(await this.auth.headers()),
            Accept: "application/json",
        };
        if (body !== undefined) headers["Content-Type"] = "application/json";

        let res: Response;
        try {
            res = await this.fetchImpl(`${this.siteUrl}${path}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (err) {
            // Network-level: DNS, TCP, TLS, timeout, offline. Brief §3.6's degrade-to-cache
            // and queue-the-write path keys off exactly this.
            throw new StorageConnectivityError(
                `Could not reach ${this.siteUrl}: ${(err as Error).message}`
            );
        }

        // 5xx is Atlassian being unavailable, not Atlassian saying no. Treat it as
        // connectivity (retryable/queueable), not as a §3.3 unplanned checkpoint.
        if (res.status >= 500) {
            throw new StorageConnectivityError(
                `Atlassian returned ${res.status} ${res.statusText} for ${method} ${path}`
            );
        }
        if (!res.ok) throw new JiraRejection(await extractReason(res), res.status);

        // Several Jira mutations answer with no body at all, and NOT always via 204 —
        // `POST /issueLink` returns 201 Created with an empty body, `PUT /issue/{key}`
        // returns 204. Sniffing the status code (or content-length, which Jira doesn't
        // always send) is fragile; reading the body and checking whether there was one is
        // not. Caught by a test that faithfully imitated Jira's actual 201-with-no-body.
        const text = await res.text();
        if (text === "") return undefined as T;
        return JSON.parse(text) as T;
    }

    /** GET where 404 means "absent" rather than "no" — the caller opts in explicitly. */
    async getOrNull<T>(path: string): Promise<T | null> {
        try {
            return await this.request<T>("GET", path);
        } catch (err) {
            if (err instanceof JiraRejection && err.status === NOT_FOUND) return null;
            throw err;
        }
    }

    /** Fetch raw bytes (attachments) — outside the JSON path. */
    async getBinary(url: string): Promise<Buffer> {
        const headers = await this.auth.headers();
        let res: Response;
        try {
            res = await this.fetchImpl(url.startsWith("http") ? url : `${this.siteUrl}${url}`, {
                headers,
            });
        } catch (err) {
            throw new StorageConnectivityError(
                `Could not fetch attachment: ${(err as Error).message}`
            );
        }
        if (res.status >= 500) {
            throw new StorageConnectivityError(`Atlassian returned ${res.status} fetching attachment`);
        }
        if (!res.ok) throw new JiraRejection(await extractReason(res), res.status);
        return Buffer.from(await res.arrayBuffer());
    }
}
