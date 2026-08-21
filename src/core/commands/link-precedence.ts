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
import { toIssueKey, type Issue, type IssueKey, type WorkTracker } from "../storage/interface.js";

export interface PrecedenceLinkResult {
    readonly before: SubtaskType;
    readonly after: SubtaskType;
    readonly beforeKey: IssueKey;
    readonly afterKey: IssueKey;
    readonly created: boolean; // false = the Blocks link already existed, left untouched
}

export interface MaterializePrecedenceLinksResult {
    readonly results: readonly PrecedenceLinkResult[];
    /** Non-null when the subtask count returned by `search()` was still changing across
     *  every retry attempt — see `ConsistencyRetryOptions` below. A persona seeing this
     *  should re-run `link-precedence` rather than assume `results` reflects every
     *  subtask that was actually created. */
    readonly warning: string | null;
}

/**
 * `attempts`/`delayMs` for the eventual-consistency retry below (TAI-118). Jira Cloud's
 * search index is eventually consistent — a subtask created moments ago can be briefly
 * invisible to `search()` (confirmed live, TAI-100: first poll empty, second poll ~5s
 * later saw both). `link-precedence` is explicitly meant to be run once, immediately
 * after front-loading a story's subtask set (TAI-96's own scope note) — exactly the
 * window this lag hits. `attempts: 1` (the default) is today's original one-shot
 * behavior, unchanged for any caller that doesn't opt in.
 */
export interface ConsistencyRetryOptions {
    readonly attempts?: number;
    readonly delayMs?: number;
}

const DEFAULT_RETRY: Required<ConsistencyRetryOptions> = { attempts: 1, delayMs: 0 };

/**
 * Polls `search()` for `storyKey`'s subtasks, retrying while the returned count keeps
 * changing between consecutive polls (evidence the search index hasn't caught up yet) —
 * mirrors `link-precedence.integration.test.ts`'s own `waitForSubtasks` wait pattern, but
 * without that test's luxury of knowing an expected count up front: this stops as soon as
 * two consecutive polls agree, rather than waiting for a specific target. If the count is
 * still changing when `attempts` is exhausted, the last poll's result is used anyway
 * (best effort) and a warning is returned instead of silently claiming completeness.
 */
async function searchSubtasksWithRetry(
    workTracker: Pick<WorkTracker, "search">,
    projectKey: string,
    storyKey: IssueKey,
    retryOptions?: ConsistencyRetryOptions
): Promise<{ subtasks: readonly Issue[]; warning: string | null }> {
    const { attempts, delayMs } = { ...DEFAULT_RETRY, ...retryOptions };

    let previous = await workTracker.search({ projectKey, parentKey: storyKey });
    for (let attempt = 1; attempt < attempts; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const current = await workTracker.search({ projectKey, parentKey: storyKey });
        if (current.length === previous.length) return { subtasks: current, warning: null };
        previous = current;
    }
    const warning =
        attempts > 1
            ? `Subtask count under ${storyKey} was still changing across ${attempts} search() polls — Jira's ` +
              `search index can be eventually consistent right after subtask creation (TAI-100/TAI-118). Some ` +
              `precedence links may not have been materialized — re-run link-precedence for ${storyKey} to catch ` +
              `any that were missed.`
            : null;
    return { subtasks: previous, warning };
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
    storyKey: IssueKey,
    retryOptions?: ConsistencyRetryOptions
): Promise<MaterializePrecedenceLinksResult> {
    const story = await workTracker.getIssue(storyKey);
    if (!story || !isStoryIssueType(story.issueType)) {
        throw new Error(`${storyKey} is not a Story-level ticket — no SUBTASK_PRECEDENCE graph applies.`);
    }

    const { subtasks: found, warning } = await searchSubtasksWithRetry(
        workTracker,
        story.projectKey,
        storyKey,
        retryOptions
    );
    const subtasks = found.filter((s) => isSubtaskIssueType(s.issueType));

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
    return { results, warning };
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
