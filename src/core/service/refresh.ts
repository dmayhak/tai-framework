/**
 * TAI Framework — bringing the service's own clone up to date before a run (Epic TAI-763, Story TAI-770).
 *
 * `git fetch --prune` always; then main is fast-forwarded only when the tree is clean and on main. A tree holding a paused ticket's
 * cut-off work, or a branch under way, is left alone: a hard reset would destroy it, and the run's own resume logic takes it from there.
 * Git is injected, so the rules are tested without a repository.
 */

export interface ClonePosition {
    readonly branch: string;
    readonly defaultBranch: string;
    /** No uncommitted changes (tracked or untracked, apart from what git ignores). */
    readonly clean: boolean;
}

export interface RefreshGit {
    readonly fetchPrune: () => Promise<void>;
    readonly position: () => Promise<ClonePosition>;
    readonly fastForward: (defaultBranch: string) => Promise<void>;
}

export type RefreshOutcome =
    | { readonly action: "fast-forwarded"; readonly branch: string }
    | { readonly action: "left-alone"; readonly why: string }
    | { readonly action: "failed"; readonly why: string };

export async function refreshClone(git: RefreshGit): Promise<RefreshOutcome> {
    try {
        await git.fetchPrune();
        const where = await git.position();
        if (!where.clean) return { action: "left-alone", why: `the working tree has uncommitted changes (on ${where.branch}), which may be a paused ticket's work` };
        if (where.branch !== where.defaultBranch) return { action: "left-alone", why: `the clone is on ${where.branch}, not ${where.defaultBranch}, which may be a branch under way` };
        await git.fastForward(where.defaultBranch);
        return { action: "fast-forwarded", branch: where.defaultBranch };
    } catch (e) {
        return { action: "failed", why: e instanceof Error ? e.message : String(e) };
    }
}
