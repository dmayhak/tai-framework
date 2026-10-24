import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildAllowRules, describeAllowRules, mergeAllowRules, personaSpellings, settingsLocalPath, writeSettingsLocal } from "./claude-allow-rule.js";
import { PERSONA_ALIASES, Persona } from "../schema/story-schema.js";

const HOME = "/home/x/.tai-framework";
const CLI = `npx --prefix ${HOME} tsx ${HOME}/src/hosts/cli.ts`;

describe("buildAllowRules (TAI-589)", () => {
    const rules = buildAllowRules(HOME);

    it("covers the issue and page subcommands, bare and with every persona spelled out after --as", () => {
        for (const sub of ["issue", "page"]) {
            assert.ok(rules.includes(`Bash(${CLI} ${sub} *)`), sub);
            for (const persona of Object.values(Persona)) assert.ok(rules.includes(`Bash(${CLI} --as ${persona} ${sub} *)`), `--as ${persona} ${sub}`);
        }
    });

    it("covers the read-only commands, bare and with every persona", () => {
        for (const sub of ["ready", "pr-ready", "work", "verify", "git-pr review-prep", "git-pr comments", "git-pr render-findings"]) {
            assert.ok(rules.includes(`Bash(${CLI} ${sub} *)`), sub);
            for (const persona of Object.values(Persona)) assert.ok(rules.includes(`Bash(${CLI} --as ${persona} ${sub} *)`), `--as ${persona} ${sub}`);
        }
    });

    it("never uses a wildcard for the persona: it would span words (found in the review of PR 8)", () => {
        assert.ok(rules.every((r) => !r.includes("--as *")));
    });

    describe("what the rules match, with `*` matching any characters including spaces (as Claude Code's does)", () => {
        const matches = (rule: string, command: string): boolean => {
            const body = rule.slice("Bash(".length, -1);
            const re = new RegExp(`^${body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
            return re.test(command);
        };
        const allowed = (command: string) => rules.some((r) => matches(r, command));

        it("allows the routine commands, with and without --as", () => {
            assert.ok(allowed(`${CLI} issue comment TAI-1 "Handoff: next"`));
            assert.ok(allowed(`${CLI} --as tester issue transition TAI-2 Done`));
            assert.ok(allowed(`${CLI} --as code-reviewer git-pr comments o/r 3`));
            assert.ok(allowed(`${CLI} ready pm`));
        });

        it("does not allow merge, review, init or create, even with a covered word in the text", () => {
            const blocked = [
                `${CLI} git-pr merge TAI-9 o/r 3`,
                `${CLI} git-pr review o/r 3 approve "see issue fixed"`,
                `${CLI} --as x git-pr merge TAI-9 o/r 3 page`,
                `${CLI} --as code-reviewer git-pr review o/r 3 approve "ready to work on verify"`,
                `${CLI} --as tester git-pr merge TAI-9 o/r 3 issue`,
                `${CLI} --as nobody git-pr merge TAI-9 o/r 3 issue`,
                `${CLI} init run`,
                `${CLI} --as pm init run issue`,
                `${CLI} git-pr create TAI-9 o/r b main title`,
            ];
            for (const command of blocked) assert.equal(allowed(command), false, command);
        });
    });

    it("never covers git-pr merge, git-pr review, init, or a bare git-pr or wildcard subcommand", () => {
        for (const rule of rules) {
            assert.doesNotMatch(rule, /git-pr merge|git-pr review(?!-prep)|\binit\b/, rule);
            assert.doesNotMatch(rule, /cli\.ts (--as[ =]\S+ )?\*\)|git-pr \*\)/, rule);
        }
    });

    it("covers every short name and the --as=<name> spelling (TAI-622)", () => {
        for (const sub of ["issue", "page", "git-pr comments"]) {
            for (const persona of Object.values(Persona)) {
                assert.ok(rules.includes(`Bash(${CLI} --as=${persona} ${sub} *)`), `--as=${persona} ${sub}`);
                for (const alias of PERSONA_ALIASES[persona]) {
                    assert.ok(rules.includes(`Bash(${CLI} --as ${alias} ${sub} *)`), `--as ${alias} ${sub}`);
                    assert.ok(rules.includes(`Bash(${CLI} --as=${alias} ${sub} *)`), `--as=${alias} ${sub}`);
                }
            }
        }
    });

    it("names this install's CLI only, and has no duplicates", () => {
        assert.ok(rules.every((r) => r.startsWith(`Bash(${CLI} `)));
        assert.equal(new Set(rules).size, rules.length);
    });
});

describe("project personas in the rules (TAI-622)", () => {
    const rules = buildAllowRules(HOME, ["release-manager", "Bad Name", "x;rm", "9lives"]);

    it("spells out a project's own persona after --as and --as=, for every covered subcommand", () => {
        for (const sub of ["issue", "page", "ready", "pr-ready", "work", "verify", "git-pr review-prep", "git-pr comments", "git-pr render-findings"]) {
            assert.ok(rules.includes(`Bash(${CLI} --as release-manager ${sub} *)`), sub);
            assert.ok(rules.includes(`Bash(${CLI} --as=release-manager ${sub} *)`), sub);
        }
    });

    it("leaves out an id that is not a valid --as value rather than writing it into a rule", () => {
        assert.deepEqual(personaSpellings(["Bad Name", "x;rm", "9lives"]), personaSpellings());
        assert.ok(rules.every((r) => !/Bad Name|x;rm|9lives/.test(r)));
    });

    it("still has no wildcard persona and no merge, review or init rule, and no duplicates", () => {
        assert.ok(rules.every((r) => !r.includes("--as *") && !r.includes("--as=*")));
        for (const rule of rules) assert.doesNotMatch(rule, /git-pr merge|git-pr review(?!-prep)|\binit\b/, rule);
        assert.equal(new Set(rules).size, rules.length);
        assert.deepEqual(rules, buildAllowRules(HOME, ["release-manager", "release-manager"].concat(["Bad Name", "x;rm", "9lives"])));
    });

    it("does not let a project persona id turn a merge into an allowed command", () => {
        const body = (r: string) => r.slice("Bash(".length, -1);
        const re = (r: string) => new RegExp(`^${body(r).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
        const merge = `${CLI} --as=release-manager git-pr merge TAI-9 o/r 3 issue`;
        assert.equal(rules.some((r) => re(r).test(merge)), false);
    });
});

describe("describeAllowRules (TAI-622)", () => {
    it("lists the bare rules in full and summarises the per-persona ones", () => {
        const names = personaSpellings(["release-manager"]);
        const text = describeAllowRules(buildAllowRules(HOME, ["release-manager"]), HOME, names);
        assert.ok(text.includes(`Bash(${CLI} issue *)`));
        assert.match(text, /and \d+ more/);
        assert.match(text, /release-manager/);
        assert.ok(!text.includes("--as release-manager issue"), "the per-persona rules are not each printed");
        assert.ok(text.split("\n").length < 20);
    });
});

describe("writeSettingsLocal (TAI-622)", () => {
    it("replaces the file through a temporary file, leaving only the settings file behind", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "allow-"));
        try {
            await writeSettingsLocal(dir, '{"a":1}\n');
            await writeSettingsLocal(dir, '{"a":2}\n');
            assert.equal(await readFile(settingsLocalPath(dir), "utf-8"), '{"a":2}\n');
            assert.deepEqual(await readdir(path.dirname(settingsLocalPath(dir))), ["settings.local.json"]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("keeps the old file and removes the temporary one when the write fails", async () => {
        const dir = await mkdtemp(path.join(os.tmpdir(), "allow-"));
        try {
            await writeSettingsLocal(dir, '{"keep":true}\n');
            // A directory where the target should be makes the rename fail after the temporary file was written.
            const file = settingsLocalPath(dir);
            await rm(file);
            await writeFile(path.join(path.dirname(file), "blocker"), "");
            await rm(path.join(path.dirname(file), "blocker"));
            await import("node:fs/promises").then((fs) => fs.mkdir(file));
            await assert.rejects(writeSettingsLocal(dir, '{"new":true}\n'));
            assert.deepEqual(await readdir(path.dirname(file)), ["settings.local.json"], "no temporary file left");
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
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
