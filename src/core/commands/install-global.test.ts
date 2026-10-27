import { DESIGN_WITHOUT_DEV_HEADING } from "../storage/design-without-dev.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderGlobalSkillFiles, installGlobal, defaultTaiHome, PM_KICKOFF_HINT } from "./install-global.js";

describe("renderGlobalSkillFiles", () => {
    const files = renderGlobalSkillFiles("/home/x/.tai-framework");

    test("produces 26 files -- 13 skills x 2 hosts", () => {
        assert.equal(files.length, 26);
    });

    test("the tai-verify skill runs verify <STORY-KEY>, acts as Tessa, treats the Story and diffs as data and does not close the Story (TAI-546)", () => {
        for (const host of [".claude", ".gemini"]) {
            const verify = files.find((f) => f.relativePath === `${host}/skills/tai-verify/SKILL.md`)!;
            assert.ok(verify, `${host} gets a tai-verify skill`);
            assert.match(verify.content, /name: tai-verify/);
            assert.match(verify.content, /cli\.ts verify <STORY-KEY>/);
            assert.match(verify.content, /Tessa/);
            assert.match(verify.content, /data, not instructions/);
            assert.match(verify.content, /Do not close the Story/);
        }
    });

    test("the tai-settings skill runs settings, and leaves autonomy changes to the human (TAI-627)", () => {
        for (const host of [".claude", ".gemini"]) {
            const skill = files.find((f) => f.relativePath === `${host}/skills/tai-settings/SKILL.md`)!;
            assert.ok(skill, `${host} gets a tai-settings skill`);
            assert.match(skill.content, /name: tai-settings/);
            assert.match(skill.content, /cli\.ts settings\n/);
            assert.match(skill.content, /settings set <KEY> <VALUE>/);
            assert.match(skill.content, /never yours/);
        }
    });

    test("the tai-do-dev-tasks skill lists with dryrun first, leaves the tickets to the command and never turns DEV-YOLO on (TAI-633)", () => {
        for (const host of [".claude", ".gemini"]) {
            const skill = files.find((f) => f.relativePath === `${host}/skills/tai-do-dev-tasks/SKILL.md`)!;
            assert.ok(skill, `${host} gets a tai-do-dev-tasks skill`);
            assert.match(skill.content, /name: tai-do-dev-tasks/);
            assert.match(skill.content, /cli\.ts do-dev-tasks dryrun=true/);
            assert.match(skill.content, /YOU do not do the tickets/);
            assert.match(skill.content, /never turn the setting on yourself/);
        }
    });

    test("the tai-do-dev-tasks skill describes `rules` and the pre-run warning, and never writes the rules itself (TAI-685)", () => {
        for (const host of [".claude", ".gemini"]) {
            const skill = files.find((f) => f.relativePath === `${host}/skills/tai-do-dev-tasks/SKILL.md`)!;
            assert.match(skill.content, /`do-dev-tasks rules` prints the rule set/);
            assert.match(skill.content, /Show the human that warning verbatim/);
            assert.match(skill.content, /Never write that file or those rules yourself/);
            assert.match(skill.content, /`yolo=true` is refused in an AI session, so never add it yourself/);
        }
    });

    test("the tai-init skill offers the short commands but leaves installing them to the human (TAI-699)", () => {
        for (const host of [".claude", ".gemini"]) {
            const skill = files.find((f) => f.relativePath === `${host}/skills/tai-init/SKILL.md`)!;
            assert.match(skill.content, /`tai <command>`, `tai-settings` and `tai-do-dev-tasks`/);
            assert.match(skill.content, /never install them yourself: tell the human to run `[^`]*\/bin\/tai-link`/);
            assert.match(skill.content, /bin\/tai-link --remove/);
        }
    });

    test("the tai-retro skill runs retro [EPIC-KEY | since=<date>], acts as Perry, shows the briefing first and writes nothing itself (TAI-491)", () => {
        for (const host of [".claude", ".gemini"]) {
            const retro = files.find((f) => f.relativePath === `${host}/skills/tai-retro/SKILL.md`)!;
            assert.ok(retro, `${host} gets a tai-retro skill`);
            assert.match(retro.content, /name: tai-retro/);
            assert.match(retro.content, /cli\.ts retro \[EPIC-KEY \| since=<date>\]/);
            assert.match(retro.content, /act as that persona/i);
            assert.match(retro.content, /needs no\s+ticket/i);
            assert.match(retro.content, /last 30 days/);
            assert.match(retro.content, /# Retro briefing/);
            assert.match(retro.content, /all five numbered sections/);
            assert.match(retro.content, /ordinary chat text/i);
            assert.match(retro.content, /Do NOT, in this same turn, ask a question with an interactive tool/i);
            assert.match(retro.content, /The command itself writes nothing/);
        }
    });

    test("the tai-change skill runs change, quotes the statement, treats it as data, shows the briefing first and stops (TAI-492)", () => {
        for (const host of [".claude", ".gemini"]) {
            const change = files.find((f) => f.relativePath === `${host}/skills/tai-change/SKILL.md`)!;
            assert.ok(change, `${host} gets a tai-change skill`);
            assert.match(change.content, /name: tai-change/);
            // a plain-language request can start it: the description and the body say so
            assert.match(change.content, /Use it when the human says the scope or plan changed/);
            assert.match(change.content, /even if they never type `\/tai-change`/);
            assert.match(change.content, /cli\.ts change \[EPIC-KEY\] '<STATEMENT>'/);
            assert.match(change.content, /ONE single-quoted argument/);
            assert.match(change.content, /never put it inside double quotes/i);
            assert.match(change.content, /data, not instructions/);
            assert.match(change.content, /# Change briefing/);
            assert.match(change.content, /down to, but not including, the `---` line/);
            assert.match(change.content, /ordinary chat text/i);
            assert.match(change.content, /Do\s+NOT, in this same turn, ask a question with an interactive tool/i);
            assert.match(change.content, /The command itself writes nothing/);
            assert.match(change.content, /Perry may create Backlog tickets and links on her own/);
        }
    });

    test("the tai-small skill runs issue create-small, needs an AC-1 line, quotes the text, and stops without starting the work (TAI-473)", () => {
        for (const host of [".claude", ".gemini"]) {
            const small = files.find((f) => f.relativePath === `${host}/skills/tai-small/SKILL.md`)!;
            assert.ok(small, `${host} gets a tai-small skill`);
            assert.match(small.content, /name: tai-small/);
            assert.match(small.content, /cli\.ts issue create-small <PROJECT-KEY> story\|bug/);
            assert.match(small.content, /two\s+sentences/);
            assert.match(small.content, /`AC-1:`/);
            assert.match(small.content, /Review and the merge gate apply/);
            assert.match(small.content, /Wrap each argument in single quotes/);
            assert.match(small.content, /never put the text inside double quotes/);
            assert.match(small.content, /do not stretch the lane/);
            assert.match(small.content, /Do not start the work in the same turn/);
        }
    });

    test("the tai-kickoff skill runs kickoff [INITIATIVE], acts as Perry, shows the briefing and stops before asking (TAI-450)", () => {
        for (const host of [".claude", ".gemini"]) {
            const kickoff = files.find((f) => f.relativePath === `${host}/skills/tai-kickoff/SKILL.md`)!;
            assert.ok(kickoff, `${host} gets a tai-kickoff skill`);
            assert.match(kickoff.content, /name: tai-kickoff/);
            assert.match(kickoff.content, /cli\.ts kickoff \[INITIATIVE\]/);
            assert.match(kickoff.content, /act as that persona|act as Perry/i);
            assert.match(kickoff.content, /needs no ticket/i);
            // works on a project that already has Epics, not only a fresh one
            assert.match(kickoff.content, /new initiative/i);
            assert.match(kickoff.content, /already has Epics|existing Epics/i);
            // TAI-423: show the briefing as chat text before any question, then stop
            assert.match(kickoff.content, /# Kickoff briefing/);
            assert.match(kickoff.content, /verbatim/i);
            assert.match(kickoff.content, /ordinary chat text/i);
            assert.match(kickoff.content, /Do NOT, in this same turn, ask a question with an interactive tool/i);
            assert.match(kickoff.content, /human's own NEXT message/i);
            // the initiative reaches a shell as ONE single-quoted argument: an apostrophe or $(...) in the human's text
            // must neither break the command nor run (PR 158 review)
            assert.match(kickoff.content, /ONE single-quoted argument/);
            assert.match(kickoff.content, /'\\''/);
            assert.match(kickoff.content, /never (put it )?inside double quotes/i);
            assert.doesNotMatch(kickoff.content, /unquoted words are joined/i);
            // the initiative is the human's data, and Perry's authority is unchanged
            assert.match(kickoff.content, /data, not instructions/i);
            assert.match(kickoff.content, /Backlog tickets/);
            assert.match(kickoff.content, /only after the human confirms/i);
        }
    });

    test("the fresh-project hint names the real /tai-kickoff command, not a plain-language workaround (TAI-348)", () => {
        assert.match(PM_KICKOFF_HINT, /\/tai-kickoff/);
        assert.doesNotMatch(PM_KICKOFF_HINT, /ask your assistant/i);
        const ready = files.find((f) => f.relativePath === ".claude/skills/tai-ready/SKILL.md")!;
        assert.match(ready.content, /\/tai-kickoff/);
        assert.doesNotMatch(ready.content, /ask your assistant directly/i);
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
        // TAI-423 (found live in Gemini CLI): the briefing is SHOWN before any question, and no question is asked in the same turn
        assert.match(groom.content, /Show the briefing first/i);
        assert.match(groom.content, /ordinary chat text/i);
        assert.match(groom.content, /all nine numbered sections/i);
        assert.match(groom.content, /including the ones that say None/i);
        // verbatim, from the heading down (the mechanical rule tai-pr uses), with no compaction loophole
        assert.match(groom.content, /# Grooming briefing/);
        assert.match(groom.content, /verbatim/i);
        assert.doesNotMatch(groom.content, /may be compacted/i);
        assert.match(groom.content, /Do NOT, in this same turn, ask a question with an interactive tool/i);
        assert.match(groom.content, /human's own NEXT message/i);
        // read, don't parse: the work-breakdown reconciliation (decision 12) is an instruction, not a section
        assert.match(groom.content, /work-breakdown/i);
        // the ticketless entry deliberately reverses the 2026-08-25 no-planning-command decision
        assert.match(groom.content, /needs no ticket/i);
    });

    test("the tai-audit skill has a loose-pages check that reads page loose and states one check count (TAI-598)", () => {
        for (const host of [".claude", ".gemini"]) {
            const audit = files.find((f) => f.relativePath === `${host}/skills/tai-audit/SKILL.md`)!;
            assert.match(audit.content, /## Check: `loose-pages`/);
            assert.match(audit.content, /cli\.ts page loose <SPACE-KEY>/);
            assert.match(audit.content, /Overview page/);
            const named = [...audit.content.matchAll(/^## Check: `/gm)].length;
            assert.match(audit.content, new RegExp(`run all ${named} checks below`));
            assert.doesNotMatch(audit.content, /\bseven\b/);
        }
    });

    test("the tai-audit skill has a design-without-dev check that reads the ready section (TAI-602)", () => {
        for (const host of [".claude", ".gemini"]) {
            const audit = files.find((f) => f.relativePath === `${host}/skills/tai-audit/SKILL.md`)!;
            assert.match(audit.content, /## Check: `design-without-dev`/);
            assert.match(audit.content, /cli\.ts ready pm/);
            assert.ok(audit.content.includes(DESIGN_WITHOUT_DEV_HEADING));
        }
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

    test("the tai-pr review flow is one command, `git-pr review-prep`, and the skill no longer carries the review steps (TAI-425)", () => {
        const pr = files.find((f) => f.relativePath === ".claude/skills/tai-pr/SKILL.md")!;
        assert.match(pr.content, /git-pr review-prep <REPO> \[PR-ID\]/);
        assert.match(pr.content, /Follow its output exactly, as that persona/);
        assert.match(pr.content, /do NOT read the persona file yourself/i);
        assert.match(pr.content, /Do NOT fetch or diff the PR by hand/);
        assert.match(pr.content, /Never skip straight to `review`/);
        assert.match(pr.content, /No condition ever auto-approves/);
        // moved into review-prep's own output (core/git/review-prep.ts), so there is one copy:
        assert.doesNotMatch(pr.content, /"leaningReason"/);
        assert.doesNotMatch(pr.content, /\*\*1\*\* post and approve/);
        assert.doesNotMatch(pr.content, /code-reviewer\.md/);
        assert.doesNotMatch(pr.content, /git diff\s+origin/);
    });

    test("tai-pr runs the review in a fresh-context subagent in Claude Code, and the subagent never posts (TAI-469)", () => {
        for (const host of [".claude", ".gemini"]) {
            const pr = files.find((f) => f.relativePath === `${host}/skills/tai-pr/SKILL.md`)!.content;
            // AC-1: subagent by default, Claude Code only
            assert.match(pr, /\*\*Fresh context \(TAI-469\)/);
            assert.match(pr, /In Claude Code, run the review in a subagent by default/);
            // the opening instruction points ahead to the subagent rule, so it is not read as an inline review
            assert.match(pr, /inside a subagent: see \*\*Fresh context\*\* below/);
            // AC-2: the main session renders the findings verbatim and stops
            assert.match(pr, /main session runs `git-pr render-findings`/);
            assert.match(pr, /pastes its output verbatim/);
            assert.match(pr, /stops for the human/);
            // AC-3: Gemini CLI unchanged; inline only on the human's request
            assert.match(pr, /In Gemini CLI there is no subagent: run the steps yourself as above/);
            assert.match(pr, /only when the human asks in their own words/);
            // AC-4: the subagent sees only review-prep's output and the repository
            assert.match(pr, /only the `review-prep` output and the repository/);
            assert.match(pr, /none of this session's context/);
            assert.match(pr, /`coverage` block/);
            // AC-5: the subagent never posts
            assert.match(pr, /must not run `git-pr review`, `git-pr comment` or `git-pr comment-findings`/);
        }
    });

    test("tai-ready and tai-pr say the review list includes a re-review of a PR changed since the human decided (TAI-563)", () => {
        for (const host of [".claude", ".gemini"]) {
            const ready = files.find((f) => f.relativePath === `${host}/skills/tai-ready/SKILL.md`)!.content;
            assert.match(ready, /decided \(approved, or requested changes\) before the PR's latest commit/);
            assert.match(ready, /\*\*re-review\*\*/);
            assert.doesNotMatch(ready, /and hasn't yet decided\./);
            const pr = files.find((f) => f.relativePath === `${host}/skills/tai-pr/SKILL.md`)!.content;
            assert.match(pr, /includes a \*\*re-review\*\*/);
        }
    });

    test("tai-ready and tai-pr describe the 'approved PRs waiting' section as show-only, never a merge (TAI-564)", () => {
        for (const host of [".claude", ".gemini"]) {
            const ready = files.find((f) => f.relativePath === `${host}/skills/tai-ready/SKILL.md`)!.content;
            assert.match(ready, /\*\*Approved PRs waiting on something\*\*/);
            assert.match(ready, /Show-only: nothing in it can be merged yet/);
            assert.match(ready, /only\s+telling the human what it waits on \(never a merge, and never `force=true`\)/);
            const pr = files.find((f) => f.relativePath === `${host}/skills/tai-pr/SKILL.md`)!.content;
            assert.match(pr, /\*\*Approved PRs waiting on\s+something\*\*/);
            assert.match(pr, /only telling the human what the merge gate still needs \(never merge, never `force=true`\)/);
        }
    });

    test("tai-ready describes the 'Ready to close' section: the Verified: comment is shown, then the ticket is closed (TAI-569)", () => {
        for (const host of [".claude", ".gemini"]) {
            const ready = files.find((f) => f.relativePath === `${host}/skills/tai-ready/SKILL.md`)!.content;
            assert.match(ready, /\*\*Ready to close\*\*/);
            assert.match(ready, /show the human that `Verified:` comment in full, then close the ticket/);
            assert.match(ready, /`issue transition <KEY> Done` \(the pick is the instruction to close\)/);
            assert.match(ready, /Epics, Kickoff Stories and\s+Spikes are never listed/);
            assert.match(ready, /Ready to close, and all three PR sections/);
        }
    });

    test("tai-pr says comment-findings and review refuse unrendered findings, and render-findings records and reminds (TAI-575)", () => {
        for (const host of [".claude", ".gemini"]) {
            const pr = files.find((f) => f.relativePath === `${host}/skills/tai-pr/SKILL.md`)!.content;
            assert.match(pr, /It also records that these findings were rendered for this PR/);
            assert.match(pr, /It refuses \(TAI-575\), and posts nothing, unless\s+`render-findings` was run on these exact findings/);
            assert.match(pr, /Once `review-prep` has run for the PR in this clone, it refuses\s+\(TAI-575\) until `render-findings` has been run since/);
            assert.match(pr, /a\s+human who never ran `review-prep` here, and just decides, is not blocked/);
        }
    });

    test("tai-ready's In Progress section is named 'In Progress', not 'resume this' (TAI-567)", () => {
        for (const host of [".claude", ".gemini"]) {
            const ready = files.find((f) => f.relativePath === `${host}/skills/tai-ready/SKILL.md`)!.content;
            assert.match(ready, /\*\*In Progress\*\* — issues already at/);
            assert.doesNotMatch(ready, /resume this/);
        }
    });

    test("tai-ready's review line points at review-prep, not a hand-run fetch/diff (TAI-425)", () => {
        const ready = files.find((f) => f.relativePath === ".claude/skills/tai-ready/SKILL.md")!;
        assert.match(ready.content, /git-pr review-prep/);
    });

    test("tai-groom says a parked icebox epic is left out unless its key is given, on both hosts (TAI-552)", () => {
        for (const host of [".claude", ".gemini"]) {
            const groom = files.find((f) => f.relativePath === `${host}/skills/tai-groom/SKILL.md`)!;
            assert.match(groom.content, /epic labelled `icebox`/);
        }
    });

    test("tai-ready maps a Ready to verify number to /tai-verify, on both hosts (TAI-548)", () => {
        for (const host of [".claude", ".gemini"]) {
            const ready = files.find((f) => f.relativePath === `${host}/skills/tai-ready/SKILL.md`)!;
            assert.match(ready.content, /\*\*Ready to verify\*\*/);
            assert.match(ready.content, /`\/tai-verify <KEY>` for a "Ready to verify" line/);
        }
    });

    test("tai-groom describes nine sections, the ninth being Stories ready to verify with /tai-verify, on both hosts (TAI-550)", () => {
        for (const host of [".claude", ".gemini"]) {
            const groom = files.find((f) => f.relativePath === `${host}/skills/tai-groom/SKILL.md`)!;
            assert.match(groom.content, /nine numbered sections/);
            assert.match(groom.content, /all nine numbered sections/);
            assert.match(groom.content, /ready to verify[^.]*`\/tai-verify <KEY>`/);
            assert.doesNotMatch(groom.content, /\beight numbered sections\b/);
        }
    });

    test("skill descriptions are current: tai-pr no longer names the retired CodeReview subtask, tai-init no longer says 'eventually' (TAI-435)", () => {
        // The whole frontmatter shape, anchored: name, then exactly one description line, then the closing rule.
        // (A bare /^description: (.*)$/m can never see a newline, so it could not catch a broken description.)
        const description = (name: string): string => {
            const f = files.find((x) => x.relativePath === `.claude/skills/${name}/SKILL.md`)!;
            const m = f.content.match(new RegExp(`^---\\nname: ${name}\\ndescription: ([^\\n]+)\\n---\\n`));
            assert.ok(m, `${name}: frontmatter is exactly '---', name, one description line, '---'`);
            return m![1]!;
        };
        const pr = description("tai-pr");
        assert.doesNotMatch(pr, /CodeReview/);
        assert.match(pr, /review/i);
        assert.match(pr, /git-pr review-prep/);
        assert.match(pr, /create/i);
        assert.match(pr, /merge/i);
        const init = description("tai-init");
        assert.doesNotMatch(init, /eventually/i);
        assert.match(init, /onboard|set up|setup/i);
        for (const name of ["tai-work", "tai-ready", "tai-pr", "tai-init", "tai-audit", "tai-groom"]) {
            const d = description(name);
            // The description is written as an UNQUOTED YAML scalar, in which ': ' is a mapping indicator (invalid,
            // 'mapping values are not allowed here') and ' #' starts a comment (silently truncates it) -- TAI-438.
            // (A trailing ':' is the same indicator: a colon followed by the end of the line.)
            assert.ok(!d.includes(": ") && !d.endsWith(":"), `${name}: description must not contain ': ' or end with ':'`);
            assert.ok(!d.includes(" #"), `${name}: description must not contain ' #'`);
            assert.doesNotMatch(d, /^["'[{&*!|>%@`-]/, `${name}: description must not start with a YAML indicator`);
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
            // TAI-462: the very minor fix now goes through the stamped override, and the gate is described.
            assert.match(prSkill(), /merge with `force=true`/);
            assert.match(prSkill(), /cast on its current commit/);
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

    test("writes all 26 skill files under the given homedir when taiHome exists", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-install-global-"));
        try {
            const homedir = path.join(dir, "home");
            const taiHome = path.join(dir, "tai-framework");
            await mkdir(homedir, { recursive: true });
            await mkdir(taiHome, { recursive: true });

            const result = await installGlobal(taiHome, homedir);

            assert.equal(result.taiHome, taiHome);
            assert.equal(result.written.length, 26);

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

            assert.equal(second.written.length, 26);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
