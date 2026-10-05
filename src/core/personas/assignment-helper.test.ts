import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Persona } from "../schema/story-schema.js";
import { toHumanId, type HumanRef } from "../storage/interface.js";
import { parseRoster } from "./roster.js";
import { resolveAssignment } from "./assignment-helper.js";

function human(id: string, displayName: string, email?: string): HumanRef {
    return { id: toHumanId(id), displayName, ...(email ? { email } : {}) };
}

const soleCandidateRoster = parseRoster("| Persona | Humans |\n| --- | --- |\n| Developer | del (del@mayhak.com) |");

const multiCandidateRoster = parseRoster(
    "| Persona | Humans |\n| --- | --- |\n| PM | ada (ada@example.com), perry (perry@example.com) |"
);

const zeroCandidateRoster = parseRoster("| Persona | Humans |\n| --- | --- |\n| PM | ada (ada@example.com) |");

describe("resolveAssignment at creation (TAI-419 ADR decision 2: the rev 54 shortcut is removed at create)", () => {
    it("sole candidate: still pre-assigned at create", () => {
        const result = resolveAssignment(soleCandidateRoster, Persona.Developer, null, { atCreate: true });
        assert.equal(result.assignee?.email, "del@mayhak.com");
    });

    it("2+ candidates and the session's human is one of them: NOT auto-assigned at create (they get the pinned list instead)", () => {
        const result = resolveAssignment(multiCandidateRoster, Persona.Pm, human("p", "perry", "perry@example.com"), { atCreate: true });
        assert.equal(result.assignee, null);
        assert.equal(result.candidates.length, 2);
    });

    it("the same case without atCreate (claim / transition time) still auto-assigns, unchanged", () => {
        const result = resolveAssignment(multiCandidateRoster, Persona.Pm, human("p", "perry", "perry@example.com"));
        assert.equal(result.assignee?.email, "perry@example.com");
    });
});

describe("resolveAssignment", () => {
    it("sole candidate: assigns unconditionally, regardless of currentHuman (brief §5.5, pre-existing rule)", () => {
        const result = resolveAssignment(soleCandidateRoster, Persona.Developer, null);
        assert.equal(result.assignee?.email, "del@mayhak.com");
        assert.equal(result.candidates.length, 1);
    });

    it("sole candidate: still resolves to that human even when currentHuman is someone else entirely", () => {
        const result = resolveAssignment(soleCandidateRoster, Persona.Developer, human("x", "someone else", "other@x.test"));
        assert.equal(result.assignee?.email, "del@mayhak.com");
    });

    it("2+ candidates, currentHuman matches one: auto-assigns them (TAI-249 ADR extension)", () => {
        const result = resolveAssignment(multiCandidateRoster, Persona.Pm, human("p", "perry", "perry@example.com"));
        assert.equal(result.assignee?.email, "perry@example.com");
        assert.equal(result.candidates.length, 2);
    });

    it("2+ candidates, currentHuman matches by id even when email differs (sameHuman checks id first)", () => {
        // parseHumanCell derives id from the roster's own email (lowercased) -- constructing
        // currentHuman with that same id but a stale/different email still matches, proving
        // id takes priority over email in the underlying sameHuman check.
        const result = resolveAssignment(multiCandidateRoster, Persona.Pm, {
            id: toHumanId("perry@example.com"),
            displayName: "Perry",
            email: "different@x.test",
        });
        assert.equal(result.assignee?.id, "perry@example.com");
    });

    it("2+ candidates, currentHuman doesn't match any: does not guess, surfaces all candidates", () => {
        const result = resolveAssignment(multiCandidateRoster, Persona.Pm, human("z", "intruder", "intruder@x.test"));
        assert.equal(result.assignee, null);
        assert.equal(result.candidates.length, 2);
    });

    it("2+ candidates, no currentHuman at all: does not guess (today's unchanged 'always ask' behavior)", () => {
        const result = resolveAssignment(multiCandidateRoster, Persona.Pm, null);
        assert.equal(result.assignee, null);
        assert.equal(result.candidates.length, 2);
    });

    it("zero candidates: assignee null, empty candidate list -- nothing to surface", () => {
        const result = resolveAssignment(zeroCandidateRoster, Persona.Developer, null);
        assert.equal(result.assignee, null);
        assert.deepEqual(result.candidates, []);
    });
});
