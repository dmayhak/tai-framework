/**
 * TAI Framework — pages edited after their Kickoff was approved (TAI-481; human decision TAI-455, row 7)
 *
 * A Kickoff's `Approved:` comments say something about the pages as they were when it was approved.
 * A later edit to one of those pages does NOT reopen the gate: nothing is blocked and no re-approval
 * is required. It is only made visible, in `/tai-ready` and `/tai-groom`, so a human can decide
 * whether the change matters.
 *
 * Read-only. Looks at Done Kickoff Stories (the gate is enforced on the move to Done) whose Epic is
 * still open — once the Epic is closed nothing downstream depends on those pages any more — and
 * compares each linked page's last update with the latest `Approved:` comment on the Kickoff.
 */

import { Status, StoryType } from "../schema/story-schema.js";
import { parseCommentMarkers } from "../storage/comment-markers.js";
import type { DocStore, Issue, IssueKey, PageId, WorkTracker } from "../storage/interface.js";
import { mapWithLimit } from "./groom.js";

export interface EditedAfterApproval {
    readonly kickoffKey: IssueKey;
    readonly kickoffSummary: string;
    readonly pageId: PageId;
    readonly pageTitle: string;
    /** ISO 8601: the latest `Approved:` comment on the Kickoff. */
    readonly approvedAt: string;
    /** ISO 8601: the page's last update, later than `approvedAt`. */
    readonly editedAt: string;
}

export interface EditedAfterApprovalDeps {
    readonly workTracker: Pick<WorkTracker, "search" | "getIssue" | "getLinkedPages">;
    readonly docStore: Pick<DocStore, "getPage">;
    readonly projectKey: string;
    /** Limits the check to one Epic's Kickoff (`/tai-groom <EPIC-KEY>`). */
    readonly epicKey?: IssueKey;
}

const OPEN: readonly Status[] = [Status.Backlog, Status.ToDo, Status.InProgress, Status.InReview];
const READ_CONCURRENCY = 5;

/** The latest `Approved:` comment's time on `issue` (an edited comment counts from its edit), or `null`. */
export function latestApprovalAt(issue: Pick<Issue, "comments">): string | null {
    const times = parseCommentMarkers(issue.comments)
        .filter((m) => m.kind === "Approved")
        .map((m) => m.comment.updatedAt || m.comment.createdAt);
    return times.length === 0 ? null : times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

export async function findEditedAfterApproval(deps: EditedAfterApprovalDeps): Promise<EditedAfterApproval[]> {
    const { workTracker, docStore, projectKey } = deps;
    const [epics, kickoffs] = await Promise.all([
        workTracker.search({ projectKey, issueTypes: ["epic"], statuses: OPEN, exhaustive: true }),
        workTracker.search({ projectKey, issueTypes: [StoryType.Kickoff], statuses: [Status.Done], exhaustive: true }),
    ]);
    const openEpics = new Set(epics.map((e) => e.key));
    const inScope = kickoffs.filter((k) => k.parentKey && openEpics.has(k.parentKey) && (!deps.epicKey || k.parentKey === deps.epicKey));

    const perKickoff = await mapWithLimit(inScope, READ_CONCURRENCY, async (found): Promise<EditedAfterApproval[]> => {
        // A search result is not guaranteed to carry comments; the gate's own evidence is read fresh.
        const kickoff = (await workTracker.getIssue(found.key)) ?? found;
        const approvedAt = latestApprovalAt(kickoff);
        if (!approvedAt) return [];
        const edited: EditedAfterApproval[] = [];
        for (const pageId of await workTracker.getLinkedPages(kickoff.key)) {
            const page = await docStore.getPage({ id: pageId });
            if (page && Date.parse(page.updatedAt) > Date.parse(approvedAt)) {
                edited.push({ kickoffKey: kickoff.key, kickoffSummary: kickoff.summary, pageId: page.id, pageTitle: page.title, approvedAt, editedAt: page.updatedAt });
            }
        }
        return edited;
    });
    return perKickoff.flat();
}

/** Never lets this informational check break the command that shows it. */
export async function tryFindEditedAfterApproval(deps: EditedAfterApprovalDeps): Promise<EditedAfterApproval[]> {
    try {
        return await findEditedAfterApproval(deps);
    } catch {
        return [];
    }
}

const day = (iso: string): string => iso.slice(0, 10);

/** The information section for `/tai-ready` and `/tai-groom`, or `undefined` when there is nothing to show. */
export function renderEditedAfterApproval(edited: readonly EditedAfterApproval[]): string | undefined {
    if (edited.length === 0) return undefined;
    const lines = ["## Pages edited after their Kickoff was approved", "", "For information: nothing is blocked and no gate reopens. Tell the human, who decides whether the change matters.", ""];
    const byKickoff = new Map<IssueKey, EditedAfterApproval[]>();
    for (const e of edited) byKickoff.set(e.kickoffKey, [...(byKickoff.get(e.kickoffKey) ?? []), e]);
    for (const [key, pages] of byKickoff) {
        lines.push(`- **${key}** ${pages[0]!.kickoffSummary} — approved ${day(pages[0]!.approvedAt)}`);
        for (const p of pages) lines.push(`  - "${p.pageTitle}" (page ${p.pageId}) edited ${day(p.editedAt)}`);
    }
    return lines.join("\n");
}
