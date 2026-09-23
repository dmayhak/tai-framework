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
        "The output has two Jira-sourced sections, both live (TAI-196/200, 2026-08-26 — replaces " +
        "the old, purely-local \"Already in flight\" section, which couldn't show work paused on " +
        "a different machine/session):\n\n" +
        "- **In Progress — resume this** — issues already at `Status.InProgress`/`InReview`, no " +
        "precedence re-check (already started once; precedence gates OFFERING new work, not " +
        "resuming it). Each line notes whether THIS machine has local session history for it " +
        "(\"local session history here\") or not (\"no local history — started elsewhere, read " +
        "fresh\") — a flag only; full detail (currentStep etc.) surfaces via `/tai-work`'s own " +
        "briefing once picked, not inline here. A `Dev` subtask carrying a \"⚠️ needs rebase " +
        "(merge conflicts)\" flag (TAI-217/219) means a `git-pr merge` attempt hit a conflict and " +
        "posted a `Rebase needed:` comment on it — self-clears once that PR actually merges, no " +
        "separate action needed.\n" +
        "- **Ready Work** — genuinely not-yet-started (open, and — for a subtask — with every " +
        "precedence prerequisite already Done or Canceled, per `SUBTASK_PRECEDENCE`).\n\n" +
        "Both sections sort Highest-priority tickets to the top and display each line's priority " +
        "(TAI-195/199; extended to In Progress 2026-08-26 — the original decision predates that " +
        "section existing). A subtask with no `Priority` of its own inherits its parent Story/" +
        "Bug's for sort/display purposes (priority is usually set at Triage on the Bug/Story " +
        "itself, not per-subtask) — this is purely a display/ordering change, never an " +
        "auto-interrupt of in-flight work.\n\n" +
        "Plus — when `BITBUCKET_EMAIL`/`BITBUCKET_API_TOKEN`/`TAI_GIT_REPOS` are all configured — " +
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
        "Present this list to the human AS-IS — every actionable line above (In Progress, Ready " +
        "Work, and all three PR sections) is already numbered with ONE shared counter (TAI-182), " +
        "so don't renumber or reformat it yourself.\n\n" +
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
        "`/tai-work <KEY>` for an In Progress OR a Ready Work line (same action either way — " +
        "resume vs. start is `/tai-work`'s own concern, not this list's), the real review flow " +
        "above for a \"PRs ready for your review\" line, `git-pr merge` for a \"ready to merge\" " +
        "line. A number with no corresponding line, or any ambiguity about which line it means, " +
        "is a re-ask, not a guess."
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
        "**Approved PRs ready to merge**) — no In Progress section, no general Ready Work list, " +
        "no \"Open PRs ready to test,\" each numbered with its own shared counter the same way " +
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
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts git-pr render-findings <FINDINGS-JSON-OR-@FILE>\n` +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts git-pr comment-findings <REPO> [PR-ID] <FINDINGS-JSON-OR-@FILE>\n` +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts git-pr unapprove <REPO> [PR-ID]\n` +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts git-pr merge <ISSUE-KEY> <REPO> [PR-ID] [mergeCommit|squash|fastForward]\n` +
        "```\n\n" +
        "**`review`/`comment`/`comment-findings`/`unapprove` take NO `<ISSUE-KEY>`** — unlike " +
        "`create`/`merge`, none is scoped to one issue at all (rev 52, TAI-159 ADR): each resolves " +
        "the acting human from `BITBUCKET_EMAIL`/`BITBUCKET_API_TOKEN` and checks them against the " +
        "\"PR Reviewers\" roster, rejecting if they aren't listed. Passing an issue key as the " +
        "first argument to any of them fails with \"Malformed RepoId\" — `<REPO>` really is the " +
        "first argument. **`render-findings` takes neither `<ISSUE-KEY>` nor `<REPO>`** — it's a " +
        "pure local render (findings JSON in, markdown out), no GitHost call at all, so there's " +
        "nothing to scope it to or gate.\n\n" +
        "`[PR-ID]` is optional on `review`/`comment`/`comment-findings`/`unapprove`/`merge` — omit " +
        "it and TAI resolves it against `REPO`'s sole currently-open PR. If more than one is open, " +
        "the command fails with a list of candidates instead of guessing — pass one of those IDs " +
        "explicitly and re-run.\n\n" +
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
        "decision, and not structured review findings — see `render-findings`/`comment-findings` " +
        "below for those).\n" +
        "- `render-findings` (TAI-209/210 ADR) — takes a structured findings JSON payload " +
        "(`@<path>` to a file, or the raw JSON inline) and deterministically renders it to " +
        "markdown on stdout. Posts nothing. This is what the review flow below runs so the " +
        "*rendered output*, not any prose you compose, becomes the visible findings text. Also " +
        "previews TAI-207's inline-vs-summary split (next bullet) — a `critical`-severity " +
        "finding with a `line` is pulled out of its severity section and shown as a one-line " +
        "tally instead (e.g. \"🔴 — posted as inline comments\"), same as what `comment-findings` " +
        "will actually do.\n" +
        "- `comment-findings` — same rendering as `render-findings`, but posts the result as the " +
        "PR's summary comment (via the same general-comment path `comment` uses). TAI-207: before " +
        "posting the summary, also posts one real inline PR comment (anchored to that exact file " +
        "and line) for every `critical`-severity finding that has a `line` — those findings are " +
        "then excluded from the summary's own severity sections (the tally line stands in for " +
        "them). A finding whose inline post itself fails (e.g. its `line` isn't actually part of " +
        "the diff) falls back into the summary instead of being silently dropped, and the failure " +
        "is reported alongside the summary comment's own output. This is how review findings " +
        "actually get posted — see the review-flow section below.\n" +
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
        "Reviewers\" roster would apply. Build your findings as a single structured JSON object " +
        "(TAI-209 ADR) — never prose — conforming to:\n\n" +
        "```json\n" +
        "{\n" +
        '  "overview": "2-3 sentence high-level assessment",\n' +
        '  "findings": [\n' +
        "    {\n" +
        '      "severity": "critical|suggestion|nitpick|good",\n' +
        '      "category": "Security|Performance|Logic|Style|Architecture|...",\n' +
        '      "title": "brief title",\n' +
        '      "file": "path/to/file.ts",\n' +
        '      "line": 42,\n' +
        '      "issue": "one short paragraph, no line breaks",\n' +
        '      "fix": "exact replacement for the single line at \\"line\\", or omit"\n' +
        "    }\n" +
        "  ],\n" +
        '  "leaning": "approve|requestChanges|neither",\n' +
        '  "leaningReason": "one sentence — your own rationale, never a decision"\n' +
        "}\n" +
        "```\n\n" +
        "`line`, when given, is the line number in the NEW (current) version of the file — " +
        "the same numbering the diff's `+` side uses. A finding about a deleted line, or " +
        "one you can only place on the old side of the diff, should omit `line` rather than " +
        "guess at a new-side number (TAI-207: `line` now anchors a real inline PR comment, " +
        "not just cosmetic text — a wrong or old-side line number posts to the wrong place " +
        "or gets rejected by Bitbucket outright).\n" +
        "`line`/`fix` are optional per finding, everything else is required. An empty " +
        "`findings` array is a valid, preferred outcome for clean code — don't invent issues to " +
        "justify the review. Write this JSON to a temporary file (your host's own scratch/temp " +
        "location if it has one, otherwise any plain temp path) — every command below takes it as " +
        "`@<path>`, never as prose you type into the command yourself.\n" +
        "3. **Run `git-pr render-findings @<path>`, then paste its ENTIRE stdout verbatim into " +
        "your own reply as ordinary chat text — then STOP. This is the complete output of " +
        "\"review this PR,\" full stop.** A tool call's own output is not reliably visible to the " +
        "human as chat content (TAI-258, found live 2026-08-27) — running the command is not " +
        "enough, and neither is referencing or summarizing what it said (\"rendered by " +
        "render-findings, leaning approve\" is NOT the findings). Quote the real markdown the " +
        "command printed, in full, in the message the human actually reads. Do NOT, in this same " +
        "turn: run `git-pr comment-findings`, run `git-pr review`, or ask a question via any " +
        "interactive tool. End your turn right here and wait for the human's own next message — " +
        "do not try to keep going.\n\n" +
        "TAI-202/TAI-203 (found live, 2026-08-25 — two same-turn wordings tried and failed the " +
        "same way before landing on this design): a session that skips straight to a question " +
        "with no findings shown leaves the human unable to answer it; a session that shows " +
        "findings and then tries to immediately ask a question in the same turn reliably just " +
        "stops after stating its own recommendation — a polished \"Findings... I'd lean " +
        "approve\" write-up reads as a complete, satisfying answer, and no amount of \"don't " +
        "stop\" wording in this file fixed that. **Don't try to word around it a third time** — " +
        "stopping after step 3 is correct behavior, not a bug to prompt-engineer away. TAI-209 " +
        "ADR (2026-08-27): moving findings to structured JSON removes the specific narrative-" +
        "conclusion trap at its root — you never compose the write-up yourself, `render-findings`' " +
        "own deterministic stdout is what the human sees — but the stop-and-wait boundary stays " +
        "exactly as strict as before. Don't relax it just because the text is machine-rendered " +
        "now.\n\n" +
        "4. **When the human's own next message tells you what to do, that ordinary reply is " +
        "the trigger — not a same-turn continuation, not a special tool.** They'll say it in " +
        "plain language: \"post it and approve,\" \"don't post, request changes,\" \"neither,\" " +
        "\"just approve, no comment needed,\" etc. — interpret it and act:\n" +
        "   - If they want the findings posted: run `git-pr comment-findings <REPO> [PR-ID] " +
        "@<path>` — the same file from step 2, never retyped or re-composed as prose.\n" +
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
        "This (re)writes all five skills (`tai-work`/`tai-ready`/`tai-pr`/`tai-init`/`tai-audit`) " +
        "for both Claude Code and Gemini CLI, so it's always safe to re-run — e.g. after " +
        "`tai-framework` itself has been updated at its fixed location.\n\n" +
        "**Target-project setup (TAI-116 piece 3, TAI-130):** once the bootstrap above is done, " +
        "check whether the CURRENT project (cwd) still needs onboarding:\n\n" +
        "```bash\n" +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts init status\n` +
        "```\n\n" +
        'If it reports "Fully initialized," relay its next-step hint to the human verbatim ' +
        "(TAI-349) — don't just say \"done\" and stop, since a genuinely fresh project has no " +
        "obvious next action otherwise. Otherwise — including a " +
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

