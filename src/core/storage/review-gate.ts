/**
 * TAI Framework — brief §3.3/§5.6/§5.4's `REVIEW_GATES` enforcement ("Approved:" sign-off)
 *
 * A SINGLE shared implementation, imported by every backend's `transition()` — same "one
 * copy, both backends import it" discipline as assignment-gate.ts (TAI-15), for the same
 * reason: brief §3.3 says checkpoint enforcement is "enforced once, centrally, in the
 * storage plugin's transition operation," meaning every backend's, not repeated per backend
 * or per persona.
 *
 * Brief §3.9: sign-off is recorded as an `Approved:`-prefixed comment from each persona in
 * `REVIEW_GATES[storyType].requiredReviewers`; the commenting human must additionally
 * appear in the Persona Roster (brief §5.6) under that persona for it to count — otherwise
 * anyone typing "Approved:" would satisfy a gate meant to require a specific role's actual
 * sign-off. Always a FRESH re-scan of `issue.comments` (brief §3.9, via comment-markers.ts)
 * — nothing here is cached across calls, so an edited-away `Approved:` comment reopens the
 * gate for free, no separate invalidation mechanism needed.
 *
 * The only status transition currently tied to a review gate: a story-level issue reaching
 * `Done` (`workflows/kickoff.md`'s own Status Transitions section: "gate passed, Story/Spike
 * tickets created from the WBS" — documented as arriving via `In Review`, but checked on
 * ANY transition to `Done`, not conditioned on the FROM status; see `reviewGateApplies`'s
 * own comment for why). `REVIEW_GATES` is keyed by StoryType, not by transition target, so
 * that mapping is made explicit here rather than guessed at differently by each backend.
 */

import { type Persona, PERSONA_ROLE_LABEL, REVIEW_GATES, Status, StoryType } from "../schema/story-schema.js";
import type { Issue, IssueKey, Page, PageId } from "./interface.js";
import { parseCommentMarkers } from "./comment-markers.js";

const STORY_TYPES: ReadonlySet<string> = new Set(Object.values(StoryType));

function isStoryType(issueType: Issue["issueType"]): issueType is StoryType {
    return STORY_TYPES.has(issueType);
}

/** Minimal shape `checkReviewGate` needs from a Persona Roster (brief §5.6) — matches
 *  `Roster.isAuthorized` (src/core/personas/roster.ts) without importing its concrete class,
 *  so this module stays testable with a plain fake. */
export interface RosterLike {
    isAuthorized(
        persona: Persona,
        human: { readonly id: string; readonly email?: string; readonly displayName?: string }
    ): boolean;
}

/**
 * True if this specific transition is one review gates apply to for this issue.
 *
 * Deliberately NOT conditioned on the issue's current status (e.g. requiring it already be
 * `In Review`) even though that's the documented path (`workflows/kickoff.md`'s Status
 * Transitions section). Neither backend enforces strict workflow ordering — the filesystem
 * backend is permissive by design, and the live Jira project's own capability flag
 * (`strictWorkflow: false`, conformance.ts) confirms Jira doesn't either. A gate keyed to
 * "coming from In Review" would be trivially bypassable by transitioning straight from `To
 * Do`/`In Progress` to `Done`, which defeats the entire point of a gate only a
 * human's approval passes. So this checks only the one thing that
 * actually matters: is the TARGET `Done` for a gated StoryType — regardless of where it's
 * coming from.
 */
export function reviewGateApplies(issue: Issue, target: Status): boolean {
    if (!isStoryType(issue.issueType)) return false;
    return target === Status.Done && REVIEW_GATES.some((g) => g.storyType === issue.issueType);
}

export interface ReviewGateCheck {
    readonly ok: boolean;
    /** Required reviewers with no qualifying `Approved:` comment. Empty when ok. */
    readonly missing: readonly Persona[];
}

export function checkReviewGate(issue: Issue, roster: RosterLike): ReviewGateCheck {
    if (!isStoryType(issue.issueType)) return { ok: true, missing: [] };
    const gate = REVIEW_GATES.find((g) => g.storyType === issue.issueType);
    if (!gate) return { ok: true, missing: [] };

    const approvals = parseCommentMarkers(issue.comments).filter((m) => m.kind === "Approved");
    const missing = gate.requiredReviewers.filter(
        (persona) => !approvals.some((a) => roster.isAuthorized(persona, a.comment.author))
    );
    return { ok: missing.length === 0, missing };
}

