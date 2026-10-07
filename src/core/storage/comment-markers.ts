/**
 * TAI Framework — brief §3.9's `Q:`/`Approved:`/`Rejected:` comment-marker convention
 *
 * Recognizes TAI's structured comment prefixes. Works unmodified against either Jira issue
 * comments or Confluence comments (brief §3.9: "All three apply to BOTH... not just Jira")
 * since both stores already share the same `Comment` shape (interface.ts) — this module
 * only reads that shape, nothing backend-specific.
 *
 * Always operates on freshly-fetched comments — nothing here caches a marker verdict, so an
 * edited or deleted marker is reflected on the very next call (brief §3.9's "fresh re-scan,
 * never cached" rule; `Comment.updatedAt` exists specifically to make that possible).
 *
 * `Rejected:`'s target-subtask parsing is intentionally light. Brief §3.9 itself says the
 * marker is "preferred" but TAI falls back to inferring intent from the comment text when
 * it's malformed or absent (the marker-with-inference-fallback pattern, `DESIGN_NOTES.md`)
 * — the inference side is a future consumer's job, not this module's.
 */

import type { Comment } from "./interface.js";

export type CommentMarkerKind = "Q" | "Approved" | "Rejected" | "Skipped";

export interface ParsedCommentMarker {
    readonly kind: CommentMarkerKind;
    /** `Rejected:`'s routed-to target (e.g. "Dev"), when the marker states one. */
    readonly target?: string;
    /** Free text after the marker/target — the question (`Q:`), sign-off notes
     *  (`Approved:`), or rejection reason (`Rejected:`). */
    readonly note?: string;
    /** `Skipped:`'s named subtask types, normalized by `normalizeSubtaskTypeToken` (TAI-443). */
    readonly skippedTypes?: readonly string[];
    readonly comment: Comment;
}

const MARKER_KINDS: Readonly<Record<string, CommentMarkerKind>> = {
    q: "Q",
    approved: "Approved",
    rejected: "Rejected",
    skipped: "Skipped",
};
const MARKER_PATTERN = /^\s*(Q|Approved|Rejected|Skipped)\s*:\s*(.*)$/i;
// Where `Skipped:`'s type list ends and its reason begins: an em/en dash, or a spaced hyphen(s).
const SKIPPED_REASON_SEPARATOR = /\s*[\u2014\u2013]\s*|\s+--?\s+/;

/** "ux-design", "UxDesign" and "ux_design" all name the same subtask type. */
export function normalizeSubtaskTypeToken(token: string): string {
    return token.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Parses the marker on a single comment, or null if it isn't one. Only the FIRST line is
 * checked — a marker prefix appearing mid-body doesn't count, same as how these read on a
 * real Jira/Confluence comment thread.
 */
export function parseCommentMarker(comment: Comment): ParsedCommentMarker | null {
    const firstLine = comment.body.split("\n", 1)[0] ?? "";
    const match = MARKER_PATTERN.exec(firstLine);
    if (!match) return null;

    const kind = MARKER_KINDS[match[1]!.toLowerCase()]!;
    const rest = match[2]!.trim();

    if (kind === "Skipped") {
        // TAI-443: "Skipped: ux-design, requirements — backend-only epic". Types before the separator, reason after.
        const [typesPart = "", ...reasonParts] = rest.split(SKIPPED_REASON_SEPARATOR);
        const skippedTypes = typesPart
            .split(/[\s,]+|\band\b/i)
            .map(normalizeSubtaskTypeToken)
            .filter((t) => t !== "" && t !== "and");
        const note = reasonParts.join(" ").trim();
        return { kind, comment, skippedTypes, ...(note ? { note } : {}) };
    }

    if (kind !== "Rejected") {
        return { kind, comment, ...(rest ? { note: rest } : {}) };
    }

    // "Rejected: Dev" or "Rejected: Dev — didn't handle the empty state" — the first
    // whitespace-delimited token is the routed-to target; anything after is the note.
    const spaceIdx = rest.search(/\s/);
    const target = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const note = spaceIdx === -1 ? "" : rest.slice(spaceIdx).replace(/^[\s—-]+/, "").trim();
    return { kind, comment, ...(target ? { target } : {}), ...(note ? { note } : {}) };
}

/** Parses markers from every comment, dropping non-marker comments. */
export function parseCommentMarkers(comments: readonly Comment[]): readonly ParsedCommentMarker[] {
    return comments.map(parseCommentMarker).filter((m): m is ParsedCommentMarker => m !== null);
}

/**
 * Every subtask type a Kickoff's `Skipped:` comments name (TAI-443), normalized. Always re-derived from the
 * comments handed in -- an edited or deleted marker is reflected on the next call (brief §3.9).
 */
export function skippedSubtaskTypeTokens(comments: readonly Comment[]): ReadonlySet<string> {
    const tokens = new Set<string>();
    for (const marker of parseCommentMarkers(comments)) {
        if (marker.kind === "Skipped") for (const t of marker.skippedTypes ?? []) tokens.add(t);
    }
    return tokens;
}