/** TAI-268 (TAI-254 ADR) — the seven checks this skill runs, each a `[check-name]` value.
 *  Kept as a named list (not just prose) so both the argument-parsing instructions below
 *  and each check's own subsection can reference the exact same identifiers. */
const AUDIT_CHECKS: readonly { readonly name: string; readonly title: string }[] = [
    { name: "brief-gaps", title: "Stale brief-gap notes" },
    { name: "output-types", title: "Undescribed declared output types" },
    { name: "decision-drift", title: "Cross-cutting decision drift" },
    { name: "missing-links", title: "Missing real Jira links" },
    { name: "duplicate-scope", title: "Duplicate scope across open tickets" },
    { name: "stale-verification", title: "Stale test/verification claims" },
    { name: "orphaned-descriptions", title: "Orphaned or contradicting descriptions" },
];

function auditSkillBody(taiHome: string): string {
    const checkList = AUDIT_CHECKS.map((c) => `\`${c.name}\` (${c.title})`).join(", ");
    return (
        "**What this is (TAI-254 ADR):** a report-only, purely human-initiated sweep of the " +
        "current project's OPEN backlog for seven recurring staleness/drift patterns — the same " +
        "seven an earlier session ran ad hoc, one \"check the rest of the tickets for X\" request " +
        "at a time. This skill unifies them under one invocation. It never writes to Jira or " +
        "Confluence itself; every finding is surfaced for the human to decide on, case by case " +
        "(v1 has no auto-fix path at all, not even for the mechanical-looking findings).\n\n" +
        "**The one rule every check below shares, and the actual reason this ADR exists (not a " +
        "performance concern — a correctness one):** search fresh, every single time, for every " +
        "check. Never answer from anything recalled earlier in this conversation, a prior " +
        "`tai-audit` run, or `/tai-work`'s own cached briefing for a ticket you happen to already " +
        "know well — several checks in the session this skill is built from silently produced " +
        "wrong findings until re-run with an explicit \"force a fresh read\" instruction. Treat " +
        "every check as if this were the first time you'd ever looked at these tickets.\n\n" +
        "**Read primitives** (TAI-268 — plain wrappers around `WorkTracker`/`DocStore` methods " +
        "that already existed; no Atlassian MCP server needed, same TAI-126 posture as every " +
        "other `cli.ts` subcommand):\n\n" +
        "```bash\n" +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts issue search [status=<CSV>] [type=<CSV>] [persona=<P>] [parent=<KEY>] [limit=<N>]\n` +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts issue get <ISSUE-KEY>\n` +
        `npx --prefix ${taiHome} tsx ${taiHome}/src/hosts/cli.ts page get <SPACE-KEY> <TITLE> | page get id=<PAGE-ID>\n` +
        "```\n\n" +
        "`issue search` defaults to the CURRENT project (from `.env`) and applies NO status " +
        "filter unless given one — for \"the open backlog,\" pass the whole `status=` pair as one " +
        "quoted argument (values contain spaces): " +
        '`"status=Backlog,To Do,In Progress,In Review"`. Also pass a generous `limit=` (e.g. ' +
        "`limit=200`) — the default cap is only 50, and a truncated sweep is worse than a slow " +
        "one; the command itself says in its own output when the limit was hit, re-run higher if " +
        "so. `issue get` is the per-ticket drill-down — full description, every comment, real " +
        "linked issues (both `depends-on`/`relates-to`, both directions), and every linked " +
        "Confluence page (flagging one outright as `**MISSING**` if the page itself is gone, not " +
        "just unlinked). Use `issue search`'s bulk output for text-pattern scanning across the " +
        "whole backlog, `issue get`/`page get` when a specific finding needs the full picture.\n\n" +
        `**Local docs each check reads fresh** (never from memory): \`${taiHome}/PROJECT_BRIEF.md\` ` +
        `(the framework's own living design doc — read its CURRENT content and its revision-` +
        `history trail at the top, not a remembered rev number), \`${taiHome}/src/personas/*.md\` ` +
        `(one file per persona), \`${taiHome}/src/workflows/dependencies.md\` (the "material ` +
        "bearing\" link bar, §RelatesTo).\n\n" +
        `**Argument:** \`tai-audit [check-name]\`. With no argument, run all seven checks below ` +
        "in sequence — each one fully independent (its own fresh searches, no sharing/batching " +
        "across checks; decision #5's own conclusion was that batching was never the actual " +
        "problem, stale-cache correctness was). With a `check-name` argument, run only that one " +
        `check. Valid names: ${checkList}. Any other value is a re-ask — list the valid names ` +
        "back rather than guessing which one was meant.\n\n" +
        "---\n\n" +
        "## Check: `brief-gaps` — stale brief-gap notes\n\n" +
        "Search the open backlog's descriptions and comments for a ticket asserting something is " +
        "**currently unresolved** in `PROJECT_BRIEF.md` — phrasing like \"the brief doesn't cover " +
        "this yet,\" \"open question in §N,\" \"not yet decided in the brief,\" or an explicit " +
        '`NEEDS CLARIFICATION` left unresolved past the ticket it was raised in. For each one, ' +
        "read the CURRENT `PROJECT_BRIEF.md` fresh and check whether a later revision actually " +
        "resolved it already — the ticket's own claim has simply gone stale. A finding is: the " +
        "ticket key, the exact stale claim (quoted), and which brief section/revision resolved it.\n\n" +
        "## Check: `output-types` — undescribed declared output types\n\n" +
        `Read every \`${taiHome}/src/personas/*.md\` file fresh. Each has a \`confluenceOutputs:\` ` +
        "frontmatter list (output `type`s that persona can produce) and a prose `## Outputs` " +
        "section further down. Flag any type present in one but not the other (declared with no " +
        "description, or described with no matching frontmatter entry) — both directions are a " +
        "finding. Separately, scan open tickets for a persona promising to produce some named " +
        "output/artifact that the OWNING persona's doc doesn't declare or describe at all. A " +
        "finding is: the persona file (or ticket key) and the specific undescribed/undeclared " +
        "type.\n\n" +
        "## Check: `decision-drift` — cross-cutting decision drift\n\n" +
        "Distinct from `brief-gaps`: this is about a ticket stating a specific behavior as " +
        "CURRENT FACT that has since changed, not about a gap that closed. Read `PROJECT_BRIEF.md`" +
        "'s own revision-history trail at the top fresh (the \"Prior: rev N —\" chain covers the " +
        "last several decisions) and check each open ticket's description/comments against it for " +
        "a stated behavior that a later revision superseded — e.g. a ticket describing an old " +
        "gating rule, a retired mechanism, or a since-reversed default as if it were still true " +
        "today. A finding is: the ticket key, the stale statement (quoted), and the brief " +
        "revision that actually superseded it.\n\n" +
        "## Check: `missing-links` — missing real Jira links\n\n" +
        "For each open ticket, scan its description/comments for a mention of another ticket key " +
        "(`TAI-\\d+`-shaped) or a Confluence page title/URL. For each mention, run `issue get` on " +
        "that ticket and check whether a REAL link (not just prose) already exists to the " +
        "mentioned key/page. Where one is missing, read " +
        `\`${taiHome}/src/workflows/dependencies.md\` fresh and apply its own "material bearing" ` +
        "bar before flagging it — link only what has a material bearing on completing the " +
        "CURRENT ticket more efficiently, never every passing topical mention. A finding is: the " +
        "ticket key, the referenced key/page, and a one-line reason it clears the material-" +
        "bearing bar.\n\n" +
        "## Check: `duplicate-scope` — duplicate scope across open tickets\n\n" +
        "Enumerate the open backlog (Stories/Bugs/Epics as one group, subtasks as another — " +
        "duplication across those two groups isn't meaningful, within each group it is) and " +
        "compare summaries/descriptions for two or more open tickets covering substantially the " +
        "same piece of work. A finding is: the overlapping ticket keys and what scope they share.\n\n" +
        "## Check: `stale-verification` — stale test/verification claims\n\n" +
        "The one check that also needs the actual repo, not just Jira/Confluence: scan open " +
        "tickets for a specific test/verification claim (\"N/N tests pass,\" \"verified against " +
        "real Jira,\" naming a specific test file or `describe` block) and confirm it's still " +
        "true against the CURRENT code — run the real test suite, or `grep` for the named test/" +
        "describe block to confirm it still exists and still says what the ticket claims. A " +
        "finding is: the ticket key, the stale claim (quoted), and what's actually true now.\n\n" +
        "## Check: `orphaned-descriptions` — orphaned or contradicting descriptions\n\n" +
        "Two sub-patterns: **(a) dangling references** — the same ticket-key/page-mention scan " +
        "as `missing-links`, but here the referenced ticket/page itself no longer exists at all " +
        '(`issue get`/`page get` returns "not found"), not merely unlinked. **(b) parent/child or ' +
        "sibling contradiction** — for each open subtask, `issue get` its parent and `issue " +
        "search parent=<KEY>` its siblings, and check for a stated fact that contradicts what the " +
        "parent or a sibling currently says (e.g. a subtask describing its parent or a sibling as " +
        "in a status/state that isn't actually true anymore). A finding is: the ticket key(s) " +
        "involved and the specific contradiction or dangling reference. **Caveat on (a) for pages:** " +
        "`page get`'s by-title form is an EXACT `(spaceKey, title)` lookup, not a fuzzy search — a " +
        "\"not found\" only means the page is gone if the mentioned title is verbatim-accurate. A " +
        "ticket paraphrasing or slightly mis-titling a page that still exists will also miss; before " +
        "flagging a page as orphaned from a title mention, prefer resolving it via the mentioning " +
        "ticket's own `issue get` \"Linked pages\" list (by id) if it's linked at all, and treat a " +
        "title-only miss as a lower-confidence finding, not a certain one.\n\n" +
        "---\n\n" +
        "**Output:** for each check that ran, a `## <check-name>` section listing every finding " +
        "as its own bullet (ticket key(s) + the specific issue, concrete enough to act on without " +
        "re-deriving it) — or the literal line `No findings.` when a check comes back clean " +
        "(a clean pass is a real, good outcome; never invent a finding to avoid an empty section). " +
        "Present the full report for every check that ran, **then stop and wait for the human's " +
        "own next message** — same stop-and-wait discipline as `tai-ready`/`tai-pr`'s own findings " +
        "steps (TAI-202/203/258): do NOT, in this same turn, fix anything, create a Jira link or " +
        "ticket, edit `PROJECT_BRIEF.md`, or re-run a check unasked, no matter how obvious or " +
        "mechanical a finding looks. This is report-only, full stop (decision #3) — the human " +
        "decides every fix, one at a time, in their own next message."
    );
}

/** All 10 skill files (5 skills × 2 hosts) — identical content per skill across hosts, since
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
        {
            name: "tai-audit",
            description:
                "Report-only sweep of the open backlog for seven staleness/drift patterns -- stale brief-gap " +
                "notes, undescribed output types, decision drift, missing links, duplicate scope, stale " +
                "verification claims, orphaned/contradicting descriptions (TAI-254 ADR)",
            body: auditSkillBody(taiHome),
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
