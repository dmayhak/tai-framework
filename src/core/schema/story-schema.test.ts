/**
 * Precedence tests for the optional gates (DesignReview, UAT).
 *
 * The load-bearing property being locked down here is that both gates are
 * PURELY ADDITIVE: when a gate subtask is absent, it passes its prerequisites
 * through (ArchitectureDesign -> Dev; test tiers -> Deploy), TAI-463. When
 * present, the gate inserts itself without weakening the surrounding edges.
 *
 * Run: `npm test`
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    Persona,
    SUBTASK_OWNER,
    defaultPersonaFor,
    StoryType,
    SubtaskType,
    resolveApplicablePrecedence,
    isSubtaskReady,
    unblockedAbsentSubtaskTypes,
    getNewPrecedenceEdgesForInsertedSubtask,
    defaultTestTiersForBug,
    EXPEDITED_BUG_PRIORITY,
    ALWAYS_HUMAN_GATED_SUBTASKS,
    STORY_SUBTASK_MAP,
    type SubtaskPrecedenceRule,
} from "./story-schema.js";

const hasEdge = (
    rules: SubtaskPrecedenceRule[],
    before: SubtaskType,
    after: SubtaskType
): boolean => rules.some((r) => r.before === before && r.after === after);

const done = (...types: SubtaskType[]): Set<SubtaskType> => new Set(types);

describe("DesignReview gate (optional)", () => {
    it("inserts ArchitectureDesign -> DesignReview -> Dev when present", () => {
        const present = [
            SubtaskType.ArchitectureDesign,
            SubtaskType.DesignReview,
            SubtaskType.Dev,
        ];
        const rules = resolveApplicablePrecedence(StoryType.Story, present);
        assert.ok(hasEdge(rules, SubtaskType.ArchitectureDesign, SubtaskType.DesignReview));
        assert.ok(hasEdge(rules, SubtaskType.DesignReview, SubtaskType.Dev));
    });

    it("blocks Dev until DesignReview is done, not just ArchitectureDesign", () => {
        const present = [
            SubtaskType.ArchitectureDesign,
            SubtaskType.DesignReview,
            SubtaskType.Dev,
        ];
        // ArchitectureDesign done but DesignReview not yet -> Dev still blocked.
        assert.equal(
            isSubtaskReady(SubtaskType.Dev, StoryType.Story, present, done(SubtaskType.ArchitectureDesign)),
            false
        );
        // Both done -> Dev ready.
        assert.equal(
            isSubtaskReady(
                SubtaskType.Dev,
                StoryType.Story,
                present,
                done(SubtaskType.ArchitectureDesign, SubtaskType.DesignReview)
            ),
            true
        );
    });

    it("DesignReview itself waits on ArchitectureDesign", () => {
        const present = [SubtaskType.ArchitectureDesign, SubtaskType.DesignReview, SubtaskType.Dev];
        assert.equal(
            isSubtaskReady(SubtaskType.DesignReview, StoryType.Story, present, done()),
            false
        );
        assert.equal(
            isSubtaskReady(
                SubtaskType.DesignReview,
                StoryType.Story,
                present,
                done(SubtaskType.ArchitectureDesign)
            ),
            true
        );
    });

    it("is registered as inherently human-gated -- Aria prepares it, but only a human can complete it (TAI-458)", () => {
        assert.ok(ALWAYS_HUMAN_GATED_SUBTASKS.includes(SubtaskType.DesignReview));
    });

    it("COLLAPSES: with no DesignReview, ArchitectureDesign unblocks Dev directly", () => {
        const present = [SubtaskType.ArchitectureDesign, SubtaskType.Dev];
        const rules = resolveApplicablePrecedence(StoryType.Story, present);
        assert.ok(hasEdge(rules, SubtaskType.ArchitectureDesign, SubtaskType.Dev));
        // No DesignReview edges leak in.
        assert.ok(!rules.some((r) => r.before === SubtaskType.DesignReview || r.after === SubtaskType.DesignReview));
        assert.equal(
            isSubtaskReady(SubtaskType.Dev, StoryType.Story, present, done(SubtaskType.ArchitectureDesign)),
            true
        );
    });
});

describe("Requirements on a Story (TAI-458)", () => {
    it("is an allowed Story subtask, for a future-direction question handed to the PM", () => {
        assert.ok(STORY_SUBTASK_MAP[StoryType.Story].includes(SubtaskType.Requirements));
    });

    it("has no precedence edge on a Story: it neither waits on nor blocks its siblings", () => {
        const present = [SubtaskType.Requirements, SubtaskType.ArchitectureDesign, SubtaskType.Dev];
        const rules = resolveApplicablePrecedence(StoryType.Story, present);
        assert.ok(!rules.some((r) => r.before === SubtaskType.Requirements || r.after === SubtaskType.Requirements));
        assert.equal(isSubtaskReady(SubtaskType.Requirements, StoryType.Story, present, done()), true);
    });
});

describe("EpicReview gate (Kickoff, mandatory, human-gated, TAI-354)", () => {
    const kickoffSubtasks = [
        SubtaskType.Research,
        SubtaskType.EpicReview,
        SubtaskType.Requirements,
        SubtaskType.UxDesign,
    ];

    it("inserts Research -> EpicReview -> {Requirements, UxDesign}", () => {
        const rules = resolveApplicablePrecedence(StoryType.Kickoff, kickoffSubtasks);
        assert.ok(hasEdge(rules, SubtaskType.Research, SubtaskType.EpicReview));
        assert.ok(hasEdge(rules, SubtaskType.EpicReview, SubtaskType.Requirements));
        assert.ok(hasEdge(rules, SubtaskType.EpicReview, SubtaskType.UxDesign));
        // Research no longer unblocks Requirements/UxDesign directly.
        assert.ok(!hasEdge(rules, SubtaskType.Research, SubtaskType.Requirements));
        assert.ok(!hasEdge(rules, SubtaskType.Research, SubtaskType.UxDesign));
    });

    it("blocks Requirements/UxDesign until EpicReview is done, not just Research", () => {
        // Research done but EpicReview not yet -> both still blocked.
        assert.equal(
            isSubtaskReady(SubtaskType.Requirements, StoryType.Kickoff, kickoffSubtasks, done(SubtaskType.Research)),
            false
        );
        assert.equal(
            isSubtaskReady(SubtaskType.UxDesign, StoryType.Kickoff, kickoffSubtasks, done(SubtaskType.Research)),
            false
        );
        // EpicReview done too -> both ready.
        const bothDone = done(SubtaskType.Research, SubtaskType.EpicReview);
        assert.equal(isSubtaskReady(SubtaskType.Requirements, StoryType.Kickoff, kickoffSubtasks, bothDone), true);
        assert.equal(isSubtaskReady(SubtaskType.UxDesign, StoryType.Kickoff, kickoffSubtasks, bothDone), true);
    });

    it("EpicReview itself waits on Research", () => {
        assert.equal(
            isSubtaskReady(SubtaskType.EpicReview, StoryType.Kickoff, kickoffSubtasks, done()),
            false
        );
        assert.equal(
            isSubtaskReady(SubtaskType.EpicReview, StoryType.Kickoff, kickoffSubtasks, done(SubtaskType.Research)),
            true
        );
    });

    it("is registered as inherently human-gated -- Ada drives it, but only a human can complete it", () => {
        assert.ok(ALWAYS_HUMAN_GATED_SUBTASKS.includes(SubtaskType.EpicReview));
    });
});

describe("UAT gate (optional, human-gated)", () => {
    // rev 52 (TAI-159 ADR): CodeReview retired going forward — Dev anchors UAT's
    // fallback edge instead (see the "test tiers" describe block above for the full
    // rationale).
    const withUat = [
        SubtaskType.Dev,
        SubtaskType.IntegrationTest,
        SubtaskType.SystemTest,
        SubtaskType.E2ETest,
        SubtaskType.Uat,
        SubtaskType.Deploy,
    ];

    it("blocks Deploy until UAT is done, not just the test tiers", () => {
        const tiers = done(
            SubtaskType.Dev,
            SubtaskType.IntegrationTest,
            SubtaskType.SystemTest,
            SubtaskType.E2ETest
        );
        // All tiers green but UAT not signed off -> Deploy blocked.
        assert.equal(isSubtaskReady(SubtaskType.Deploy, StoryType.Story, withUat, tiers), false);
        // UAT signed off too -> Deploy ready.
        tiers.add(SubtaskType.Uat);
        assert.equal(isSubtaskReady(SubtaskType.Deploy, StoryType.Story, withUat, tiers), true);
    });

    it("UAT waits on Dev and all present tiers", () => {
        assert.equal(
            isSubtaskReady(
                SubtaskType.Uat,
                StoryType.Story,
                withUat,
                done(SubtaskType.Dev, SubtaskType.IntegrationTest, SubtaskType.SystemTest)
            ),
            false // E2ETest still outstanding
        );
        assert.equal(
            isSubtaskReady(
                SubtaskType.Uat,
                StoryType.Story,
                withUat,
                done(
                    SubtaskType.Dev,
                    SubtaskType.IntegrationTest,
                    SubtaskType.SystemTest,
                    SubtaskType.E2ETest
                )
            ),
            true
        );
        // All three tiers done but Dev itself not yet Done (rev 52 — stays In Progress
        // until merge): UAT is NOT ready via the static graph either. Same "never fires
        // statically" property as the test tiers' own Dev edge.
        assert.equal(
            isSubtaskReady(
                SubtaskType.Uat,
                StoryType.Story,
                withUat,
                done(SubtaskType.IntegrationTest, SubtaskType.SystemTest, SubtaskType.E2ETest)
            ),
            false
        );
    });

    it("COLLAPSES: with no UAT, the test tiers gate Deploy directly", () => {
        const present = [
            SubtaskType.Dev,
            SubtaskType.IntegrationTest,
            SubtaskType.SystemTest,
            SubtaskType.E2ETest,
            SubtaskType.Deploy,
        ];
        const rules = resolveApplicablePrecedence(StoryType.Story, present);
        assert.ok(!rules.some((r) => r.before === SubtaskType.Uat || r.after === SubtaskType.Uat));
        assert.ok(hasEdge(rules, SubtaskType.E2ETest, SubtaskType.Deploy));
        const tiers = [SubtaskType.IntegrationTest, SubtaskType.SystemTest, SubtaskType.E2ETest];
        // TAI-456/TAI-463: Deploy ships what is merged, so it also waits on Dev being Done.
        assert.equal(isSubtaskReady(SubtaskType.Deploy, StoryType.Story, present, done(...tiers)), false);
        assert.equal(isSubtaskReady(SubtaskType.Deploy, StoryType.Story, present, done(SubtaskType.Dev, ...tiers)), true);
    });

    it("applies to Bug as well as Story", () => {
        const present = [
            SubtaskType.Dev,
            SubtaskType.IntegrationTest,
            SubtaskType.Uat,
            SubtaskType.Deploy,
        ];
        assert.equal(
            isSubtaskReady(
                SubtaskType.Deploy,
                StoryType.Bug,
                present,
                done(SubtaskType.IntegrationTest)
            ),
            false // UAT not signed off
        );
    });

    it("is registered as inherently human-gated", () => {
        assert.ok(ALWAYS_HUMAN_GATED_SUBTASKS.includes(SubtaskType.Uat));
    });
});

describe("test tiers run sequentially by default (D12)", () => {
    // rev 52 (TAI-159 ADR): CodeReview is retired going forward — a real Story instance
    // now carries Dev + the test tiers, never CodeReview (kept in the schema only to parse
    // historical tickets). Dev anchors the tiers' fallback edge instead of CodeReview.
    const allTiers = [
        SubtaskType.Dev,
        SubtaskType.IntegrationTest,
        SubtaskType.SystemTest,
        SubtaskType.E2ETest,
    ];

    it("blocks SystemTest until IntegrationTest is done, not just Dev", () => {
        assert.equal(
            isSubtaskReady(
                SubtaskType.SystemTest,
                StoryType.Story,
                allTiers,
                done(SubtaskType.Dev)
            ),
            false
        );
        assert.equal(
            isSubtaskReady(
                SubtaskType.SystemTest,
                StoryType.Story,
                allTiers,
                done(SubtaskType.Dev, SubtaskType.IntegrationTest)
            ),
            true
        );
    });

    it("blocks E2ETest until SystemTest is done, not just IntegrationTest", () => {
        assert.equal(
            isSubtaskReady(
                SubtaskType.E2ETest,
                StoryType.Story,
                allTiers,
                done(SubtaskType.Dev, SubtaskType.IntegrationTest)
            ),
            false
        );
        assert.equal(
            isSubtaskReady(
                SubtaskType.E2ETest,
                StoryType.Story,
                allTiers,
                done(SubtaskType.Dev, SubtaskType.IntegrationTest, SubtaskType.SystemTest)
            ),
            true
        );
    });

    it("COLLAPSES: with IntegrationTest skipped, SystemTest is gated directly by Dev (rev 52 — never fires statically; readiness comes from ready.ts's live readyToTest instead)", () => {
        const present = [SubtaskType.Dev, SubtaskType.SystemTest, SubtaskType.E2ETest];
        const rules = resolveApplicablePrecedence(StoryType.Story, present);
        assert.ok(hasEdge(rules, SubtaskType.Dev, SubtaskType.SystemTest));
        assert.ok(!rules.some((r) => r.before === SubtaskType.IntegrationTest));
        assert.equal(
            isSubtaskReady(SubtaskType.SystemTest, StoryType.Story, present, done(SubtaskType.Dev)),
            true
        );
        // Dev alone present (not yet Done, rev 52 — stays In Progress until merge):
        // SystemTest is NOT ready via the static graph.
        assert.equal(
            isSubtaskReady(SubtaskType.SystemTest, StoryType.Story, present, new Set()),
            false
        );
    });

    it("COLLAPSES: with only E2ETest present, it is gated directly by Dev (rev 52)", () => {
        const present = [SubtaskType.Dev, SubtaskType.E2ETest];
        const rules = resolveApplicablePrecedence(StoryType.Story, present);
        assert.ok(hasEdge(rules, SubtaskType.Dev, SubtaskType.E2ETest));
        assert.equal(
            isSubtaskReady(SubtaskType.E2ETest, StoryType.Story, present, done(SubtaskType.Dev)),
            true
        );
    });

    it("applies to Bug as well as Story", () => {
        assert.equal(
            isSubtaskReady(
                SubtaskType.SystemTest,
                StoryType.Bug,
                allTiers,
                done(SubtaskType.Dev)
            ),
            false
        );
        assert.equal(
            isSubtaskReady(
                SubtaskType.SystemTest,
                StoryType.Bug,
                allTiers,
                done(SubtaskType.Dev, SubtaskType.IntegrationTest)
            ),
            true
        );
    });
});

describe("dynamic insertion of an optional gate mid-flight", () => {
    it("returns only the new edges touching UAT whose other end is already present", () => {
        // Dev/review already underway with one tier; UAT recognized as needed later.
        // rev 52 (TAI-159 ADR): Dev, not CodeReview (retired going forward).
        const existing = [
            SubtaskType.Dev,
            SubtaskType.IntegrationTest,
            SubtaskType.Deploy,
        ];
        const newEdges = getNewPrecedenceEdgesForInsertedSubtask(
            StoryType.Story,
            SubtaskType.Uat,
            existing
        );
        // TAI-463: the shortest chain only -- Dev -> UAT is already implied by Dev -> IntegrationTest -> UAT.
        assert.ok(!hasEdge(newEdges, SubtaskType.Dev, SubtaskType.Uat));
        assert.ok(hasEdge(newEdges, SubtaskType.IntegrationTest, SubtaskType.Uat));
        assert.ok(hasEdge(newEdges, SubtaskType.Uat, SubtaskType.Deploy));
        // Tiers not present on the instance must not produce edges.
        assert.ok(!hasEdge(newEdges, SubtaskType.SystemTest, SubtaskType.Uat));
        assert.ok(!hasEdge(newEdges, SubtaskType.E2ETest, SubtaskType.Uat));
        assert.equal(newEdges.length, 2);
        // ...and UAT still waits on Dev, through IntegrationTest.
        assert.equal(isSubtaskReady(SubtaskType.Uat, StoryType.Story, [...existing, SubtaskType.Uat], done(SubtaskType.IntegrationTest)), false);
    });
});

describe("defaultTestTiersForBug (D5 expedited-path compression, TAI-119)", () => {
    it("recommends only IntegrationTest for a Priority=Highest Bug", () => {
        assert.deepEqual(defaultTestTiersForBug(EXPEDITED_BUG_PRIORITY), [SubtaskType.IntegrationTest]);
    });

    it("recommends all three tiers for any other priority", () => {
        for (const priority of ["Medium", "High", "Low", "Lowest"]) {
            assert.deepEqual(defaultTestTiersForBug(priority), [
                SubtaskType.IntegrationTest,
                SubtaskType.SystemTest,
                SubtaskType.E2ETest,
            ]);
        }
    });

    it("recommends all three tiers when priority is unset (null/undefined)", () => {
        assert.deepEqual(defaultTestTiersForBug(undefined), [
            SubtaskType.IntegrationTest,
            SubtaskType.SystemTest,
            SubtaskType.E2ETest,
        ]);
        assert.deepEqual(defaultTestTiersForBug(null), [
            SubtaskType.IntegrationTest,
            SubtaskType.SystemTest,
            SubtaskType.E2ETest,
        ]);
    });

    it("is guidance only — SUBTASK_PRECEDENCE stays unaffected by priority", () => {
        // Even for an expedited Bug, if SystemTest/E2ETest WERE created anyway (the
        // recommendation was overridden), the precedence graph still gates them
        // normally — this function never touches resolveApplicablePrecedence/
        // isSubtaskReady, by design (see story-schema.ts's D5 design note).
        const present = [
            SubtaskType.Dev,
            SubtaskType.IntegrationTest,
            SubtaskType.SystemTest,
            SubtaskType.Deploy,
        ];
        assert.ok(hasEdge(resolveApplicablePrecedence(StoryType.Bug, present), SubtaskType.IntegrationTest, SubtaskType.SystemTest));
    });
});

describe("defaultPersonaFor (TAI-409)", () => {
    const test = it;
    test("a subtask gets SUBTASK_OWNER[type]; every subtask type with an owner matches", () => {
        for (const type of Object.values(SubtaskType)) {
            assert.equal(defaultPersonaFor(type), SUBTASK_OWNER[type], type);
        }
        assert.equal(defaultPersonaFor(SubtaskType.Dev), Persona.Developer);
        assert.equal(defaultPersonaFor(SubtaskType.Triage), Persona.Tester);
    });

    test("story-level types and Epic default to PM", () => {
        for (const type of [StoryType.Kickoff, StoryType.Spike, StoryType.Story, StoryType.Bug, "epic" as const]) {
            assert.equal(defaultPersonaFor(type), Persona.Pm, type);
        }
    });

    test("SpikeTask has no default owner", () => {
        assert.equal(defaultPersonaFor(SubtaskType.SpikeTask), null);
    });
});

describe("unblockedAbsentSubtaskTypes (TAI-373)", () => {
    const K = StoryType.Kickoff;

    it("EpicReview Done unblocks the absent Requirements and UxDesign (the EXA-2 case)", () => {
        const present = [SubtaskType.Research, SubtaskType.EpicReview];
        const done = new Set([SubtaskType.Research, SubtaskType.EpicReview]);
        assert.deepEqual(unblockedAbsentSubtaskTypes(K, present, done), [SubtaskType.Requirements, SubtaskType.UxDesign]);
    });

    it("an unfinished prerequisite unblocks nothing downstream of it", () => {
        const present = [SubtaskType.Research, SubtaskType.EpicReview];
        assert.deepEqual(unblockedAbsentSubtaskTypes(K, present, new Set([SubtaskType.Research])), []);
    });

    it("a type that already exists is never hinted, even once unblocked", () => {
        const present = [SubtaskType.Research, SubtaskType.EpicReview, SubtaskType.Requirements];
        const done = new Set([SubtaskType.Research, SubtaskType.EpicReview]);
        assert.deepEqual(unblockedAbsentSubtaskTypes(K, present, done), [SubtaskType.UxDesign]);
    });

    it("a root type with no prerequisites (Research) is absent, not 'newly unblocked'", () => {
        assert.deepEqual(unblockedAbsentSubtaskTypes(K, [], new Set()), []);
    });

    it("a Canceled prerequisite counts as finished, same as isSubtaskReady", () => {
        // doneSubtaskTypes already folds Canceled in (ready.ts), so the set is all the function sees.
        const present = [SubtaskType.Research];
        assert.deepEqual(unblockedAbsentSubtaskTypes(K, present, new Set([SubtaskType.Research])), [SubtaskType.EpicReview]);
    });

    it("a type needing BOTH prerequisites waits for both (ArchitectureDesign needs Requirements and UxDesign)", () => {
        const all = [SubtaskType.Research, SubtaskType.EpicReview, SubtaskType.Requirements, SubtaskType.UxDesign];
        const onlyReq = new Set([SubtaskType.Research, SubtaskType.EpicReview, SubtaskType.Requirements]);
        assert.ok(!unblockedAbsentSubtaskTypes(K, all, onlyReq).includes(SubtaskType.ArchitectureDesign));
        assert.ok(unblockedAbsentSubtaskTypes(K, all, new Set(all)).includes(SubtaskType.ArchitectureDesign));
    });
});

describe("an absent subtask passes its predecessors through (TAI-463)", () => {
    const edges = (storyType: StoryType, present: SubtaskType[]) =>
        resolveApplicablePrecedence(storyType, present)
            .map((r) => `${r.before}>${r.after}`)
            .sort();

    it("Kickoff: UxDesign waits on Research while EpicReview has not been created yet", () => {
        const present = [SubtaskType.Research, SubtaskType.UxDesign];
        assert.equal(isSubtaskReady(SubtaskType.UxDesign, StoryType.Kickoff, present, new Set()), false);
        assert.equal(isSubtaskReady(SubtaskType.UxDesign, StoryType.Kickoff, present, new Set([SubtaskType.Research])), true);
        assert.deepEqual(edges(StoryType.Kickoff, present), ["research>ux-design"]);
    });

    it("Kickoff: ArchitectureDesign waits on EpicReview while Requirements and UxDesign do not exist", () => {
        const present = [SubtaskType.Research, SubtaskType.EpicReview, SubtaskType.ArchitectureDesign];
        const done = new Set([SubtaskType.Research]);
        assert.equal(isSubtaskReady(SubtaskType.ArchitectureDesign, StoryType.Kickoff, present, done), false);
        assert.deepEqual(edges(StoryType.Kickoff, present), ["epic-review>architecture-design", "research>epic-review"]);
    });

    for (const storyType of [StoryType.Story, StoryType.Bug]) {
        it(`${storyType}: Deploy waits on Dev when no test tier or UAT is present`, () => {
            const present = [SubtaskType.Dev, SubtaskType.Deploy];
            assert.equal(isSubtaskReady(SubtaskType.Deploy, storyType, present, new Set()), false);
            assert.equal(isSubtaskReady(SubtaskType.Deploy, storyType, present, new Set([SubtaskType.Dev])), true);
            assert.deepEqual(edges(storyType, present), ["dev>deploy"]);
        });
    }

    it("a subtask waits on EVERY present ancestor, not only the nearest one", () => {
        // SystemTest counted as finished (e.g. Canceled) must not let E2ETest start while IntegrationTest is open.
        const present = [SubtaskType.Dev, SubtaskType.IntegrationTest, SubtaskType.SystemTest, SubtaskType.E2ETest];
        const done = new Set([SubtaskType.Dev, SubtaskType.SystemTest]);
        assert.equal(isSubtaskReady(SubtaskType.E2ETest, StoryType.Story, present, done), false);
    });

    it("the links for a story are the shortest chain between present subtasks, with no edge another path already implies", () => {
        const present = [
            SubtaskType.ArchitectureDesign,
            SubtaskType.DesignReview,
            SubtaskType.Dev,
            SubtaskType.IntegrationTest,
            SubtaskType.E2ETest,
            SubtaskType.Deploy,
        ];
        assert.deepEqual(edges(StoryType.Story, present), [
            "architecture-design>design-review",
            "design-review>dev",
            "dev>integration-test",
            "e2e-test>deploy",
            "integration-test>e2e-test",
        ]);
    });

    it("a subtask with no ancestor in the graph (Investigate, SpikeTask) is still a root", () => {
        const present = [SubtaskType.Investigate, SubtaskType.SpikeTask, SubtaskType.Dev];
        assert.equal(isSubtaskReady(SubtaskType.Investigate, StoryType.Story, present, new Set()), true);
        assert.equal(isSubtaskReady(SubtaskType.SpikeTask, StoryType.Story, present, new Set()), true);
    });

    it("inserting a gate mid-flight returns the links that touch it, routed through absent neighbours", () => {
        const added = getNewPrecedenceEdgesForInsertedSubtask(StoryType.Story, SubtaskType.Uat, [SubtaskType.Dev, SubtaskType.Deploy])
            .map((r) => `${r.before}>${r.after}`)
            .sort();
        assert.deepEqual(added, ["dev>uat", "uat>deploy"]);
    });
});
