/**
 * TAI Framework — briefing.md assembly (brief §3.6; TAI-56 ADR decision 4; TAI-77 ADR)
 *
 * Combines a subtask, its immediate parent, the Confluence pages linked to EITHER, and the
 * tickets EITHER `RelatesTo`/`DependsOn` (TAI-77 ADR decisions 1-4) into one aggregated
 * markdown file — "the parent's own linked docs necessarily come along... this is how a
 * subtask's briefing gets its ADR/PRD/schema-notes/etc. at all" (brief §3.6), extended by
 * TAI-77 to ticket links: "if A relates to B, working on A means reading B"
 * (`workflows/dependencies.md`). A linked ticket's OWN linked pages are unioned in too
 * (TAI-77 ADR decision 5) — a linked ticket's substantive content is often a linked ADR/PRD,
 * not its Jira description, same reason the parent's own linked pages are included at all.
 *
 * Bounded exactly as already decided: immediate parent only (no Epic), one hop only in
 * every dimension — no transitive page-to-page, ticket-to-ticket, or ticket-to-page-of-a-
 * linked-ticket's-own-links following. `direction: "outgoing"` only for ticket links: what
 * this ticket needs to read, not who's waiting on it (that's an orchestrator/readiness
 * concern, out of scope here — TAI-77 ADR decision 4).
 *
 * A plain string-building function, not a templating library — matches this codebase's
 * existing "hand-roll it" style for markdown generation (`storage/jira/storage-format.ts`'s
 * own converter).
 */

import { DependencyRelation } from "../schema/story-schema.js";
import type { DocStore, Issue, IssueKey, IssueLink, Page, PageId, WorkTracker } from "../storage/interface.js";
import { refreshIssue } from "../cache/issue-cache.js";
import { refreshPage } from "../cache/page-cache.js";
import { briefingPath } from "../cache/paths.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Refreshes the subtask, its immediate parent (if any), and every Confluence page linked to
 * either, renders `briefing.md`, writes it to `.tai/work/<project>/<subtaskKey>/briefing.md`,
 * and returns the rendered markdown. Throws if the subtask itself can't be found — there's
 * nothing to brief on.
 */
export async function generateBriefing(
    workTracker: WorkTracker,
    docStore: DocStore,
    taiRoot: string,
    projectKey: string,
    subtaskKey: IssueKey
): Promise<string> {
    const subtask = await refreshIssue(workTracker, taiRoot, projectKey, subtaskKey);
    if (!subtask) {
        throw new Error(`Cannot generate a briefing for ${subtaskKey}: issue not found.`);
    }
    const parent = subtask.parentKey ? await refreshIssue(workTracker, taiRoot, projectKey, subtask.parentKey) : null;

    const pageIds = new Set<PageId>(await workTracker.getLinkedPages(subtask.key));
    if (parent) {
        for (const pageId of await workTracker.getLinkedPages(parent.key)) pageIds.add(pageId);
    }

    // TAI-77 ADR decisions 3/4: union subtask's + parent's OUTGOING RelatesTo/DependsOn
    // links (Layer 1 dependencies are typically Story-level, so the parent's own links
    // matter as much as the subtask's — not just symmetry with the page-link precedent
    // above). Excludes the subtask/parent themselves (each already has its own section);
    // a target linked via both relations collects both into one entry, not two.
    const linkedIssueRelations = new Map<IssueKey, Set<DependencyRelation>>();
    const collectLinks = (links: readonly IssueLink[]): void => {
        for (const link of links) {
            if (link.key === subtask.key) continue;
            if (parent && link.key === parent.key) continue;
            const relations = linkedIssueRelations.get(link.key) ?? new Set<DependencyRelation>();
            relations.add(link.relation);
            linkedIssueRelations.set(link.key, relations);
        }
    };
    collectLinks(await workTracker.getLinkedIssues(subtask.key, undefined, "outgoing"));
    if (parent) {
        collectLinks(await workTracker.getLinkedIssues(parent.key, undefined, "outgoing"));
    }

    const linkedIssues: { issue: Issue; relations: ReadonlySet<DependencyRelation> }[] = [];
    for (const [key, relations] of linkedIssueRelations) {
        const linked = await refreshIssue(workTracker, taiRoot, projectKey, key);
        if (!linked) continue;
        linkedIssues.push({ issue: linked, relations });
        // TAI-77 ADR decision 5: a linked ticket's OWN linked pages come along too — its
        // substantive content (an ADR/PRD) often lives there, not in its description. One
        // hop from the linked ticket only, same bound as everywhere else in this function.
        for (const pageId of await workTracker.getLinkedPages(linked.key)) pageIds.add(pageId);
    }

    const pages: Page[] = [];
    for (const pageId of pageIds) {
        const page = await refreshPage(docStore, taiRoot, projectKey, { id: pageId });
        if (page) pages.push(page);
    }

    const markdown = renderBriefing(subtask, parent, pages, linkedIssues);
    const filePath = briefingPath(taiRoot, projectKey, subtaskKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, markdown, "utf8");
    return markdown;
}

function renderBriefing(
    subtask: Issue,
    parent: Issue | null,
    pages: readonly Page[],
    linkedIssues: readonly { issue: Issue; relations: ReadonlySet<DependencyRelation> }[]
): string {
    const sections: string[] = [`# Briefing: ${subtask.key}`, renderIssueSection(subtask, "Subtask")];

    if (parent) {
        sections.push(renderIssueSection(parent, "Parent"));
    }

    if (pages.length > 0) {
        sections.push("## Linked Confluence pages");
        for (const page of pages) {
            sections.push(`### ${page.title}\n\n${page.content}`);
        }
    }

    if (linkedIssues.length > 0) {
        sections.push("## Linked Tickets");
        for (const { issue, relations } of linkedIssues) {
            sections.push(renderIssueSection(issue, relationLabel(relations), "###"));
        }
    }

    return sections.join("\n\n") + "\n";
}

// Fixed order, not Set iteration order, so a ticket linked via both relations renders
// deterministically regardless of which link was discovered first.
const RELATION_LABEL_ORDER: readonly DependencyRelation[] = [DependencyRelation.DependsOn, DependencyRelation.RelatesTo];
const RELATION_LABEL: Record<DependencyRelation, string> = {
    [DependencyRelation.DependsOn]: "Depends on",
    [DependencyRelation.RelatesTo]: "Relates to",
};

function relationLabel(relations: ReadonlySet<DependencyRelation>): string {
    return RELATION_LABEL_ORDER.filter((r) => relations.has(r))
        .map((r) => RELATION_LABEL[r])
        .join(", ");
}

function renderIssueSection(issue: Issue, label: string, heading: "##" | "###" = "##"): string {
    const lines = [`${heading} ${label}: ${issue.key} — ${issue.summary}`, `Type: ${issue.issueType} · Status: ${issue.status}`];
    if (issue.description) {
        lines.push("", issue.description);
    }
    return lines.join("\n");
}
