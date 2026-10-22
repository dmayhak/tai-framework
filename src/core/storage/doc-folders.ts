/**
 * Doc-type folders (brief §4): a page lives in a folder named for its kind of document, never at the
 * space root and never nested under a ticket's page. One table maps every output type a persona can
 * declare (`confluenceOutputs`) to its folder; `ensureDocFolder` finds the folder in a space or creates
 * it. `doc-folders.test.ts` fails when a persona declares a type this table lacks.
 */

import { toPageId, type DocStore, type Page, type PageId, type PageSummary } from "./interface.js";

export const DOC_FOLDER_NAMES = [
    "Requirements",
    "Work Breakdowns and Refinement",
    "UX Designs",
    "Architecture Decisions",
    "Schema Notes and Migration Plans",
    "Test Plans",
    "Implementation Notes",
    "Runbooks and Infra",
] as const;

/** The top-level folder for personas' and project configuration pages (brief §4); not a doc-type folder. */
export const CONFIG_FOLDER_TITLE = "Config";

export type DocFolderName = (typeof DOC_FOLDER_NAMES)[number];

/** Output type -> folder. `null` is a type that is deliberately not filed: `project-home` is the space's
 *  own native Overview page, which already exists and is updated in place. */
export const DOC_TYPE_FOLDERS: Readonly<Record<string, DocFolderName | null>> = {
    // Requirements
    prd: "Requirements",
    // Work breakdowns
    "work-breakdown": "Work Breakdowns and Refinement",
    "refinement-notes": "Work Breakdowns and Refinement",
    "subtask-wbs": "Work Breakdowns and Refinement",
    "jira-issue-creation-log": "Work Breakdowns and Refinement",
    // UX
    "ux-flow": "UX Designs",
    wireframe: "UX Designs",
    "wireframe-index": "UX Designs",
    "story-ux-detail": "UX Designs",
    "design-system": "UX Designs",
    // Architecture
    adr: "Architecture Decisions",
    "feasibility-assessment": "Architecture Decisions",
    "design-review-notes": "Architecture Decisions",
    "architecture-overview": "Architecture Decisions",
    // Database
    "schema-notes": "Schema Notes and Migration Plans",
    "migration-plan": "Schema Notes and Migration Plans",
    // Testing
    "test-plan": "Test Plans",
    "triage-notes": "Test Plans",
    "uat-plan": "Test Plans",
    // Implementation and operations
    "implementation-notes": "Implementation Notes",
    "deploy-runbook": "Runbooks and Infra",
    "infra-notes": "Runbooks and Infra",
    // Not filed
    "project-home": null,
};

/** The folder for an output type, or `null` for a type that is not filed. Throws on an unknown type, naming
 *  the valid ones, so a typo is a refusal and not a page at the space root. */
export function folderForDocType(type: string): DocFolderName | null {
    if (!Object.hasOwn(DOC_TYPE_FOLDERS, type)) {
        throw new Error(`Unknown page type "${type}" -- expected one of: ${Object.keys(DOC_TYPE_FOLDERS).join(", ")}.`);
    }
    return DOC_TYPE_FOLDERS[type] ?? null;
}

/** Finds the folder page for `type` in `spaceKey`, creating it at the space root when it is absent. Returns
 *  `null`, and creates nothing, for a type that is not filed. */
export async function ensureDocFolder(docStore: DocStore, spaceKey: string, type: string): Promise<Page | null> {
    const title = folderForDocType(type);
    if (title === null) return null;
    const existing = await docStore.getPage({ spaceKey, title });
    if (existing) return existing;
    return docStore.createPage({
        spaceKey,
        title,
        content: `Folder for ${title.toLowerCase()} pages. Pages are filed here by type, not by ticket (brief §4).`,
    });
}

/** The parent for a new page, from `page create`'s `type=` and `parent=`: an explicit `parent=` is the override
 *  and wins (an unknown `type=` is still refused), a `type=` files into its folder, and neither is refused, so a
 *  page never lands at the space root by accident. `undefined` means the root, only for a type that is not filed. */
export async function resolvePageParent(
    docStore: DocStore,
    spaceKey: string,
    fields: { readonly type?: string; readonly parent?: string }
): Promise<PageId | undefined> {
    if (fields.type === undefined && fields.parent === undefined) {
        throw new Error(
            "page create needs type=<output-type> or parent=<PAGE-ID>: a page is filed in its doc-type folder, never " +
                `left at the space root (brief §4). Valid types: ${Object.keys(DOC_TYPE_FOLDERS).join(", ")}.`
        );
    }
    if (fields.type !== undefined) folderForDocType(fields.type);
    if (fields.parent !== undefined) return toPageId(fields.parent);
    const folder = await ensureDocFolder(docStore, spaceKey, fields.type!);
    return folder?.id;
}

/** The pages at a space's root that are neither a doc-type folder nor the `Config` folder (brief §4): the pages
 *  that should have been filed. The space's own Overview page also sits at the root; it is the caller's to
 *  recognise, since a backend may not say which page that is. */
export function looseRootPages(rootPages: readonly PageSummary[]): readonly PageSummary[] {
    const kept = new Set<string>([...DOC_FOLDER_NAMES, CONFIG_FOLDER_TITLE]);
    return rootPages.filter((p) => !kept.has(p.title));
}

/** Moves an existing page into the folder for `type`, in the page's own space. Throws for a type that is not
 *  filed and for a page that does not exist. */
export async function filePage(docStore: DocStore, pageId: PageId, type: string): Promise<Page> {
    if (folderForDocType(type) === null) {
        throw new Error(`Page type "${type}" is not filed in a folder, so there is nothing to file it under.`);
    }
    const page = await docStore.getPage({ id: pageId });
    if (!page) throw new Error(`Page not found: ${pageId}`);
    const folder = await ensureDocFolder(docStore, page.spaceKey, type);
    return docStore.updatePage({ id: pageId }, { parentId: folder!.id });
}
