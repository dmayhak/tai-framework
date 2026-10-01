import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { gitStatusPorcelain } from "./init-run-io.js";
import { unpushedChangesReminder } from "./init-run.js";

/** No ambient GIT_* (a git hook sets GIT_DIR) and no developer/global git config. */
function isolatedGitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-init-run-io-"));
    try {
        await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("gitStatusPorcelain (real git)", () => {
    it("is null outside a git repository", async () => {
        await withTempDir(async (dir) => {
            assert.equal(await gitStatusPorcelain(dir, isolatedGitEnv()), null);
        });
    });

    it("shows an untracked CLAUDE.md, which feeds the reminder end to end", async () => {
        await withTempDir(async (dir) => {
            execFileSync("git", ["init", "-q"], { cwd: dir, env: isolatedGitEnv() });
            assert.equal(unpushedChangesReminder(await gitStatusPorcelain(dir, isolatedGitEnv())), null, "clean tree");
            await writeFile(path.join(dir, "CLAUDE.md"), "x", "utf-8");
            const porcelain = await gitStatusPorcelain(dir, isolatedGitEnv());
            assert.match(porcelain ?? "", /\?\? CLAUDE\.md/);
            assert.match(unpushedChangesReminder(porcelain) ?? "", /CLAUDE\.md/);
        });
    });
});
