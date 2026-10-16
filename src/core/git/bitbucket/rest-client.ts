/**
 * TAI Framework — Bitbucket Cloud REST transport
 *
 * A thin `fetch` wrapper over the Bitbucket Cloud REST API (`https://api.bitbucket.org/2.0`),
 * mirroring `storage/jira/rest-client.ts`'s shape (same rejection-vs-connectivity split,
 * same injected-auth pattern) but a separate file — git hosting is a sibling domain, not a
 * shared transport (TAI-33 ADR decision 1).
 *
 * Node built-ins only — native `fetch` (Node 20+), zero new runtime dependencies, same
 * discipline as the Jira/Confluence backend.
 *
 * AUTH: HTTP Basic (email + API token), confirmed live this project's own Bitbucket
 * Pipelines work (TAI-32) — NOT Bearer, which is what a naive reading of Bitbucket's docs
 * suggests (see the `bitbucket-mcp-server-setup` memory). Same injected-provider shape as
 * the Jira/Confluence backend (TAI-12 ADR decision 2) — swapping in OAuth later is a config
 * change, not a redesign.
 */

import { StorageConnectivityError } from "../../storage/interface.js";

// ---------- Auth ----------

export interface BitbucketAuth {
    headers(): Promise<Record<string, string>>;
}

export function apiTokenAuth(email: string, apiToken: string): BitbucketAuth {
    const basic = Buffer.from(`${email}:${apiToken}`).toString("base64");
    return {
        async headers() {
            return { Authorization: `Basic ${basic}` };
        },
    };
}

// ---------- Rejection ----------

/**
 * A genuine backend-side rejection — a branch restriction, a permission gap, a merge
 * conflict, a missing required field. Distinct from `StorageConnectivityError`, exactly the
 * same load-bearing distinction `storage/jira/rest-client.ts`'s `JiraRejection` preserves
 * (brief §3.3 escalates a rejection immediately with no retry; §3.6 queues a connectivity
 * failure and replays it on reconnect).
 */
export class BitbucketRejection extends Error {
    constructor(
        readonly reason: string,
        readonly status: number
    ) {
        super(`Bitbucket rejected the request (${status}): ${reason}`);
        this.name = "BitbucketRejection";
    }
}

const NOT_FOUND = 404;

// Bitbucket's error body shape: { "type": "error", "error": { "message": "...", "detail"?: ... } }
async function extractReason(res: Response): Promise<string> {
    let raw: string;
    try {
        raw = await res.text();
    } catch {
        return res.statusText || `HTTP ${res.status}`;
    }
    try {
        const body = JSON.parse(raw) as { error?: { message?: string; detail?: unknown } };
        if (body.error?.message) return body.error.message;
    } catch {
        // Not JSON — fall through and return the raw body.
    }
    return raw.trim() || res.statusText || `HTTP ${res.status}`;
}

// ---------- Client ----------

export interface RestClientOptions {
    /** Defaults to `https://api.bitbucket.org/2.0`; overridable for tests. */
    readonly baseUrl?: string;
    readonly auth: BitbucketAuth;
    /** Injectable for tests — defaults to global fetch. */
    readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.bitbucket.org/2.0";

export class RestClient {
    readonly baseUrl: string;
    private readonly auth: BitbucketAuth;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: RestClientOptions) {
        this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
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

        const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
        let res: Response;
        try {
            res = await this.fetchImpl(url, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (err) {
            // Network-level: DNS, TCP, TLS, timeout, offline — brief §3.6's degrade/queue path.
            throw new StorageConnectivityError(`Could not reach ${url}: ${(err as Error).message}`);
        }

        // 5xx is Bitbucket being unavailable, not Bitbucket saying no — connectivity, not a
        // §3.3 unplanned checkpoint. Same split as the Jira rest-client.
        if (res.status >= 500) {
            throw new StorageConnectivityError(
                `Bitbucket returned ${res.status} ${res.statusText} for ${method} ${path}`
            );
        }
        if (!res.ok) throw new BitbucketRejection(await extractReason(res), res.status);

        const text = await res.text();
        if (text === "") return undefined as T;
        return JSON.parse(text) as T;
    }

    /** GET where 404 means "absent" rather than "no" — the caller opts in explicitly. */
    async getOrNull<T>(path: string): Promise<T | null> {
        try {
            return await this.request<T>("GET", path);
        } catch (err) {
            if (err instanceof BitbucketRejection && err.status === NOT_FOUND) return null;
            throw err;
        }
    }

    /**
     * Bitbucket paginates list endpoints via `{ values: T[], next?: string }`, with `next`
     * being a FULL absolute URL (not a token/cursor) — walk it directly rather than
     * re-deriving query params. Stops once `limit` items are collected, `next` is absent, or `stopAfterPage` says a page was enough.
     */
    async paginate<T>(path: string, limit?: number, stopAfterPage?: (page: readonly T[]) => boolean): Promise<T[]> {
        const results: T[] = [];
        let next: string | undefined = path;
        while (next && (limit === undefined || results.length < limit)) {
            const page: { values: T[]; next?: string } = await this.request("GET", next);
            results.push(...page.values);
            // TAI-562: a caller reading a list sorted newest-first can say a page already reached what it needs.
            if (stopAfterPage?.(page.values)) break;
            next = page.next;
        }
        return limit === undefined ? results : results.slice(0, limit);
    }
}
