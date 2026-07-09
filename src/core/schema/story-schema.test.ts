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
    const withUat = [
        SubtaskType.CodeReview,
        SubtaskType.IntegrationTest,
        SubtaskType.SystemTest,
        SubtaskType.E2ETest,
        SubtaskType.Uat,
        SubtaskType.Deploy,
    ];

    it("blocks Deploy until UAT is done, not just the test tiers", () => {
        const tiers = done(
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

    it("UAT waits on CodeReview and all present tiers", () => {
        assert.equal(
            isSubtaskReady(
                SubtaskType.Uat,
                StoryType.Story,
                withUat,
                done(SubtaskType.CodeReview, SubtaskType.IntegrationTest, SubtaskType.SystemTest)
            ),
            false // E2ETest still outstanding
        );
        assert.equal(
            isSubtaskReady(
                SubtaskType.Uat,
                StoryType.Story,
                withUat,
                done(
                    SubtaskType.CodeReview,
                    SubtaskType.IntegrationTest,
                    SubtaskType.SystemTest,
                    SubtaskType.E2ETest
                )
            ),
            true
        );
    });

    it("COLLAPSES: with no UAT, the test tiers gate Deploy directly", () => {
        const present = [
            SubtaskType.CodeReview,
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
            SubtaskType.CodeReview,
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

describe("dynamic insertion of an optional gate mid-flight", () => {
    it("returns only the new edges touching UAT whose other end is already present", () => {
        // Dev/review already underway with one tier; UAT recognized as needed later.
        const existing = [
            SubtaskType.CodeReview,
            SubtaskType.IntegrationTest,
            SubtaskType.Deploy,
        ];
        const newEdges = getNewPrecedenceEdgesForInsertedSubtask(
            StoryType.Story,
            SubtaskType.Uat,
            existing
        );
        assert.ok(hasEdge(newEdges, SubtaskType.CodeReview, SubtaskType.Uat));
        assert.ok(hasEdge(newEdges, SubtaskType.IntegrationTest, SubtaskType.Uat));
        assert.ok(hasEdge(newEdges, SubtaskType.Uat, SubtaskType.Deploy));
        // Tiers not present on the instance must not produce edges.
        assert.ok(!hasEdge(newEdges, SubtaskType.SystemTest, SubtaskType.Uat));
        assert.ok(!hasEdge(newEdges, SubtaskType.E2ETest, SubtaskType.Uat));
        assert.equal(newEdges.length, 3);
    });
});
