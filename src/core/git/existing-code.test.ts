import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { countExistingCode, detectExistingCode, isCodePath } from "./existing-code.js";

describe("existing code detection (TAI-471)", () => {
    it("counts source and build files as code", () => {
        for (const file of ["go.mod", "Makefile", "cmd/server/main.go", "web/src/App.tsx", "migrations/001_init.sql", "package.json"]) {
            assert.equal(isCodePath(file), true, file);
        }
    });

    it("does not count documents, dot-files, dot-directories or licence-style files", () => {
        for (const file of ["README.md", "docs/design.md", "LICENSE", "CHANGELOG", ".gitignore", ".github/workflows/ci.yml", ".claude/settings.json", "docs/diagram.png", "CLAUDE.md"]) {
            assert.equal(isCodePath(file), false, file);
        }
    });

    it("reports how many code files there are and the first few", () => {
        const result = countExistingCode(["README.md", "a.go", "b.go", "c.go", "d.go", "e.go", "f.go"]);
        assert.equal(result.codeFiles, 6);
        assert.deepEqual(result.examples, ["a.go", "b.go", "c.go", "d.go", "e.go"]);
        assert.deepEqual(countExistingCode(["README.md", ".gitignore"]), { codeFiles: 0, examples: [] });
    });

    it("is null outside a git repo", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-existing-code-"));
        try {
            assert.equal(await detectExistingCode(dir), null);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
