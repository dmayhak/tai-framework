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

    it("refuses merge, review and init in the --as spellings too, because * spans spaces (PR 27 review)", () => {
        const { deny } = buildRunRules(HOME);
        for (const sub of ["git-pr merge", "git-pr review", "init"]) {
            assert.ok(deny.includes(`Bash(${CLI} --as * ${sub} *)`), `--as <persona> ${sub}`);
            assert.ok(deny.includes(`Bash(${CLI} --as=* ${sub} *)`), `--as=<persona> ${sub}`);
        }
        const bareOnly = { allow: [], deny: [`Bash(${CLI} git-pr merge *)`, `Bash(${CLI} git-pr review *)`, `Bash(${CLI} init *)`] };
        const gaps = missingRules(buildRunRules(HOME), bareOnly).deny;
        assert.ok(gaps.includes(`Bash(${CLI} --as * git-pr merge *)`), "a bare-only deny is not enough");
        const covered = missingRules(buildRunRules(HOME), { allow: [], deny: [`Bash(${CLI} *git-pr merge*)`, `Bash(${CLI} *git-pr review*)`, `Bash(${CLI} *init*)`] }).deny;
        assert.ok(!covered.some((r) => r.includes("git-pr merge")), "a deny that spans the persona flag covers every spelling");
    });

    it("also refuses the destructive git forms: a --delete push, a branch delete, a checkout that discards work", () => {
        const { deny } = buildRunRules(HOME);
        for (const rule of ["git push *--delete*", "git branch -D*", "git branch -d*", "git branch --delete*", "git checkout -- *", "git checkout ."]) assert.ok(deny.includes(`Bash(${rule})`), rule);
    });

    it("counts the older Bash(cmd:*) prefix form as covering, and does not let it match a longer word", () => {
        const required = { allow: ["Bash(git status*)", "Bash(git add *)"], deny: [] };
        assert.deepEqual(missingRules(required, { allow: ["Bash(git status:*)", "Bash(git add:*)"], deny: [] }), { allow: [], deny: [] });
        const wrongWord = missingRules({ allow: ["Bash(git status *)"], deny: [] }, { allow: ["Bash(git statusx:*)"], deny: [] });
        assert.deepEqual(wrongWord.allow, ["Bash(git status *)"], "git statusx is not git status");
    });

    it("allows the project's check command as it is written, and only when there is one", () => {
        assert.ok(buildRunRules(HOME, "npm test").allow.includes("Bash(npm test)"));
        assert.ok(!buildRunRules(HOME, null).allow.some((r) => r.includes("npm")));
    });

    it("allows each command of a compound check command on its own, since Claude Code matches the parts separately (PR 27 review)", () => {
        const { allow } = buildRunRules(HOME, "npm run typecheck && npm run lint && npm test");
        for (const part of ["npm run typecheck", "npm run lint", "npm test"]) assert.ok(allow.includes(`Bash(${part})`), part);
        assert.ok(!allow.some((r) => r.includes("&&")), "no rule holds the whole chain");
        const mixed = buildRunRules(HOME, "make build; make test | tee out.log || true").allow;
        for (const part of ["make build", "make test", "tee out.log", "true"]) assert.ok(mixed.includes(`Bash(${part})`), part);
        assert.equal(buildRunRules(HOME, "npm test && npm test").allow.filter((r) => r === "Bash(npm test)").length, 1, "a repeated part is listed once");
    });

    it("also refuses a push to main or master, --mirror and --prune, and a forced or resetting checkout or switch (PR 27 review)", () => {
        const { deny } = buildRunRules(HOME);
        for (const rule of [
            "git push *--mirror*", "git push *--prune*", "git push origin main", "git push origin main *", "git push -u origin master", "git push *:main",
            "git checkout -f*", "git checkout *--force*", "git checkout -B*", "git switch -f*", "git switch *--discard-changes*", "git switch -C*",
        ]) assert.ok(deny.includes(`Bash(${rule})`), rule);
        assert.ok(!deny.some((r) => r === "Bash(git push origin *)"), "pushing a branch to origin is still allowed");
    });

    it("reports an allow entry that a deny rule of the person's own refuses, since a deny beats an allow (PR 27 review)", () => {
        const rules = buildRunRules(HOME);
        const have = { allow: rules.allow, deny: [...rules.deny, "Bash(git push *)"] };
        const gaps = missingRules(rules, have).allow;
        assert.ok(gaps.includes("Bash(git push origin *)") && gaps.includes("Bash(git push -u origin *)"));
        assert.ok(!gaps.includes("Bash(git status*)"), "commands the deny does not touch stay covered");
        assert.match(readinessWarning({ allow: gaps, deny: [] }, true)!, /or a deny rule of yours refuses/);
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
        assert.match(text, /force a push, delete a branch, or reach a merge/);
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
