/**
 * TAI Framework — Jira + Confluence StorageBackend
 *
 * Composes the two halves (WorkTracker over Jira, DocStore over Confluence) into the
 * StorageBackend the rest of TAI is written against. The default backend, brief §3.2.
 */

import type { StorageBackend } from "../interface.js";
import { RestClient, apiTokenAuth, type AtlassianAuth } from "./rest-client.js";
import { createJiraWorkTracker, discoverPersonaFieldId } from "./work-tracker.js";
import { createConfluenceDocStore } from "./doc-store.js";
import type { MermaidConfig } from "./storage-format.js";

export interface JiraBackendConfig {
    /** e.g. `https://your-site.atlassian.net` */
    readonly siteUrl: string;
    /**
     * The Confluence space key. Deliberately separate from the Jira project key — brief §4
     * (rev 18) withdrew the "they match" rule after this project turned out to be Jira `TAI`
     * / Confluence `TA`. Nothing may derive one from the other.
     */
    readonly spaceKey: string;
    readonly auth: AtlassianAuth;
    readonly mermaid?: MermaidConfig;
    /** Injectable for tests. */
    readonly fetchImpl?: typeof fetch;
}

/**
 * Async because the `Persona` custom field's id is DISCOVERED by name at startup rather than
 * hardcoded — it's `customfield_10105` on the TAI site, but that number is assigned per
 * Atlassian instance, and hardcoding it would silently write to the wrong field elsewhere.
 */
export async function createJiraBackend(config: JiraBackendConfig): Promise<StorageBackend> {
    const client = new RestClient({
        siteUrl: config.siteUrl,
        auth: config.auth,
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    });

    const personaFieldId = await discoverPersonaFieldId(client);
    const docStore = createConfluenceDocStore(client, {
        spaceKey: config.spaceKey,
        ...(config.mermaid ? { mermaid: config.mermaid } : {}),
    });

    return {
        kind: "jira",
        workTracker: createJiraWorkTracker(client, { personaFieldId, docStore, spaceKey: config.spaceKey }),
        docStore,
    };
}

export { apiTokenAuth, type AtlassianAuth };
