import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Persona, PERSONA_ROLE_LABEL } from "../schema/story-schema.js";
import { JIRA_PERSONA } from "../storage/jira/mappers.js";
import { toHumanId } from "../storage/interface.js";
import { parseRoster, parseHumanCell, Roster } from "./roster.js";

// The live page, verbatim through DocStore (prose above and below the table included).
const LIVE_ROSTER = `TAI's own storage-agnostic human↔persona registry (PROJECT_BRIEF.md §5.6, rev 12). This page is what TAI checks.

A human can be listed under more than one persona.

| Persona | Authorized humans |
| --- | --- |
| Analyst | del ([del@mayhak.com](mailto:del@mayhak.com)) |
| PM | del ([del@mayhak.com](mailto:del@mayhak.com)) |
| Architect | del ([del@mayhak.com](mailto:del@mayhak.com)) |
| UX Designer | del ([del@mayhak.com](mailto:del@mayhak.com)) |
| Developer | del ([del@mayhak.com](mailto:del@mayhak.com)) |
| DBA | del ([del@mayhak.com](mailto:del@mayhak.com)) |
| Code Reviewer | del ([del@mayhak.com](mailto:del@mayhak.com)) |
| Tester | del ([del@mayhak.com](mailto:del@mayhak.com)) |
| DevOps | del ([del@mayhak.com](mailto:del@mayhak.com)) |

Cached locally, refreshed at the usual refresh points.`;

describe("canonical label map (drift guard)", () => {
    it("the Jira Persona field options ARE the role labels — one source, no drift", () => {
        // If these ever diverge, roster parsing and Jira persona writes disagree about what a
        // role is called, and authorized humans silently stop matching. This is the guard.
        assert.deepEqual(JIRA_PERSONA, PERSONA_ROLE_LABEL);
    });
});

describe("parseHumanCell", () => {
    it("parses 'Name ([email](mailto:email))'", () => {
        const [h] = parseHumanCell("del ([del@mayhak.com](mailto:del@mayhak.com))");
        assert.equal(h?.displayName, "del");
        assert.equal(h?.email, "del@mayhak.com");
        assert.equal(h?.id, toHumanId("del@mayhak.com"));
    });

    it("parses a bare email, deriving a name", () => {
        const [h] = parseHumanCell("jordan@x.test");
        assert.equal(h?.email, "jordan@x.test");
        assert.equal(h?.displayName, "jordan");
    });

    it("parses a bare name with no email", () => {
        const [h] = parseHumanCell("Sam Rivera");
        assert.equal(h?.displayName, "Sam Rivera");
        assert.equal(h?.email, undefined);
    });

    it("parses several humans in one cell", () => {
        const hs = parseHumanCell("del ([del@mayhak.com](mailto:del@mayhak.com)), Sam Rivera");
        assert.equal(hs.length, 2);
        assert.equal(hs[1]?.displayName, "Sam Rivera");
    });
});

describe("parseRoster", () => {
    it("parses every persona from the live page shape", () => {
        const roster = parseRoster(LIVE_ROSTER);
        for (const persona of Object.values(Persona)) {
            const humans = roster.humansFor(persona);
            assert.equal(humans.length, 1, `expected one human for ${persona}`);
            assert.equal(humans[0]?.email, "del@mayhak.com");
        }
    });

    it("handles the tricky labels (UX Designer, Code Reviewer, DBA, PM)", () => {
        const roster = parseRoster(LIVE_ROSTER);
        assert.equal(roster.humansFor(Persona.UxDesigner).length, 1);
        assert.equal(roster.humansFor(Persona.CodeReviewer).length, 1);
        assert.equal(roster.humansFor(Persona.Dba).length, 1);
        assert.equal(roster.humansFor(Persona.Pm).length, 1);
    });

    it("is case- and whitespace-tolerant in the persona column (human-edited)", () => {
        const md = "| Persona | Humans |\n| --- | --- |\n| code REVIEWER | a@b.co |\n|  ux  designer | d@e.co |";
        const roster = parseRoster(md);
        assert.equal(roster.humansFor(Persona.CodeReviewer)[0]?.email, "a@b.co");
        assert.equal(roster.humansFor(Persona.UxDesigner)[0]?.email, "d@e.co");
    });

    it("supports one human under multiple personas (solo/small-team)", () => {
        const roster = parseRoster(LIVE_ROSTER);
        const personas = roster.personasFor({ id: toHumanId("x"), email: "del@mayhak.com" });
        assert.equal(personas.length, 9);
    });

    it("skips an unknown persona label rather than crashing", () => {
        const md = "| Persona | Humans |\n| --- | --- |\n| Scrum Master | a@b.c |\n| PM | p@m.co |";
        const roster = parseRoster(md);
        assert.equal(roster.humansFor(Persona.Pm)[0]?.email, "p@m.co");
    });

    it("throws rather than returning an empty roster when there is no table", () => {
        // An empty roster would silently deny every review gate — fail loud instead.
        assert.throws(() => parseRoster("Just prose, no table here."), /no recognisable table/);
    });
});

describe("Roster queries", () => {
    const roster = parseRoster(LIVE_ROSTER);

    it("isAuthorized matches by email even when the id differs (accountId vs email)", () => {
        // The real case: a comment author arrives as a Jira accountId; the roster stored an
        // email. They must still match.
        assert.equal(
            roster.isAuthorized(Persona.Pm, { id: toHumanId("712020:abc"), email: "del@mayhak.com" }),
            true
        );
    });

    it("isAuthorized matches by display name as a last resort", () => {
        assert.equal(roster.isAuthorized(Persona.Pm, { id: toHumanId("whatever"), displayName: "del" }), true);
    });

    it("rejects a human who isn't listed", () => {
        assert.equal(
            roster.isAuthorized(Persona.Pm, { id: toHumanId("z"), email: "intruder@x.test" }),
            false
        );
    });

    it("soleHumanFor returns the human when exactly one is listed (pre-assign case §5.5)", () => {
        assert.equal(roster.soleHumanFor(Persona.Developer)?.email, "del@mayhak.com");
    });

    it("soleHumanFor returns null when a persona has 0 or >1 humans", () => {
        const md = "| Persona | Humans |\n| --- | --- |\n| PM | a@b.c, d@e.f |";
        const r = parseRoster(md);
        assert.equal(r.soleHumanFor(Persona.Pm), null); // two candidates -> don't guess
        assert.equal(r.soleHumanFor(Persona.Developer), null); // none listed
    });

    it("round-trips through JSON (the cache format)", () => {
        const restored = Roster.fromJSON(JSON.parse(JSON.stringify(roster.toJSON())));
        assert.equal(restored.humansFor(Persona.Architect)[0]?.email, "del@mayhak.com");
    });
});
