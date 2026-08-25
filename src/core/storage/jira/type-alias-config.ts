/**
 * TAI Framework — Type-alias mapping config (TAI-116 piece 4, TAI-178 ADR)
 *
 * Parses/loads the optional "Type Aliases" Confluence page: a project-specific override
 * letting a pre-existing target project's native Jira issue-type names stand in for TAI's
 * own bundled `JIRA_ISSUE_TYPE` display names (`mappers.ts`), so a real project's
 * issue-type scheme doesn't have to exactly match TAI's out of the box.
 *
 * Mirrors `persona/config.ts`'s split between page-parsing/loading (this file, which does
 * the `DocStore` I/O) and pure resolution logic (`mappers.ts`, which stays free of any I/O
 * dependency) — same "skip malformed content, don't crash the caller" tolerance as
 * `parsePersonasOverridePage`, since this is live, human-edited Confluence content.
 */

import { load as loadYaml } from "js-yaml";

import type { DocStore, PageRef } from "../interface.js";
import { JIRA_ISSUE_TYPE, EMPTY_TYPE_ALIAS_MAP, type IssueType, type TypeAliasMap } from "./mappers.js";

export const TYPE_ALIASES_PAGE_TITLE = "Type Aliases";

const KNOWN_ISSUE_TYPES: ReadonlySet<string> = new Set(Object.keys(JIRA_ISSUE_TYPE));

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Same fence pattern as persona/config.ts's YAML_FENCE — trailing whitespace after the
// language tag is common from copy-paste/editor auto-formatting in human-edited content.
const YAML_FENCE = /```ya?ml[ \t]*\r?\n([\s\S]*?)\r?\n```/;

/**
 * Parses the "Type Aliases" page: a single ```yaml fence mapping the project's native
 * Jira issue-type display name -> one of TAI's own `IssueType` strings (the same value
 * `issue create`'s `<ISSUE-TYPE>` argument accepts). A YAML error, a missing fence, or a
 * value that isn't a recognised `IssueType` degrades to "no aliases" (or that one entry
 * dropped) rather than throwing — an alias narrows what's recognized, it never fabricates
 * a wrong mapping. Duplicate keys (two native names aliased to the same `IssueType`, or
 * the same native name twice) resolve last-declared-wins, same as a YAML mapping's own
 * parse semantics and `parsePersonasOverridePage`'s duplicate-heading behavior.
 */
export function parseTypeAliasesPage(markdown: string): TypeAliasMap {
    const fenceMatch = YAML_FENCE.exec(markdown);
    if (!fenceMatch) return EMPTY_TYPE_ALIAS_MAP;

    let parsed: unknown;
    try {
        parsed = loadYaml(fenceMatch[1]!);
    } catch {
        return EMPTY_TYPE_ALIAS_MAP;
    }
    if (!isRecord(parsed)) return EMPTY_TYPE_ALIAS_MAP;

    const fromJira = new Map<string, IssueType>();
    const toJira = new Map<IssueType, string>();
    for (const [nativeName, value] of Object.entries(parsed)) {
        if (typeof value !== "string" || !KNOWN_ISSUE_TYPES.has(value)) continue;
        const issueType = value as IssueType;
        fromJira.set(nativeName, issueType);
        toJira.set(issueType, nativeName);
    }
    return { fromJira, toJira };
}

/** Reads and parses the page via `DocStore`; returns `EMPTY_TYPE_ALIAS_MAP` when the page
 *  doesn't exist yet (the common case — most target projects provision matching custom
 *  issue types via the `/tai-init` checklist and never need this). */
export async function loadTypeAliasMap(
    docStore: DocStore,
    spaceKey: string,
    pageTitle: string = TYPE_ALIASES_PAGE_TITLE
): Promise<TypeAliasMap> {
    const page = await docStore.getPage({ spaceKey, title: pageTitle } satisfies PageRef);
    return page ? parseTypeAliasesPage(page.content) : EMPTY_TYPE_ALIAS_MAP;
}
