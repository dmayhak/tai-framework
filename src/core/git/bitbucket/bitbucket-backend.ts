/**
 * TAI Framework — Bitbucket `GitHostBackend`
 *
 * Composes the REST client and `GitHost` implementation into the `GitHostBackend` the rest
 * of TAI is written against (`git/interface.ts`) — mirrors `storage/jira/jira-backend.ts`'s
 * shape for the sibling git-hosting domain (TAI-33 ADR decision 1).
 */

import type { GitHostBackend } from "../interface.js";
import { RestClient, apiTokenAuth, type BitbucketAuth } from "./rest-client.js";
import { createBitbucketGitHost } from "./git-host.js";

export interface BitbucketBackendConfig {
    readonly auth: BitbucketAuth;
    /** Defaults to `https://api.bitbucket.org/2.0`; overridable for tests. */
    readonly baseUrl?: string;
    /** Injectable for tests. */
    readonly fetchImpl?: typeof fetch;
}

export function createBitbucketBackend(config: BitbucketBackendConfig): GitHostBackend {
    const client = new RestClient({
        auth: config.auth,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    });

    return {
        kind: "bitbucket",
        gitHost: createBitbucketGitHost(client),
    };
}

export { apiTokenAuth, type BitbucketAuth };
