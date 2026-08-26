/**
 * TAI Framework — one-per-story-instance duplicate-subtask guard (TAI-226/227/228)
 *
 * `story-schema.ts` already documents the invariant `materializePrecedenceLinks` relies on:
 * "a story instance has at most one subtask of a given fixed-owner type present" (brief
 * §5.3). Nothing enforced it at CREATE time before this — found live (TAI-192 work,
 * 2026-08-26) when a second `dev` subtask (TAI-224) was created under a story that already
 * had one (TAI-193, Done). `createIssue` accepted it silently.
 *
 * A SINGLE shared implementation, imported by every backend's `createIssue` — same posture
 * as `assignment-gate.ts` for `transition()`/`assignIssue()`/`updateIssue()`: one copy, both
 * backends import it, so the check and its rejection message can't drift apart between them.
 *
 * Decided (ADR, Confluence page 29720577, linked to TAI-227/228):
 * - Hard-blocks against ANY existing sibling of the same type, regardless of its status
 *   (Done/Canceled siblings still block — this is what actually failed for TAI-224/193).
 * - Explicit `CreateIssueInput.allowDuplicate: true` opts out, for a genuine redo.
 * - Scope is every `SubtaskType` where `SUBTASK_OWNER[type] !== null` — reuses that existing
 *   "no fixed default owner" signal (currently only `SpikeTask`) as the exemption list,
 *   rather than a second, separately-maintained list that could drift out of sync.
 */

import { SUBTASK_OWNER, type SubtaskType } from "../schema/story-schema.js";
import type { Issue, IssueKey } from "./interface.js";

/** True if `type` is exempt from the one-per-story-instance guard (no fixed default owner
 *  — currently only `SpikeTask`, which is explicitly ad-hoc/multi-instance by design). */
export function isExemptFromDuplicateGate(type: SubtaskType): boolean {
    return SUBTASK_OWNER[type] === null;
}

/** Rejection message for a blocked duplicate create — names the existing sibling and its
 *  status so the caller can tell at a glance whether `allowDuplicate: true` is warranted. */
export function duplicateSubtaskGateReason(parentKey: IssueKey, type: SubtaskType, existing: Issue): string {
    return (
        `Cannot create a second "${type}" subtask under ${parentKey} -- ${existing.key} ` +
        `(${existing.status}) already exists. Pass allowDuplicate: true on the create call ` +
        `if this is a deliberate redo.`
    );
}
