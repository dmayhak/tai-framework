/**
 * TAI Framework — staleness detection for living docs (TAI-302/319 ADR)
 *
 * A "living doc" (brief §4: `project-home` / `architecture-overview` `confluenceOutputs`
 * types — see `personas/analyst.md`/`architect.md`) is a single page per project, refreshed
 * periodically/on-demand rather than written once. "Periodic/on-demand" (TAI-280/300) had no
 * real trigger, staleness definition, or update command behind it — this fills that gap for
 * the Home Page's Epic-status table specifically (brief §4's own "generalize, don't build
 * TAI-specific" principle, TAI-317 — the mechanism below isn't Home-Page-named, but only the
 * Epic-summary case is actually wired up; Architecture Overview's own staleness signal is a
 * different question — codebase change, not Jira-issue change — and is NOT this file's scope).
 *
 * DESIGN (human-confirmed, TAI-319 ADR): staleness is NOT "did the underlying Jira data
 * change since some timestamp" — that fires constantly during ordinary active work (a child
 * Story moving between In Progress/In Review is not something a reader of an Epic-level
 * summary row would ever see reflected either way) and would make the signal useless noise.
 * Instead: does the page's own last-WRITTEN summary of an Epic still match what a FRESH
 * computation of that same summary would produce right now? A snapshot of the computed
 * summary is captured whenever a persona finishes updating the page (`doc snapshot-living-doc`
 * CLI command); this module diffs a fresh computation against that snapshot, not against raw
 * Jira fields. No prior snapshot at all is NOT itself a staleness signal (same "absence isn't
 * evidence of drift" posture as `issue-cache.ts`'s `cacheIssue`) — it just means nothing has
 * been captured yet to compare against.
 */

import { Status, StoryType } from "../schema/story-schema.js";
import type { Issue, IssueKey } from "../storage/interface.js";
import { livingDocSnapshotPath, readJsonFile, writeJsonFile } from "../cache/paths.js";

/** Direct Story/Bug/Kickoff/Spike children of an Epic — the granularity a Home Page reader
 *  actually cares about (not their own subtasks). */
const STORY_LEVEL_TYPES: readonly StoryType[] = [StoryType.Kickoff, StoryType.Spike, StoryType.Story, StoryType.Bug];
export const EPIC_CHILD_ISSUE_TYPES = STORY_LEVEL_TYPES;

/** Status.Canceled counts as satisfied for this tally too — same "terminal, not still open"
 *  treatment `story-schema.ts` already gives it for SUBTASK_PRECEDENCE purposes. */
function isChildDone(status: Status): boolean {
    return status === Status.Done || status === Status.Canceled;
}

/** The computed, structured "what would this Epic's row currently say" value — the thing
 *  actually diffed, never the page's free-form prose (which this module never parses). */
export interface EpicSummary {
    readonly epicKey: IssueKey;
    readonly status: Status;
    readonly childTotal: number;
    readonly childDone: number;
}

export function computeEpicSummary(epic: Issue, children: readonly Issue[]): EpicSummary {
    return {
        epicKey: epic.key,
        status: epic.status,
        childTotal: children.length,
        childDone: children.filter((c) => isChildDone(c.status)).length,
    };
}

export interface LivingDocSnapshot {
    readonly generatedAt: string;
    readonly epics: readonly EpicSummary[];
}

export async function readLivingDocSnapshot(
    taiRoot: string,
    projectKey: string,
    outputType: string
): Promise<LivingDocSnapshot | null> {
    return readJsonFile<LivingDocSnapshot>(livingDocSnapshotPath(taiRoot, projectKey, outputType));
}

/** Run by a persona right after it finishes writing/updating the living doc's actual page
 *  content — records "this is now the truth as of now," the baseline future checks diff
 *  against. Deliberately decoupled from the Confluence page itself (no page-ID linkage, no
 *  content parsing) — simpler and more robust than trying to read the rendered page back. */
export async function writeLivingDocSnapshot(
    taiRoot: string,
    projectKey: string,
    outputType: string,
    epics: readonly EpicSummary[]
): Promise<LivingDocSnapshot> {
    const snapshot: LivingDocSnapshot = { generatedAt: new Date().toISOString(), epics };
    await writeJsonFile(livingDocSnapshotPath(taiRoot, projectKey, outputType), snapshot);
    return snapshot;
}

export interface StaleEpic {
    readonly epicKey: IssueKey;
    readonly reason: string;
}

/** Pure comparison — no I/O. `null` snapshot (nothing captured yet) yields no findings,
 *  same "absence isn't a signal" posture as the rest of the caching layer. A brand-new Epic
 *  not present in the snapshot at all is flagged too (the page doesn't mention it yet) — that
 *  IS something a reader would notice missing, unlike an unrelated child status flip. */
export function diffLivingDocSnapshot(
    current: readonly EpicSummary[],
    snapshot: LivingDocSnapshot | null
): readonly StaleEpic[] {
    if (!snapshot) return [];

    const stale: StaleEpic[] = [];
    for (const c of current) {
        const prior = snapshot.epics.find((e) => e.epicKey === c.epicKey);
        if (!prior) {
            stale.push({ epicKey: c.epicKey, reason: "not yet on the page" });
        } else if (prior.status !== c.status) {
            stale.push({ epicKey: c.epicKey, reason: `status: ${prior.status} → ${c.status}` });
        } else if (prior.childDone !== c.childDone || prior.childTotal !== c.childTotal) {
            stale.push({
                epicKey: c.epicKey,
                reason: `${prior.childDone}/${prior.childTotal} → ${c.childDone}/${c.childTotal} stories done`,
            });
        }
    }
    return stale;
}
