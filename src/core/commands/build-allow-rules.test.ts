import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildDevPrompt, buildFixPrompt, buildReviewerPrompt, buildVerifyPrompt } from "./headless-claude.js";
import { buildRunRules, commandVerdict, documentedCheckCommands, missingRules, parsePermissions, readPermissionFiles, readinessWarning, renderRulesJson, undocumentedCheckGaps } from "./build-allow-rules.js";

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

    // The same reading of `*` the module uses: any characters, spaces included.
    const matches = (rule: string, command: string): boolean => new RegExp(`^${rule.replace(/^Bash\(|\)$/g, "").split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s").test(command);

    it("refuses merge, review and init under every persona name after --as and --as=, never with a wildcard (PR 27 review)", () => {
        const { deny } = buildRunRules(HOME);
        for (const sub of ["git-pr merge", "git-pr review", "init"]) {
            for (const name of ["developer", "dev", "reviewer", "cr", "pm", "tester"]) {
                assert.ok(deny.includes(`Bash(${CLI} --as ${name} ${sub} *)`), `--as ${name} ${sub}`);
                assert.ok(deny.includes(`Bash(${CLI} --as=${name} ${sub} *)`), `--as=${name} ${sub}`);
            }
        }
        assert.ok(!deny.some((r) => r.includes("--as *") || r.includes("--as=*")), "no wildcard stands in for the persona");
        assert.ok(deny.some((r) => matches(r, `${CLI} --as reviewer git-pr merge 5`)), "a merge as a persona is refused");
        assert.ok(deny.some((r) => matches(r, `${CLI} --as=cr init run`)), "init as a persona is refused");
    });

    it("does not refuse a build's own ticket and PR commands whose text mentions init, a merge or a review (PR 27 review)", () => {
        const { deny } = buildRunRules(HOME);
        for (const command of [
            `${CLI} --as developer issue comment TAI-1 "Handoff: do not run init yet"`,
            `${CLI} --as developer issue create TAIT dev "git-pr merge docs" description="a git-pr review note"`,
            `${CLI} git-pr create TAI-2 o/r b main "title" "what init and git-pr merge do"`,
            `${CLI} --as=developer git-pr create TAI-2 o/r b main "title" "mentions git-pr review"`,
        ]) assert.ok(!deny.some((r) => matches(r, command)), command);
    });

    it("names the project's own personas in the deny entries too", () => {
        const { deny } = buildRunRules(HOME, null, ["release-captain"]);
        assert.ok(deny.includes(`Bash(${CLI} --as release-captain git-pr merge *)`));
        assert.ok(deny.includes(`Bash(${CLI} --as=release-captain init *)`));
    });

    it("reports a deny that names only the bare spelling, and counts one that spans every persona as covering", () => {
        const bareOnly = { allow: [], deny: [`Bash(${CLI} git-pr merge *)`, `Bash(${CLI} git-pr review *)`, `Bash(${CLI} init *)`] };
        const gaps = missingRules(buildRunRules(HOME), bareOnly).deny;
        assert.ok(gaps.includes(`Bash(${CLI} --as developer git-pr merge *)`), "a bare-only deny is not enough");
        const spanning = missingRules(buildRunRules(HOME), { allow: [], deny: [`Bash(${CLI} *git-pr merge*)`, `Bash(${CLI} *git-pr review*)`, `Bash(${CLI} *init*)`] }).deny;
        assert.ok(!spanning.some((r) => r.includes("git-pr merge")), "a deny that spans the persona flag covers every spelling");
    });

    it("does not count a narrower rule as covering one with a wildcard in the middle (PR 27 review)", () => {
        const required = { allow: [], deny: ["Bash(git push *--force*)"] };
        assert.deepEqual(missingRules(required, { allow: [], deny: ["Bash(git push --force*)"] }).deny, ["Bash(git push *--force*)"], "git push origin --force would get through");
        assert.deepEqual(missingRules(required, { allow: [], deny: ["Bash(git push *--force*)"] }).deny, []);
        assert.deepEqual(missingRules(required, { allow: [], deny: ["Bash(git push *)"] }).deny, [], "a wider deny covers it");
    });

    it("splits a compound check command outside quotes only, and on & and newlines too (PR 27 review)", () => {
        const parts = (c: string): string[] => buildRunRules(HOME, c).allow.filter((r) => !r.includes("cli.ts") && !/^Bash\(git /.test(r)).map((r) => r.slice(5, -1));
        assert.deepEqual(parts('npm test -- --grep "a|b"'), ['npm test -- --grep "a|b"'], "a | inside quotes stays");
        assert.deepEqual(parts("npm run a; npm run b"), ["npm run a", "npm run b"]);
        assert.deepEqual(parts("make build & make test"), ["make build", "make test"], "a lone & separates");
        assert.deepEqual(parts("npm run a\nnpm run b"), ["npm run a", "npm run b"], "a newline separates");
        assert.deepEqual(parts("npm test 2>&1 | tee out.log"), ["npm test 2>&1", "tee out.log"], "the & of a redirect stays");
        assert.deepEqual(parts("npm run 'a && b'"), ["npm run 'a && b'"]);
    });

    it("also refuses the destructive git forms: a --delete push, a branch delete, a checkout that discards work", () => {
        const { deny } = buildRunRules(HOME);
        for (const rule of ["git push *--delete*", "git push -uf*", "git branch -D*", "git branch -d*", "git branch --delete*", "git branch -f*", "git branch --force*", "git branch -M*", "git checkout *-- *", "git checkout .", "git checkout ./*"]) assert.ok(deny.includes(`Bash(${rule})`), rule);
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

    it("allows git rm and git mv in both sets, and refuses their forced forms and the other destructive git still (TAI-709)", () => {
        for (const rules of [buildRunRules(HOME), buildRunRules(HOME, null, [], true)]) {
            assert.ok(rules.allow.includes("Bash(git rm *)") && rules.allow.includes("Bash(git mv *)"));
            for (const c of ["git rm README.md", "git rm --cached notes.txt", "git rm -r old/", "git mv a.txt b.txt", "git rm src/fix.ts"]) assert.equal(commandVerdict(rules, c), "allowed", c);
            for (const c of ["git rm -f README.md", "git rm --force README.md", "git mv -f a b", "git mv a b --force", "git rm a -f", "git rm -r -f d", "git rm -rf d", "git rm -fr d", "git rm d -rf", "git mv a b -f"]) assert.equal(commandVerdict(rules, c), "refused", c);
            assert.equal(commandVerdict(rules, "git rm -r old/file"), "allowed", "a path containing an f is not a force flag");
            for (const c of ["git push --force origin x", "git branch -D x", "git checkout -- src", "git checkout ."]) assert.equal(commandVerdict(rules, c), "refused", c);
        }
    });

    it("the readiness warning names git rm and git mv when a project's settings lack them (TAI-709)", () => {
        const rules = buildRunRules(HOME);
        const have = { allow: rules.allow.filter((r) => !r.includes("git rm") && !r.includes("git mv")), deny: rules.deny };
        const gaps = missingRules(rules, have);
        assert.deepEqual(gaps.allow, ["Bash(git rm *)", "Bash(git mv *)"]);
        assert.match(readinessWarning(gaps, true, false)!, /git rm \*[\s\S]*git mv \*/);
    });

    it("refuses a checkout that discards a file's changes, with a commit before the --, and a checkout of . or ./ (TAI-685)", () => {
        const rules = buildRunRules(HOME);
        for (const c of ["git checkout -- src", "git checkout HEAD -- src", "git checkout origin/main -- .", "git checkout .", "git checkout ./", "git checkout ./src"]) assert.equal(commandVerdict(rules, c), "refused", c);
        for (const c of ["git checkout TAI-9-x", "git checkout -b TAI-9-x", "git switch TAI-9-x"]) assert.equal(commandVerdict(rules, c), "allowed", c);
    });
});

describe("rules for a DEV-YOLO run (TAI-685)", () => {
    const yolo = buildRunRules(HOME, "npm test", [], true);
    const build = buildRunRules(HOME, "npm test");

    it("allows the reviewer, fix and verify commands and does not deny git-pr review, but still denies merge and init", () => {
        for (const sub of ["git-pr review-prep", "git-pr render-findings", "git-pr comment-findings", "git-pr comment", "git-pr review", "verify", "--as tester issue"]) assert.ok(yolo.allow.includes(`Bash(${CLI} ${sub} *)`), sub);
        assert.ok(!yolo.deny.some((r) => r.includes("git-pr review")), "no deny names git-pr review");
        assert.ok(yolo.deny.includes(`Bash(${CLI} git-pr merge *)`));
        assert.ok(yolo.deny.includes(`Bash(${CLI} --as reviewer git-pr merge *)`));
        assert.ok(yolo.deny.includes(`Bash(${CLI} init *)`));
        assert.ok(yolo.deny.includes("Bash(git push *--force*)"), "the git denies are the same");
    });

    it("leaves the build-only set as it was: git-pr review denied, none of the YOLO commands allowed", () => {
        assert.ok(build.deny.includes(`Bash(${CLI} git-pr review *)`));
        assert.ok(!build.allow.some((r) => /review-prep|render-findings|comment-findings|verify|--as tester/.test(r)));
    });

    it("never refuses a command a DEV-YOLO run makes, and lists each of them as allowed", () => {
        const prompts = [
            buildDevPrompt("TAI-9", CLI),
            buildReviewerPrompt({ repo: "o/r", prId: "7", cli: CLI, findingsPath: "/x/.tai/f.json", storyKey: "TAI-5", criteria: ["AC-1: x"] }),
            buildFixPrompt({ key: "TAI-9", repo: "o/r", prId: "7", branch: "TAI-8-x", cli: CLI, findings: [] }),
            buildVerifyPrompt({ key: "TAI-8", cli: CLI }),
        ];
        const commands = prompts.flatMap((p) => [...p.matchAll(/`([^`]*cli\.ts[^`]*)`/g)].map((m) => m[1]!.replace(/ \.\.\.$/, "").replace(/"\.\.\."/g, '"x"')).map((c) => `${c} x`));
        assert.ok(commands.length >= 10, `found the commands in the prompts, each given an argument as a real run gives it (${commands.length})`);
        for (const c of commands) assert.equal(commandVerdict(yolo, c), "allowed", c);
        for (const c of [`${CLI} --as tester issue comment TAI-8 "Verified: x"`, `${CLI} git-pr review o/r 7 approve`]) assert.equal(commandVerdict(yolo, c), "allowed", c);
        for (const c of [`${CLI} git-pr merge TAI-9 o/r 7`, `${CLI} --as developer git-pr merge TAI-9 o/r 7`, `${CLI} init run`]) assert.equal(commandVerdict(yolo, c), "refused", c);
    });

    it("words the pre-run warning for the mode: a YOLO run is not told a review is reachable", () => {
        const gaps = { allow: [], deny: [`Bash(${CLI} git-pr merge *)`] };
        assert.match(readinessWarning(gaps, true, true)!, /reach a merge or init:/);
        assert.match(readinessWarning(gaps, true)!, /reach a merge, a review or init:/);
        assert.match(readinessWarning(gaps, true, true)!, /to see the rule set for a DEV-YOLO run/);
        assert.match(readinessWarning(gaps, true)!, /to see the narrow rule set/);
        const missing = missingRules(yolo, { allow: [], deny: [] });
        assert.ok(!missing.deny.some((r) => r.includes("git-pr review")), "a YOLO run is never told to deny git-pr review");
        assert.ok(missing.allow.some((r) => r.includes("review-prep")));
    });
});

describe("the commands the project's rules file names (TAI-723)", () => {
    const ENV_TEST = "env -u TAI_TEST_JIRA_SITE_URL -u TAI_TEST_JIRA_EMAIL -u TAI_TEST_JIRA_API_TOKEN npm test";
    const CONTEXT = [
        "## Commands",
        "",
        `- Offline test suite: \`${ENV_TEST}\``,
        "- Type check: `npm run typecheck`",
        "- Lint: `npm run lint`",
        "- All three pass before a PR is opened.",
        "- Run the app with: `npm start`",
    ].join("\n");

    it("reads the test, lint and type-check commands from their bullets and nothing else", () => {
        assert.deepEqual(documentedCheckCommands(CONTEXT), [ENV_TEST, "npm run typecheck", "npm run lint"]);
        assert.deepEqual(documentedCheckCommands(null), []);
    });

    it("ignores a bullet that says what not to do, and a label with none of the words", () => {
        const text = [
            "## Commands",
            "- Never run the check: `rm -rf x`",
            "- Do not skip tests: `npm test --force`",
            "- Run the app with: `npm start`",
            "- Tests: `npm test`",
            "- Lint (do not edit by hand): `npm run lint`",
        ].join("\n");
        assert.deepEqual(documentedCheckCommands(text), ["npm test"]);
    });

    it("finds nothing uncovered when TAI_CHECK_COMMAND names the documented commands, and allows the env -u form as written", () => {
        const rules = buildRunRules(HOME, `npm run typecheck && npm run lint && ${ENV_TEST}`);
        assert.deepEqual(undocumentedCheckGaps(CONTEXT, rules), []);
        assert.equal(commandVerdict(rules, ENV_TEST), "allowed");
    });

    it("does not allow a variant of the documented command with another command appended or a flag changed", () => {
        const rules = buildRunRules(HOME, `npm run typecheck && npm run lint && ${ENV_TEST}`);
        assert.equal(commandVerdict(rules, `${ENV_TEST} -- --force`), "unlisted");
        assert.equal(commandVerdict(rules, `${ENV_TEST}; rm -rf .`), "unlisted");
        assert.equal(commandVerdict(rules, "npm test"), "unlisted");
    });

    it("reads only the section about commands, and nothing when the file has none", () => {
        const text = [
            "## Conventions",
            "- Check out the branch: `git checkout x`",
            "- Test data lives in: `fixtures/`",
            "## Build commands",
            "- Tests: `npm test`",
            "## Never",
            "- Skip the check: `npm run skip`",
        ].join("\n");
        assert.deepEqual(documentedCheckCommands(text), ["npm test"]);
        assert.deepEqual(documentedCheckCommands("- Tests: `npm test`"), []);
    });

    it("lists no documented command as a gap when TAI_CHECK_COMMAND is not set, since the 'not set' line already says so", () => {
        const rules = buildRunRules(HOME, null);
        assert.ok(undocumentedCheckGaps(CONTEXT, rules).length > 0);
        assert.deepEqual(undocumentedCheckGaps(CONTEXT, rules, false), []);
    });

    it("names the documented command that the check command lacks, in the readiness warning", () => {
        const rules = buildRunRules(HOME, "npm run typecheck && npm run lint && npm test");
        const gaps = undocumentedCheckGaps(CONTEXT, rules);
        assert.deepEqual(gaps, [ENV_TEST]);
        const text = readinessWarning({ allow: [], deny: [] }, true, true, gaps)!;
        assert.match(text, /rules file names 1 command for a run to use that TAI_CHECK_COMMAND does not allow/);
        assert.ok(text.includes(`  ${ENV_TEST}`));
        assert.equal(readinessWarning({ allow: [], deny: [] }, true, true, []), null);
    });
});
