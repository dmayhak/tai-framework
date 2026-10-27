import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildRunRules, missingRules, parsePermissions, readPermissionFiles, readinessWarning, renderRulesJson } from "./build-allow-rules.js";

const HOME = "/home/x/.tai-framework";
const CLI = `npx --prefix ${HOME} tsx ${HOME}/src/hosts/cli.ts`;

describe("build allow rules (TAI-649)", () => {
    it("covers the commands a build uses and never allows merge, review or init", () => {
        const { allow } = buildRunRules(HOME);
        for (const sub of ["issue", "work", "git-pr create", "git-pr check"]) assert.ok(allow.includes(`Bash(${CLI} ${sub} *)`), sub);
        assert.ok(allow.includes("Bash(git push -u origin *)"));
        for (const rule of allow) assert.doesNotMatch(rule, /git-pr merge|git-pr review|\binit\b/);
    });

    it("refuses a force push and the merge, review and init commands by deny entries", () => {
        const { deny } = buildRunRules(HOME);
        assert.ok(deny.includes("Bash(git push *--force*)"));
        assert.ok(deny.includes(`Bash(${CLI} git-pr merge *)`));
        assert.ok(deny.includes(`Bash(${CLI} git-pr review *)`));
        assert.ok(deny.includes(`Bash(${CLI} init *)`));
    });

    it("allows the project's check command as it is written, and only when there is one", () => {
        assert.ok(buildRunRules(HOME, "npm test").allow.includes("Bash(npm test)"));
        assert.ok(!buildRunRules(HOME, null).allow.some((r) => r.includes("npm")));
    });

    it("reports nothing missing for the full set, and counts a broader rule the person wrote as covering", () => {
        const rules = buildRunRules(HOME, "npm test");
        assert.deepEqual(missingRules(rules, rules), { allow: [], deny: [] });
        const broad = { allow: [`Bash(${CLI} *)`, "Bash(git *)", "Bash(npm *)"], deny: rules.deny };
        assert.deepEqual(missingRules(rules, broad).allow, []);
    });

    it("lists what is missing, and the deny entries nothing provides", () => {
        const gaps = missingRules(buildRunRules(HOME), { allow: [`Bash(${CLI} issue *)`], deny: [] });
        assert.ok(gaps.allow.includes(`Bash(${CLI} git-pr create *)`));
        assert.ok(!gaps.allow.includes(`Bash(${CLI} issue *)`));
        assert.ok(gaps.deny.includes("Bash(git push *--force*)"));
    });

    it("warns plainly about the gaps and a missing check command, and is silent when all is covered", () => {
        const gaps = missingRules(buildRunRules(HOME), { allow: [], deny: [] });
        const text = readinessWarning(gaps, false)!;
        assert.match(text, /will stop at the first one/);
        assert.match(text, /force a push or reach a merge/);
        assert.match(text, /TAI_CHECK_COMMAND is not set/);
        assert.match(text, /TAI does not write it/);
        assert.equal(readinessWarning({ allow: [], deny: [] }, true), null);
    });

    it("renders a permissions block the person can paste", () => {
        const parsed = JSON.parse(renderRulesJson(buildRunRules(HOME))) as { permissions: { allow: string[]; deny: string[] } };
        assert.ok(parsed.permissions.allow.length > 0 && parsed.permissions.deny.length > 0);
    });

    it("reads allow and deny from the project and user settings files, and ignores a file that is not JSON", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-rules-"));
        try {
            await mkdir(path.join(dir, "proj", ".claude"), { recursive: true });
            await mkdir(path.join(dir, "home", ".claude"), { recursive: true });
            await writeFile(path.join(dir, "proj", ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(a)"], deny: ["Bash(d)"] } }));
            await writeFile(path.join(dir, "home", ".claude", "settings.json"), "not json");
            assert.deepEqual(await readPermissionFiles(path.join(dir, "proj"), path.join(dir, "home")), { allow: ["Bash(a)"], deny: ["Bash(d)"] });
            assert.deepEqual(parsePermissions(null), { allow: [], deny: [] });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
