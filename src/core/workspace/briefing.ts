/**
 * TAI Framework — briefing.md assembly (brief §3.6; TAI-56 ADR decision 4)
 *
 * Combines a subtask, its immediate parent, and the Confluence pages linked to EITHER into
 * one aggregated markdown file — "the parent's own linked docs necessarily come along...
 * this is how a subtask's briefing gets its ADR/PRD/schema-notes/etc. at all" (brief §3.6).
 * Bounded exactly as brief §3.6 already decided: immediate parent only (no Epic), one-hop
 * page links only (no transitive page-to-page following) — both already-decided rules, not
 * new ones this module invents.
 *
 * A plain string-building function, not a templating library — matches this codebase's
 * existing "hand-roll it" style for markdown generation (`storage/jira/storage-format.ts`'s
 * own converter).
 */

import type { DocStore, Issue, IssueKey, Page, PageId, WorkTracker } from "../storage/interface.js";
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

    const pages: Page[] = [];
    for (const pageId of pageIds) {
        const page = await refreshPage(docStore, taiRoot, projectKey, { id: pageId });
        if (page) pages.push(page);
    }

    const markdown = renderBriefing(subtask, parent, pages);
    const filePath = briefingPath(taiRoot, projectKey, subtaskKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, markdown, "utf8");
    return markdown;
}

function renderBriefing(subtask: Issue, parent: Issue | null, pages: readonly Page[]): string {
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

    return sections.join("\n\n") + "\n";
}

function renderIssueSection(issue: Issue, label: string): string {
    const lines = [`## ${label}: ${issue.key} — ${issue.summary}`, `Type: ${issue.issueType} · Status: ${issue.status}`];
    if (issue.description) {
        lines.push("", issue.description);
    }
    return lines.join("\n");
}
