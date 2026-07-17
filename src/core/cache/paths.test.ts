import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    briefingPath,
    cacheDir,
    issueCachePath,
    journalPath,
    lastSyncPath,
    pageCachePath,
    readJsonFile,
    rootStatusPath,
    workItemDir,
    workStatusPath,
    writeJsonFile,
} from "./paths.js";

describe("path builders match brief §7's layout", () => {
    const root = "/tai-root";

    it("cache tree", () => {
        assert.equal(cacheDir(root, "TAI"), "/tai-root/cache/TAI");
        assert.equal(issueCachePath(root, "TAI", "TAI-1"), "/tai-root/cache/TAI/issues/TAI-1.json");
        assert.equal(pageCachePath(root, "TAI", "123"), "/tai-root/cache/TAI/confluence/123.json");
        assert.equal(lastSyncPath(root, "TAI"), "/tai-root/cache/TAI/last-sync.json");
    });

    it("work tree", () => {
        assert.equal(workItemDir(root, "TAI", "TAI-1"), "/tai-root/work/TAI/TAI-1");
        assert.equal(briefingPath(root, "TAI", "TAI-1"), "/tai-root/work/TAI/TAI-1/briefing.md");
        assert.equal(journalPath(root, "TAI", "TAI-1"), "/tai-root/work/TAI/TAI-1/journal.md");
        assert.equal(workStatusPath(root, "TAI", "TAI-1"), "/tai-root/work/TAI/TAI-1/status.json");
        assert.equal(rootStatusPath(root), "/tai-root/status.json");
    });
});

describe("readJsonFile / writeJsonFile", () => {
    it("round-trips a value, creating parent directories as needed", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-paths-"));
        try {
            const filePath = path.join(dir, "nested", "deeper", "file.json");
            await writeJsonFile(filePath, { hello: "world" });
            const read = await readJsonFile<{ hello: string }>(filePath);
            assert.deepEqual(read, { hello: "world" });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("returns null (not a throw) for a missing file", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-paths-"));
        try {
            const result = await readJsonFile(path.join(dir, "nope.json"));
            assert.equal(result, null);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
