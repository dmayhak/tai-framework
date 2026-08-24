/**
 * Precedence tests for the optional gates (DesignReview, UAT).
 *
 * The load-bearing property being locked down here is that both gates are
 * PURELY ADDITIVE: when a gate subtask is absent, the resolved precedence
 * graph collapses to exactly the pre-gate shape (ArchitectureDesign -> Dev
 * directly; test tiers -> Deploy directly). When present, the gate inserts
 * itself without weakening the surrounding edges.
 *
 * Run: `npm test`
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    StoryType,
    SubtaskType,
    resolveApplicablePrecedence,
    isSubtaskReady,
    getNewPrecedenceEdgesForInsertedSubtask,
    defaultTestTiersForBug,
    EXPEDITED_BUG_PRIORITY,
    ALWAYS_HUMAN_GATED_SUBTASKS,
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
        assert.equal(
            isSubtaskReady(
                SubtaskType.Deploy,
                StoryType.Story,
                present,
                done(SubtaskType.IntegrationTest, SubtaskType.SystemTest, SubtaskType.E2ETest)
            ),
            true
        );
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
        assert.ok(hasEdge(newEdges, SubtaskType.Dev, SubtaskType.Uat));
        assert.ok(hasEdge(newEdges, SubtaskType.IntegrationTest, SubtaskType.Uat));
        assert.ok(hasEdge(newEdges, SubtaskType.Uat, SubtaskType.Deploy));
        // Tiers not present on the instance must not produce edges.
        assert.ok(!hasEdge(newEdges, SubtaskType.SystemTest, SubtaskType.Uat));
        assert.ok(!hasEdge(newEdges, SubtaskType.E2ETest, SubtaskType.Uat));
        assert.equal(newEdges.length, 3);
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
