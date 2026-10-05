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

export function matchesIssueFilter(issue: Issue, filter: IssueFilter): boolean {
    if (issue.projectKey !== filter.projectKey) return false;
    if (filter.issueTypes && !filter.issueTypes.includes(issue.issueType)) return false;
    if (filter.statuses && !filter.statuses.includes(issue.status)) return false;
    if (filter.assignee && issue.assignee?.id !== filter.assignee) return false;
    if (filter.persona && issue.persona !== filter.persona) return false;
    if (filter.parentKey && issue.parentKey !== filter.parentKey) return false;
    if (filter.updatedSince && issue.updatedAt < filter.updatedSince) return false;
    if (filter.component && issue.component !== filter.component) return false;
    if (filter.labels?.length && !filter.labels.every((l) => issue.labels.includes(l))) return false;
    return true;
}
