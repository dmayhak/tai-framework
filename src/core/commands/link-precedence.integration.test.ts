/**
 * TAI-100 IntegrationTest: exercises `materializePrecedenceLinks`/`materializeStoryDependencies`
 * (TAI-98) against the REAL Jira backend, targeting the TAIT scratch project — the unit tests
 * in `link-precedence.test.ts` already cover this logic against the filesystem backend (a real
 * `StorageBackend`, per TAI-60's own definition of "real, not a hand-rolled fake"), but only the
 * live Jira REST API can confirm the `createLink()`/`getLinkedIssues()` round-trip actually
 * produces real `Blocks`/`Relates` links that Jira itself recognizes and reports back — exactly
 * the interface-mismatch risk TAI-96 exists to close (this session's TAI-98→99→100 chain was
 * originally wired by hand, before this code existed, precisely because nothing verified the
 * real link got created). Skips cleanly when credentials are absent — `npm test` must stay
 * green offline, same discipline as `jira-backend.conformance.test.ts`.
 *
 * PROJECT KEY IS HARDCODED, NEVER READ FROM ENV — same reasoning as the conformance suite:
 * the whole safety point of a scratch project is that a misconfigured environment variable can
 * never accidentally point these tests at the real `TAI` project.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { DependencyRelation, Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import type { IssueKey, WorkTracker } from "../storage/interface.js";
import { apiTokenAuth } from "../storage/jira/rest-client.js";
import { createJiraBackend } from "../storage/jira/jira-backend.js";
import { materializePrecedenceLinks, materializeStoryDependencies } from "./link-precedence.js";

const SITE_URL = process.env["TAI_TEST_JIRA_SITE_URL"];
const EMAIL = process.env["TAI_TEST_JIRA_EMAIL"];
const API_TOKEN = process.env["TAI_TEST_JIRA_API_TOKEN"];

const PROJECT_KEY = "TAIT"; // hardcoded — see file header

const skip =
    SITE_URL && EMAIL && API_TOKEN
        ? false
        : "TAI_TEST_JIRA_SITE_URL / TAI_TEST_JIRA_EMAIL / TAI_TEST_JIRA_API_TOKEN not set — " +
          "set them to run this suite against the TAIT scratch project.";

describe("link-precedence against a real Jira backend (TAIT)", { skip }, () => {
    let workTracker: WorkTracker;
    const createdKeys: IssueKey[] = [];

    before(async () => {
        const backend = await createJiraBackend({
            siteUrl: SITE_URL ?? "",
            spaceKey: PROJECT_KEY,
            auth: apiTokenAuth(EMAIL ?? "", API_TOKEN ?? ""),
        });
        workTracker = backend.workTracker;
    });

    after(async () => {
        // Jira Cloud's Free plan cannot delete issues — cancel + label instead, same cleanup
        // pattern as jira-backend.conformance.test.ts's disposeIssue. Canceled is exempt from
        // the §5.5 assignment gate, so no assignment is needed first.
        for (const key of createdKeys) {
            await workTracker.addLabel(key, "tai-integration-fixture").catch(() => {});
            await workTracker.transition(key, Status.Canceled).catch(() => {});
        }
    });

    function track(key: IssueKey): IssueKey {
        createdKeys.push(key);
        return key;
    }

    // Live finding (TAI-100): Jira Cloud's search index is eventually consistent — a subtask
    // created moments ago can be briefly invisible to `search()`, confirmed live via a throwaway
    // diagnostic script (first poll: empty; second poll ~5s later: both present). This is the
    // SAME phenomenon already documented for `/tai-ready` (prior session's handoff). This helper
    // exists so the tests below that don't specifically exercise the retry aren't flaky against
    // that lag. `materializePrecedenceLinks` itself gained a bounded retry for this exact gap
    // (TAI-118) — see the "closes the eventual-consistency gap live" test below, which
    // deliberately does NOT call this helper first, to prove the production retry alone is
    // sufficient without a test-side pre-wait.
    async function waitForSubtasks(storyKey: IssueKey, expectedCount: number): Promise<void> {
        for (let attempt = 0; attempt < 6; attempt++) {
            const found = await workTracker.search({ projectKey: PROJECT_KEY, parentKey: storyKey });
            if (found.length >= expectedCount) return;
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        throw new Error(`search() never converged to ${expectedCount} subtasks under ${storyKey}`);
    }

    test("creates a real Blocks link Jira itself reports back, and is idempotent against the live backend", async () => {
        const story = await workTracker.createIssue({
            projectKey: PROJECT_KEY,
            issueType: StoryType.Story,
            summary: "TAI-100 fixture: precedence link Story",
        });
        track(story.key);
        // The edge under test must still exist in SUBTASK_PRECEDENCE for a Story. ArchitectureDesign -> Dev
        // is the direct edge kept for the no-DesignReview case (TAI-396: the old Dev -> CodeReview edge was
        // retired in rev 52, so a fixture built around it never materializes a link).
        const architectureDesign = await workTracker.createIssue({
            projectKey: PROJECT_KEY,
            issueType: SubtaskType.ArchitectureDesign,
            summary: "TAI-100 fixture: ArchitectureDesign",
            persona: Persona.Architect,
            parentKey: story.key,
        });
        track(architectureDesign.key);
        const dev = await workTracker.createIssue({
            projectKey: PROJECT_KEY,
            issueType: SubtaskType.Dev,
            summary: "TAI-100 fixture: Dev",
            persona: Persona.Developer,
            parentKey: story.key,
        });
        track(dev.key);

        await waitForSubtasks(story.key, 2);
        const first = await materializePrecedenceLinks(workTracker, story.key);
        assert.equal(first.warning, null);
        assert.ok(
            first.results.some((r) => r.beforeKey === architectureDesign.key && r.afterKey === dev.key && r.created),
            "expected a newly-created ArchitectureDesign -> Dev edge"
        );

        const linked = await workTracker.getLinkedIssues(dev.key, DependencyRelation.DependsOn, "outgoing");
        assert.ok(
            linked.some((l) => l.key === architectureDesign.key),
            "Jira's own API must report the real Blocks link back"
        );

        const second = await materializePrecedenceLinks(workTracker, story.key);
        const secondEdge = second.results.find((r) => r.beforeKey === architectureDesign.key && r.afterKey === dev.key);
        assert.equal(secondEdge?.created, false, "a second call against the live backend must not recreate the link");

        const linkedAgain = await workTracker.getLinkedIssues(dev.key, DependencyRelation.DependsOn, "outgoing");
        assert.equal(
            linkedAgain.filter((l) => l.key === architectureDesign.key).length,
            1,
            "Jira itself must show exactly one link, not a duplicate"
        );
    });

    test("closes the eventual-consistency gap live — retry alone succeeds with no pre-wait (TAI-118)", async () => {
        const story = await workTracker.createIssue({
            projectKey: PROJECT_KEY,
            issueType: StoryType.Story,
            summary: "TAI-118 fixture: retry-without-pre-wait Story",
        });
        track(story.key);
        const architectureDesign = await workTracker.createIssue({
            projectKey: PROJECT_KEY,
            issueType: SubtaskType.ArchitectureDesign,
            summary: "TAI-118 fixture: ArchitectureDesign",
            persona: Persona.Architect,
            parentKey: story.key,
        });
        track(architectureDesign.key);
        const dev = await workTracker.createIssue({
            projectKey: PROJECT_KEY,
            issueType: SubtaskType.Dev,
            summary: "TAI-118 fixture: Dev",
            persona: Persona.Developer,
            parentKey: story.key,
        });
        track(dev.key);

        // Deliberately NO waitForSubtasks() call here — this is the exact real-world shape
        // (front-load subtasks, immediately run link-precedence) TAI-118 exists to fix.
        // attempts/delayMs mirror what cli.ts's own link-precedence subcommand now passes.
        const { results, warning } = await materializePrecedenceLinks(workTracker, story.key, {
            attempts: 4,
            delayMs: 3000,
        });

        assert.equal(warning, null, "the retry should have converged well within the 4-attempt budget");
        assert.ok(
            results.some((r) => r.beforeKey === architectureDesign.key && r.afterKey === dev.key && r.created),
            "the edge should be created even without a test-side pre-wait, proving the production retry works"
        );
    });

    test("creates a real Relates link Jira itself reports back, and is idempotent against the live backend", async () => {
        const a = await workTracker.createIssue({
            projectKey: PROJECT_KEY,
            issueType: StoryType.Spike,
            summary: "TAI-100 fixture: Spike A",
        });
        track(a.key);
        const b = await workTracker.createIssue({
            projectKey: PROJECT_KEY,
            issueType: StoryType.Spike,
            summary: "TAI-100 fixture: Spike B",
        });
        track(b.key);

        const dependencies = [{ from: a.key, relation: DependencyRelation.RelatesTo, to: b.key }];

        const first = await materializeStoryDependencies(workTracker, dependencies);
        assert.ok(first[0]?.created, "expected a newly-created Relates link");

        const related = await workTracker.getLinkedIssues(a.key, DependencyRelation.RelatesTo);
        assert.ok(related.some((l) => l.key === b.key), "Jira's own API must report the real Relates link back");

        const second = await materializeStoryDependencies(workTracker, dependencies);
        assert.equal(second[0]?.created, false, "a second call against the live backend must not recreate the link");
    });
});
