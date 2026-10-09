/**
 * TAI Framework — "Rebase needed:" comment marker (TAI-217/219)
 *
 * A system-posted status marker, not a human checkpoint decision (contrast
 * `comment-markers.ts`'s `Q:`/`Approved:`/`Rejected:`, which ARE human decisions):
 * automatically posted by `git-pr merge`'s
 * conflict-rejection path (cli.ts), read back by `tai-ready` to flag the Dev subtask's Ready
 * Work line.
 *
 * Deliberately no paired "resolved" marker. The flag self-clears the same way readiness
 * itself already does elsewhere in this codebase: once the Dev subtask actually reaches
 * `Status.Done` (the PR merges — whether via a later `git-pr merge` succeeding, or an
 * out-of-band Bitbucket-side merge caught by `ready.ts`'s existing `syncMergedDevSubtasks`),
 * it drops out of Ready Work entirely and the marker stops mattering. A second conflict after
 * a first rebase just posts a second `Rebase needed:` comment — still correctly flagged, no
 * counting or "latest wins" resolution needed, since presence alone is the whole signal.
 */

import type { Issue } from "./interface.js";

export const REBASE_NEEDED_MARKER = "Rebase needed:";

/** The comment body `git-pr merge` posts on a conflict rejection. */
export function rebaseNeededCommentBody(prUrl: string): string {
    return (
        `${REBASE_NEEDED_MARKER} this PR has merge conflicts against its destination branch — ` +
        `rebase and push before it can be merged. If it was already approved, that approval ` +
        `predates this conflict; re-review the rebased diff before approving again ` +
        `(\`git-pr unapprove\` clears the stale approval).\n\n${prUrl}`
    );
}

/** True if this issue has an outstanding `Rebase needed:` marker — see the module doc
 *  comment for why "any occurrence" is the whole check (no latest-wins/resolved-marker
 *  logic needed). */
export function hasUnresolvedRebaseMarker(issue: Issue): boolean {
    return issue.comments.some((c) => c.body.startsWith(REBASE_NEEDED_MARKER));
}