export function reviewGateReason(key: IssueKey, missing: readonly Persona[]): string {
    const labels = missing.map((p) => PERSONA_ROLE_LABEL[p]).join(", ");
    return (
        `${key} is blocked by its review gate (brief §3.3/§5.6) — missing "Approved:" sign-off ` +
        `from: ${labels}. Each required reviewer must comment "Approved:" on this issue and ` +
        `appear in the Persona Roster under that persona.`
    );
}

// ---------- Unresolved NEEDS CLARIFICATION markers (TAI-480; human decision TAI-455, row 6) ----------

/**
 * While drafting, the PM and UX Designer mark a real gap inline with
 * `NEEDS CLARIFICATION: <question>` instead of guessing (`workflows/kickoff.md`). A gated ticket may
 * not reach Done while a page linked to it still carries one: the marker is resolved by editing it
 * out once the question is answered, not by approving around it.
 *
 * A marker inside code formatting (a fenced block or an inline code span) does not count, so a page
 * can describe the convention without tripping the gate.
 *
 * Pages on the Jira backend are converted from Confluence storage to markdown, so a marker may come
 * back with emphasis on part of it (`**NEEDS** CLARIFICATION`) or a line break between its two
 * words. Both still count: the two words are joined before the line scan. A longer word that merely
 * starts with the marker (`NEEDS CLARIFICATIONS`, `NEEDS CLARIFICATION-free`) does not.
 */
export const CLARIFICATION_MARKER = "NEEDS CLARIFICATION";

export interface UnresolvedClarifications {
    readonly pageId: PageId;
    readonly title: string;
    /** The text after each marker on its line, trimmed; "" when the marker stands alone. */
    readonly questions: readonly string[];
}

const FENCED_BLOCK = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
const INLINE_CODE = /`[^`\n]*`/g;
/** The marker's two words with only whitespace and emphasis characters between them. */
const SPLIT_MARKER = /NEEDS[\s*_~]+CLARIFICATION(?![A-Za-z]|-[A-Za-z])/g;
const MARKER_LINE = /NEEDS CLARIFICATION(?![A-Za-z]|-[A-Za-z])[*_~]*\s*:?\s*(.*)$/;

/** Every unresolved marker in one page's markdown, in order. */
export function findClarificationQuestions(content: string): string[] {
    const prose = content.replace(FENCED_BLOCK, "").replace(INLINE_CODE, "").replace(SPLIT_MARKER, CLARIFICATION_MARKER);
    const questions: string[] = [];
    for (const line of prose.split("\n")) {
        const match = MARKER_LINE.exec(line);
        if (match) questions.push(match[1]!.replace(/^[-–—]\s*/, "").replace(/[*_\s]+$/, "").trim());
    }
    return questions;
}

/** The pages, of those given, that still carry at least one unresolved marker. */
export function findUnresolvedClarifications(pages: readonly Pick<Page, "id" | "title" | "content">[]): UnresolvedClarifications[] {
    return pages
        .map((page) => ({ pageId: page.id, title: page.title, questions: findClarificationQuestions(page.content) }))
        .filter((found) => found.questions.length > 0);
}

/**
 * Reads the pages linked to a gated ticket and returns the ones with unresolved markers. Shared by
 * both backends' `transition()`, like `checkReviewGate`. A linked page that no longer exists is
 * skipped; a page that cannot be read fails the transition, since "could not check" must not pass.
 */
export async function checkClarificationGate(
    key: IssueKey,
    io: { getLinkedPages(key: IssueKey): Promise<readonly PageId[]>; getPage(ref: { readonly id: PageId }): Promise<Pick<Page, "id" | "title" | "content"> | null> }
): Promise<UnresolvedClarifications[]> {
    const pages: Pick<Page, "id" | "title" | "content">[] = [];
    for (const id of await io.getLinkedPages(key)) {
        const page = await io.getPage({ id });
        if (page) pages.push(page);
    }
    return findUnresolvedClarifications(pages);
}

export function clarificationGateReason(key: IssueKey, unresolved: readonly UnresolvedClarifications[]): string {
    const total = unresolved.reduce((n, u) => n + u.questions.length, 0);
    const lines = unresolved.flatMap((u) => u.questions.map((q) => `- "${u.title}" (page ${u.pageId}): ${q === "" ? "(no question written after the marker)" : q}`));
    return (
        `${key} is blocked by its review gate — ${total} unresolved "${CLARIFICATION_MARKER}" marker${total === 1 ? "" : "s"} in the pages linked to it:\n` +
        `${lines.join("\n")}\n` +
        "Answer each question and edit its marker out of the page; approving does not resolve one."
    );
}

