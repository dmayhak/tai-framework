import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderGlobalSkillFiles, installGlobal, defaultTaiHome } from "./install-global.js";

describe("renderGlobalSkillFiles", () => {
    const files = renderGlobalSkillFiles("/home/x/.tai-framework");

    test("produces 8 files -- 4 skills x 2 hosts", () => {
        assert.equal(files.length, 8);
    });

    test("covers both hosts for every skill name", () => {
        for (const name of ["tai-work", "tai-ready", "tai-pr", "tai-init"]) {
            assert.ok(files.some((f) => f.relativePath === `.claude/skills/${name}/SKILL.md`));
            assert.ok(files.some((f) => f.relativePath === `.gemini/skills/${name}/SKILL.md`));
        }
    });

    test("every file has valid SKILL.md frontmatter (name + description)", () => {
        for (const f of files) {
            assert.match(f.content, /^---\nname: [\w-]+\ndescription: .+\n---\n/);
        }
    });

    test("every skill's content embeds the taiHome path, not a relative one", () => {
        for (const f of files) {
            assert.match(f.content, /\/home\/x\/\.tai-framework\/src\/hosts\/cli\.ts/);
        }
    });

    test("Claude and Gemini versions of the same skill are byte-identical", () => {
        for (const name of ["tai-work", "tai-ready", "tai-pr", "tai-init"]) {
            const claude = files.find((f) => f.relativePath === `.claude/skills/${name}/SKILL.md`)!;
            const gemini = files.find((f) => f.relativePath === `.gemini/skills/${name}/SKILL.md`)!;
            assert.equal(claude.content, gemini.content);
        }
    });

    test("no skill relies on Gemini's !{...} or backtick shell auto-exec syntax", () => {
        for (const f of files) {
            assert.ok(!f.content.includes("!{"), `${f.relativePath} should not use !{...} auto-exec`);
        }
    });
});

describe("defaultTaiHome", () => {
    test("is a .tai-framework directory under the home dir", () => {
        assert.ok(defaultTaiHome().endsWith(path.join(".tai-framework")));
    });
});

describe("installGlobal", () => {
    test("throws when taiHome doesn't exist, without writing anything", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-install-global-"));
        try {
            const homedir = path.join(dir, "home");
            await mkdir(homedir, { recursive: true });
            const missingTaiHome = path.join(dir, "does-not-exist");

            await assert.rejects(() => installGlobal(missingTaiHome, homedir), /does-not-exist.*clone/s);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("writes all 8 skill files under the given homedir when taiHome exists", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-install-global-"));
        try {
            const homedir = path.join(dir, "home");
            const taiHome = path.join(dir, "tai-framework");
            await mkdir(homedir, { recursive: true });
            await mkdir(taiHome, { recursive: true });

            const result = await installGlobal(taiHome, homedir);

            assert.equal(result.taiHome, taiHome);
            assert.equal(result.written.length, 8);

            const claudeWork = await readFile(path.join(homedir, ".claude/skills/tai-work/SKILL.md"), "utf-8");
            assert.match(claudeWork, /name: tai-work/);
            assert.match(claudeWork, new RegExp(taiHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

            const geminiInit = await readFile(path.join(homedir, ".gemini/skills/tai-init/SKILL.md"), "utf-8");
            assert.match(geminiInit, /name: tai-init/);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("is idempotent -- re-running overwrites cleanly, no duplication or error", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-install-global-"));
        try {
            const homedir = path.join(dir, "home");
            const taiHome = path.join(dir, "tai-framework");
            await mkdir(homedir, { recursive: true });
            await mkdir(taiHome, { recursive: true });

            await installGlobal(taiHome, homedir);
            const second = await installGlobal(taiHome, homedir);

            assert.equal(second.written.length, 8);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
