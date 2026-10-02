/**
 * TAI Framework — label validity gate for `updateIssue({ labels })` (TAI-379 review)
 *
 * Jira rejects a label containing whitespace ("The label 'has space' can't contain spaces",
 * 400 -- reproduced live on TAIT). A SINGLE shared check imported by both backends, so the
 * filesystem backend can't accept what Jira would refuse -- the TAI-15-style divergence the
 * shared gates (`reparent-gate.ts`, `assignment-gate.ts`) exist to prevent.
 */

/** A rejection reason, or `null` when every label is acceptable. An empty or whitespace-only
 *  label is rejected too: Jira accepts it but silently drops it (verified live on TAIT), while
 *  the filesystem backend would store it -- so rejecting is the only way to keep them aligned.
 *  The CLI parser already drops empty entries, so only programmatic callers can hit this. */
export function labelViolation(labels: readonly string[]): string | null {
    if (labels.some((l) => l.trim() === "")) return "A label can't be empty.";
    const bad = labels.find((l) => /\s/.test(l));
    return bad === undefined ? null : `The label "${bad}" can't contain spaces.`;
}
