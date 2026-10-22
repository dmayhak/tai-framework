/**
 * TAI Framework — DocStore over the Confluence REST API (TAI-13)
 *
 * The Confluence half of StorageBackend. Uses the v2 API (`/wiki/api/v2`).
 *
 * `Page.content` is markdown in both directions — see storage-format.ts for that decision
 * and the Mermaid mapping. Confluence's native XHTML never escapes this file.
 */

import {
    type DocStore,
    type Page,
    type PageSummary,
    type PageRef,
    type CreatePageInput,
    type PagePatch,
    type Comment,
    type AttachmentRef,
    type IssueKey,
    type PageId,
    toPageId,
    toHumanId,
} from "../interface.js";
import { RestClient, JiraRejection } from "./rest-client.js";
import { markdownToStorage, storageToMarkdown, type MermaidConfig, TAI_DEV_MERMAID } from "./storage-format.js";

const API = "/wiki/api/v2";

export interface ConfluenceDocStoreConfig {
    /**
     * The Confluence space key.
     *
     * NOT derived from the Jira project key. Brief §4 (rev 18) withdrew that rule after this
     * very project turned out to be Jira `TAI` / Confluence `TA` — Confluence mints a space
     * key from the space *name* and may shorten it, and a human can rename it afterwards.
     * It is separate config.
     *
     * NOT USED TO RESOLVE ANY OPERATION BELOW (fixed — TAI-15 code review). Every `PageRef`/
     * `CreatePageInput` in interface.ts is self-sufficient: `{id}` needs no space at all, and
     * `{spaceKey, title}` / `CreatePageInput.spaceKey` always carries its own. An earlier
     * version of this file resolved every call against THIS value regardless of what the
     * caller actually asked for — so a caller requesting a different space silently got data
     * from (or written to) the configured one instead. This field is kept only as descriptive
     * default config for whatever future caller needs "this project's home space" without
     * itself tracking one; no method here reads it anymore.
     */
    readonly spaceKey: string;
    readonly mermaid?: MermaidConfig;
}

interface RawPage {
    id: string;
    spaceId: string;
    title: string;
    parentId?: string | null;
    version: { number: number; createdAt: string };
    createdAt?: string;
    body?: { storage?: { value: string } };
}

interface RawComment {
    id: string;
    version: { number: number; createdAt: string };
    body?: { storage?: { value: string } };
    // v2 comment payloads carry only the author's accountId, not a display name.
    authorId?: string;
    createdAt?: string;
}

