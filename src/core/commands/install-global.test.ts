import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderGlobalSkillFiles, installGlobal, defaultTaiHome } from "./install-global.js";

describe("renderGlobalSkillFiles", () => {
    const files = renderGlobalSkillFiles("/home/x/.tai-framework");

    test("produces 12 files -- 6 skills x 2 hosts", () => {
        assert.equal(files.length, 12);
    });

    test("the tai-groom skill runs groom [EPIC-KEY], acts as Perry, and never applies a change without the human's own confirmation (TAI-395)", () => {
        const groom = files.find((f) => f.relativePath === ".claude/skills/tai-groom/SKILL.md")!;
        assert.match(groom.content, /cli\.ts groom \[EPIC-KEY\]/);
        assert.match(groom.content, /act as that persona|act as Perry/i);
        assert.match(groom.content, /optional epic key/i);
        // authority (ADR decision 3): creates on her own; proposes the rest as a batch
        assert.match(groom.content, /Backlog tickets, depends-on links and phase labels/);
        assert.match(groom.content, /Backlog → To Do move, every epic approval/);
        assert.match(groom.content, /only after the human confirms/i);
        assert.match(groom.content, /one question per group|once per group/i);
        // read, don't parse: the work-breakdown reconciliation (decision 12) is an instruction, not a section
        assert.match(groom.content, /work-breakdown/i);
        // the ticketless entry deliberately reverses the 2026-08-25 no-planning-command decision
        assert.match(groom.content, /needs no ticket/i);
    });

    test("covers both hosts for every skill name", () => {
        for (const name of ["tai-work", "tai-ready", "tai-pr", "tai-init", "tai-audit", "tai-groom"]) {
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

    test("the tai-pr skill tells the session to paste render-findings' numbered options and maps each number (TAI-411)", () => {
        const pr = files.find((f) => f.relativePath === ".claude/skills/tai-pr/SKILL.md")!;
        assert.match(pr.content, /numbered "what would you like to do\?" list/);
        assert.match(pr.content, /never trim it/);
        for (const mapping of [
            /\*\*1\*\* post and approve/,
            /\*\*2\*\* post the findings only/,
            /\*\*3\*\* approve only/,
            /\*\*4\*\* post and request changes/,
            /\*\*5\*\* neither/,
        ]) {
            assert.match(pr.content, mapping);
        }
    });

    test("the tai-init skill tells the human a running Gemini session needs a full restart (TAI-397)", () => {
        const init = files.find((f) => f.relativePath === ".gemini/skills/tai-init/SKILL.md")!;
        assert.match(init.content, /quit and restart the Gemini process/);
        assert.match(init.content, /`\/clear` is not enough/);
    });

    test("Claude and Gemini versions of the same skill are byte-identical", () => {
        for (const name of ["tai-work", "tai-ready", "tai-pr", "tai-init", "tai-audit", "tai-groom"]) {
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

    test("tai-ready's skill tells the invoking session what to say when the backlog is genuinely empty (TAI-348/349)", () => {
        const readyFile = files.find((f) => f.relativePath === ".claude/skills/tai-ready/SKILL.md")!;
        assert.match(readyFile.content, /both sections come back empty/i);
        assert.match(readyFile.content, /Perry/);
        assert.match(readyFile.content, /genuinely fresh project/i);
    });

    test("tai-init's skill relays the /tai-init completion hint rather than just saying \"done\" (TAI-349)", () => {
        const initFile = files.find((f) => f.relativePath === ".claude/skills/tai-init/SKILL.md")!;
        assert.match(initFile.content, /relay its next-step hint/);
    });

    describe("tai-pr / tai-ready: read ALL PR comments before merging, even an approved PR (TAI-382/383)", () => {
        const prSkill = () => files.find((f) => f.relativePath === ".claude/skills/tai-pr/SKILL.md")!.content;
        const readySkill = () => files.find((f) => f.relativePath === ".claude/skills/tai-ready/SKILL.md")!.content;

        test("tai-pr documents the read-only `git-pr comments <REPO> [PR-ID]` command", () => {
            assert.match(prSkill(), /git-pr comments <REPO> \[PR-ID\]/);
        });

        test("tai-pr says approval does not finish a PR: read every comment first, including a second reviewer's", () => {
            assert.match(prSkill(), /even an approved PR/i);
            assert.match(prSkill(), /ALL comments/);
            assert.match(prSkill(), /second reviewer/i);
        });

        test("tai-pr states the minor-vs-review-worthy policy: minor -> fix, test, push, merge; review-worthy -> ask first", () => {
            assert.match(prSkill(), /very minor/i);
            assert.match(prSkill(), /fix it, run the tests, push, note it on the PR, and merge/i);
            assert.match(prSkill(), /review-worthy/i);
            assert.match(prSkill(), /do NOT merge automatically/i);
            assert.match(prSkill(), /unsure which.*review-worthy/i);
        });

        test("tai-pr says to file a ticket or skip with a stated reason, report it, and verify a reviewer's claims", () => {
            assert.match(prSkill(), /file a ticket/i);
            assert.match(prSkill(), /stated reason/i);
            assert.match(prSkill(), /verify (a|the) reviewer's (factual )?claims/i);
        });

        test("picking a 'ready to merge' line no longer means merge immediately: comments are read first", () => {
            assert.doesNotMatch(prSkill(), /run `git-pr merge <ISSUE-KEY> <REPO>` directly, no further confirmation needed/);
            assert.match(prSkill(), /git-pr comments[^.]*before[^.]*git-pr merge|before[^.]*git-pr merge[^.]*git-pr comments/is);
        });

        test("tai-ready's merge line points at the comments step too", () => {
            assert.match(readySkill(), /git-pr comments/);
        });

        test("the Gemini copy of tai-pr carries the same rule", () => {
            const gemini = files.find((f) => f.relativePath === ".gemini/skills/tai-pr/SKILL.md")!;
            assert.match(gemini.content, /even an approved PR/i);
            assert.match(gemini.content, /git-pr comments/);
        });
    });

    describe("tai-init's skill drives `init run` (TAI-368)", () => {
        const body = () => files.find((f) => f.relativePath === ".claude/skills/tai-init/SKILL.md")!.content;

        test("runs `init run` itself only to surface the printed command, then relays it for a separate terminal", () => {
            assert.match(body(), /init run/);
            assert.match(body(), /separate terminal/i);
            assert.match(body(), /exits? (with )?(code )?2/i);
            assert.match(body(), /verbatim/i);
        });

        test("says the assistant-side run also touches .gitignore, so the human isn't surprised by the diff", () => {
            assert.match(body(), /`\.env` skeleton and updates `\.gitignore`/);
        });

        test("covers joining an already-onboarded project on a new folder or PC with the same command", () => {
            assert.match(body(), /already-onboarded/i);
            assert.match(body(), /new folder or onto a new PC/i);
        });

        test("never takes a secret in chat and never relies on the host's `!` prefix", () => {
            assert.match(body(), /never ask (the human )?for (a|an|any) (token|secret)/i);
            assert.match(body(), /never suggest the `!` prefix/i);
        });

        test("keeps the manual Jira provisioning walk-through for a missing issue type or field", () => {
            assert.match(body(), /target-project-setup-checklist\.md/);
            assert.match(body(), /missing issue type/i);
            assert.match(body(), /Persona/);
        });

        test("no longer walks the old shell-export step-by-step order", () => {
            assert.doesNotMatch(body(), /export(s|ed)? into this shell/i);
            assert.doesNotMatch(body(), /`init env` → `init claude-md`/);
        });

        test("says init run writes both the CLAUDE.md and GEMINI.md pointers (TAI-376)", () => {
            assert.match(body(), /init gemini-md/);
            assert.match(body(), /writes both pointer files/);
        });

        test("the Gemini copy gets the same text", () => {
            const gemini = files.find((f) => f.relativePath === ".gemini/skills/tai-init/SKILL.md")!;
            assert.match(gemini.content, /separate terminal/i);
            assert.match(gemini.content, /init run/);
        });
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

    test("writes all 10 skill files under the given homedir when taiHome exists", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-install-global-"));
        try {
            const homedir = path.join(dir, "home");
            const taiHome = path.join(dir, "tai-framework");
            await mkdir(homedir, { recursive: true });
            await mkdir(taiHome, { recursive: true });

            const result = await installGlobal(taiHome, homedir);

            assert.equal(result.taiHome, taiHome);
            assert.equal(result.written.length, 12);

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

            assert.equal(second.written.length, 12);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
