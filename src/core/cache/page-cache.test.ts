import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { StorageConnectivityError, toPageId, type DocStore, type Page } from "../storage/interface.js";
import { cachePage, classifyPageChange, readCachedPage, refreshPage } from "./page-cache.js";

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
            assert.deepEqual(result, { page: null, severity: "none" });
            assert.equal(await readCachedPage(dir, "TAI", "123"), null);
        });
    });

    it("writes a fresh cache entry on first refresh, severity 'none' -- nothing to have changed from", async () => {
        await withTempDir(async (dir) => {
            const docStore = new FakeDocStore(page()) as unknown as DocStore;
            const result = await refreshPage(docStore, dir, "TAI", { id: toPageId("123") });
            assert.equal(result.page?.id, "123");
            assert.equal(result.severity, "none");
            assert.deepEqual(await readCachedPage(dir, "TAI", "123"), page());
        });
    });

    it("cachePage skips the disk write when updatedAt is unchanged", async () => {
        await withTempDir(async (dir) => {
            await cachePage(dir, "TAI", page());
            const severity = await cachePage(dir, "TAI", page({ content: "different content" }));
            const after = await readCachedPage(dir, "TAI", "123");
            assert.equal(severity, "none");
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

    // PR #9 code review: offline (StorageConnectivityError) used to propagate as a hard
    // crash instead of degrading to whatever's already cached (brief §3.6).
    describe("degrades to the cached copy on StorageConnectivityError", () => {
        it("returns the cached page instead of throwing when one exists, for an id-shaped ref", async () => {
            await withTempDir(async (dir) => {
                await cachePage(dir, "TAI", page());
                const offlineDocStore = {
                    async getPage(): Promise<Page | null> {
                        throw new StorageConnectivityError("network unreachable");
                    },
                } as unknown as DocStore;

                const result = await refreshPage(offlineDocStore, dir, "TAI", { id: toPageId("123") });
                assert.deepEqual(result, { page: page(), severity: "none" });
            });
        });

        it("still throws for a title-shaped ref -- offline, there's no id to look the cache up by", async () => {
            await withTempDir(async (dir) => {
                const offlineDocStore = {
                    async getPage(): Promise<Page | null> {
                        throw new StorageConnectivityError("network unreachable");
                    },
                } as unknown as DocStore;

                await assert.rejects(
                    () => refreshPage(offlineDocStore, dir, "TAI", { spaceKey: "TA", title: "Some Page" }),
                    StorageConnectivityError
                );
            });
        });

        it("still propagates a non-connectivity error rather than masking it as offline", async () => {
            await withTempDir(async (dir) => {
                const brokenDocStore = {
                    async getPage(): Promise<Page | null> {
                        throw new Error("something else entirely");
                    },
                } as unknown as DocStore;

                await assert.rejects(
                    () => refreshPage(brokenDocStore, dir, "TAI", { id: toPageId("123") }),
                    /something else entirely/
                );
            });
        });
    });
});

describe("classifyPageChange (TAI-285 ADR)", () => {
    it("classifies as 'none' when neither title nor content differs", () => {
        assert.equal(classifyPageChange(page(), page({ spaceKey: "OTHER" })), "none");
    });

    it("classifies a title change as 'content' -- pages have no structural tier", () => {
        assert.equal(classifyPageChange(page(), page({ title: "New title" })), "content");
    });

    it("classifies a content change as 'content'", () => {
        assert.equal(classifyPageChange(page(), page({ content: "new content" })), "content");
    });
});
