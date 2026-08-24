/**
 * TAI Framework — global skill installer (TAI-116/126, piece "global skill packaging")
 *
 * TAI-90's ADR decided TAI's own command surface (`tai-work`/`tai-ready`/`tai-pr`/
 * `tai-init`) should ship as global skills — installed once at `~/.claude/skills/tai-<name>/`
 * and `~/.gemini/skills/tai-<name>/`, referencing a fixed, well-known install path for TAI
 * itself (`~/.tai-framework/` by default) — rather than generating project-local wrapper
 * files (`.claude/commands/*.md`, `.gemini/commands/*.toml`) per target project. Both
 * hosts turned out to use the SAME file format for their global mechanism (a Markdown
 * `SKILL.md` with `name`/`description` frontmatter — confirmed by inspecting the
 * already-installed `sess-resume`/`sess-handoff` skills, identical content on both
 * `~/.claude/skills/sess-resume/SKILL.md` and `~/.gemini/skills/sess-resume/SKILL.md`),
 * unlike each host's own project-local mechanism (Claude: plain `.md`; Gemini: `.toml`
 * with `!{...}` shell-injection support).
 *
 * Deliberately does NOT rely on either host's shell auto-exec syntax (Claude's
 * project-local files don't have one; Gemini's `.toml` `!{...}` has the known
 * `{{args}}`-single-token gotcha documented in `.gemini/commands/tai-pr.toml`, and its
 * SKILL.md-level auto-exec syntax is a third, different mechanism again). Every skill
 * file here uses the same proven-safe pattern instead: plain prose telling the model
 * which command to run and how to construct it (correctly quoted, via its own Bash
 * tool) — one shared content generator per skill, reused verbatim for both hosts.
 *
 * This module does NOT shell out to git — same "the AI agent does git via its own Bash
 * tool, TAI's own code doesn't" posture already established for target-project work
 * (`grep` for `execSync`/`child_process` across `src/` stays empty). If `taiHome` doesn't
 * exist yet, `installGlobal` fails loudly with instructions rather than cloning it itself.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export interface SkillFile {
    readonly relativePath: string; // e.g. "tai-work/SKILL.md", relative to a skills root
    readonly content: string;
}

function skillFrontmatter(name: string, description: string): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

function workSkillBody(taiHome: string): string {
    return (
        `Run this and read its full output, substituting <ISSUE-KEY> with whatever key was ` +
        `given for this invocation:\n\n` +
        "```bash\n" +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts work <ISSUE-KEY>\n` +
        "```\n\n" +
        "The output starts with a `# Persona: <name> (<id>)` heading followed by that " +
        "persona's own instructions, then a `---` separator, then the assembled briefing " +
        "(the unit of work plus its immediate parent and linked Confluence pages, brief §3.6).\n\n" +
        "For the rest of this turn, act as that persona: follow its instructions against the " +
        "briefing exactly as it would if invoked directly (brief §3.8's `/tai-work <KEY>`) — same " +
        "flow whether this is starting fresh or resuming, no separate handling for either case.\n\n" +
        "If the command errors (no such issue, no persona assigned, or the persona isn't " +
        "permitted to work on this issue type), report the error to the human rather than " +
        "guessing a persona or proceeding anyway."
    );
}

function readySkillBody(taiHome: string): string {
    return (
        `Run this and read its full output. If a persona was given for this invocation, pass ` +
        `it as the one argument; otherwise run with no argument:\n\n` +
        "```bash\n" +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts ready [PERSONA]\n` +
        "```\n\n" +
        "The output lists issues that are actually ready to start (open, and — for a subtask — " +
        "with every precedence prerequisite already Done or Canceled, per `SUBTASK_PRECEDENCE`), " +
        "plus an \"Already in flight\" section for context (the root status rollup — display only, " +
        "never the readiness source itself, brief §7).\n\n" +
        "When `BITBUCKET_EMAIL`/`BITBUCKET_API_TOKEN`/`TAI_GIT_REPOS` are all configured, an " +
        "\"Approved PRs ready to merge\" section may also appear — a CodeReview subtask that's " +
        "Done, whose linked PR is still open, with green CI. This is a DIFFERENT action type than " +
        "the ready-to-start list above: run `git-pr merge <ISSUE-KEY> <REPO>` to land it, not " +
        "`/tai-work`.\n\n" +
        "Present this list to the human. If they pick a ready-to-start issue, follow up with " +
        "`/tai-work <KEY>` for that issue — same underlying flow, `/tai-ready` is only for when " +
        "there's no specific key in mind yet (brief §3.8)."
    );
}

function prSkillBody(taiHome: string): string {
    return (
        "Parse the raw typed command yourself, then run the matching command **directly via " +
        "your own Bash tool** — construct it as separate, correctly-quoted arguments (not one " +
        "blob), so a multi-word title/description/comment survives intact:\n\n" +
        "```\n" +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts git-pr create <ISSUE-KEY> <REPO> <SOURCE_BRANCH> <DEST_BRANCH> <TITLE> [DESCRIPTION]\n` +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts git-pr review <ISSUE-KEY> <REPO> [PR-ID] <approve|requestChanges> [COMMENT]\n` +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts git-pr merge <ISSUE-KEY> <REPO> [PR-ID] [mergeCommit|squash|fastForward]\n` +
        "```\n\n" +
        "`[PR-ID]` is optional on `review`/`merge` — omit it and TAI resolves it against `REPO`'s " +
        "sole currently-open PR. If more than one is open, the command fails with a list of " +
        "candidates instead of guessing — pass one of those IDs explicitly and re-run.\n\n" +
        "The output is from TAI's own `GitHost` layer, invoked as whichever persona owns the " +
        "issue key you passed — it resolves that persona's identity from the issue's own " +
        "`persona` field and enforces its `gitHost` permission grant, the same way `/tai-work` " +
        "enforces `workOn`.\n\n" +
        "- `create` — Dev subtask done, opens the real PR (source = the Story's branch, brief §6; " +
        "destination = the repo's default branch). `SOURCE_BRANCH` and `TITLE` are both validated " +
        "(brief §6/§112) — a branch or title that doesn't follow the parent-Story-first convention " +
        "fails loudly rather than silently opening the PR anyway. Also auto-links the new PR to " +
        "whichever CodeReview subtask should review it (a Jira remote issue link) — no separate " +
        "manual linking step needed.\n" +
        "- `review` — Code Reviewer subtask, approve or request changes on the real PR diff. This " +
        "writes the PR only — also transition the Jira CodeReview subtask yourself as the second " +
        "half of the review decision.\n" +
        "- `merge` — Developer merges their own already-approved work once CodeReview passes. " +
        "Gated on CI status being green first — a red or missing status is reported as \"Merge " +
        "denied\" without attempting the merge.\n\n" +
        "If the command errors, report the error to the human rather than guessing or proceeding " +
        "anyway."
    );
}

function initSkillBody(taiHome: string): string {
    return (
        "**Bootstrap check (do this first, every invocation):**\n\n" +
        "```bash\n" +
        `test -d ${taiHome} && echo present || echo missing\n` +
        "```\n\n" +
        `If "missing": TAI itself isn't installed at its fixed location yet. Discover this ` +
        "repo's remote URL (`git remote get-url origin`, run from wherever tai-framework's own " +
        `checkout currently is) and clone it yourself via your own Bash tool: \`git clone ` +
        `<remote-url> ${taiHome}\`. Then run the install step below.\n\n` +
        "**Install/refresh the global skill files:**\n\n" +
        "```bash\n" +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts install-global\n` +
        "```\n\n" +
        "This (re)writes all four skills (`tai-work`/`tai-ready`/`tai-pr`/`tai-init`) for both " +
        "Claude Code and Gemini CLI, so it's always safe to re-run — e.g. after `tai-framework` " +
        "itself has been updated at its fixed location.\n\n" +
        "**Target-project setup (TAI-116 piece 3, TAI-130):** once the bootstrap above is done, " +
        "check whether the CURRENT project (cwd) still needs onboarding:\n\n" +
        "```bash\n" +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts init status\n` +
        "```\n\n" +
        'If it reports "Fully initialized," nothing further is needed. Otherwise — including a ' +
        "fresh project with no state file at all — read the full checklist yourself " +
        `(\`${taiHome}/docs/target-project-setup-checklist.md\`) and walk the human through it ` +
        "step by step, in this order: Jira setup (issue types, the `Persona` field, workflow " +
        "statuses) → `init jira` → Confluence space → `init confluence` → Bitbucket repo (only " +
        "if this project needs `git-pr`) → `init bitbucket <workspace/repo>` → `init env` → " +
        "`init claude-md`. Each `init <step>` call both performs and verifies its own step " +
        "against the real API, and records completion for next time — safe to stop and resume " +
        "later; re-run `init status` to see what's left rather than guessing. The credentials " +
        "each step needs are plain env vars the human exports into this shell first — the exact " +
        "checklist doc lists which ones, matching `.env.example`'s own names."
    );
}

/** All 8 skill files (4 skills × 2 hosts) — identical content per skill across hosts, since
 *  both use the same SKILL.md format and neither relies on host-specific auto-exec syntax. */
