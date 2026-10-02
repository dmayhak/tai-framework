/**
 * TAI Framework — label validity gate for `updateIssue({ labels })` (TAI-379 review)
 *
 * Jira rejects a label containing whitespace ("The label 'has space' can't contain spaces",
 * 400 -- reproduced live on TAIT). A SINGLE shared check imported by both backends, so the
 * filesystem backend can't accept what Jira would refuse -- the TAI-15-style divergence the
 * shared gates (`reparent-gate.ts`, `assignment-gate.ts`) exist to prevent.
 */

/** A rejection reason, or `null` when every label is acceptable. */
export function labelViolation(labels: readonly string[]): string | null {
    const bad = labels.find((l) => /\s/.test(l));
    return bad === undefined ? null : `The label "${bad}" can't contain spaces.`;
}
