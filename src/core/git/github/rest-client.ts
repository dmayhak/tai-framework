/**
 * TAI Framework — GitHub REST transport (TAI-583 ADR)
 *
 * A thin `fetch` wrapper over the GitHub REST API (`https://api.github.com`), the sibling of
 * `bitbucket/rest-client.ts`: the same rejection-vs-connectivity split and the same injected
 * auth, kept as its own file because the two hosts' error and paging shapes differ.
 *
 * Node built-ins only — native `fetch`, no new runtime dependency.
 *
 * AUTH: a bearer token (`GITHUB_TOKEN`, a fine-grained or classic personal access token).
 * The permissions it needs are listed in the ADR.
 */

import { StorageConnectivityError } from "../../storage/interface.js";

// ---------- Auth ----------

export interface GitHubAuth {
    headers(): Promise<Record<string, string>>;
}

export function tokenAuth(token: string): GitHubAuth {
    return {
        async headers() {
            return { Authorization: `Bearer ${token}` };
        },
    };
}

// ---------- Rejection ----------

/**
 * GitHub saying no — a permission gap, an unmergeable PR, a self-approval, a line outside the
 * diff. Distinct from `StorageConnectivityError` for the same reason `BitbucketRejection` is
 * (brief §3.3 escalates a rejection, §3.6 queues a connectivity failure).
 */
export class GitHubRejection extends Error {
    constructor(
        readonly reason: string,
        readonly status: number
    ) {
        super(`GitHub rejected the request (${status}): ${reason}`);
        this.name = "GitHubRejection";
    }
}

const NOT_FOUND = 404;

// GitHub's error body: { "message": "...", "errors"?: [{ "message"?: "...", "code"?: "..." }] }
async function extractReason(res: Response): Promise<string> {
    let raw: string;
    try {
        raw = await res.text();
    } catch {
        return res.statusText || `HTTP ${res.status}`;
    }
    try {
        const body = JSON.parse(raw) as { message?: string; errors?: readonly ({ message?: string; code?: string } | string)[] };
        const details = (body.errors ?? [])
            .map((e) => (typeof e === "string" ? e : (e.message ?? e.code)))
            .filter((d): d is string => Boolean(d));
        if (body.message) return details.length > 0 ? `${body.message}: ${details.join("; ")}` : body.message;
    } catch {
        // Not JSON — fall through and return the raw body.
    }
    return raw.trim() || res.statusText || `HTTP ${res.status}`;
}

/** True for GitHub's rate-limit responses: 429, or a 403 with no requests left or a Retry-After. */
export function isRateLimited(res: Pick<Response, "status" | "headers">): boolean {
    if (res.status === 429) return true;
    return res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after") !== null);
}

/** The `rel="next"` URL of a `Link` header, if any. */
export function nextLink(link: string | null): string | undefined {
    if (!link) return undefined;
    for (const part of link.split(",")) {
        const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
        if (m) return m[1];
    }
    return undefined;
}

// ---------- Client ----------

export interface RestClientOptions {
    /** Defaults to `https://api.github.com`; overridable for tests. */
    readonly baseUrl?: string;
    readonly auth: GitHubAuth;
    /** Injectable for tests — defaults to global fetch. */
    readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.github.com";

export interface PaginateOptions<T> {
    readonly limit?: number;
    /** A caller reading a list sorted newest first can say a page already reached what it needs (TAI-562). */
    readonly stopAfterPage?: (page: readonly T[]) => boolean;
    /** Where the items are when a list endpoint wraps them in an object (`check_runs`). */
    readonly itemsKey?: string;
}

export class RestClient {
    readonly baseUrl: string;
    private readonly auth: GitHubAuth;
    private readonly fetchImpl: typeof fetch;

    constructor(opts: RestClientOptions) {
        this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
        this.auth = opts.auth;
        this.fetchImpl = opts.fetchImpl ?? fetch;
    }

    private async send(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<{ data: unknown; link: string | null }> {
        const headers: Record<string, string> = {
            ...(await this.auth.headers()),
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "tai-framework",
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
            throw new StorageConnectivityError(`Could not reach ${url}: ${(err as Error).message}`);
        }

        // 5xx is GitHub being unavailable, not GitHub saying no — same split as the Bitbucket client.
        if (res.status >= 500) {
            throw new StorageConnectivityError(`GitHub returned ${res.status} ${res.statusText} for ${method} ${path}`);
        }
        // A rate limit is temporary, not a refusal (PR 215 review): GitHub sends 429, or 403 with no
        // requests left. Kept apart so a 403 for permissions is never mistaken for one, or the reverse.
        if (isRateLimited(res)) {
            throw new StorageConnectivityError(`GitHub rate limit reached for ${method} ${path}; try again later.`);
        }
        if (!res.ok) throw new GitHubRejection(await extractReason(res), res.status);

        const text = await res.text();
        return { data: text === "" ? undefined : JSON.parse(text), link: res.headers.get("link") };
    }

    async request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
        return (await this.send(method, path, body)).data as T;
    }

    /** GET where 404 means "absent" rather than "no" — the caller opts in explicitly. */
    async getOrNull<T>(path: string): Promise<T | null> {
        try {
            return await this.request<T>("GET", path);
        } catch (err) {
            if (err instanceof GitHubRejection && err.status === NOT_FOUND) return null;
            throw err;
        }
    }

    /**
     * GitHub pages list endpoints through the `Link` header's `rel="next"` URL. Asks for 100
     * items a page, and stops once `limit` items are collected, there is no next page, or
     * `stopAfterPage` says a page was enough.
     */
    async paginate<T>(path: string, options: PaginateOptions<T> = {}): Promise<T[]> {
        const { limit, stopAfterPage, itemsKey } = options;
        const results: T[] = [];
        let next: string | undefined = path.includes("per_page=") ? path : `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
        while (next && (limit === undefined || results.length < limit)) {
            const { data, link } = await this.send("GET", next);
            const page = (itemsKey ? (data as Record<string, T[]>)[itemsKey] : (data as T[])) ?? [];
            results.push(...page);
            if (stopAfterPage?.(page)) break;
            next = nextLink(link);
        }
        return limit === undefined ? results : results.slice(0, limit);
    }
}
