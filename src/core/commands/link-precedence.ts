/**
 * TAI Framework — materialize subtask precedence + story dependencies as real Jira
 * `Blocks`/`Relates` links (TAI-96)
 *
 * `SUBTASK_PRECEDENCE` and `StoryDependency`/`resolveStoryDependencies()` (story-schema.ts)
 * drive TAI's own internal orchestration/readiness computation, but neither one reaches
 * `WorkTracker.createLink()` on its own — a persona had to remember to also create the
 * matching real Jira link by hand (`workflows/dependencies.md`'s "Decided" section,
 * `personas/pm.md`'s WBS-assembly step). Gap found (2026-08-17) while wiring TAI-85's
 * TAI-87→TAI-92→TAI-93 chain manually. This closes it for both layers:
 *
 *   - Layer 2 (subtask precedence within one story): `materializePrecedenceLinks()` reads
 *     a story's current subtask set, computes the applicable edges via
 *     `resolveApplicablePrecedence()`, and creates any missing `Blocks` link per edge.
 *   - Layer 1 (cross-story `StoryDependency`): `materializeStoryDependencies()` takes the
 *     already-resolved output of `resolveStoryDependencies()` and creates the missing link
 *     per dependency. `resolveStoryDependencies()` itself has no other caller anywhere in
 *     `src/core` (confirmed by inspection) — it was still a fully manual step before this
 *     Story, exactly the open question this Story's scope named. This function is that
 *     wiring; a caller runs the dependency batch through `resolveStoryDependencies()` first,
 *     then hands the resolved array here.
 *
 * Both are idempotent by the same rule: check `getLinkedIssues()` first, skip an edge whose
 * link already exists rather than duplicating it — same dedup-before-create posture as
 * TAI-83's eager subtask creation.
 */

import {
    DependencyRelation,
    isStoryIssueType,
    isSubtaskIssueType,
    resolveApplicablePrecedence,
    type StoryType,
    type SubtaskType,
} from "../schema/story-schema.js";
import { toIssueKey, type IssueKey, type WorkTracker } from "../storage/interface.js";

export interface PrecedenceLinkResult {
    readonly before: SubtaskType;
    readonly after: SubtaskType;
    readonly beforeKey: IssueKey;
    readonly afterKey: IssueKey;
    readonly created: boolean; // false = the Blocks link already existed, left untouched
}

/**
 * Reads `storyKey`'s current subtask set, computes the applicable `SUBTASK_PRECEDENCE`
 * edges (both ends present on this instance), and creates any missing `Blocks` link per
 * edge — `after` depends on `before` (`createLink(after, DependsOn, before)`, matching
 * story-schema.ts's documented direction: `to` blocks `from`). Idempotent: an edge whose
 * link already exists is left alone, never recreated or duplicated.
 */
export async function materializePrecedenceLinks(
    workTracker: WorkTracker,
    storyKey: IssueKey
): Promise<readonly PrecedenceLinkResult[]> {
    const story = await workTracker.getIssue(storyKey);
    if (!story || !isStoryIssueType(story.issueType)) {
        throw new Error(`${storyKey} is not a Story-level ticket — no SUBTASK_PRECEDENCE graph applies.`);
    }

    const subtasks = (
        await workTracker.search({ projectKey: story.projectKey, parentKey: storyKey })
    ).filter((s) => isSubtaskIssueType(s.issueType));

    // A story instance has at most one subtask of a given fixed-owner type present
    // (brief §5.3) — first-seen wins in the pathological case that's ever violated,
    // rather than crashing on a data-integrity issue this command didn't cause.
    const keyByType = new Map<SubtaskType, IssueKey>();
    for (const s of subtasks) {
        const type = s.issueType as SubtaskType;
        if (!keyByType.has(type)) keyByType.set(type, s.key);
    }

    const edges = resolveApplicablePrecedence(story.issueType as StoryType, [...keyByType.keys()]);

    const results: PrecedenceLinkResult[] = [];
    for (const edge of edges) {
        const beforeKey = keyByType.get(edge.before)!;
        const afterKey = keyByType.get(edge.after)!;

        const existing = await workTracker.getLinkedIssues(afterKey, DependencyRelation.DependsOn, "outgoing");
        const created = !existing.some((l) => l.key === beforeKey);
        if (created) {
            await workTracker.createLink(afterKey, DependencyRelation.DependsOn, beforeKey);
        }
        results.push({ before: edge.before, after: edge.after, beforeKey, afterKey, created });
    }
    return results;
}

export interface ResolvedStoryDependency {
    readonly from: string;
    readonly relation: DependencyRelation;
    readonly to: string;
    readonly note?: string;
}

export interface StoryDependencyLinkResult {
    readonly from: IssueKey;
    readonly relation: DependencyRelation;
    readonly to: IssueKey;
    readonly created: boolean; // false = the link already existed, left untouched
}

/**
 * Wires `resolveStoryDependencies()`'s resolved output to `WorkTracker.createLink()` — the
 * Layer 1 half of this Story's scope. Idempotent, same dedup-before-create rule as
 * `materializePrecedenceLinks`. `RelatesTo` is symmetric (`getLinkedIssues` already
 * collapses direction for it), so the existence check below is correct for both relations
 * without special-casing either.
 */
export async function materializeStoryDependencies(
    workTracker: WorkTracker,
    dependencies: readonly ResolvedStoryDependency[]
): Promise<readonly StoryDependencyLinkResult[]> {
    const results: StoryDependencyLinkResult[] = [];
    for (const dep of dependencies) {
        const from = toIssueKey(dep.from);
        const to = toIssueKey(dep.to);

        const existing = await workTracker.getLinkedIssues(from, dep.relation, "outgoing");
        const created = !existing.some((l) => l.key === to);
        if (created) {
            await workTracker.createLink(from, dep.relation, to);
        }
        results.push({ from, relation: dep.relation, to, created });
    }
    return results;
}
