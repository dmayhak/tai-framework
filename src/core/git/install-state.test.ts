import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describeTaiInstall, isOnDefaultBranch, renderInstallWarning, type TaiInstallState } from "./install-state.js";

const state = (over: Partial<TaiInstallState>): TaiInstallState => ({ root: "/opt/tai", branch: "master", commit: "abc1234", defaultBranch: "master", ...over });

describe("TAI install state (TAI-522 ADR decision 4)", () => {
    it("says nothing when the install is on its default branch", () => {
        assert.equal(renderInstallWarning(state({})), undefined);
        assert.equal(renderInstallWarning(state({ branch: "trunk", defaultBranch: "trunk" })), undefined);
        assert.equal(renderInstallWarning(null), undefined);
    });

    it("names the branch, the commit and the install when it is on another branch", () => {
        const text = renderInstallWarning(state({ branch: "TAI-1-feature" }))!;
        assert.match(text, /running from branch `TAI-1-feature` \(commit abc1234\) of `\/opt\/tai`, not its default branch `master`/);
    });

    it("treats a detached HEAD as not the default branch", () => {
        assert.match(renderInstallWarning(state({ branch: null }))!, /running from a detached HEAD \(commit abc1234\)/);
    });

    it("with no recorded default, main and master count as the default and anything else does not", () => {
        assert.equal(isOnDefaultBranch(state({ defaultBranch: null, branch: "main" })), true);
        assert.equal(isOnDefaultBranch(state({ defaultBranch: null, branch: "master" })), true);
        assert.equal(isOnDefaultBranch(state({ defaultBranch: null, branch: "feature" })), false);
    });

    it("reads the branch and commit of a real checkout, and is null outside one", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-install-state-"));
        try {
            assert.equal(await describeTaiInstall(dir), null);
            const git = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
            git("init", "-q", "-b", "master");
            git("config", "user.email", "t@example.com");
            git("config", "user.name", "T");
            await writeFile(path.join(dir, "a.txt"), "a");
            git("add", ".");
            git("commit", "-q", "-m", "one");
            git("checkout", "-q", "-b", "feature");
            const found = await describeTaiInstall(dir);
            assert.equal(found?.branch, "feature");
            assert.equal(found?.defaultBranch, null);
            assert.match(found?.commit ?? "", /^[0-9a-f]{7,}$/);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
