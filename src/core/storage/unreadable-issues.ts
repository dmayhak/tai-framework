/**
 * TAI-399/405: tickets TAI cannot read because their Jira issue type is not mapped.
 *
 * A search used to throw on the first such row, taking down every reader (`/tai-ready`, `issue
 * search`, the cascade lookups) for one stray ticket. Decided with the human (TAI-404): a search
 * SKIPS the row and WARNS; reading that one issue by key still fails hard.
 *
 * `WorkTracker.search` returns a plain array, so the skipped keys travel on a small process-wide
 * collector instead of a changed return type or a method every wrapper (caching, persona-scoped)
 * would have to forward. One CLI invocation is one process, so "what was skipped during this
 * command" is well defined; the CLI renderers (and later the grooming briefing) drain it.
 */

export class UnreadableIssueError extends Error {
    constructor(
        readonly key: string,
        readonly typeName: string,
        message: string
    ) {
        super(message);
        this.name = "UnreadableIssueError";
    }
}

export interface UnreadableIssue {
    readonly key: string;
    readonly typeName: string;
}

const seen = new Map<string, UnreadableIssue>();

/** Records a skipped ticket; warns on stderr the first time a key is seen in this process. */
export function reportUnreadableIssue(
    issue: UnreadableIssue,
    warn: (message: string) => void = (m) => process.stderr.write(`${m}\n`)
): void {
    if (seen.has(issue.key)) return;
    seen.set(issue.key, issue);
    warn(`Skipped ${issue.key}: its Jira issue type "${issue.typeName}" is not mapped, so TAI cannot read it.`);
}

/** Returns every ticket skipped since the last call, and clears the collector. */
export function takeUnreadableIssues(): readonly UnreadableIssue[] {
    const all = [...seen.values()];
    seen.clear();
    return all;
}

/** The way out for a ticket of an unmapped Jira type -- shared by the per-search note and the setup report (TAI-413). */
export const UNMAPPED_TYPE_FIX_PATH =
    `If the type means the same as a TAI type, alias it on the Type Aliases Confluence page, then set the persona with ` +
    `\`issue update <KEY> persona=<PERSONA>\`; otherwise leave it unmanaged and work it outside TAI.`;

/** The one-line note the CLI renderers append, naming each skipped ticket and the way out. */
export function renderUnreadableIssuesNote(issues: readonly UnreadableIssue[]): string | undefined {
    if (issues.length === 0) return undefined;
    const list = issues.map((i) => `${i.key} ("${i.typeName}")`).join(", ");
    return (
        `_Skipped ${issues.length} ticket${issues.length === 1 ? "" : "s"} TAI cannot read (Jira issue type not mapped): ${list}. ` +
        `${UNMAPPED_TYPE_FIX_PATH}_`
    );
}
