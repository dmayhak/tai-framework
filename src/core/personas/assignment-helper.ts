/**
 * TAI Framework — the assignment-helper (brief §5.5/§5.6; TAI-249/260 ADR, Confluence page
 * 30572546)
 *
 * Brief §5.5's two rules in one function: pre-assign when exactly one Persona Roster
 * candidate exists, and the ratified extension — when 2+ candidates exist, auto-assign the
 * CURRENT session's human if they're one of the candidates, rather than always asking (since
 * TAI-419 only at claim/transition time, not at creation; the ranked list lives in `assignee-ranking.ts`).
 * Neither rule guesses beyond that: with 2+ candidates and no matching current human, a
 * human must pick (the caller surfaces `candidates`, never invents an assignee).
 *
 * Deliberately pure — no I/O, no `DocStore`/`WorkTracker` access — same "pure resolve
 * function, loader adds fetch+cache" split `roster.ts` already establishes. Both call sites
 * (`cli.ts`'s `issue create` and `issue transition` handlers) already have a loaded `Roster`
 * and a resolved `currentHuman` (or `null`) on hand; this function only ever needs those.
 *
 * `WorkTracker.createIssue` is deliberately NOT where this gets called from, in either
 * backend — see the ADR's Decision §1. The multi-candidate shortcut needs session identity
 * (`TAI_JIRA_EMAIL`/`TAI_HUMAN_EMAIL`), a host-layer (`cli.ts`) concern never threaded into
 * backend internals, and duplicating even the sole-candidate half across both backends risks
 * exactly the copy-drift regression `assignment-gate.ts`'s own header already documents.
 */

import type { Persona } from "../schema/story-schema.js";
import type { HumanRef } from "../storage/interface.js";
import { sameHuman, type Roster } from "./roster.js";

export interface AssignmentResolution {
    /** The resolved pick, or `null` if a human must choose (2+ candidates, none of them
     *  the current session's human — or zero candidates at all). */
    readonly assignee: HumanRef | null;
    /** The full Persona Roster candidate list for `persona` — always returned, even when
     *  `assignee` already resolved, so a caller can show/log who else was eligible. */
    readonly candidates: readonly HumanRef[];
}

/**
 * Resolves who should be assigned a ticket whose owning persona is `persona`:
 * - Exactly one roster candidate: that human, unconditionally (brief §5.5, pre-existing).
 * - 2+ candidates, current session's human is among them: that human (TAI-249 ADR
 *   extension; NOT at creation since TAI-419 -- see `options.atCreate`) — `currentHuman` is matched via `sameHuman` (id, then email, then
 *   case-insensitive display name), same matching this codebase already uses everywhere
 *   else a `HumanRef` gets compared against a roster entry.
 * - Otherwise (2+ candidates and no match, or zero candidates): `assignee: null` — the
 *   caller must surface `candidates` and let a human pick. Never guesses further.
 */
export function resolveAssignment(
    roster: Roster,
    persona: Persona,
    currentHuman: HumanRef | null,
    options: { readonly atCreate?: boolean } = {}
): AssignmentResolution {
    const candidates = roster.humansFor(persona);

    if (candidates.length === 1) {
        return { assignee: candidates[0]!, candidates };
    }

    // TAI-416/419 ADR decision 2: at CREATE the session's human is no longer silently assigned when several
    // humans hold the persona (someone logging a ticket for a colleague must not become its owner); they get a
    // ranked list with themselves pinned first instead. The shortcut stays at claim and transition time.
    if (candidates.length > 1 && currentHuman && !options.atCreate) {
        const match = candidates.find((c) => sameHuman(c, currentHuman));
        if (match) return { assignee: match, candidates };
    }

    return { assignee: null, candidates };
}
