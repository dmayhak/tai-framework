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
        `Before doing anything else, make sure <ISSUE-KEY> is assigned and already ` +
        `\`In Progress\` — transition it first if it isn't:\n\n` +
        "```bash\n" +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts issue transition <ISSUE-KEY> "In Progress"\n` +
        "```\n\n" +
        "Verify from that command's own output that the transition actually succeeded before " +
        "doing any work — never after. A rejection (no assignee, an unmet precedence gate, etc.) " +
        "is a hard stop: report it to the human rather than retrying or proceeding with the work " +
        "anyway.\n\n" +
        `Then run this and read its full output, substituting <ISSUE-KEY> with whatever key was ` +
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
        "with every precedence prerequisite already Done or Canceled, per `SUBTASK_PRECEDENCE`) — " +
        "a `Dev` subtask carrying a \"⚠️ needs rebase (merge conflicts)\" flag (TAI-217/219) means " +
        "a `git-pr merge` attempt hit a conflict and posted a `Rebase needed:` comment on it; the " +
        "flag clears itself once that PR actually merges (no separate action needed to clear it) — " +
        "plus — when `BITBUCKET_EMAIL`/`BITBUCKET_API_TOKEN`/`TAI_GIT_REPOS` are all configured — " +
        "up to three PR-related sections, all live signals read directly from Bitbucket rather " +
        "than any Jira subtask (rev 52, TAI-159 ADR — there is no CodeReview subtask anymore):\n\n" +
        "- **PRs ready for your review** — open PRs where the current human (`BITBUCKET_EMAIL`) is " +
        "on the \"PR Reviewers\" roster and hasn't yet decided. Picking this line's number means " +
        "doing a REAL review (TAI-187) — see `tai-pr`'s own skill for the full flow (fetch the " +
        "diff, apply Cole's rules, present findings, then ask separately whether to post and " +
        "whether to approve) — never just running `git-pr review` straight off the number.\n" +
        "- **Open PRs ready to test** — `Dev` subtasks with a linked, open PR, full stop. Testing " +
        "runs in parallel with review, not gated behind it.\n" +
        "- **Approved PRs ready to merge** — the same `Dev`-subtask/PR pairs as above, additionally " +
        "at the required approval count AND CI-green. Run `git-pr merge <ISSUE-KEY> <REPO>` to " +
        "land it, not `/tai-work`.\n\n" +
        "Plus an \"Already in flight\" section for context (the root status rollup — display only, " +
        "never the readiness source itself, brief §7).\n\n" +
        "Present this list to the human AS-IS — every actionable line above (Ready Work and all " +
        "three PR sections) is already numbered with ONE shared counter (TAI-182), so don't " +
        "renumber or reformat it yourself. \"Already in flight\" is deliberately NOT numbered — " +
        "it's display-only context, never a valid reply.\n\n" +
        "**Presenting this list is the entire, complete output of a `tai-ready` invocation — " +
        "TAI-215 (found live, 2026-08-26, in `tai-pr`'s own equivalent listing step — same " +
        "underlying gap, never triggered here yet but structurally identical): do NOT, in this " +
        "same turn, pick a line yourself and act on it (start a review, run `/tai-work`, run any " +
        "`git-pr` command) — no matter how obvious or unambiguous a line looks.** End your turn " +
        "right here and wait for the human's own next message — a bare number, an issue key, a " +
        "PR URL, or plain language all work, but it has to be an ordinary NEW turn, not a " +
        "same-turn continuation (same principle as `tai-pr`'s findings step, TAI-202/203 — a " +
        "complete-looking list reads as a place to stop just as much as a complete-looking " +
        "recommendation does).\n\n" +
        "Once the human's own next message picks a line: map it back to that exact line (by its " +
        "position in this shared numbering) and take the ACTION that section describes — " +
        "`/tai-work <KEY>` for a Ready Work line, the real review flow above for a \"PRs ready " +
        "for your review\" line, `git-pr merge` for a \"ready to merge\" line. A number with no " +
        "corresponding line, or any ambiguity about which line it means, is a re-ask, not a guess."
    );
}

