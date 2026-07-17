import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { toPageId, type DocStore, type Page } from "../storage/interface.js";
import { cachePage, readCachedPage, refreshPage } from "./page-cache.js";

function page(overrides: Partial<Page> = {}): Page {
    return {
        id: toPageId("123"),
        spaceKey: "TA",
        title: "A page",
        content: "content",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        comments: [],
        ...overrides,
    };
}

class FakeDocStore implements Partial<DocStore> {
    constructor(private result: Page | null) {}
    async getPage(): Promise<Page | null> {
        return this.result;
    }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-page-cache-"));
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("refreshPage / readCachedPage / cachePage", () => {
    it("returns null and caches nothing when the page doesn't exist", async () => {
        await withTempDir(async (dir) => {
            const docStore = new FakeDocStore(null) as unknown as DocStore;
            const result = await refreshPage(docStore, dir, "TAI", { id: toPageId("123") });
            assert.equal(result, null);
            assert.equal(await readCachedPage(dir, "TAI", "123"), null);
        });
    });

    it("writes a fresh cache entry on first refresh", async () => {
        await withTempDir(async (dir) => {
            const docStore = new FakeDocStore(page()) as unknown as DocStore;
            const result = await refreshPage(docStore, dir, "TAI", { id: toPageId("123") });
            assert.equal(result?.id, "123");
            assert.deepEqual(await readCachedPage(dir, "TAI", "123"), page());
        });
    });

    it("cachePage skips the disk write when updatedAt is unchanged", async () => {
        await withTempDir(async (dir) => {
            await cachePage(dir, "TAI", page());
            await cachePage(dir, "TAI", page({ content: "different content" }));
            const after = await readCachedPage(dir, "TAI", "123");
            assert.equal(after?.content, "content");
        });
    });

    it("cachePage DOES write when updatedAt changed", async () => {
        await withTempDir(async (dir) => {
            await cachePage(dir, "TAI", page());
            await cachePage(dir, "TAI", page({ content: "updated", updatedAt: "2026-02-01T00:00:00Z" }));
            const after = await readCachedPage(dir, "TAI", "123");
            assert.equal(after?.content, "updated");
        });
    });
});
