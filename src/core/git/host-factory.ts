/**
 * TAI Framework — which git host a project uses, and its backend (TAI-583 ADR decisions 2 and 4)
 *
 * One place that reads `TAI_GIT_HOST` and the matching credentials, so every command that
 * talks to the git host gets the same backend. `TAI_GIT_HOST` is written by `init run` from
 * `origin`'s remote; when it is unset, `origin` is read at run time, and Bitbucket is the
 * fallback, so a project set up before GitHub support keeps working unchanged.
 */

import type { GitHostBackend } from "./interface.js";
import { createBitbucketBackend, apiTokenAuth as bitbucketApiTokenAuth } from "./bitbucket/bitbucket-backend.js";
import { createGitHubBackend, tokenAuth } from "./github/github-backend.js";

export type GitHostKind = "bitbucket" | "github";
export const GIT_HOST_KINDS: readonly GitHostKind[] = ["bitbucket", "github"];

/** The credential variables each host needs, in the order they are asked for. */
export const GIT_HOST_SECRET_KEYS: Record<GitHostKind, readonly string[]> = {
    bitbucket: ["BITBUCKET_EMAIL", "BITBUCKET_API_TOKEN"],
    github: ["GITHUB_TOKEN"],
};

/** Every git-host credential variable, for keeping them out of a check command's environment. */
export const ALL_GIT_HOST_SECRET_KEYS: readonly string[] = [...GIT_HOST_SECRET_KEYS.bitbucket, ...GIT_HOST_SECRET_KEYS.github, "GH_TOKEN"];

export function parseGitHostKind(value: string): GitHostKind | null {
    const v = value.trim().toLowerCase();
    return (GIT_HOST_KINDS as readonly string[]).includes(v) ? (v as GitHostKind) : null;
}

/**
 * `TAI_GIT_HOST` when set (an unknown value is an error, not a guess), else the host of
 * `origin`, else Bitbucket.
 */
export async function resolveGitHostKind(
    env: NodeJS.ProcessEnv,
    detectOrigin: () => Promise<GitHostKind | null>
): Promise<GitHostKind> {
    const configured = env["TAI_GIT_HOST"];
    if (configured !== undefined && configured.trim() !== "") {
        const kind = parseGitHostKind(configured);
        if (!kind) throw new Error(`TAI_GIT_HOST is "${configured}" -- expected one of: ${GIT_HOST_KINDS.join(", ")}.`);
        return kind;
    }
    return (await detectOrigin()) ?? "bitbucket";
}

/** True when the credentials `kind` needs are all set. */
export function hasGitHostCredentials(kind: GitHostKind, env: NodeJS.ProcessEnv): boolean {
    return GIT_HOST_SECRET_KEYS[kind].every((key) => Boolean(env[key]));
}

/** `TAI_PR_SELF_REVIEW` (TAI-583 ADR decision 1). */
export function selfReviewAllowed(env: NodeJS.ProcessEnv): boolean {
    return (env["TAI_PR_SELF_REVIEW"] ?? "").trim().toLowerCase() === "true";
}

export interface GitHostSession {
    readonly kind: GitHostKind;
    readonly backend: GitHostBackend;
    /**
     * The email of the human behind these credentials, for matching the PR Reviewers page. On
     * Bitbucket it is `BITBUCKET_EMAIL`; a GitHub token carries none, so it is the current human's
     * own email (`TAI_JIRA_EMAIL`, or `TAI_HUMAN_EMAIL` on the filesystem backend).
     */
    readonly email: string | undefined;
}

/**
 * The backend for `kind`, from the environment. Throws, naming the variable, when a required
 * credential is missing. `currentHumanEmail` is used on GitHub only.
 */
export function createGitHostSession(kind: GitHostKind, env: NodeJS.ProcessEnv, currentHumanEmail?: string): GitHostSession {
    const missing = GIT_HOST_SECRET_KEYS[kind].find((key) => !env[key]);
    if (missing) throw new Error(`Missing required environment variable ${missing} (TAI_GIT_HOST is ${kind}).`);
    if (kind === "github") {
        return {
            kind,
            backend: createGitHubBackend({ auth: tokenAuth(env["GITHUB_TOKEN"]!), allowSelfReview: selfReviewAllowed(env) }),
            email: currentHumanEmail,
        };
    }
    return {
        kind,
        backend: createBitbucketBackend({ auth: bitbucketApiTokenAuth(env["BITBUCKET_EMAIL"]!, env["BITBUCKET_API_TOKEN"]!) }),
        email: env["BITBUCKET_EMAIL"],
    };
}
