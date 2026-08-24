import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { toHumanId, type HumanRef } from "../storage/interface.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import {
    parsePrReviewers,
    isEligibleReviewer,
    loadPrReviewers,
    loadCachedPrReviewers,
    PR_REVIEWERS_TITLE,
} from "./pr-reviewers.js";

// A plausible live page shape: prose above the table, a single "Reviewer" column.
const LIVE_PAGE = `Eligible PR approvers for this project (rev 52, TAI-159 ADR). Separate from the
Persona Roster — reviewer eligibility isn't tied to acting as a TAI persona.

| Reviewer |
| --- |
| del ([del@mayhak.com](mailto:del@mayhak.com)) |
| Sam Rivera |

Edit this page directly to add/remove eligible reviewers.`;

describe("parsePrReviewers", () => {
    it("parses every reviewer from the live page shape", () => {
        const reviewers = parsePrReviewers(LIVE_PAGE);
        assert.equal(reviewers.length, 2);
        assert.equal(reviewers[0]?.email, "del@mayhak.com");
        assert.equal(reviewers[1]?.displayName, "Sam Rivera");
    });

    it("supports several reviewers in one cell", () => {
        const md = "| Reviewer |\n| --- |\n| a@b.co, Sam Rivera |";
        const reviewers = parsePrReviewers(md);
        assert.equal(reviewers.length, 2);
    });

    it("de-duplicates the same human listed twice", () => {
        const md = "| Reviewer |\n| --- |\n| a@b.co |\n| a@b.co |";
        assert.equal(parsePrReviewers(md).length, 1);
    });

    it("finds the reviewer column by name when other columns are present", () => {
        const md = "| Notes | Reviewer |\n| --- | --- |\n| some note | p@m.co |";
        const reviewers = parsePrReviewers(md);
        assert.equal(reviewers[0]?.email, "p@m.co");
    });

    it("falls back to a single unnamed column", () => {
        const md = "| Name |\n| --- |\n| p@m.co |";
        assert.equal(parsePrReviewers(md)[0]?.email, "p@m.co");
    });

    it("refuses to guess for 2+ columns with no recognisable reviewer column", () => {
        const md = "| Notes | Other |\n| --- | --- |\n| x | y |";
        assert.throws(() => parsePrReviewers(md), /none look like a reviewer column/);
    });

    it("throws rather than returning an empty list when there is no table", () => {
        assert.throws(() => parsePrReviewers("Just prose, no table here."), /no recognisable table/);
    });
});

describe("isEligibleReviewer", () => {
    const reviewers = parsePrReviewers(LIVE_PAGE);

    it("matches by email even when the id differs", () => {
        assert.equal(
            isEligibleReviewer(reviewers, { id: toHumanId("712020:abc"), email: "del@mayhak.com" }),
            true
        );
    });

    it("matches by display name as a last resort", () => {
        assert.equal(isEligibleReviewer(reviewers, { id: toHumanId("whatever"), displayName: "Sam Rivera" }), true);
    });

    it("rejects a human who isn't listed", () => {
        assert.equal(isEligibleReviewer(reviewers, { id: toHumanId("z"), email: "intruder@x.test" }), false);
    });
});

describe("loadPrReviewers / loadCachedPrReviewers", () => {
    const CURRENT_USER: HumanRef = { id: toHumanId("del@example.com"), displayName: "Del", email: "del@example.com" };

    async function withBackend(fn: (dir: string, docStore: ReturnType<typeof createFilesystemBackend>["docStore"]) => Promise<void>): Promise<void> {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-pr-reviewers-"));
        try {
            const backend = createFilesystemBackend(dir, CURRENT_USER);
            await fn(dir, backend.docStore);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }

    test("throws a clear error when the page doesn't exist", async () => {
        await withBackend(async (_dir, docStore) => {
            await assert.rejects(
                () => loadPrReviewers(docStore, { spaceKey: "TAI", projectKey: "TAI", cacheRoot: null }),
                /PR Reviewers.*not found/
            );
        });
    });

    test("fetches, parses, and caches; a later cache read matches", async () => {
        await withBackend(async (dir, docStore) => {
            await docStore.createPage({ spaceKey: "TAI", title: PR_REVIEWERS_TITLE, content: LIVE_PAGE });

            const cacheRoot = path.join(dir, "cache");
            const reviewers = await loadPrReviewers(docStore, { spaceKey: "TAI", projectKey: "TAI", cacheRoot });
            assert.equal(reviewers.length, 2);

            const cached = await loadCachedPrReviewers(cacheRoot, "TAI");
            assert.deepEqual(cached, reviewers);
        });
    });

    test("loadCachedPrReviewers returns null when nothing is cached yet", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-pr-reviewers-nocache-"));
        try {
            assert.equal(await loadCachedPrReviewers(path.join(dir, "cache"), "TAI"), null);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