function prSkillBody(taiHome: string): string {
    return (
        "**Bare invocation (no arguments) — TAI-211/212, a lighter PR-only sibling to " +
        "`tai-ready`:** run EXACTLY this command — `pr-ready`, not `ready` (that's `tai-ready`'s " +
        "own, heavier command; running it here defeats the entire point of this lighter " +
        "sibling, TAI-215 found live) — and read its full output:\n\n" +
        "```bash\n" +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts pr-ready\n` +
        "```\n\n" +
        "Just the two PR sections `tai-ready` also shows (**PRs ready for your review**, " +
        "**Approved PRs ready to merge**) — no general Ready Work list, no \"Open PRs ready to " +
        "test,\" no \"Already in flight,\" each numbered with its own shared counter the same way " +
        "`tai-ready`'s combined list is. Present it AS-IS, don't renumber it.\n\n" +
        "**Presenting this list is the entire, complete output of a bare `tai-pr` invocation — " +
        "TAI-215 (found live, 2026-08-26): a Gemini CLI session skipped straight from printing " +
        "this list into picking a line and fully reviewing that PR itself, in the same turn, " +
        "with zero human input at any point.** Do NOT, in this same turn: pick a line yourself " +
        "(no matter how obvious or unambiguous it looks), start the review flow below, or run " +
        "any `git-pr` command. End your turn right here and wait for the human's own next " +
        "message — a bare number, an issue key, a PR URL, or plain language all work, but it " +
        "has to be an ordinary NEW turn, not a same-turn continuation (same principle as step 3 " +
        "below, TAI-202/203 — this is the same class of \"looks done, so it reads as a place to " +
        "stop\" trap, just one step earlier).\n\n" +
        "Once the human's own next message picks a line: map it back to that exact line (by its " +
        "position in the shared numbering) and take the action its section describes — for a " +
        "\"ready for your review\" line, that means doing the real review flow below (fetch, " +
        "diff, findings, stop — never skip straight to `git-pr review`); for a \"ready to merge\" " +
        "line, picking that number IS the explicit instruction, so run `git-pr merge <ISSUE-KEY> " +
        "<REPO>` directly, no further confirmation needed. A number with no corresponding line, or " +
        "any ambiguity about which line it means, is a re-ask, not a guess.\n\n" +
        "Everything below this point is for an explicit `create`/`review`/`comment`/`merge` " +
        "invocation (typed directly, or reached via a number from `tai-ready`'s own combined " +
        "list) — parse the raw typed command yourself, then run the matching command **directly via " +
        "your own Bash tool** — construct it as separate, correctly-quoted arguments (not one " +
        "blob), so a multi-word title/description/comment survives intact:\n\n" +
        "```\n" +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts git-pr create <ISSUE-KEY> <REPO> <SOURCE_BRANCH> <DEST_BRANCH> <TITLE> [DESCRIPTION]\n` +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts git-pr review <REPO> [PR-ID] <approve|requestChanges> [COMMENT]\n` +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts git-pr comment <REPO> [PR-ID] <BODY>\n` +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts git-pr unapprove <REPO> [PR-ID]\n` +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts git-pr merge <ISSUE-KEY> <REPO> [PR-ID] [mergeCommit|squash|fastForward]\n` +
        "```\n\n" +
        "**`review`/`comment`/`unapprove` take NO `<ISSUE-KEY>`** — unlike `create`/`merge`, none " +
        "is scoped to one issue at all (rev 52, TAI-159 ADR): each resolves the acting human from " +
        "`BITBUCKET_EMAIL`/`BITBUCKET_API_TOKEN` and checks them against the \"PR Reviewers\" " +
        "roster, rejecting if they aren't listed. Passing an issue key as the first argument to " +
        "any of them fails with \"Malformed RepoId\" — `<REPO>` really is the first argument.\n\n" +
        "`[PR-ID]` is optional on `review`/`comment`/`unapprove`/`merge` — omit it and TAI resolves it against " +
        "`REPO`'s sole currently-open PR. If more than one is open, the command fails with a list " +
        "of candidates instead of guessing — pass one of those IDs explicitly and re-run.\n\n" +
        "`create`/`merge` are invoked as whichever persona owns `<ISSUE-KEY>` — resolved from the " +
        "issue's own `persona` field, with its `gitHost` permission grant enforced, the same way " +
        "`/tai-work` enforces `workOn`. `review`/`comment` are not persona-scoped at all (see " +
        "above).\n\n" +
        "- `create` — Dev subtask's code is ready, opens the real PR (source = the Story's branch, " +
        "brief §6; destination = the repo's default branch). `SOURCE_BRANCH` and `TITLE` are both " +
        "validated (brief §6/§112) — a branch or title that doesn't follow the parent-Story-first " +
        "convention fails loudly rather than silently opening the PR anyway. Auto-assigns the " +
        "\"PR Reviewers\" roster (minus the author) as Bitbucket reviewers on creation (rev 52) — " +
        "best-effort, a resolution failure for one reviewer still lets the PR itself get created. " +
        "There is no CodeReview subtask to link to anymore (retired rev 52) — nothing further to " +
        "wire up manually.\n" +
        "- `review` — records a real approve/request-changes decision on the PR itself. This is " +
        "the roster-gated review action `readyToReview` surfaces (no Jira subtask involved at " +
        "all) — nothing else to transition afterward.\n" +
        "- `comment` — posts a real general PR comment (not tied to an approve/request-changes " +
        "decision). This is how review findings actually get posted — see the review-flow section " +
        "below.\n" +
        "- `unapprove` (TAI-217/219) — withdraws a previously-cast approval. Only ever run because " +
        "the human explicitly asked for it, in their own words — never automatically, not even " +
        "when `merge` itself suggests it (see below). The main real use: Bitbucket's free tier has " +
        "no \"reset approvals on change\" (Premium-only), so a stale approval survives new commits " +
        "on its own; this is how a human clears one before a rebased PR gets re-reviewed.\n" +
        "- `merge` — the Dev subtask's own owner merges their already-reviewed work. Gated on CI " +
        "status being green — a red or missing status is reported as \"Merge denied\" without " +
        "attempting the merge (approval-count gating happens upstream, in whether `readyToMerge` " +
        "surfaced this PR at all — `merge` itself doesn't re-check approvals). On success, also " +
        "transitions the linked Dev subtask to Done as a second write (rev 52) — the actual " +
        "completion signal; Dev was never moved to Done earlier just because code was ready. **On " +
        "a merge-conflict denial specifically** (TAI-217/219): automatically posts a `Rebase " +
        "needed:` comment on the linked Dev subtask — durable, visible whenever that ticket is " +
        "next opened via `/tai-work` or `/tai-ready`, not just in whichever terminal ran this " +
        "merge attempt — and the denial message suggests `git-pr unapprove` as the next step " +
        "(suggest only; run it because the human says to, same as everywhere else in this file).\n\n" +
        "**Doing an actual review (TAI-187), not just recording a decision:** when the human asks " +
        "to review a PR — including picking a numbered \"PRs ready for your review\" line from " +
        "`/tai-ready`'s output — do the real review yourself, inline, in this same session, " +
        "before touching `review`/`comment` at all:\n\n" +
        "1. Fetch and diff the PR's actual branches (`/tai-ready`'s line shows `sourceBranch → " +
        "destinationBranch`; `git-pr create`'s own confirmation and the Bitbucket PR page also " +
        "show them): `git fetch origin <sourceBranch>` then `git diff " +
        "origin/<destinationBranch>...origin/<sourceBranch>`.\n" +
        `2. Read \`${taiHome}/src/personas/code-reviewer.md\` and apply Cole's Core Principles to ` +
        "what the diff actually changed — the same standard a human reviewer on the \"PR " +
        "Reviewers\" roster would apply.\n" +
        "3. **Present your findings, then STOP — this is the complete output of \"review this " +
        "PR,\" full stop.** What you'd flag (or \"no issues found\"), and your own leaning " +
        "(approve, request changes, or neither) as one input for the human's decision. Do NOT, " +
        "in this same turn: run `git-pr comment`, run `git-pr review`, or ask a question via any " +
        "interactive tool. End your turn right here and wait for the human's own next message — " +
        "do not try to keep going.\n\n" +
        "TAI-202/TAI-203 (found live, 2026-08-25 — two same-turn wordings tried and failed the " +
        "same way before landing on this design): a session that skips straight to a question " +
        "with no findings shown leaves the human unable to answer it; a session that shows " +
        "findings and then tries to immediately ask a question in the same turn reliably just " +
        "stops after stating its own recommendation — a polished \"Findings... I'd lean " +
        "approve\" write-up reads as a complete, satisfying answer, and no amount of \"don't " +
        "stop\" wording in this file fixed that. **Don't try to word around it a third time** — " +
        "stopping after step 3 is correct behavior, not a bug to prompt-engineer away.\n\n" +
        "4. **When the human's own next message tells you what to do, that ordinary reply is " +
        "the trigger — not a same-turn continuation, not a special tool.** They'll say it in " +
        "plain language: \"post it and approve,\" \"don't post, request changes,\" \"neither,\" " +
        "\"just approve, no comment needed,\" etc. — interpret it and act:\n" +
        "   - If they want the findings posted: run `git-pr comment` with your findings as " +
        "`<BODY>`.\n" +
        "   - If they want a decision recorded: run `git-pr review` with `approve` or " +
        "`requestChanges` — only ever because they said so explicitly; \"neither\"/no clear " +
        "decision means no `review` call at all.\n" +
        "   - If their reply is genuinely ambiguous about either the posting or the decision, " +
        "ask ONE clarifying question, not two separate ones — bundle both the comment-posting " +
        "choice and the approve/request-changes decision into a single `AskUserQuestion` call " +
        "(one call, multiple sub-questions), pre-filled with your own stated leaning from the " +
        "findings as the suggested answer for the human to confirm or override rather than " +
        "leaving both blank. Confirmed working live (2026-08-25, Gemini CLI): a human reply of " +
        "just \"post and review\" produced exactly this — one bundled question (\"PR Comment: " +
        "yes, post comment\" / \"PR Decision: Approve\") the human could confirm in a single " +
        "step, not a guess and not two back-and-forths.\n\n" +
        "This applies even when you already know the diff well (e.g. you wrote it earlier this " +
        "session) — reviewing and recording a decision are still two separate steps, and the " +
        "human still decides the outcome of each, every time. Never chain straight from reading a " +
        "diff into `review`/`merge` on your own initiative — only run either because the human " +
        "explicitly asked for that specific action, in their own message. No condition here ever " +
        "auto-approves (brief §3.4: human sign-off is the default) — running `review`/`comment` " +
        "without the human having actually said to, in their own words, is always wrong, however " +
        "clean the diff looked.\n\n" +
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
