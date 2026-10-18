/**
 * TAI Framework — GitHub `GitHostBackend` (TAI-583 ADR)
 *
 * Composes the REST client and `GitHost` implementation, as `bitbucket/bitbucket-backend.ts` does.
 */

import type { GitHostBackend } from "../interface.js";
import { RestClient, tokenAuth, type GitHubAuth } from "./rest-client.js";
import { createGitHubGitHost } from "./git-host.js";

export interface GitHubBackendConfig {
    readonly auth: GitHubAuth;
    /** `TAI_PR_SELF_REVIEW` (TAI-583 ADR decision 1). */
    readonly allowSelfReview?: boolean;
    /** Defaults to `https://api.github.com`; overridable for tests. */
    readonly baseUrl?: string;
    /** Injectable for tests. */
    readonly fetchImpl?: typeof fetch;
}

export function createGitHubBackend(config: GitHubBackendConfig): GitHostBackend {
    const client = new RestClient({
        auth: config.auth,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    });

    return {
        kind: "github",
        gitHost: createGitHubGitHost(client, { allowSelfReview: config.allowSelfReview === true }),
    };
}

export { tokenAuth, type GitHubAuth };
