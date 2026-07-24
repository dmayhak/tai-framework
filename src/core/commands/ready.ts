/**
 * TAI Framework — `/tai_ready [persona]` command core (TAI-61 ADR)
 *
 * Root `status.json` (`rollupStatus`) is a **display index only** (brief §7: "purely a
 * rollup/index, never authoritative") — readiness itself is computed live here, per brief
 * §3.6's refresh-point rule, never read off the cached rollup:
 *
 *   1. `search({ persona, statuses: OPEN_STATUSES })` — a coarse pre-filter (right persona,
 *      not yet closed). Story-level tickets (Kickoff/Story/Bug/Spike) have no precedence
 *      gate of their own (brief §5.3) and are trivially ready once open.
 *   2. For a subtask candidate, `isSubtaskReady()` against its parent's actual present/done
 *      subtask sets is the real gate — one `search({ parentKey })` per distinct parent
 *      (siblings share a parent, so this batches naturally rather than querying per subtask).
 *
 * `rollupStatus()`'s in-flight items are still surfaced alongside the ready list, as display
 * context (what's already being worked), not as part of the readiness computation.
 */

import {
    Status,
    StoryType,
    SubtaskType,
    isSubtaskReady,
    type Persona,
} from "../schema/story-schema.js";
import { DEFAULT_SEARCH_LIMIT, type Issue, type IssueKey, type WorkTracker } from "../storage/interface.js";
import { rollupStatus, type RootStatusRollup } from "../workspace/status.js";

const OPEN_STATUSES: readonly Status[] = [Status.ToDo, Status.InProgress, Status.InReview];

const STORY_TYPE_VALUES: ReadonlySet<string> = new Set(Object.values(StoryType));
const SUBTASK_TYPE_VALUES: ReadonlySet<string> = new Set(Object.values(SubtaskType));

function isSubtaskIssueType(issueType: Issue["issueType"]): issueType is SubtaskType {
    return SUBTASK_TYPE_VALUES.has(issueType);
}

function isStoryIssueType(issueType: Issue["issueType"]): issueType is StoryType {
    return STORY_TYPE_VALUES.has(issueType);
}

export interface FindReadyWorkDeps {
    readonly workTracker: WorkTracker;
    readonly taiRoot: string;
    readonly projectKey: string;
}

export interface ReadyWorkResult {
    readonly ready: readonly Issue[];
    /** Display context only — what's already in flight, per the root status rollup. */
    readonly inFlight: RootStatusRollup;
}

interface ParentPrecedenceContext {
    readonly storyType: StoryType;
    readonly presentSubtaskTypes: SubtaskType[];
    readonly doneSubtaskTypes: Set<SubtaskType>;
}

async function loadParentPrecedenceContext(
    workTracker: WorkTracker,
    projectKey: string,
    parentKey: IssueKey
): Promise<ParentPrecedenceContext | null> {
    const parent = await workTracker.getIssue(parentKey);
    if (!parent || !isStoryIssueType(parent.issueType)) {
        // No parent, or a parent that isn't a Story-level ticket (e.g. an Epic) — no
        // SUBTASK_PRECEDENCE graph applies. Conservatively not "ready" via this path rather
        // than guessing; a data-integrity gap here is worth surfacing, not silently papering
        // over.
        return null;
    }
    const siblings = await workTracker.search({ projectKey, parentKey, limit: DEFAULT_SEARCH_LIMIT });
    const presentSubtaskTypes = siblings.filter((s) => isSubtaskIssueType(s.issueType)).map((s) => s.issueType as SubtaskType);
    const doneSubtaskTypes = new Set(
        siblings
            .filter((s) => isSubtaskIssueType(s.issueType) && (s.status === Status.Done || s.status === Status.Canceled))
            .map((s) => s.issueType as SubtaskType)
    );
    return { storyType: parent.issueType, presentSubtaskTypes, doneSubtaskTypes };
}

/**
 * Finds work that's actually ready to start, optionally scoped to one persona. `persona`
 * omitted means "ready for anyone."
 */
export async function findReadyWork(deps: FindReadyWorkDeps, persona?: Persona): Promise<ReadyWorkResult> {
    const candidates = await deps.workTracker.search({
        projectKey: deps.projectKey,
        ...(persona ? { persona } : {}),
        statuses: OPEN_STATUSES,
        limit: DEFAULT_SEARCH_LIMIT,
    });

    const ready: Issue[] = [];
    const parentContexts = new Map<IssueKey, ParentPrecedenceContext | null>();

    for (const issue of candidates) {
        if (!isSubtaskIssueType(issue.issueType)) {
            // Story-level ticket — no precedence gate of its own (brief §5.3), trivially
            // ready once it's open and matches the persona filter.
            ready.push(issue);
            continue;
        }
        if (!issue.parentKey) continue; // malformed data — skip rather than crash

        let ctx = parentContexts.get(issue.parentKey);
        if (ctx === undefined) {
            ctx = await loadParentPrecedenceContext(deps.workTracker, deps.projectKey, issue.parentKey);
            parentContexts.set(issue.parentKey, ctx);
        }
        if (!ctx) continue;

        if (isSubtaskReady(issue.issueType, ctx.storyType, ctx.presentSubtaskTypes, ctx.doneSubtaskTypes)) {
            ready.push(issue);
        }
    }

    const inFlight = await rollupStatus(deps.taiRoot);
    return { ready, inFlight };
}
