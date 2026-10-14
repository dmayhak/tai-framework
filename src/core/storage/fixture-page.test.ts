import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFilesystemBackend } from "./filesystem-backend.js";
import { ensureFixturePage } from "./fixture-page.js";
import { toHumanId, type DocStore, type HumanRef } from "./interface.js";

const ME: HumanRef = { id: toHumanId("a@b.c"), displayName: "A", email: "a@b.c" };

async function withDocStore(fn: (docStore: DocStore) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-fixture-page-"));
    try {
        await fn(createFilesystemBackend(dir, ME).docStore);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("ensureFixturePage (TAI-497)", () => {
    it("creates the page when none exists, and hands its id back to be deleted", async () => {
        await withDocStore(async (docStore) => {
            const fixture = await ensureFixturePage(docStore, "TAI", "Persona Roster", "mine");
            assert.equal(fixture.createdId, fixture.page.id);
            assert.equal((await docStore.getPage({ spaceKey: "TAI", title: "Persona Roster" }))?.content, "mine");
        });
    });

    it("leaves a page that already says what the case needs untouched: no write, so nothing to restore or to lose if the run dies", async () => {
        await withDocStore(async (docStore) => {
            const existing = await docStore.createPage({ spaceKey: "TAI", title: "Persona Roster", content: "same table" });
            const fixture = await ensureFixturePage(docStore, "TAI", "Persona Roster", "same table\n");
            assert.equal(fixture.page.id, existing.id);
            assert.equal(fixture.createdId, null);
            assert.equal((await docStore.getPage({ id: existing.id }))?.updatedAt, existing.updatedAt, "not written");
        });
    });

    it("reuses an existing page instead of creating a duplicate, and puts its own content back, run after run", async () => {
        await withDocStore(async (docStore) => {
            const existing = await docStore.createPage({ spaceKey: "TAI", title: "Persona Roster", content: "left from an earlier run" });
            for (let run = 0; run < 2; run++) {
                const fixture = await ensureFixturePage(docStore, "TAI", "Persona Roster", `case content ${run}`);
                assert.equal(fixture.page.id, existing.id, "the same page, not a new one");
                assert.equal(fixture.createdId, null, "not created here, so never the caller's to delete");
                assert.equal((await docStore.getPage({ id: existing.id }))?.content, `case content ${run}`);
                await fixture.restore();
                assert.equal((await docStore.getPage({ id: existing.id }))?.content, "left from an earlier run");
            }
        });
    });
});
