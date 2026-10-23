import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAllowRules, mergeAllowRules } from "./claude-allow-rule.js";

const HOME = "/home/x/.tai-framework";
const CLI = `npx --prefix ${HOME} tsx ${HOME}/src/hosts/cli.ts`;

describe("buildAllowRules (TAI-589)", () => {
    const rules = buildAllowRules(HOME);

    it("covers the issue and page subcommands, with and without --as", () => {
        for (const sub of ["issue", "page"]) {
            assert.ok(rules.includes(`Bash(${CLI} ${sub} *)`), sub);
            assert.ok(rules.includes(`Bash(${CLI} --as * ${sub} *)`), `--as ${sub}`);
        }
    });

    it("covers the read-only commands, with and without --as", () => {
        for (const sub of ["ready", "pr-ready", "work", "verify", "git-pr review-prep", "git-pr comments", "git-pr render-findings"]) {
            assert.ok(rules.includes(`Bash(${CLI} ${sub} *)`), sub);
            assert.ok(rules.includes(`Bash(${CLI} --as * ${sub} *)`), `--as ${sub}`);
        }
    });

    it("never covers git-pr merge, git-pr review, init, or a bare git-pr or wildcard subcommand", () => {
        for (const rule of rules) {
            assert.doesNotMatch(rule, /git-pr merge|git-pr review(?!-prep)|\binit\b/, rule);
            assert.doesNotMatch(rule, /cli\.ts (--as \* )?\*\)|git-pr \*\)/, rule);
        }
    });

    it("names this install's CLI only, and has no duplicates", () => {
        assert.ok(rules.every((r) => r.startsWith(`Bash(${CLI} `) || r.startsWith(`Bash(${CLI} --as * `)));
        assert.equal(new Set(rules).size, rules.length);
    });
});

describe("mergeAllowRules (TAI-589)", () => {
    const rules = ["Bash(a *)", "Bash(b *)"];

    it("creates the settings from nothing, with a trailing newline", () => {
        const r = mergeAllowRules(null, rules);
        assert.ok(r.ok);
        assert.deepEqual(JSON.parse(r.content), { permissions: { allow: rules } });
        assert.ok(r.content.endsWith("\n"));
        assert.deepEqual(r.added, rules);
    });

    it("treats an empty file as none", () => {
        assert.ok(mergeAllowRules("  \n", rules).ok);
    });

    it("keeps every other key and every existing rule, in order, and appends the new ones", () => {
        const existing = JSON.stringify({
            env: { A: "1" },
            permissions: { allow: ["Bash(npm test *)", "WebSearch"], deny: ["Bash(rm *)"], defaultMode: "acceptEdits" },
        });
        const r = mergeAllowRules(existing, rules);
        assert.ok(r.ok);
        const out = JSON.parse(r.content);
        assert.deepEqual(out.env, { A: "1" });
        assert.deepEqual(out.permissions.deny, ["Bash(rm *)"]);
        assert.equal(out.permissions.defaultMode, "acceptEdits");
        assert.deepEqual(out.permissions.allow, ["Bash(npm test *)", "WebSearch", ...rules]);
    });

    it("adds no duplicate when run again, and says which rules were already there", () => {
        const first = mergeAllowRules(null, rules);
        assert.ok(first.ok);
        const second = mergeAllowRules(first.content, rules);
        assert.ok(second.ok);
        assert.deepEqual(second.added, []);
        assert.deepEqual(second.present, rules);
        assert.deepEqual(JSON.parse(second.content).permissions.allow, rules);
    });

    it("adds only the missing rules when some are present", () => {
        const r = mergeAllowRules(JSON.stringify({ permissions: { allow: ["Bash(a *)"] } }), rules);
        assert.ok(r.ok);
        assert.deepEqual(r.added, ["Bash(b *)"]);
        assert.deepEqual(r.present, ["Bash(a *)"]);
    });

    it("refuses a file it cannot safely merge into, and never returns content for it", () => {
        for (const bad of ["{not json", "[]", "7", '{"permissions": []}', '{"permissions": {"allow": "x"}}']) {
            const r = mergeAllowRules(bad, rules);
            assert.equal(r.ok, false, bad);
            assert.ok(!r.ok && r.reason.length > 0);
        }
    });
});
