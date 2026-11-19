/**
 * TAI Framework — the cheap checks before the unattended Dev service starts a model run (Epic TAI-763, Story TAI-770).
 *
 * A failed preflight starts no run and names the FIRST missing piece with the command that fixes it. This file holds the checks that
 * need no network and no Jira: not an AI session, the clone is there, its `.env` is there, and the credentials it holds, by role.
 * The checks that read Jira (DEV-YOLO setting, Autonomy admins, attestation) and the permission rules run in the clone itself
 * (`tai service check`), because they need the clone's own configuration; `checkFailure` turns that command's answer into the same shape.
 */

export type CredentialRole = "jira" | "git-host" | "reviewer" | "merge";

export type Env = Readonly<Record<string, string | undefined>>;

const present = (env: Env, name: string): boolean => (env[name] ?? "").trim() !== "";

/**
 * The environment variables each role needs, as the clone's `.env` must hold them. Today one run does dev, review and merge, so the
 * service's `.env` carries all of them. The roles are named apart so a later container (Epic TAI-754) can be given fewer of them
 * and be checked for fewer. The `merge` role is the git host's own token today, the same variables as `git-host`; they are
 * listed separately so the message can say which power is missing once the two come apart.
 */
export function credentialVariables(role: CredentialRole, env: Env): readonly string[] {
    switch (role) {
        case "jira":
            return ["TAI_JIRA_SITE_URL", "TAI_JIRA_EMAIL", "TAI_JIRA_API_TOKEN"];
        case "git-host":
        case "merge":
            return (env["TAI_GIT_HOST"] ?? "").trim().toLowerCase() === "github" ? ["GITHUB_TOKEN"] : ["BITBUCKET_EMAIL", "BITBUCKET_API_TOKEN"];
        case "reviewer":
            return ["TAI_REVIEWER_GITHUB_TOKEN", "TAI_REVIEWER_EMAIL"];
    }
}

const ROLE_ORDER: readonly CredentialRole[] = ["jira", "git-host", "reviewer", "merge"];

/** The first role with a variable missing, and which ones, or null when every role is complete. */
export function missingCredential(env: Env): { readonly role: CredentialRole; readonly variables: readonly string[] } | null {
    for (const role of ROLE_ORDER) {
        const missing = credentialVariables(role, env).filter((name) => !present(env, name));
        if (missing.length > 0) return { role, variables: missing };
    }
    return null;
}

export interface LocalPreflightFacts {
    /** Run from an AI session (Claude Code or Gemini CLI markers in the environment). */
    readonly aiSession: boolean;
    readonly clonePath: string;
    readonly cloneIsGitRepo: boolean;
    readonly envFileFound: boolean;
    /** The clone's `.env` laid over the process environment, as the run will see it. */
    readonly env: Env;
}

/** The first thing missing before any Jira read, as one sentence that names the fix; null when none of these checks fails. */
export function localPreflightFailure(facts: LocalPreflightFacts): string | null {
    if (facts.aiSession) {
        return "this is an AI session, which the unattended run refuses: run `tai service run` from a plain terminal, or let the timer start it";
    }
    if (!facts.cloneIsGitRepo) {
        return `the clone ${facts.clonePath} is missing or is not a git repository: make it with \`git clone <remote> ${facts.clonePath}\` (\`tai service setup\` will do this)`;
    }
    if (!facts.envFileFound) {
        return `the clone has no .env (${facts.clonePath}/.env): write it in your own editor with the credentials the unattended run needs`;
    }
    const gap = missingCredential(facts.env);
    if (gap) {
        return `the ${gap.role} credential is incomplete in ${facts.clonePath}/.env: ${gap.variables.join(", ")} ${gap.variables.length === 1 ? "is" : "are"} not set`;
    }
    return null;
}

/** The first reason `tai service check` gave in the clone, or null when it passed. */
export function checkFailure(result: { readonly ok: boolean; readonly reasons: readonly string[] }): string | null {
    return result.ok ? null : (result.reasons[0] ?? "the check in the clone failed without saying why");
}