export function createConfluenceDocStore(
    client: RestClient,
    config: ConfluenceDocStoreConfig
): DocStore {
    const mermaid = config.mermaid ?? TAI_DEV_MERMAID;

    // key/alias -> numeric spaceId, AND the reverse (numeric id -> canonical key), each keyed
    // per-space rather than a single flat value — TAI-15's code review found the earlier
    // single-cache version silently ignored a caller-supplied space that differed from
    // whatever was configured. Both directions are cached: resolution is on the hot path for
    // every page creation/lookup, and it cannot change for the life of a session.
    //
    // Confluence Cloud has a dual-key system: an immutable "system" key assigned at space
    // creation, and an editable "alias" (what a human sees/renames in the UI — up to 10
    // times). The `keys=` filter on this endpoint ALREADY resolves against the current
    // alias, not just the system key (verified live: a space whose real system key is `TA1`
    // is correctly returned by `?keys=TAIT`, its current alias). Matching on either field is
    // what makes lookups genuinely alias-or-key agnostic — the friendlier of the two options
    // brief §4 (rev 18) left open after finding `spaceKey` and the Jira `projectKey` are
    // never safely derivable from each other.
    const spaceIdByKey = new Map<string, string>();
    const spaceKeyById = new Map<string, string>();

    async function resolveSpaceId(key: string): Promise<string> {
        const cached = spaceIdByKey.get(key);
        if (cached) return cached;
        const res = await client.request<{
            results: { id: string; key: string; currentActiveAlias?: string }[];
        }>("GET", `${API}/spaces?keys=${encodeURIComponent(key)}`);
        const found = res.results.find((s) => s.key === key || s.currentActiveAlias === key);
        if (!found) {
            throw new Error(
                `Confluence space "${key}" not found (checked by system key and by current alias). Space key and Jira project key are never safely derivable from each other (brief §4, rev 18) — double check your config.`
            );
        }
        spaceIdByKey.set(key, found.id);
        spaceKeyById.set(found.id, found.key);
        return found.id;
    }

    /** The reverse of resolveSpaceId — needed so a Page reports the space it's ACTUALLY in,
     *  not whichever space happened to be configured at construction time. */
    async function resolveSpaceKeyForId(id: string): Promise<string> {
        const cached = spaceKeyById.get(id);
        if (cached) return cached;
        const space = await client.request<{ key: string }>("GET", `${API}/spaces/${id}`);
        spaceKeyById.set(id, space.key);
        return space.key;
    }

    async function toPage(raw: RawPage): Promise<Page> {
        return {
            id: toPageId(raw.id),
            spaceKey: await resolveSpaceKeyForId(raw.spaceId),
            title: raw.title,
            content: storageToMarkdown(raw.body?.storage?.value ?? ""),
            ...(raw.parentId ? { parentId: toPageId(raw.parentId) } : {}),
            // v2 doesn't return a page-level createdAt on every shape; the first version's
            // timestamp is the honest stand-in rather than inventing `new Date()`.
            createdAt: raw.createdAt ?? raw.version.createdAt,
            updatedAt: raw.version.createdAt,
            comments: [],
        };
    }

    function toComment(raw: RawComment): Comment {
        return {
            id: raw.id,
            author: {
                id: toHumanId(raw.authorId ?? "unknown"),
                // Confluence v2 comment payloads don't expand the author. Resolving every
                // accountId to a display name would cost an N+1 of user lookups on every page
                // read; callers who need names can resolve them. Not inventing one here.
                displayName: raw.authorId ?? "unknown",
            },
            body: storageToMarkdown(raw.body?.storage?.value ?? ""),
            createdAt: raw.createdAt ?? raw.version.createdAt,
            updatedAt: raw.version.createdAt,
        };
    }

    /**
     * Resolve a PageRef to a concrete id. Title lookup is a search within THE SPACE THE
     * CALLER ASKED FOR (`ref.spaceKey`) — never a single configured space. This is the fix:
     * an earlier version always searched `config.spaceKey` regardless of what `ref` said,
     * so a caller requesting a different space either silently got the wrong space's page or
     * a false 404, with no error surfacing the mismatch.
     */
    async function resolveId(ref: PageRef): Promise<PageId | null> {
        if ("id" in ref) return ref.id;
        const sid = await resolveSpaceId(ref.spaceKey);
        const res = await client.request<{ results: { id: string; title: string }[] }>(
            "GET",
            `${API}/spaces/${sid}/pages?title=${encodeURIComponent(ref.title)}&limit=250`
        );
        const found = res.results.find((p) => p.title === ref.title);
        return found ? toPageId(found.id) : null;
    }

    async function mustResolveId(ref: PageRef): Promise<PageId> {
        const id = await resolveId(ref);
        if (!id) throw new JiraRejection(`Page not found: ${JSON.stringify(ref)}`, 404);
        return id;
    }

    async function fetchPage(id: PageId): Promise<Page> {
        const raw = await client.request<RawPage>("GET", `${API}/pages/${id}?body-format=storage`);
        return toPage(raw);
    }

    /** Confluence uses optimistic locking: every update must carry the NEXT version number. */
    async function currentVersion(id: PageId): Promise<number> {
        const raw = await client.request<RawPage>("GET", `${API}/pages/${id}`);
        return raw.version.number;
    }

    return {
        async createPage(input: CreatePageInput): Promise<Page> {
            const created = await client.request<RawPage>("POST", `${API}/pages`, {
                spaceId: await resolveSpaceId(input.spaceKey),
                title: input.title,
                ...(input.parentId ? { parentId: input.parentId } : {}),
                body: {
                    representation: "storage",
                    value: markdownToStorage(input.content, mermaid),
                },
            });
            // Re-fetch for the same reason as Jira's createIssue: the create response doesn't
            // reliably echo the body back, and returning a guess is worse than a round trip.
            return fetchPage(toPageId(created.id));
        },

        async getPage(ref: PageRef): Promise<Page | null> {
            const id = await resolveId(ref);
            if (!id) return null;
            const raw = await client.getOrNull<RawPage>(`${API}/pages/${id}?body-format=storage`);
            return raw ? toPage(raw) : null;
        },

        async updatePage(ref: PageRef, patch: PagePatch): Promise<Page> {
            const id = await mustResolveId(ref);
            const version = await currentVersion(id);
            const existing = await client.request<RawPage>(
                "GET",
                `${API}/pages/${id}?body-format=storage`
            );

            // TAI-305 (PR #89 review): same guard as filesystem-backend.ts -- reject a
            // cross-space move outright rather than leave an inconsistent result (raw
            // spaceId compare, no need to resolve either side to its space key).
            if (patch.parentId) {
                const newParent = await client.request<RawPage>(
                    "GET",
                    `${API}/pages/${patch.parentId}`
                );
                if (newParent.spaceId !== existing.spaceId) {
                    throw new Error(
                        `Cannot move page ${id} to parent ${patch.parentId}: different spaces -- not supported.`
                    );
                }
            }

            await client.request("PUT", `${API}/pages/${id}`, {
                id,
                status: "current",
                title: patch.title ?? existing.title,
                ...(patch.parentId ? { parentId: patch.parentId } : {}),
                body: {
                    representation: "storage",
                    value:
                        patch.content !== undefined
                            ? markdownToStorage(patch.content, mermaid)
                            : (existing.body?.storage?.value ?? ""),
                },
                version: { number: version + 1 },
            });
            return fetchPage(id);
        },

        async addComment(ref: PageRef, body: string): Promise<Comment> {
            const id = await mustResolveId(ref);
            const raw = await client.request<RawComment>("POST", `${API}/footer-comments`, {
                pageId: id,
                body: { representation: "storage", value: markdownToStorage(body, mermaid) },
            });
            return toComment(raw);
        },

        /**
         * Editing a Confluence comment IS possible — `PUT /wiki/api/v2/footer-comments/{id}`,
         * verified live. It was listed as a hard gap ("no MCP tool at all") only because the
         * mcp-atlassian wrapper doesn't expose one. Going direct to REST closes it, which is
         * a concrete win for the transport decision in TAI-16.
         */
        async editComment(ref: PageRef, commentId: string, body: string): Promise<Comment> {
            void ref; // comment ids are globally unique; the page isn't needed to address one
            const cur = await client.request<RawComment>("GET", `${API}/footer-comments/${commentId}`);
            const raw = await client.request<RawComment>("PUT", `${API}/footer-comments/${commentId}`, {
                version: { number: cur.version.number + 1 },
                body: { representation: "storage", value: markdownToStorage(body, mermaid) },
            });
            return toComment(raw);
        },

        async getChildren(ref: PageRef, limit = 50): Promise<readonly Page[]> {
            const id = await mustResolveId(ref);
            const res = await client.request<{ results: { id: string }[] }>(
                "GET",
                `${API}/pages/${id}/children?limit=${limit}`
            );
            // The children endpoint returns a summary shape with no body, so fetch each in
            // full — Page promises content, and returning it empty would be a lie.
            return Promise.all(res.results.map((c) => fetchPage(toPageId(c.id))));
        },

        async listRootPages(spaceKey: string, limit = 250): Promise<readonly PageSummary[]> {
            const sid = await resolveSpaceId(spaceKey);
            // Found live (TAI-600): Confluence puts a page created with no parent UNDER THE SPACE HOME PAGE, so the
            // top of the tree is the home page's children. `depth=root` returns only the home page itself, which
            // would list nothing. A space with no home page falls back to `depth=root`.
            const space = await client.request<{ homepageId?: string | null }>("GET", `${API}/spaces/${sid}`);
            const listPath = space.homepageId
                ? `${API}/pages/${space.homepageId}/children?limit=${limit}`
                : `${API}/spaces/${sid}/pages?depth=root&limit=${limit}`;
            const res = await client.request<{ results: { id: string; title: string }[] }>("GET", listPath);
            const resolvedKey = await resolveSpaceKeyForId(sid);
            return res.results.map((raw) => ({ id: toPageId(raw.id), spaceKey: resolvedKey, title: raw.title }));
        },

        /**
         * The complementary view of WorkTracker.linkPage/getLinkedPages — the same link data,
         * not a second store. Jira owns the link (it's a remote link ON the issue), so the
         * only way to answer "which issues reference this page" is to ask Jira.
         */
        async getLinkedIssues(ref: PageRef): Promise<readonly IssueKey[]> {
            const id = await mustResolveId(ref);
            // CQL/Jira has no reverse index for remote links, so this is answered from the
            // Jira side by the caller that owns both halves (the cache's link index, brief §7).
            // Returning [] here would silently claim "no links"; throwing says what's true.
            throw new Error(
                `getLinkedIssues is not answerable from Confluence alone: Jira owns the issue->page remote link, and Jira exposes no reverse index for it. Resolve it from the link cache (brief §7 \`links/\`) or by querying WorkTracker.getLinkedPages across candidate issues. (page ${id})`
            );
        },

        async listAttachments(ref: PageRef): Promise<readonly AttachmentRef[]> {
            const id = await mustResolveId(ref);
            const res = await client.request<{
                results: { id: string; title: string; fileSize?: number }[];
            }>("GET", `${API}/pages/${id}/attachments`);
            return res.results.map((a) => ({
                id: a.id,
                filename: a.title,
                ...(a.fileSize !== undefined ? { sizeBytes: a.fileSize } : {}),
            }));
        },

        async getAttachment(ref: PageRef, attachmentId: string): Promise<Buffer> {
            void ref;
            const meta = await client.request<{ downloadLink: string }>(
                "GET",
                `${API}/attachments/${attachmentId}`
            );
            // downloadLink is site-relative and lives under /wiki.
            const url = meta.downloadLink.startsWith("/wiki")
                ? meta.downloadLink
                : `/wiki${meta.downloadLink}`;
            return client.getBinary(url);
        },
    };
}
