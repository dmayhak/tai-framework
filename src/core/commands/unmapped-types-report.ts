/**
 * TAI-413: report the Jira issue types TAI cannot map, ONCE at setup.
 *
 * A search skips and warns about a ticket of an unmapped type (TAI-405); this gives a project with
 * legacy tickets (a default Jira "Task", say) the whole picture up front -- at `init jira` and
 * `init run` -- instead of one warning per search. REPORT ONLY: nothing is created, retyped,
 * cancelled or deleted, and nothing here fails the init step.
 *
 * The classification reuses `fromJiraIssueType` with the project's alias map, so "unmapped" means
 * exactly what the backend means by it: neither a TAI type nor on the Type Aliases page.
 */

import { fromJiraIssueType, JIRA_ISSUE_TYPE, jqlString, UnknownJiraIssueTypeError, type TypeAliasMap } from "../storage/jira/mappers.js";
import type { RestClient } from "../storage/jira/rest-client.js";
import { UNMAPPED_TYPE_FIX_PATH } from "../storage/unreadable-issues.js";

export interface IssueTypeRow {
    readonly key: string;
    /** The raw Jira issue-type display name. */
    readonly typeName: string;
}

export interface UnmappedTypeGroup {
    readonly typeName: string;
    readonly count: number;
    /** The first few ticket keys of this type, in the order scanned. */
    readonly exampleKeys: readonly string[];
}

const MAX_EXAMPLES = 3;
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 50;

/** Groups the tickets whose type is not mapped; biggest group first, then by name. Empty when all map. */
export function summarizeUnmappedTypes(rows: readonly IssueTypeRow[], aliases: TypeAliasMap): readonly UnmappedTypeGroup[] {
    const groups = new Map<string, { count: number; exampleKeys: string[] }>();
    for (const row of rows) {
        try {
            fromJiraIssueType(row.typeName, aliases);
        } catch (e) {
            if (!(e instanceof UnknownJiraIssueTypeError)) throw e;
            const group = groups.get(row.typeName) ?? { count: 0, exampleKeys: [] };
            group.count += 1;
            if (group.exampleKeys.length < MAX_EXAMPLES) group.exampleKeys.push(row.key);
            groups.set(row.typeName, group);
        }
    }
    return [...groups.entries()]
        .map(([typeName, g]) => ({ typeName, count: g.count, exampleKeys: g.exampleKeys }))
        .sort((a, b) => b.count - a.count || a.typeName.localeCompare(b.typeName));
}

/** The report appended to the init step's output. `truncated` = the scan hit its page cap. */
export function renderUnmappedTypesNote(groups: readonly UnmappedTypeGroup[], truncated: boolean): string | undefined {
    if (groups.length === 0) return undefined;
    const lines = groups.map(
        (g) => `  - "${g.typeName}" — ${g.count} ticket${g.count === 1 ? "" : "s"} (e.g. ${g.exampleKeys.join(", ")})`
    );
    return [
        `Found tickets whose Jira issue type TAI does not map (they are skipped, with a warning, whenever TAI searches):`,
        ...lines,
        UNMAPPED_TYPE_FIX_PATH,
        truncated ? `The scan covered only the first ${DEFAULT_MAX_PAGES * PAGE_SIZE} tickets, so there may be more.` : undefined,
        `Report only: nothing was changed.`,
    ]
        .filter((l): l is string => l !== undefined)
        .join("\n");
}

interface SearchPage {
    readonly issues: readonly { readonly key: string; readonly fields: { readonly issuetype: { readonly name: string } } }[];
    readonly nextPageToken?: string;
    readonly isLast?: boolean;
}

/** Every Jira issue-type name TAI maps: its own display names plus the project's aliased native names. */
export function mappedIssueTypeNames(aliases: TypeAliasMap): readonly string[] {
    return [...new Set([...Object.values(JIRA_ISSUE_TYPE), ...aliases.fromJira.keys()])].sort();
}

/**
 * Reads the key and raw issue-type name of every ticket in `projectKey` (any status) whose type is NOT one of
 * `mappedNames`, paging with the cursor up to `maxPages`. The type filter runs on the Jira side, so a big legacy
 * project returns only the few tickets that matter -- normally one page -- and asks only for the issuetype field.
 * Callers still classify the rows locally (`summarizeUnmappedTypes`) as a double check.
 */
export async function scanProjectIssueTypes(
    client: Pick<RestClient, "request">,
    projectKey: string,
    mappedNames: readonly string[],
    maxPages = DEFAULT_MAX_PAGES
): Promise<{ readonly rows: readonly IssueTypeRow[]; readonly truncated: boolean }> {
    const rows: IssueTypeRow[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
        const res: SearchPage = await client.request("POST", "/rest/api/2/search/jql", {
            jql: `project = ${jqlString(projectKey)} AND issuetype NOT IN (${mappedNames.map(jqlString).join(", ")}) ORDER BY key ASC`,
            fields: ["issuetype"],
            maxResults: PAGE_SIZE,
            ...(nextPageToken ? { nextPageToken } : {}),
        });
        for (const issue of res.issues) rows.push({ key: issue.key, typeName: issue.fields.issuetype.name });
        nextPageToken = res.nextPageToken;
        if (res.isLast !== false || !nextPageToken) return { rows, truncated: false };
    }
    return { rows, truncated: true };
}
