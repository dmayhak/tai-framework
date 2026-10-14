/**
 * TAI-497: a page a conformance case needs under a fixed title (the Persona Roster) may already exist in the scratch
 * space, left by an earlier run or made on purpose. Creating it again is rejected, so the case failed before testing
 * anything. This reuses it instead: an existing page gets the case's content for the duration of the case and its own
 * content back afterwards, and is never deleted; only a page this call created is the caller's to delete.
 *
 * Two limits, both from writing a page through the DocStore's markdown view: (1) a page that already says what the
 * case needs is left untouched, which is the usual case for a roster kept for real use and the only way to be sure
 * it is never left altered if the run is killed; (2) for any other page, "its own content back" is a markdown
 * round-trip, so on Confluence a page using macros, layouts or panels comes back in plain-markdown form, not
 * byte for byte. A killed run before `restore` leaves the case's content on the page.
 */

import type { DocStore, Page, PageId } from "./interface.js";

export interface FixturePage {
    readonly page: Page;
    /** Set when this call created the page, so the caller deletes it; null when an existing page was reused. */
    readonly createdId: PageId | null;
    /** Puts an existing page's original content back. A no-op for a page this call created. */
    readonly restore: () => Promise<void>;
}

export async function ensureFixturePage(docStore: DocStore, spaceKey: string, title: string, content: string): Promise<FixturePage> {
    const existing = await docStore.getPage({ spaceKey, title });
    if (!existing) {
        const page = await docStore.createPage({ spaceKey, title, content });
        return { page, createdId: page.id, restore: async () => {} };
    }
    if (existing.content.trim() === content.trim()) return { page: existing, createdId: null, restore: async () => {} };
    const page = await docStore.updatePage({ id: existing.id }, { content });
    return { page, createdId: null, restore: async () => void (await docStore.updatePage({ id: existing.id }, { content: existing.content })) };
}
