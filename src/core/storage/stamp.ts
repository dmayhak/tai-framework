/**
 * TAI Framework — the provenance stamp on what the CLI posts (TAI-475, deciding TAI-454)
 *
 * The CLI and the human share one Jira/Bitbucket identity, so nothing can prove who performed an
 * action. Human-gated steps are therefore conventions, and TAI makes the difference VISIBLE
 * instead: every comment the CLI posts ends with a stamp line, and the sign-off actions leave a
 * stamped comment of their own. A comment or sign-off with no stamp was made directly, in the
 * Jira or Bitbucket UI.
 *
 * The stamp says only what the CLI knows — that the action came through it, and which persona the
 * command named (`--as`, TAI-477). It cannot tell an AI session from a human typing the command.
 *
 * Pure text, no I/O. The stamp is always the LAST line, on its own, after a blank line (which is a
 * paragraph break in Jira wiki markup and in Bitbucket markdown alike), so the first-line comment
 * markers (`Approved:`, `Skipped:`, `Q:` — comment-markers.ts) are unaffected.
 */

import { ALWAYS_HUMAN_GATED_SUBTASKS, Status, SubtaskType } from "../schema/story-schema.js";
import type { Issue } from "./interface.js";

export interface ActingPersona {
    readonly id: string;
    readonly displayName: string;
}

const STAMP_LINE = /^Posted via the TAI CLI(?: as [^\n]+)?\.$/;

export function stampLine(persona?: ActingPersona): string {
    if (!persona) return "Posted via the TAI CLI.";
    const name = persona.displayName === persona.id ? persona.id : `${persona.displayName} (${persona.id})`;
    return `Posted via the TAI CLI as ${name}.`;
}

/** True if `body` already ends with a stamp line. */
export function isStamped(body: string): boolean {
    return STAMP_LINE.test(body.trimEnd().split("\n").at(-1)?.trim() ?? "");
}

/** `body` with the stamp as its last line. A body that already ends with a stamp (a session that
 *  typed one itself) has it replaced, never doubled — the CLI's own knowledge wins. */
export function stampComment(body: string, persona?: ActingPersona): string {
    let text = body.trimEnd();
    if (isStamped(text)) text = text.split("\n").slice(0, -1).join("\n").trimEnd();
    return text === "" ? stampLine(persona) : `${text}\n\n${stampLine(persona)}`;
}

// The sign-off steps (TAI-454/TAI-458): the human-gated subtasks (UAT, EpicReview, DesignReview) and closing an Epic.
const SIGN_OFF_SUBTASKS: ReadonlySet<string> = new Set(ALWAYS_HUMAN_GATED_SUBTASKS);
const SIGN_OFF_LABEL: Record<string, string> = {
    [SubtaskType.Uat]: "UAT",
    [SubtaskType.EpicReview]: "EpicReview",
    [SubtaskType.DesignReview]: "DesignReview",
    epic: "Epic",
};

/**
 * The comment the CLI leaves when IT performs a sign-off: moving a UAT, EpicReview or DesignReview
 * subtask, or an Epic, to Done. `null` for every other transition. Closing a Story or Bug is not a
 * sign-off (it follows from its subtasks).
 */
export function signOffComment(issue: Pick<Issue, "issueType">, target: Status, persona?: ActingPersona): string | null {
    if (target !== Status.Done) return null;
    if (issue.issueType !== "epic" && !SIGN_OFF_SUBTASKS.has(issue.issueType)) return null;
    return stampComment(`Sign-off: ${SIGN_OFF_LABEL[issue.issueType] ?? issue.issueType} moved to "${Status.Done}" through the TAI CLI.`, persona);
}

/** The PR comment that accompanies an approve / request-changes decision made through the CLI. */
export function reviewDecisionComment(decision: "approve" | "requestChanges", note: string | undefined, persona?: ActingPersona): string {
    const headline = decision === "approve" ? "Approved through the TAI CLI." : "Changes requested through the TAI CLI.";
    return stampComment(note && note.trim() !== "" ? `${note.trim()}\n\n${headline}` : headline, persona);
}
