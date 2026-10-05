/**
 * TAI-416/419 (ADR page 50692097): the ranked "needs an assignee" list for one ticket -- the single function behind
 * `issue create`'s output, `issue suggest`, the transition-gate rejection and /tai-ready's top suggestion, so
 * every surface shows the same order and the same reasons. Computed live, never stored.
 */

import { PERSONA_ROLE_LABEL } from "../schema/story-schema.js";
import type { HumanRef, Issue } from "../storage/interface.js";
import type { Roster } from "../personas/roster.js";
import { gatherAssigneeEvidence, type EvidenceReader } from "../personas/assignee-evidence.js";
import { rankAssignees, renderRankedAssignees, type RankedCandidate } from "../personas/assignee-ranking.js";

export interface SuggestAssigneesDeps {
    readonly workTracker: EvidenceReader;
    readonly roster: Roster;
    readonly areaWindowDays?: number;
    readonly now?: Date;
    readonly onWarning?: (message: string) => void;
}

export interface AssigneeSuggestion {
    readonly ranked: readonly RankedCandidate[];
    readonly text: string;
}

export async function suggestAssignees(
    deps: SuggestAssigneesDeps,
    issue: Issue,
    options: { readonly pin?: HumanRef | null }
): Promise<AssigneeSuggestion> {
    if (!issue.persona) {
        return {
            ranked: [],
            text: `Needs an assignee: ${issue.key} — it has no persona, so there is no roster to rank. Set one with issue update ${issue.key} persona=<PERSONA>.`,
        };
    }
    const candidates = deps.roster.humansFor(issue.persona);
    const evidence = await gatherAssigneeEvidence(deps.workTracker, issue, candidates, {
        ...(deps.areaWindowDays !== undefined ? { areaWindowDays: deps.areaWindowDays } : {}),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.onWarning ? { onWarning: deps.onWarning } : {}),
    });
    const ranked = rankAssignees(evidence, options.pin ? { pin: options.pin } : {});
    return { ranked, text: renderRankedAssignees({ issueKey: issue.key, personaLabel: PERSONA_ROLE_LABEL[issue.persona], ranked }) };
}