export function renderGlobalSkillFiles(taiHome: string): readonly SkillFile[] {
    const skills: readonly { readonly name: string; readonly description: string; readonly body: string }[] = [
        {
            name: "tai-work",
            description: "Load/refresh a TAI unit of work's briefing and invoke its owning persona (brief §3.8)",
            body: workSkillBody(taiHome),
        },
        {
            name: "tai-ready",
            description: "Show what's ready to work on, optionally scoped to one persona (brief §3.8)",
            body: readySkillBody(taiHome),
        },
        {
            name: "tai-pr",
            description: "Create, review, or merge a real git PR for a Dev/CodeReview subtask (TAI-34 ADR)",
            body: prSkillBody(taiHome),
        },
        {
            name: "tai-init",
            description: "Install/refresh TAI's own global skills, and (eventually) guide setup of a real target project (TAI-116)",
            body: initSkillBody(taiHome),
        },
    ];

    const files: SkillFile[] = [];
    for (const host of ["claude", "gemini"] as const) {
        for (const skill of skills) {
            files.push({
                relativePath: `.${host}/skills/${skill.name}/SKILL.md`,
                content: skillFrontmatter(skill.name, skill.description) + "\n" + skill.body + "\n",
            });
        }
    }
    return files;
}

export interface InstallGlobalResult {
    readonly taiHome: string;
    readonly written: readonly string[]; // absolute paths written
}

/** Default fixed install path for TAI itself — separate from wherever a developer happens
 *  to have originally cloned `tai-framework` for its own development (TAI-90 ADR). */
export function defaultTaiHome(): string {
    return path.join(os.homedir(), ".tai-framework");
}

/**
 * Writes all 8 global skill files under the user's home directory. Fails loudly if
 * `taiHome` doesn't exist — this function never clones it (see file header); the caller
 * (the `tai-init` skill's own prose, or a human) is responsible for that first.
 */
export async function installGlobal(taiHome: string, homedir: string = os.homedir()): Promise<InstallGlobalResult> {
    if (!existsSync(taiHome)) {
        throw new Error(
            `${taiHome} doesn't exist yet -- clone tai-framework there first ` +
                `(e.g. "git clone <remote-url> ${taiHome}"), then re-run install-global.`
        );
    }

    const written: string[] = [];
    for (const file of renderGlobalSkillFiles(taiHome)) {
        const absolutePath = path.join(homedir, file.relativePath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, file.content, "utf-8");
        written.push(absolutePath);
    }
    return { taiHome, written };
}
