/**
 * TAI Framework — in-memory `IssueFilter` matching (TAI-381)
 *
 * One definition of "does this issue satisfy this filter", shared by the filesystem backend's
 * `search()` and by the Jira backend when it merges in issues found through a read-your-write
 * path rather than through JQL (see `IssueFilter.readYourWrites`). Same posture as the other
 * shared storage gates: one copy, so the two backends can't drift on what a filter means.
 *
 * `limit`, `exhaustive` and `readYourWrites` shape the QUERY, not the match, so they are deliberately ignored.
 */

import type { Issue, IssueFilter } from "./interface.js";

// A date (UTC midnight) or an ISO 8601 date-time that NAMES its timezone (Z or an offset). Anything else -- a
// relative offset like -7d, a bare local time -- is ambiguous or backend-specific, so it is rejected, never guessed.
const ISO_UPDATED_SINCE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2}))?$/;

/**
 * The one contract for `IssueFilter.updatedSince` on every backend (TAI-420 review): an ISO 8601 date or an ISO date-time
 * with a timezone, returned as the instant in epoch milliseconds. Throws on anything else, so neither backend can
 * turn a bad value into a query that quietly matches nothing (Jira did, found live: it silently matched nothing for
 * an ISO string, which is why the Jira backend sends this epoch value).
 */
export function parseUpdatedSince(value: string): number {
    const ms = ISO_UPDATED_SINCE.test(value) ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(ms)) {
        throw new Error(
            `Invalid updatedSince ${JSON.stringify(value)} -- expected an ISO 8601 date (2026-10-02) or date-time with a timezone (2026-10-02T10:00:00Z).`
        );
    }
    return ms;
}

export function matchesIssueFilter(issue: Issue, filter: IssueFilter): boolean {
    if (issue.projectKey !== filter.projectKey) return false;
    if (filter.issueTypes && !filter.issueTypes.includes(issue.issueType)) return false;
    if (filter.statuses && !filter.statuses.includes(issue.status)) return false;
    if (filter.assignee && issue.assignee?.id !== filter.assignee) return false;
    if (filter.persona && issue.persona !== filter.persona) return false;
    if (filter.parentKey && issue.parentKey !== filter.parentKey) return false;
    if (filter.updatedSince && Date.parse(issue.updatedAt) < parseUpdatedSince(filter.updatedSince)) return false;
    if (filter.component && issue.component !== filter.component) return false;
    if (filter.labels?.length && !filter.labels.every((l) => issue.labels.includes(l))) return false;
    return true;
}
