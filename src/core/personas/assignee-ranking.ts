/**
 * TAI Framework — ranked assignee suggestions (TAI-416/419; ADR Confluence page 50692097)
 *
 * When 2 or more humans hold a ticket's persona and nobody was named, TAI shows a sorted list with a
 * REASON on every line instead of guessing (brief §5.5/§5.6). This module is the pure half: it orders
 * candidates from already-gathered evidence and renders the list. All reads (siblings, links, past
 * tickets, open counts) live in `assignee-evidence.ts`, same "pure resolve, loader does the I/O" split as
 * `assignment-helper.ts` and `roster.ts`.
 *
 * Order (ADR decision 6, strict tiers, never a score): continuity tier, then area knowledge, then
 * open-ticket count ascending, then name for stability. The author of work under review is DEMOTED to the
 * bottom with a visible reason, never removed (decision 10). The session's human can be PINNED first at
 * create time (decision 3).
 */

import type { HumanRef } from "../storage/interface.js";

export interface ContinuityEvidence {
    /** 1 = a sibling under the same Story (or the Dev of the Story a Bug relates to), 2 = a linked ticket, 3 = same Epic. */
    readonly tier: 1 | 2 | 3;
    readonly reasons: readonly string[];
}

export interface AreaEvidence {
    /** How many Done tickets with the same Component/labels this person was assigned within the window. */
    readonly count: number;
    readonly reasons: readonly string[];
}

export interface CandidateEvidence {
    /** The identity to DISPLAY (the roster's name and email -- `issue assign` takes the email). */
    readonly candidate: HumanRef;
    readonly continuity: ContinuityEvidence | null;
    readonly area: AreaEvidence | null;
    /** Open tickets assigned to them, or null when it could not be counted. */
    readonly openCount: number | null;
    /** True for a review-type ticket when this person is assigned the work under review. */
    readonly authoredWorkUnderReview: boolean;
}

export interface RankedCandidate {
    readonly candidate: HumanRef;
    readonly reasons: readonly string[];
    readonly openCount: number | null;
    readonly demoted: boolean;
}

export const PIN_REASON = "you are creating it";
export const DEMOTION_REASON = "authored the work under review";

const NO_TIER = 4;

export function rankAssignees(
    evidence: readonly CandidateEvidence[],
    options: { readonly pin?: HumanRef } = {}
): readonly RankedCandidate[] {
    const sorted = [...evidence].sort((a, b) => {
        if (a.authoredWorkUnderReview !== b.authoredWorkUnderReview) return a.authoredWorkUnderReview ? 1 : -1;
        const tier = (a.continuity?.tier ?? NO_TIER) - (b.continuity?.tier ?? NO_TIER);
        if (tier !== 0) return tier;
        const areaA = a.area?.count ?? 0;
        const areaB = b.area?.count ?? 0;
        if (areaA > 0 !== areaB > 0) return areaA > 0 ? -1 : 1;
        if (areaA !== areaB) return areaB - areaA;
        const loadA = a.openCount ?? Number.POSITIVE_INFINITY;
        const loadB = b.openCount ?? Number.POSITIVE_INFINITY;
        if (loadA !== loadB) return loadA - loadB;
        return a.candidate.displayName.localeCompare(b.candidate.displayName);
    });

    const ranked: RankedCandidate[] = sorted.map((e) => ({
        candidate: e.candidate,
        reasons: [
            ...(e.continuity?.reasons ?? []),
            ...(e.area?.reasons ?? []),
            ...(e.authoredWorkUnderReview ? [DEMOTION_REASON] : []),
        ],
        openCount: e.openCount,
        demoted: e.authoredWorkUnderReview,
    }));

    const pin = options.pin;
    if (!pin) return ranked;
    const index = ranked.findIndex((r) => samePerson(r.candidate, pin));
    if (index < 0) return ranked;
    const picked = ranked[index]!;
    const pinned: RankedCandidate = { ...picked, reasons: [PIN_REASON, ...picked.reasons] };
    return [pinned, ...ranked.filter((_, i) => i !== index)];
}

function samePerson(a: HumanRef, b: HumanRef): boolean {
    if (a.id === b.id) return true;
    if (a.email && b.email) return a.email.toLowerCase() === b.email.toLowerCase();
    return a.displayName.toLowerCase() === b.displayName.toLowerCase();
}

/**
 * The list the CLI prints. The last lines are the SHARED instruction (ADR decision 14) every persona sees,
 * wherever the list appears: an interactive session offers it to the human with its own question tool
 * (including "leave unassigned"); anything else leaves the ticket unassigned.
 */
export function renderRankedAssignees(input: {
    readonly issueKey: string;
    readonly personaLabel: string;
    readonly ranked: readonly RankedCandidate[];
}): string {
    const { issueKey, personaLabel, ranked } = input;
    if (ranked.length === 0) {
        return `Needs an assignee: ${issueKey} — No one is listed for ${personaLabel} in the Persona Roster. Leave it unassigned or assign someone by name with issue assign ${issueKey} <EMAIL>.`;
    }
    const lines = ranked.map((r, i) => {
        const who = r.candidate.email ? `${r.candidate.displayName} (${r.candidate.email})` : r.candidate.displayName;
        const reasons = r.reasons.length > 0 ? r.reasons.join("; ") : "no signal";
        const open = r.openCount === null ? "open tickets unknown" : `${r.openCount} open ticket${r.openCount === 1 ? "" : "s"}`;
        return `  ${i + 1}. ${who} — ${reasons} · ${open}`;
    });
    return [
        `Needs an assignee: ${issueKey} — candidates for ${personaLabel}, best first:`,
        ...lines,
        `  ${ranked.length + 1}. Leave unassigned`,
        `To assign: issue assign ${issueKey} <EMAIL>.`,
        `Interactive session: offer this list to the human, including "Leave unassigned", with your question tool, then run issue assign for the pick; otherwise leave the ticket unassigned.`,
    ].join("\n");
}
