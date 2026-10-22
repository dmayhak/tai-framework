import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DOC_TYPE_FOLDERS, folderForDocType, ensureDocFolder, resolvePageParent, looseRootPages, filePage, DOC_FOLDER_NAMES } from "./doc-folders.js";
import { createFilesystemBackend } from "./filesystem-backend.js";
import { loadBuiltinPersonaConfigs } from "../persona/config.js";
import { toPageId, type HumanRef } from "./interface.js";

const USER = { id: "u1", displayName: "Test", email: "t@example.com" } as unknown as HumanRef;

async function withBackend(fn: (backend: ReturnType<typeof createFilesystemBackend>) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-doc-folders-"));
    try {
        await fn(createFilesystemBackend(dir, USER));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("DOC_TYPE_FOLDERS", () => {
    it("has an entry for every output type any built-in persona declares", async () => {
        const configs = await loadBuiltinPersonaConfigs();
        const missing: string[] = [];
        for (const config of configs.values()) {
            for (const type of config.confluenceOutputs) {
                if (!(type in DOC_TYPE_FOLDERS)) missing.push(`${config.id}:${type}`);
            }
        }
        assert.deepEqual(missing, [], `output types with no folder in DOC_TYPE_FOLDERS: ${missing.join(", ")}`);
    });

    it("has no entry for a type no persona declares (a stale row)", async () => {
        const configs = await loadBuiltinPersonaConfigs();
        const declared = new Set([...configs.values()].flatMap((c) => c.confluenceOutputs));
        const stale = Object.keys(DOC_TYPE_FOLDERS).filter((t) => !declared.has(t));
        assert.deepEqual(stale, []);
    });

    it("only names folders from the canonical set", () => {
        for (const folder of Object.values(DOC_TYPE_FOLDERS)) {
            if (folder !== null) assert.ok(DOC_FOLDER_NAMES.includes(folder), folder);
        }
    });
});

describe("folderForDocType", () => {
    it("maps the DBA's output types to the schema folder", () => {
        assert.equal(folderForDocType("schema-notes"), "Schema Notes and Migration Plans");
        assert.equal(folderForDocType("migration-plan"), "Schema Notes and Migration Plans");
    });

    it("returns null for a type that is deliberately not filed", () => {
        assert.equal(folderForDocType("project-home"), null);
    });

    it("throws for an unknown type, listing the valid ones", () => {
        assert.throws(() => folderForDocType("not-a-type"), /Unknown page type "not-a-type".*schema-notes/s);
    });
});

describe("ensureDocFolder", () => {
    it("creates the folder at the space root when it does not exist", async () => {
        await withBackend(async (backend) => {
            const folder = await ensureDocFolder(backend.docStore, "EXA", "schema-notes");
            assert.ok(folder);
            assert.equal(folder.title, "Schema Notes and Migration Plans");
            assert.equal(folder.parentId, undefined);
        });
    });

    it("reuses the folder on a second call, and across types that share it", async () => {
        await withBackend(async (backend) => {
            const first = await ensureDocFolder(backend.docStore, "EXA", "schema-notes");
            const second = await ensureDocFolder(backend.docStore, "EXA", "schema-notes");
            const third = await ensureDocFolder(backend.docStore, "EXA", "migration-plan");
            assert.equal(second?.id, first?.id);
            assert.equal(third?.id, first?.id);
        });
    });

    it("keeps one folder per space", async () => {
        await withBackend(async (backend) => {
            const a = await ensureDocFolder(backend.docStore, "EXA", "test-plan");
            const b = await ensureDocFolder(backend.docStore, "EXB", "test-plan");
            assert.notEqual(a?.id, b?.id);
            assert.equal(b?.spaceKey, "EXB");
        });
    });

    it("returns null, and creates nothing, for a type that is not filed", async () => {
        await withBackend(async (backend) => {
            assert.equal(await ensureDocFolder(backend.docStore, "EXA", "project-home"), null);
            assert.equal(await backend.docStore.getPage({ spaceKey: "EXA", title: "Project Home" }), null);
        });
    });
});

describe("resolvePageParent", () => {
    it("refuses a create with neither type nor parent", async () => {
        await withBackend(async (backend) => {
            await assert.rejects(
                () => resolvePageParent(backend.docStore, "EXA", {}),
                /needs type=<output-type> or parent=<PAGE-ID>/
            );
        });
    });

    it("files under the type's folder when only type is given", async () => {
        await withBackend(async (backend) => {
            const parent = await resolvePageParent(backend.docStore, "EXA", { type: "test-plan" });
            const folder = await backend.docStore.getPage({ spaceKey: "EXA", title: "Test Plans" });
            assert.equal(parent, folder?.id);
        });
    });

    it("an explicit parent wins and creates no folder", async () => {
        await withBackend(async (backend) => {
            const page = await backend.docStore.createPage({ spaceKey: "EXA", title: "Somewhere", content: "x" });
            assert.equal(await resolvePageParent(backend.docStore, "EXA", { parent: page.id }), page.id);
            assert.equal(await backend.docStore.getPage({ spaceKey: "EXA", title: "Test Plans" }), null);
        });
    });

    it("still rejects an unknown type when a parent is also given", async () => {
        await assert.rejects(
            () => resolvePageParent({} as never, "EXA", { type: "nope", parent: "1" }),
            /Unknown page type "nope"/
        );
    });

    it("a type that is not filed creates at the root, deliberately", async () => {
        await withBackend(async (backend) => {
            assert.equal(await resolvePageParent(backend.docStore, "EXA", { type: "project-home" }), undefined);
        });
    });
});

describe("looseRootPages", () => {
    it("drops the doc-type folders and Config, keeps everything else", () => {
        const page = (title: string) => ({ id: title, spaceKey: "EXA", title, createdAt: "", updatedAt: "" }) as never;
        const loose = looseRootPages([page("Test Plans"), page("Config"), page("Schema notes: Sites (EXA-1)"), page("Runbooks and Infra")]);
        assert.deepEqual(loose.map((p) => p.title), ["Schema notes: Sites (EXA-1)"]);
    });
});

describe("filePage", () => {
    it("moves a loose page under its type's folder", async () => {
        await withBackend(async (backend) => {
            const loose = await backend.docStore.createPage({ spaceKey: "EXA", title: "Schema notes: Sites", content: "x" });
            const moved = await filePage(backend.docStore, loose.id, "schema-notes");
            const folder = await backend.docStore.getPage({ spaceKey: "EXA", title: "Schema Notes and Migration Plans" });
            assert.equal(moved.parentId, folder?.id);
            assert.deepEqual((await backend.docStore.listRootPages("EXA")).map((p) => p.title), ["Schema Notes and Migration Plans"]);
        });
    });

    it("files into the page's own space", async () => {
        await withBackend(async (backend) => {
            const loose = await backend.docStore.createPage({ spaceKey: "EXB", title: "Plan", content: "x" });
            const moved = await filePage(backend.docStore, loose.id, "test-plan");
            assert.equal(moved.spaceKey, "EXB");
            assert.ok(moved.parentId);
        });
    });

    it("refuses to file a folder under a folder", async () => {
        await withBackend(async (backend) => {
            const folder = await ensureDocFolder(backend.docStore, "EXA", "test-plan");
            await assert.rejects(() => filePage(backend.docStore, folder!.id, "test-plan"), /is itself a folder/);
        });
    });

    it("refuses a type that is not filed, and a page that does not exist", async () => {
        await withBackend(async (backend) => {
            const loose = await backend.docStore.createPage({ spaceKey: "EXA", title: "Home", content: "x" });
            await assert.rejects(() => filePage(backend.docStore, loose.id, "project-home"), /not filed/);
            await assert.rejects(() => filePage(backend.docStore, toPageId("EXA-999"), "test-plan"), /not found/i);
        });
    });
});
