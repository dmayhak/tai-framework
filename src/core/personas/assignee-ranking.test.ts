import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toHumanId, type HumanRef } from "../storage/interface.js";
import { rankAssignees, renderRankedAssignees, type CandidateEvidence } from "./assignee-ranking.js";

const human = (name: string): HumanRef => ({ id: toHumanId(name.toLowerCase()), displayName: name, email: `${name.toLowerCase()}@example.com` });
const ev = (name: string, over: Partial<CandidateEvidence> = {}): CandidateEvidence => ({
    candidate: human(name),
    continuity: null,
    area: null,
    openCount: 0,
    authoredWorkUnderReview: false,
    ...over,
});
const names = (r: readonly { candidate: HumanRef }[]) => r.map((x) => x.candidate.displayName);

describe("rankAssignees (TAI-419 ADR decision 6)", () => {
    it("orders by continuity tier first, strongest first", () => {
        const ranked = rankAssignees([
            ev("Cy", { continuity: { tier: 3, reasons: ["worked on this Epic"] } }),
            ev("Ann", { continuity: { tier: 1, reasons: ["worked on this Story (TAI-1)"] } }),
            ev("Bo", { continuity: { tier: 2, reasons: ["worked on related ticket TAI-2"] } }),
            ev("Di"),
        ]);
        assert.deepEqual(names(ranked), ["Ann", "Bo", "Cy", "Di"]);
    });

    it("within the same continuity tier, area knowledge ranks next, more closed tickets first", () => {
        const c = { tier: 1 as const, reasons: ["worked on this Story (TAI-1)"] };
        const ranked = rankAssignees([
            ev("Ann", { continuity: c }),
            ev("Bo", { continuity: c, area: { count: 1, reasons: ["closed 1 ticket under component x"] } }),
            ev("Cy", { continuity: c, area: { count: 4, reasons: ["closed 4 tickets under component x"] } }),
        ]);
        assert.deepEqual(names(ranked), ["Cy", "Bo", "Ann"]);
    });

    it("area knowledge outranks load, and load (fewest open tickets) breaks the remaining ties", () => {
        const ranked = rankAssignees([
            ev("Ann", { openCount: 0 }),
            ev("Bo", { openCount: 9, area: { count: 2, reasons: ["closed 2 tickets under component x"] } }),
            ev("Cy", { openCount: 3 }),
        ]);
        assert.deepEqual(names(ranked), ["Bo", "Ann", "Cy"]);
    });

    it("an unknown open count sorts after a known one, and the name keeps the order stable", () => {
        const ranked = rankAssignees([ev("Zed", { openCount: 2 }), ev("Ann", { openCount: null }), ev("Bob", { openCount: 2 })]);
        assert.deepEqual(names(ranked), ["Bob", "Zed", "Ann"]);
    });

    it("the author of the work under review is DEMOTED below everyone else, not removed, and says why", () => {
        const ranked = rankAssignees([
            ev("Ann", { continuity: { tier: 1, reasons: ["worked on this Story (TAI-1)"] }, authoredWorkUnderReview: true }),
            ev("Bo"),
        ]);
        assert.deepEqual(names(ranked), ["Bo", "Ann"]);
        assert.equal(ranked[1]!.demoted, true);
        assert.deepEqual(ranked[1]!.reasons, ["worked on this Story (TAI-1)", "authored the work under review"]);
    });

    it("pin puts the session's human first with 'you are creating it', keeping their other reasons", () => {
        const ranked = rankAssignees(
            [
                ev("Ann", { continuity: { tier: 1, reasons: ["worked on this Story (TAI-1)"] } }),
                ev("Bo", { openCount: 5, area: { count: 2, reasons: ["closed 2 tickets under component x"] } }),
            ],
            { pin: human("Bo") }
        );
        assert.deepEqual(names(ranked), ["Bo", "Ann"]);
        assert.deepEqual(ranked[0]!.reasons, ["you are creating it", "closed 2 tickets under component x"]);
    });

    it("a pin that is not among the candidates changes nothing", () => {
        assert.deepEqual(names(rankAssignees([ev("Ann"), ev("Bo")], { pin: human("Zed") })), ["Ann", "Bo"]);
    });

    it("carries each candidate's reasons in order and their open-ticket count", () => {
        const [first] = rankAssignees([
            ev("Ann", {
                openCount: 4,
                continuity: { tier: 1, reasons: ["worked on this Story (TAI-1)", "worked on related ticket TAI-9"] },
                area: { count: 3, reasons: ["closed 3 tickets under component x in the last 90 days"] },
            }),
        ]);
        assert.deepEqual(first!.reasons, [
            "worked on this Story (TAI-1)",
            "worked on related ticket TAI-9",
            "closed 3 tickets under component x in the last 90 days",
        ]);
        assert.equal(first!.openCount, 4);
    });

    it("an empty candidate list ranks to an empty list", () => {
        assert.deepEqual(rankAssignees([]), []);
    });
});

describe("renderRankedAssignees (TAI-419)", () => {
    const ranked = rankAssignees([
        ev("Ann", { openCount: 1, continuity: { tier: 1, reasons: ["worked on this Story (TAI-1)"] } }),
        ev("Bo", { openCount: 3 }),
    ]);

    it("numbers each candidate with email, reasons and open count, ends with 'leave unassigned' and the assign command", () => {
        const out = renderRankedAssignees({ issueKey: "TAI-7", personaLabel: "Developer", ranked });
        assert.match(out, /Needs an assignee: TAI-7/);
        assert.match(out, /1\. Ann \(ann@example\.com\) — worked on this Story \(TAI-1\) · 1 open ticket/);
        assert.match(out, /2\. Bo \(bo@example\.com\) — no signal · 3 open tickets/);
        assert.match(out, /Leave unassigned/);
        assert.match(out, /issue assign TAI-7 <EMAIL>/);
    });

    it("tells an interactive session to offer the list, including leave unassigned (the shared instruction)", () => {
        const out = renderRankedAssignees({ issueKey: "TAI-7", personaLabel: "Developer", ranked });
        assert.match(out, /Interactive session: offer this list to the human/i);
        assert.match(out, /otherwise leave the ticket unassigned/i);
    });

    it("says so when nobody holds the persona", () => {
        assert.match(renderRankedAssignees({ issueKey: "TAI-7", personaLabel: "Developer", ranked: [] }), /No one is listed for Developer/);
    });
});
