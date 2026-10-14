/**
 * TAI Framework — was a sign-off made through the TAI CLI, or directly? (TAI-500, built on TAI-475's stamp)
 *
 * The CLI and the human share one Jira identity, so this cannot say WHO signed off. It reads what the CLI left:
 * a stamped `Approved:` comment, or the stamped `Sign-off:` companion comment (`stamp.ts`). A sign-off with
 * neither was made in the Jira UI. The stamp is text, so a person could type one; this is a visible signal, not
 * proof, and nothing is ever blocked on it (brief §4). One known limit: a close is read from the LAST companion
 * comment anywhere in the history, so a ticket closed through the CLI, reopened, then closed again in the Jira UI
 * still reads "through the TAI CLI". Telling them apart needs the transition history (an extra read per ticket) or a
 * marker left on reopen; neither is done.
 *
 * Pure: reads only the comments and status already on the `Issue`, so no view makes an extra call for it.
 * Covers the Kickoff `Approved:` comments (PM and UX Designer) and the closes of UAT, EpicReview, DesignReview
 * and Epic. Closing a Story or Bug is not a sign-off, and PR approvals are out of scope (they are a git-host read).
 */

import { Status, StoryType } from "../schema/story-schema.js";
import { parseCommentMarkers } from "./comment-markers.js";
import type { Issue } from "./interface.js";
import { isSignOffComment, isStamped, signOffLabel, stampedAs } from "./stamp.js";

export type SignOffProvenance = "via-cli" | "direct" | "not-signed-off";

export interface ApprovalReading {
    /** The comment author's display name. The CLI and the human share one identity, so this is often the same name. */
    readonly author: string;
    readonly provenance: "via-cli" | "direct";
    /** The persona the CLI was run as ("Perry (pm)"), when the stamp names one. */
    readonly actingAs?: string;
}

export interface SignOffReading {
    /** "Kickoff approval", "UAT", "EpicReview", "DesignReview" or "Epic". */
    readonly label: string;
    /** `via-cli` only when EVERY approval went through the CLI: one unstamped approval makes it `direct`. */
    readonly provenance: SignOffProvenance;
    /** The approvals (Kickoff) or the one close (the rest) behind `provenance`; empty when not signed off. */
    readonly approvals: readonly ApprovalReading[];
}

const KICKOFF_LABEL = "Kickoff approval";

/** The reading for `issue`, or null when it is not a sign-off (or was canceled, so nothing was signed). */
export function signOffProvenance(issue: Pick<Issue, "issueType" | "status" | "comments">): SignOffReading | null {
    if (issue.status === Status.Canceled) return null;
    if (issue.issueType === StoryType.Kickoff) {
        const approvals = parseCommentMarkers(issue.comments)
            .filter((m) => m.kind === "Approved")
            .map(({ comment }): ApprovalReading => {
                const actingAs = isStamped(comment.body) ? stampedAs(comment.body) : undefined;
                return {
                    author: comment.author.displayName,
                    provenance: isStamped(comment.body) ? "via-cli" : "direct",
                    ...(actingAs ? { actingAs } : {}),
                };
            });
        const provenance: SignOffProvenance =
            approvals.length === 0 ? "not-signed-off" : approvals.every((a) => a.provenance === "via-cli") ? "via-cli" : "direct";
        return { label: KICKOFF_LABEL, provenance, approvals };
    }

    const label = signOffLabel(issue.issueType);
    if (label === undefined) return null;
    if (issue.status !== Status.Done) return { label, provenance: "not-signed-off", approvals: [] };

    const companion = issue.comments.filter((c) => isSignOffComment(c.body)).at(-1);
    if (!companion) return { label, provenance: "direct", approvals: [{ author: "the Jira UI", provenance: "direct" }] };
    const actingAs = stampedAs(companion.body);
    return {
        label,
        provenance: "via-cli",
        approvals: [{ author: companion.author.displayName, provenance: "via-cli", ...(actingAs ? { actingAs } : {}) }],
    };
}

const how = (a: ApprovalReading): string => (a.provenance === "via-cli" ? `through the TAI CLI${a.actingAs ? ` as ${a.actingAs}` : ""}` : "directly");

/** One line saying how the sign-off was made: "Epic closed through the TAI CLI as Perry (pm)". */
export function renderSignOffProvenance(reading: SignOffReading): string {
    if (reading.provenance === "not-signed-off") return `${reading.label} not signed off yet`;
    if (reading.label === KICKOFF_LABEL) {
        return `${reading.label}${reading.approvals.length === 1 ? "" : "s"}: ${reading.approvals.map((a) => `${a.author} ${how(a)}`).join("; ")}`;
    }
    const a = reading.approvals[0]!;
    return `${reading.label} closed ${how(a)}${a.provenance === "direct" ? " (no TAI CLI sign-off comment)" : ""}`;
}

/** ` — sign-off: …` for a list row, or "" when there is nothing signed off to say (list rows are open work: a
 *  "not signed off yet" on every UAT and EpicReview would only be noise). */
export function signOffRowNote(issue: Pick<Issue, "issueType" | "status" | "comments">): string {
    const reading = signOffProvenance(issue);
    return reading && reading.provenance !== "not-signed-off" ? ` — sign-off: ${renderSignOffProvenance(reading)}` : "";
}
