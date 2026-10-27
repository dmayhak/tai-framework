# Team AI (TAI) — Changelog

The revision history of `PROJECT_BRIEF.md`, newest first. Moved out of the brief on 2026-10-09 (TAI-486); the entries below rev 81 are unchanged from how they read there. The brief states what is true now; this file says how it got there.

## rev 146 (2026-10-27)

**TAI-701 (Story TAI-700): the PR 33 leftovers.** The `do-dev-tasks` usage line and the handler comment name `yolo=true|false`. `do-dev-tasks rules dryrun=true` is now refused (after `rules` only `yolo=` is taken), as the rev 145 entry said `rules` would. `parseDevTasksArgs` reads the two `yolo=` values with plain checks instead of a nested ternary and a null sentinel. The choice of the effective DEV-YOLO value is one function, `resolveYolo`: the argument wins in both directions, the setting is read only when there is no argument, and nothing is written; tests cover `yolo=false` with the setting on, `yolo=true` with it off and no argument both ways, which the TAI-692 verification found untested.

## rev 145 (2026-10-27)

**TAI-693 (Story TAI-692): `do-dev-tasks yolo=true|false` for one run.** A person no longer has to turn the `dev-yolo` setting on and off to try an unattended run. `yolo=true` sets DEV-YOLO for that run only and passes the checks the setting does, in `allowYoloForOneRun`: a person on the Autonomy admins list, not in an AI session, not acting as a persona; a refusal names the check. It leaves a `dev-yolo-once` attestation as an audit record that says it was for one run; nothing requires it, since it is written just before the run and a check of it could not fail (PR 33 review), and the setting's own record is not asked for on a one-run override. The stop checks (Database, UAT, test tiers, the reviewer account) still apply. `yolo=false` runs without DEV-YOLO even when the setting is on and needs no check. The stored setting is never written. The report says when DEV-YOLO is on or off for this run only; the readiness warning and `do-dev-tasks rules` use the effective value, and `rules yolo=true|false` prints that set whatever the setting is. `parseDevTasksArgs` accepts `dryrun=true`, `yolo=true` and `yolo=false` (and refuses both yolo values together, or anything else), and a run with only `yolo=...` is no longer read as a dry run. The override is on `do-dev-tasks` only, not on `/tai-work` or the review command, which are single steps of the flow and the ones most often run from an AI session. `do-dev-tasks rules` now refuses an argument it does not know (`rules foo`), which it used to ignore. Also from the PR 32 review: a comma expression in the `rules` handler is now a block.

## rev 144 (2026-10-27)

**TAI-685 (Story TAI-684): the rule set and warning for a DEV-YOLO run, and the PR 27 review leftovers.** With `dev-yolo` on, `do-dev-tasks rules` and the pre-run warning use a larger set: the reviewer, fix and verify commands are allowed, `git-pr review` is no longer denied (a person who added that deny would have stopped every ticket at the reviewer's own decision), and the warning no longer lists a review as something to refuse; `git-pr merge` and `init` stay denied. `rules` says which set it prints. A test builds the four unattended prompts, takes the commands they name and checks that no deny refuses one and that the allow set covers each (`commandVerdict`). The checkout deny is widened to `git checkout *-- *` and `git checkout ./*`, so `HEAD -- src`, `origin/main -- .` and `./` are refused. The `/tai-do-dev-tasks` skill text describes `rules` and the warning, and the module comment records combined short flags on a branch delete (`git branch -vD x`, `-rD`, `-fd`) as an accepted limit.

## rev 143 (2026-10-27)

**TAI-691 (Story TAI-690): the unattended reviewer checks the change against the Story's acceptance criteria.** The DEV-YOLO wiring reads the Story's numbered `AC-n` lines and `buildReviewerPrompt` puts them in the reviewer's prompt as data. A criterion the diff does not meet is a critical finding that names it, so the run stops for a person before any fix or merge; one that needs a live run to judge goes in `notChecked`. A Story with no criteria, or whose criteria cannot be read, reviews as before and the prompt tells the reviewer to say so in `notChecked`. Found in the first live DEV-YOLO trial, where the reviewer approved without being told the criteria and only the later Tester run looked at them.

## rev 142 (2026-10-27)

**TAI-689 (Bug TAI-688): the `do-dev-tasks` report puts each outcome where it belongs.** A ticket DEV-YOLO ran to the end (merged, verified, Story closed) is listed under Done with what was done, and a ticket it stopped for a person is listed under "Waiting for a person" with the reason; both used to sit under a "Not run" section, so a finished run showed `Done (0)`. The "Not run" section is gone. A ticket with a PR opened and awaiting review is listed as before. Found in the first live DEV-YOLO trial on TAIT.

## rev 141 (2026-10-27)

**TAI-683 (Story TAI-682): the unattended reviewer's leaning follows the bar.** The reviewer prompt now says to set `leaning` by the DEV-YOLO bar (`requestChanges` when any finding is critical, otherwise `approve`, never `neither`), since nobody is there to decide and the author decides every Suggestion and Nitpick after the approval. A round that has an approval and no critical finding but whose findings lean anything other than `approve` stops that ticket with a `Handoff:` before any fix run starts. The human review flow keeps all three leanings. The stop reason for an approval whose findings lean `requestChanges` says the review contradicts itself, apart from the `neither` wording.

## rev 140 (2026-10-27)

**TAI-679 (Story TAI-678): review findings list the critical ones in full, at the top.** `render-findings` and the summary comment `comment-findings` posts now list every finding, critical ones included, in full under its severity heading, so the red section at the top shows the most serious findings. The one-line tally ("posted as inline comments") and the preview's separate "Will be posted inline" block (TAI-644/645) are gone. A critical finding that has a line is still also posted as an inline comment, and a failed inline post loses nothing because the summary already holds the finding; the failure is still reported to the person running the command. `renderReviewFindings` no longer takes a partition argument. The Code Reviewer persona's note on inline comments says the summary lists those findings too.

## rev 139 (2026-10-27)

**TAI-649 (Story TAI-648): the rules an unattended Dev build needs.** `core/commands/build-allow-rules.ts` names the narrow Claude Code allow set a build uses and the deny entries that keep out a force push, `git-pr merge`, `git-pr review` and `init`. `do-dev-tasks rules` prints it for the person to add themselves; before the first run `do-dev-tasks` checks the project's and the user's settings files against it and says plainly what is missing, what nothing refuses, and when `TAI_CHECK_COMMAND` is not set. Nothing is written or blocked. PR 27 review: the deny entries for `git-pr merge`, `git-pr review` and `init` also name the `--as <persona>` and `--as=<persona>` spellings (a `*` spans spaces, so the bare entry did not match them); a branch delete, a `--delete` push and a checkout that discards the working tree are denied too (a delete by refspec cannot be written, since its pattern would end in `:*`); the coverage check counts the older `Bash(cmd:*)` prefix form; and the module comment records what the allow set does not narrow and which settings files the check reads. Second PR 27 review: a compound `TAI_CHECK_COMMAND` is allowed one command at a time (Claude Code matches the parts of `&&`, `||`, `;` and `|` separately, so a rule holding the whole chain matched none of them); a `--mirror` or `--prune` push, a push to `main` or `master`, and a forced or resetting checkout or switch are denied, with the forms still open (another default-branch name, a refspec spelling) named in the module comment; the coverage check reports a required command that a deny rule of the person's own refuses; and the allow side naming `--as developer` and not `--as=developer` is recorded as accepted. Third PR 27 review: the `--as <persona>` deny entries had a `*` for the persona, which spans spaces, so `--as * init *` also matched a build's own `issue comment` whose text mentioned init and would have stopped the run; they now name every persona (the built-in ids and short names, and the project's own when its personas page can be read), 201 entries for the built-ins. The coverage check no longer takes a narrower rule for a required one with a wildcard in the middle (`git push --force*` is not `git push *--force*`): a rule covers only when it matches every command the required one stands for. A compound `TAI_CHECK_COMMAND` is split outside quotes only, and on `&` and newlines as well. `git branch -f`, `--force` and `-M` and `git push -uf` are denied too; other combined short flags on a push are named as accepted.

## rev 138 (2026-10-26)

**TAI-647 (Bug TAI-646): a run that exits 0 with no PR now says why.** `do-dev-tasks` and the DEV-YOLO build step put the end of the run's own output (already redacted, on one line) in the failure reason and the hand-off, so a run that stopped on a command it was not allowed to run no longer has to be re-run by hand to see the cause.

## rev 137 (2026-10-26)

**TAI-667 (Bug TAI-666): wording from the PR 24 review.** The DEV-YOLO dirty-tree stop lists the changed files once instead of repeating the start-of-run message, and the comment above the merge call's catch matches the hand-off wording.

## rev 136 (2026-10-26)

**TAI-665 (Bug TAI-664): DEV-YOLO finish follow-up from the PR 23 review.** A `Handoff:` after the merge goes on the parent Story or Bug and says what the Dev ticket did, since the Dev ticket is Done by then and drops out of the open work. The hand-off before the merge no longer says the PR is open. A dirty working tree is found before the merge (`assertCleanTree`), not after it. PR 24 review: the hand-off says the Dev ticket is Done only once it really reached Done; if the move to Done fails, the hand-off goes on the Dev ticket and says it is not Done.

## rev 135 (2026-10-26)

**TAI-634 (Story TAI-629), part 3: the gated merge, verify and close.** `core/commands/dev-yolo-finish.ts` finishes a PR the automated reviewer approved. It merges only through the merge gate (check green, gate met, a check result when a check command is set, and the fresh approval the automated reviewer's own), on the commit the gate checked, never with force; says on the PR that the approval was automated, by which account and on which commit; moves the linked ticket to Done; updates the checkout; and has a fresh Tester run verify the Story or Bug (`buildVerifyPrompt`). It closes the Story or Bug only on a `Verified:` comment that appeared during that run. Any other result leaves it open with a `Handoff:` saying whether the PR had merged. The PR 23 review's hardening: a verdict counts only as a comment's first line, stamped as the Tester and new during the run; any `Not verified:` among them keeps the Story open; a Story with other subtasks still open is not closed; a merge call that threw after the host merged is read from the host; a missing merge comment is noted on every later stop. With this, the DEV-YOLO run covers AC-1 to AC-7 of Story TAI-629; the TAIT trial (AC-8) remains.

## rev 134 (2026-10-26)

**TAI-634 (Story TAI-629), part 2: build, review, decide, fix.** With `dev-yolo` on, `do-dev-tasks` now checks each ticket (`yoloGate`: the part 1 stop checks and a configured automated reviewer account listed on `PR Reviewers` with the `automated` marker, not the person's own), then runs it (`core/commands/dev-yolo.ts`, connected to the real parts in `dev-yolo-wiring.ts`): the build run, then up to `review-rounds` rounds of a fresh reviewer run (its own account from `TAI_REVIEWER_GITHUB_TOKEN` and `TAI_REVIEWER_EMAIL`; it writes structured findings, posts them and casts its decision) and a fix run that decides each Suggestion and Nitpick and posts one line per finding. A finding above Suggestion, a request for changes, no approval on the current commit, a failed run or an exhausted round limit leaves a `Handoff:` and the batch goes on. `runHeadlessClaude` takes extra environment for a run, redacted from what it reports. The PR 22 review's fixes: only the reviewer account's own decision counts (a request for changes from anyone is still a stop), the gate resolves the reviewer token's account on the git host, the findings file is under `.tai/`, the head is read the same way before and after a fix, and findings of another commit than the head stop the run. The second review's fixes: the reviewer token is removed from every other run's environment, the reviewer prompt carves its findings file out of the `.tai/` rule, and the findings must name this repo and PR. The third review's fixes: the reviewer run keeps the person's own Jira email and token (a matching pair) and differs only in its git host account, so its row on `PR Reviewers` must carry its GitHub login; and a decision from an earlier abandoned run does not count, the run must cast a new one. Part 3 (the gated merge, verify and close, AC-5 and AC-6) and the TAIT trial (AC-8) remain.

## rev 133 (2026-10-26)

**TAI-634 (Story TAI-629), part 1: the checks before an unattended run.** The first of three PRs for DEV-YOLO (ADR page 64782337). `review-rounds` now defaults to 4 (it was 2). `settings set` on an autonomy setting records on that machine that the person set it (`.tai/autonomy-attestations.json`, `core/settings/attestation.ts`), because the `Settings` page and `Autonomy admins` list can be edited by hand and are not proof of a human decision (the PR 17 review carry-over). `core/commands/yolo-checks.ts` gives, for one Dev ticket, every reason a person must do it: DEV-YOLO off, not on the admins list, no record on this machine, or an open `Database`, `UAT` or test-tier subtask on its Story. The `PR Reviewers` page reads an optional Marker column; `automated` marks the separate Claude reviewer account. The Developer persona gained the three-way decision for each Suggestion and Nitpick (do it now, make a ticket, comment why not), with its rationale. Nothing runs yet: part 2 is the build, review and fix loop; part 3 is the gated merge, verify and close.

## rev 132 (2026-10-25)

**TAI-633 (Story TAI-628): "Do all dev tasks".** `do-dev-tasks` (skill `tai-do-dev-tasks`, now thirteen) works the current user's In Progress and To Do `Dev` subtasks on Stories and Bugs one at a time, each in its own headless `claude -p` run (ADR page 64782337 decision 8). With `dev-yolo` off a run builds, opens the PR and records the check; review and merge stay with people. A failure leaves a `Handoff:` comment and the others go on; a precedence- or `DependsOn`-blocked ticket is skipped with its reason, but the list is found again after every ticket, so one that a ticket of ours unblocks is picked up (each ticket is tried once per run); PR 19 review: the PR is matched by the whole Dev key and not a substring, a ticket whose PR is already open is skipped, `TAI_DEV_RUN_TIMEOUT_MIN` is validated, the kill follows the stop after a grace, and the run accepts edits only; second PR 19 review: the timeout stops the whole process group and returns even if a child holds the pipes, a run that leaves the tree dirty stops the command with the hand-off on that ticket and not on every later one, the open PRs are listed once per look, the title match is limited to the first two slots, only the tail of a run's output is kept, and the dry run says when it could not leave out tickets that have a PR; the report ends with done, failed, skipped and waiting. With `dev-yolo` on the ticket goes to `yoloRun`, which TAI-634 supplies; until then the command builds nothing and says so. Decided in the build: the prompt spells the steps out instead of relying on a skill loading in print mode; a run is stopped after `TAI_DEV_RUN_TIMEOUT_MIN` (45); the working tree must be clean before each ticket; the command is not in the Claude allow rule.

## rev 131 (2026-10-25)

**TAI-632 (Story TAI-627): `tai-settings` shows and changes the project's settings.** The first piece of Epic TAI-625 (ADR page 64782337, decisions 6 and 7). A typed `Settings` page in the `Config` folder holds per-user values keyed by email and an `Autonomy admins` list; `settings`, `settings set <key> <value>` and `settings admins add|remove <email>` read and write it through the DocStore. The three autonomy settings (`dev-yolo`, `review-rounds`, `reviewer`) are refused from an acting persona, from an AI session and from a human not on the list. Decided in the build: the AI-session check reads the `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and `GEMINI_CLI` markers, so the human runs autonomy changes in a plain terminal; with an empty admins list a human may add only themselves; `settings` is not in the Claude allow rule. A new `tai-settings` global skill (twelve skills now). PR 17 review: a save keeps rows it does not understand and the page's prose instead of re-rendering the page; the skill list is updated in the init text, comments and README; the brief says the admins list is as editable as the page. Second review: the settings table is found by its `User | Setting | Value` header, not by any table, and an extra column on a recognised row is kept; `settings` is in the CLI usage line. Third review: a save rewrites every row for a user and setting, so a duplicate row cannot leave the old value winning when autonomy is revoked; the ignored-rows note says to edit the page. Fourth review: reading and saving share one rule for which Autonomy admins bullets are admins (a bare address, or a link to an address, including a named `mailto:` link), so a save keeps every other bullet.

## rev 130 (2026-10-24)

**TAI-622 (Story TAI-612): the allow rule covers the project's own personas, short names and `--as=<name>`.** From the review of PR 8: the rule `init run` offers spelled out only the built-in ids after `--as`, so a team with a persona of its own, a habit of typing `--as dev` (TAI-618), or the `--as=<id>` spelling still stalled on a prompt. Decided with the human: build the rule from the project's persona list (`listProjectPersonaIds`: the built-ins plus the `Personas` page) rather than document the limit. `buildAllowRules` now spells out each built-in id, each short name and each project persona, after both `--as` and `--as=`; an id that is not a valid `--as` value is dropped, and there is still no wildcard persona, so `git-pr merge` stays uncovered. When the page cannot be read the rule covers the built-ins and says so. The prompt lists the bare rules and summarises the several hundred per-persona ones. `settings.local.json` is now written to a temporary file and renamed. Not taken: changing when the offer re-prompts after a release adds a persona or subcommand, which is how a new rule reaches a project. Also decided: acceptance criteria are written as a `* ` bullet list under a bold `*Acceptance Criteria*` header (`pm.md`); grooming and `/tai-verify` already match a list item.

## rev 129 (2026-10-23)

**TAI-609 (Story TAI-608): `issue unlink` removes a link.** Found in a real target project, 2026-10-19 (TAI-588): two duplicate links had to be removed with the Atlassian MCP tool because the CLI had `issue link` and nothing to undo it. `WorkTracker` gains `removeLink(from, relation, to)`, the inverse of `createLink` with the same argument meaning (for `depends-on`, the second key is the blocker; `relates-to` matches either way round). It removes every matching link, so a duplicated pair goes in one call, and answers whether anything matched; `false` changes nothing. The Jira backend reads the links on `from`, matches on the inward/outward slots `createLink` writes, and deletes each by id; links of a type TAI does not own (`Duplicate`, say) are never touched. `issue unlink <depends-on|relates-to> <FROM> <TO>` takes `issue link`'s arguments and prints `Link removed` or `No such link`. The conformance suite covers create-then-remove on both backends (run live against TAIT). Not taken: an `unlink` for page and remote-PR links, which no session has needed.

## rev 128 (2026-10-23)

**TAI-618 (Story TAI-617): personas have short names.** Found running `/tai-ready dev` in a real target project: people type `dev`, not `developer`. `PERSONA_ALIASES` (`story-schema.ts`) gives each built-in persona one or more aliases (`dev`/`eng`/`engineer`, `ux`/`design`/`designer`, `db`/`data`/`database`, `ops`/`infra`/`sre`, `qa`/`test`, `reviewer`/`review`/`cr`, and so on), and `resolvePersonaName` matches an id or an alias in any case. It is used by the `ready` argument, `persona=` on `issue create`, `update` and `search`, and `--as`. A test fails when two personas share an alias or an alias equals a persona id. A persona the project added under an id that is also a built-in's alias keeps that id. An unknown name is refused with every id and its aliases. Not taken: aliasing the persona display names (Perry, Dario), which a team can rename. The Claude Code allow rule (`init run`) still spells out ids only, so a command typed with an alias is judged by the classifier as before.

## rev 127 (2026-10-23)

**TAI-621 (Story TAI-620): the grooming and retro briefings indent each numbered section's content.** Found reading `/tai-groom` in a real target project: under a heading such as `1. Epics with nothing under them`, the rows and `None.` sat at the same column as the heading, which made the briefing hard to scan. `indentSectionBody` (`section-indent.ts`) puts every line under a `## n. Title` heading in by three spaces, continuation lines included, in `renderGroomingBriefing` and `renderRetroBriefing`; headings, the scope line and the closing paragraph stay where they were, and a three-space `- ` row is still a Markdown list item. Not taken: `/tai-ready`, whose bold group names and numbering that runs across groups would read differently indented.

## rev 126 (2026-10-23)

**TAI-616 (Bug TAI-615): `ready <persona>` refuses an unknown persona.** Found in a real target project, 2026-10-23: `/tai-ready dev` (`dev` is not a persona id; `developer` is) failed with `Cannot read properties of undefined (reading 'replace')`, because the `ready` branch of `cli.ts` cast its argument to `Persona` without checking it. `parseReadyPersonaArg` now runs it through `parsePersonaArg`, so a wrong word gets the same `Unknown persona "<value>". Expected one of: …` message `issue search persona=` already gave. Short aliases for personas are TAI-617.

## rev 125 (2026-10-23)

**TAI-614 (Story TAI-613): a DBA and a Tester open PRs for the scripts they write.** Found working in a real target project: a DBA writes SQL and migrations and a Tester writes test scripts, and the DBA had no `gitHost` grant at all while Tester's `createPullRequest` was limited to test code found after the `Dev` PR merged. Decided with the human: the author commits onto the Story's branch and opens a PR from it, titled with the Story key and then their own subtask's key, whenever no open PR already carries those commits; neither merges, the `Dev` owner or PM does. `dba.md` gains `createPullRequest` (no merge), `tester.md`'s grant is widened from the single post-merge case, and brief §5.4 item 8 says so. In code a `Database` subtask is now handled as a test tier already was: merging its PR resolves permission through the sibling `Dev` (`resolveMergePersona`), `findLinkedIssueForPR` and the out-of-band merge sync close it on merge, and `readyToMerge` lists its PR beside the Dev PR. The merge gate skips the test-tier and `UAT` checks for a `Database` PR (found in the review of PR 10: Database precedes `Dev`, so the tiers could never be Done when it merged and only `force=true` would get it through); approvals and standing change requests still apply. Also from that review, decided with the human: `Dev` may start once `Database` has started (`precedence-gate.ts`; a test tier or UAT too, once `Dev` has started), because `Database` now stays In Progress until its PR merges and would otherwise stall `Dev` on a human merge; `/tai-ready` still lists `Dev` only once `Database` is Done. Not taken: a separate branch per subtask (a second merge step into the Story branch for no gain), and a review subtask for the DBA PR.

## rev 124 (2026-10-23)

**TAI-611 (Story TAI-610): `issue transition` accepts `Cancelled`.** Found in a real target project, 2026-10-19: Jira's status is spelled `Canceled`, and `issue transition <KEY> Cancelled` was rejected, costing a retry. `normalizeStatusArg` (`cli.ts`) matches a typed status to TAI's own spelling, ignoring case and treating `Cancelled` as `Canceled`; it is used by `issue transition` and by the `status=` filter of `issue search`, which would otherwise quietly find nothing for `cancelled`. A word that is no status is passed through unchanged, so the backend refuses it with its own message. Not taken: accepting abbreviations or partial matches (`cancel`, `prog`), which could pick the wrong transition.

## rev 123 (2026-10-23)

**TAI-589 (Story TAI-588): `init run` offers a Claude Code allow rule.** Found in a real target project, 2026-10-19: a Claude Code session in auto mode had its TAI CLI writes judged one by one by the auto-mode classifier, so 47 `page link` calls went through and 5 identical ones were denied, and a routine clean-up stalled; on 2026-10-20 a read-only `pr-ready` failed twice on a transient classifier error and stopped a session. `init run` now ends by offering, in a terminal only, on each run until accepted, to add a narrow allow rule to the project's `.claude/settings.local.json`. It covers `issue` and `page` and the read-only `ready`, `pr-ready`, `work`, `verify` and `git-pr review-prep`/`comments`/`render-findings`, each bare and with every persona id spelled out after `--as`, and never `git-pr merge`, `git-pr review`, `init` or anything else. The rules are shown first and written only on a yes; an existing file keeps every other setting and rule, a second run adds nothing, and a file that is not valid JSON is left alone. The README and setup checklist explain why, and how to remove it. Found in the review of PR 8: an `--as *` form would also match `--as x git-pr merge … issue …` (Claude Code's `*` spans words), so the persona ids are spelled out, and a test applies a glob matcher to merge and review commands. Not taken: writing the rule into the committed `settings.json` (it names this machine's TAI path), adding the Atlassian MCP link-removal tool to the rule (an `issue unlink` command is TAI-608 instead), and making the offer a recorded init step. Split out of the same Story: `issue unlink` (TAI-608) and accepting `Cancelled` for `Canceled` (TAI-610).

## rev 122 (2026-10-22)

**TAI-606 (Story TAI-605): the design-without-dev backstop is cheaper, covers `UxDesign` and can be dismissed.** Found in the review of PR 5. `findDesignWithoutDev` read each Done design subtask's parent one at a time on every PM `/tai-ready`, so its cost followed the project's whole design history; it now makes one search for the open Stories and Bugs and matches parents from it (three searches, plus one per Epic that needs a sibling check). `UxDesign` is covered, since the UX Designer is told to create the follow-on `Dev` too. A design subtask whose first comment line is `No Dev needed: <reason>` is dismissed and never listed, for design work with no implementation by design (a decision-only ADR). Not taken: a dismissal on the Story (it would hide a later, real design subtask on it), and listing dismissable items outside the numbered actions.

## rev 121 (2026-10-22)

**TAI-602 (Story TAI-601): design work that ends leaves a ticket for what comes next.** Found in a real target project, 2026-10-22: the DBA finished and approved the schema notes, but the migrations had no ticket, and `/tai-ready` (which reads tickets only, and never Backlog) showed nothing to do. The rule, confirmed by the human: anyone who knows a task is needed creates it in the same turn, with the persona set, no human assignee and real `Blocks`/`Relates` links, so the PM sees it in grooming; status follows TAI-292 (To Do when a Story holds it and it is fully actionable, or when someone is blocked on a decision; Backlog when it has no home yet). It is in `workflows/dependencies.md` and in the `Database`, `ArchitectureDesign`, `UxDesign` and Analyst persona docs, with a `Subtask:Dev` (Analyst: `Subtask:Requirements`) `create` grant for it. As a backstop, `/tai-ready` lists a Done `Database` or `ArchitectureDesign` subtask on an open Story with no `Dev` under its Story or Epic as "Design done, nothing implements it" in the PM's list, and `/tai-audit` gains the `design-without-dev` check, both from `findDesignWithoutDev`. Not taken: auto-creating the ticket (where the work goes is the PM's call), and flagging design work on a Story that is already Done (history, it would nag forever).

## rev 120 (2026-10-22)

**TAI-604 (Bug TAI-603): `page loose` and the `loose-pages` audit skip Confluence's template pages.** Found by running `page loose` on a real target project's space (TAI-597): Confluence's own blueprint pages ("Template - How-to guide", "Template - Troubleshooting article") sit under the home page and were listed as loose on every space. `looseRootPages` now ignores a page whose title starts with "Template - ". The same entry corrects rev 119's note that `/tai-retro` still nested under the epic's page.

## rev 119 (2026-10-22)

**TAI-598 (Story TAI-597): Confluence pages are filed by doc type, in code.** Found in a real target project, 2026-10-22: the DBA wrote six schema-notes pages and a summary at the root of the Confluence space; they were moved into a folder by hand. The brief already said pages are organized by doc-type folder, but nothing enforced it: `page create` took an optional `parent=`, no table mapped a persona's output type to a folder, and the folder names were whatever the model made up. Human decisions, 2026-10-22: a `page create` with neither `type=` nor `parent=` is refused (an explicit `parent=` stays as the override), and the canonical folder names are the ones that project already used, plus an architecture folder. `src/core/storage/doc-folders.ts` holds the table, and a test fails when a persona declares an output type the table lacks. `page create type=<output-type>` finds or creates the folder in the space; `page file` moves an existing loose page into its folder; `DocStore.listRootPages` and `page loose` list the pages left at a space's root; and `/tai-audit` gains a `loose-pages` check (its check count is now derived from its list). Every persona that writes pages is told to pass `type=`, and the Analyst no longer nests its work-breakdown under the Kickoff Story. `project-home` is not filed, since it is the space's own Overview page. Not taken: warning and creating the page anyway, one folder per output type, and rewriting page titles to the `<KEY> — <Doc Type>: …` convention at create time. Found by the live conformance run (TAI-600), 2026-10-22: Confluence puts a page created with no parent under the space home page, so the top of a space's tree is the home page's children, not pages with no parent. `listRootPages` first used `depth=root`, which returns only the home page and would have made `page loose` find nothing in a real space; on Confluence it now lists the home page's children (the home page itself is never listed), and `PageSummary` carries no dates, which that endpoint does not return. `/tai-retro`'s page is now output type `retro-notes`, filed under Work Breakdowns and Refinement and not under the epic's page (found in the review of PR 3).

## rev 118 (2026-10-17)

**TAI-584 (Story TAI-581): a GitHub git-host backend.** TAI's own development is moving to a public GitHub repo, with Bitbucket kept private as an archive, and only a Bitbucket backend existed. Human decisions, 2026-10-17 (TAI-583 ADR, page 58753025): a project names its host with `TAI_GIT_HOST`, written by `init run` from `origin`'s remote, and an unset value reads `origin` and then falls back to Bitbucket, so existing projects are unchanged; reviewers are mapped by a GitHub login in a GitHub column on the "PR Reviewers" page; the token is `GITHUB_TOKEN`, and the current human's email comes from `TAI_JIRA_EMAIL`; and a solo developer may opt in to a recorded self-review (`TAI_PR_SELF_REVIEW=true`), since GitHub refuses an author's own approval. The new backend lives in `src/core/git/github/`; one factory (`core/git/host-factory.ts`) replaces the direct Bitbucket construction in every command; GitHub remotes, GitHub PR URLs, `init github` and the check command's environment (no `GITHUB_TOKEN`/`GH_TOKEN`) follow. Found in the live test (TAI-585), human decision 2026-10-19: fine-grained GitHub tokens cannot read check runs (there is no Checks permission for them), so when check runs are refused the commit's GitHub Actions workflow runs are read instead, with the Actions: read permission; CI that cannot be read at all is an error, never skipped. Also found live and fixed: `git-pr merge` now passes the commit the gate checked (`GitHost.mergePullRequest`'s new `expectedHead`), and the GitHub backend refuses the merge when the branch has moved, since GitHub reports a PR's new head a few seconds after a push; on GitHub, `/tai-ready` no longer offers a human their own PR for review unless `TAI_PR_SELF_REVIEW` is on; and the git-pr review and comment lines name the acting account, not just the email. Not taken: zero required approvals or a mandatory second account for a solo developer, detecting the host from `origin` on every run, treating every collaborator as a reviewer, a `TAI_GITHUB_TOKEN` name, requiring a classic token, and reading only Actions runs.

## rev 117 (2026-10-16)

**TAI-576 (Story TAI-575): `git-pr comment-findings` and `review` refuse findings that were never rendered.** Found live, 2026-10-14: a reviewer session ended with "reply with a number" without showing the findings list, and the findings went on to be posted. Human decision, 2026-10-16: `render-findings` records a hash of what it rendered for the PR (kept with the review manifest in this clone); `comment-findings` refuses unless the findings it is asked to post hash the same; `git-pr review` refuses once `review-prep` has run for the PR here until findings were rendered, and does not block a human who never ran `review-prep` and only decides; a new `review-prep` run clears the record. `review-prep` and `render-findings` each end with a one-line reminder to show the list as chat text and stop. The guard cannot tell whether the list was actually shown; the reminder is for that. Not taken: refusing a decision with no manifest at all (it would block a review done outside TAI), and any bypass flag.

## rev 116 (2026-10-16)

**TAI-574 (Bug TAI-556): `/tai-groom`'s `NEEDS CLARIFICATION` warning says how to clear a mere mention.** Found grooming TAI-447, 2026-10-14: its description said "real gaps as NEEDS CLARIFICATION" in two checklist items, and the readiness warning counted them as open questions. Human decision, 2026-10-16: keep the shared matcher, which the Kickoff review gate also uses (a code span is already ignored, so a ticket that only describes the convention wraps the phrase in backticks), and change only the groom warning to say so, plus Perry's grooming text and the brief. Not taken: counting a marker only at the start of a line, which would stop a real mid-line marker such as `PRD §4: NEEDS CLARIFICATION: ...` from blocking the Kickoff gate, and a missed real marker is worse than a false warning.

## rev 115 (2026-10-16)

**TAI-573 (Bug TAI-562): `/tai-retro` no longer reads a repo's whole merged-PR history.** Found in the review of PR 203: `retro` listed every merged PR and filtered by date afterwards, so the cost grew with the repo's age even for the default 30-day window. `GitHost.listPullRequests` now takes an optional `{ updatedSince }`; the Bitbucket host then asks for `sort=-updated_on` and stops paging at the first page that reaches a PR older than that, returning only the newer ones. Without the option nothing changes (same query, same results). On the real repo the last three days cost 2 requests for 16 PRs, where listing all 208 merged PRs costs 21. `retro` passes its window's start for open and merged lists. Not taken: the same bound for `/tai-ready`'s own open-PR reads (it needs every open PR).

## rev 114 (2026-10-16)

**TAI-570 (Story TAI-569): `/tai-ready` lists a "Ready to close" section for verified Stories and Bugs.** Found live, 2026-10-15, trying `/tai-change`: TAI-469, TAI-473, TAI-491, TAI-492, TAI-563 and TAI-564 sat under In Progress only because nobody had closed them, so the section mixed work in flight with tickets waiting for a human. A Story or Bug whose latest verification comment is `Verified:` and which has at least one subtask, all of them Done or Canceled, now has its own numbered section after "Ready to verify", with the first line of that comment on its line; picking it shows the comment in full, then closes the ticket (the pick is the instruction). A later `Not verified:` takes it back out. One shared function (`findReadyToClose`). Epics, Kickoff Stories and Spikes are never listed, and the bare `/tai-pr` list does not have it. Not taken: closing automatically (a human closes, as before).

## rev 113 (2026-10-15)

**TAI-572 (Story TAI-571): the `/tai-change` briefing has shorter lines.** Found live, 2026-10-15, on the first real `/tai-change` run: pasting the board as chat text gave very long lines, mostly 240-character description excerpts, and the old epics carried long descriptions that say nothing about a change to their children. Excerpts are now 100 characters, an epic shows none, and the skill pastes the briefing only down to its `---` line, so Perry's closing instruction paragraph is no longer shown to the human. The briefing is about a fifth smaller on the real board. Not taken: grouping tickets under their epic (a larger restructure; see how this reads first).

## rev 112 (2026-10-15)

**TAI-568 (Bug TAI-567): the `/tai-ready` In Progress section is headed "In Progress".** Found live, 2026-10-15, trying `/tai-change`: the old heading, "In Progress — resume this", put a singular "this" over a plural list, and "resume" says nothing the status does not (and is misleading for a verified Story that is only waiting to be closed, which TAI-569 handles). The skill text and tests say the same. The brief did not quote the heading.

## rev 111 (2026-10-15)

**TAI-559 (Story TAI-492): `/tai-change` is built; correct-course is no longer declined.** Human decision, 2026-10-08 (TAI-461), scope settled 2026-10-14. Adapted from BMAD's `correct-course`: the human says what changed and Perry works out which open tickets and pages it touches and proposes one batch (cancel, reword, new tickets, pages to revise), applied only after confirmation, except new Backlog tickets and links. The command is read-only. Linked pages appear as titles and page ids only; descriptions are cut and a long board abbreviated, with a notice. The icebox rule is now one function shared with `/tai-groom`. A plain-language request starts it through the skill description and the project pointer. Not taken: a pointer line telling any session to apply the batch without asking; page bodies in the briefing (too large a board). Item 26 of the brief's open list is fully resolved.

## rev 110 (2026-10-15)

**TAI-566 (Story TAI-564): `/tai-ready` and `/tai-pr` list approved PRs that are waiting, with what the merge gate still needs.** Found live with TAI-563, 2026-10-15: PR 204 was approved but absent from "ready to merge", and the answer was "the gate probably needs something". A new show-only section, "Approved PRs waiting on something", follows "ready to merge": an open PR with an approval on any commit that the gate holds, with the gate's own sentences (so the list and `git-pr merge`'s refusal cannot disagree). A PR with no approval is in neither section, and one that passes the gate but has red or missing CI stays out of this one, as before. Picking a waiting line shows what it waits on; it never merges.

## rev 109 (2026-10-15)

**TAI-565 (Bug TAI-563): `/tai-ready` and `/tai-pr` list a PR for re-review when the reviewer's decision predates its latest commit.** Found live, 2026-10-15: PR 204 had an approval, then two more commits, and `/tai-pr` answered "Nothing ready for you right now". The review list counted a reviewer as decided from the host's status alone, and Bitbucket keeps an approval and a request for changes across new commits. It now reads the PR's history, as the merge gate does: a decision made on an earlier commit puts the PR back on the list, marked as a re-review of the new commit; one with no decision of the reviewer's in the history counts as not shown fresh, the merge gate's own rule. A stale request for changes is included, because the author's fix commits do not clear it. The line gives the old and the new commit and the `git diff` between them, and a history that cannot be read lists the PR with a note instead of failing the whole section.

## rev 108 (2026-10-14)

**TAI-560 (Story TAI-473): a light lane for very small changes, `issue create-small`.** Human decision, 2026-10-14 (from the 2026-10-07 review, Confluence page 53608449 section 6, where the quick lane was "a policy choice more than a build"). One command makes a Story or Bug with its `Dev` subtask, assigned and in To Do; only the ticket setup shrinks. It requires an `AC-1` line, makes no other subtask, and exempts nothing from review or the merge gate (a test checks that). Entry point: the `/tai-small` skill, typed by the human, so the call to use the lane is theirs (no pointer line telling any session to use it on its own). The size limit is a convention in the persona docs, not code. Not taken: a description-length cap (crude, and size is not mechanically checkable).

## rev 107 (2026-10-14)

**TAI-558 (Story TAI-491): `/tai-retro` is built; the brief's earlier decline of a retrospective is reversed.** Human decision, 2026-10-08 (TAI-461), scope settled 2026-10-14. Lessons had been landing in a private memory folder and many brief revisions were course corrections found live. It is on demand and read-only: a briefing of five signals for a window, then Perry asks questions, writes a retro page and files action items, with TAI lessons filed apart. The default window is the last 30 days; "since the last retro page" was left out because pages cannot be searched by title. Correct-course (`/tai-change`) is still not built, so item 26 is split.

## rev 106 (2026-10-14)

**TAI-557 (Story TAI-469): `/tai-pr` runs the review in a fresh-context subagent in Claude Code.** Human decision, 2026-10-14, scoping TAI-469 (from the 2026-10-07 review, Confluence page 53608449 section 6): a review should not come from the session that wrote the code. The subagent follows `review-prep` through the findings file and never posts; the main session renders the findings and stops for the human. Gemini CLI is unchanged, a human can still ask for an inline review, and a different-model setting is left out of scope.

## rev 105 (2026-10-14)

**TAI-531: the `humanSignOffDefault` key and the persona files' `alwaysHumanGated` lists are removed.** Human decision, 2026-10-14, raised in the review of PR 186: autocompletion was retired in TAI-482, so the key was the switch for a mechanism that no longer exists, and the code reads the schema's own always-human-gated list, not the persona files'. Removed from every persona file, the config parser, `PersonaCheckpoints` and the `mergePersonaConfig` protection; `cannotApprove` stays protected exactly as before. A persona file, override or extension page that still carries either key loads without error and the key is never read. Not taken: keeping the protection as a guard against the key returning with a meaning (the guard would be unreachable code; a returning key can bring its own check). Persona files whose `checkpoints` block held only the key lost the block.

## rev 104 (2026-10-14)

**TAI-552: `/tai-groom` leaves out a parked (`icebox`-labelled) epic and everything under it.** Human decision, 2026-10-14, after the grooming briefing listed every Backlog ticket under the Icebox epic (TAI-370) and buried the real promotion candidates. The label goes on the epic only, so any epic can be parked even with Stories already under it, and a new ticket under it needs no tag. With no epic key every section skips the epic and the Backlog tickets under it (children and their subtasks), and the briefing says what was left out; a ticket under it that has moved to To Do or later is still listed, so started work is never hidden from the board view, and a non-epic ticket carrying the label gets a warning instead of silence (human decision, 2026-10-14, after asking what a mistaken label or assignment would do); `/tai-groom <EPIC-KEY>` for a parked epic lists it as usual. Not taken: an `icebox` label on each ticket (a forgotten tag leaks it back in), an Icebox status (changes the Jira workflow and the shared Status enum), and reusing Jira's Flag (it means an external impediment and would put the epic in section 4). `/tai-ready` is unchanged: parked work sits in Backlog, which it does not offer. `pm.md` item 8 and the `tai-groom` skill text updated; the global skills need reinstalling. Brief §3.8.

## rev 103 (2026-10-14)

**TAI-550: `/tai-groom` lists Stories and Bugs ready to verify.** Human decision, 2026-10-14: the grooming briefing is the board-wide view, so what waits for `/tai-verify` shows there too, not only in `/tai-ready`. A new section 9 after the existing eight (their numbering is unchanged) lists each In Progress Story or Bug whose Dev subtasks are all Done and which has no `Verified:` / `Not verified:` comment, with `/tai-verify <KEY>` as the next step; with an epic key it lists that epic's tickets only. Perry names the step and does not verify. The set comes from one function, `findNotVerified` (`storage/verification.ts`), now also used by `/tai-ready`, so the two lists cannot disagree. Not taken: placing it earlier in the list (renumbering section 8), and including Stories whose latest comment is `Not verified:`. `pm.md` item 9 and the `tai-groom` skill text updated; the global skills need reinstalling.

## rev 102 (2026-10-14)

**TAI-548: `/tai-ready` offers "Ready to verify" as a numbered action.** Human decision, 2026-10-14, after picking the "not verified" Story's number ran `/tai-work` as the PM, who had nothing to do, and the human had to type `/tai-verify` by hand. A new numbered section "Ready to verify" lists each In Progress Story or Bug in the existing `notVerified` set, on the shared counter and absent when empty; its number means `/tai-verify <KEY>`, which loads Tessa. The Story still appears under In Progress, where the long warning shrinks to a "⚠️ not verified" marker. The `tai-ready` skill text maps the new section, and the global skills need reinstalling. No new reads; show-only. Brief §3.9, setup checklist.

## rev 101 (2026-10-14)

**TAI-500: the briefing, `/tai-ready` and `/tai-groom` show whether a sign-off was made through the TAI CLI or directly.** Built on TAI-475's stamp, show-only, with these decisions by the human on 2026-10-14. Covered: the Kickoff `Approved:` comments and the closes of UAT, EpicReview, DesignReview and Epic. A pure classifier (`storage/sign-off-provenance.ts`) reads the comments already on the ticket: a stamped `Approved:` comment, or the stamped `Sign-off:` companion comment, is "through the TAI CLI"; a Done ticket without one is "directly"; anything not yet signed off says so. A Kickoff lists each approval and counts as direct unless every one is stamped. A hand-typed `Sign-off:` line without the stamp does not count. The `/tai-work` briefing shows the line on the ticket and its parent; `/tai-ready` and `/tai-groom` add it to an open row only once something is signed off, since they list open work and, by decision, read no extra tickets (a closed sign-off sits on a Done ticket they never load). Not taken: PR approvals (a Bitbucket read per PR for little gain, the stamped comment is on the PR itself), and widening groom's per-epic read to include Done subtasks. Brief §4.

## rev 100 (2026-10-13)

**TAI-468: `verify` checks a Story's finished work against its acceptance criteria.** Shape agreed 2026-10-08, with these decisions by the human on 2026-10-13. `Dev` is Done when its PR merges and nothing compared the result with what the Story asked for. A new read-only `verify <STORY-KEY>` command (and `/tai-verify` skill) loads Tessa with the Story's numbered `AC-n` criteria and the diff of every Dev PR on it, open or merged (a merged one found through its merge commit; a PR merged by squash or fast-forward is reported as having no diff), adapted from the GSD verifier: assume each criterion unmet until the code proves it that it exists, is real and is wired. She posts one stamped comment on the Story starting `Verified:` or `Not verified:` with a verdict and evidence per criterion. It is show-only: `/tai-ready` marks an In Progress Story or Bug whose Dev subtasks are all Done and which has no such comment "not verified"; `issue transition <KEY> Done` on a Story or Bug with none prints a warning; neither blocks anything. A later Dev commit does not invalidate an earlier comment. No new subtask type. Brief §3.9; `tester.md` item 6.

## rev 99 (2026-10-13)

**TAI-472: grooming's promotion section checks readiness, and acceptance criteria are numbered.** Human decisions on 2026-10-13, on top of the shape agreed 2026-10-08. `/tai-groom`'s section 3 had listed only Backlog tickets that carried a `depends-on` link with every blocker done, so a Story with no links, which is most of them, was never offered for promotion or checked. It now lists every Backlog ticket with no open blocker: a Story, Bug or Spike with or without links, and a subtask only when its links show it was unblocked. Each Story, Bug or Spike row carries readiness warnings, never a block: no numbered acceptance criteria, a `NEEDS CLARIFICATION` marker in the description, no `Dev` subtask (a Spike is not asked), no issue link and no linked page. Acceptance criteria are description lines starting `AC-1`, `AC-2`, …, the numbering TAI-468's verification will cite. The move from Backlog to To Do stays a soft convention (§8 item 28). The brief's description-writing rule, §5 and `pm.md` say so; the grooming skill text names the new section title. Existing tickets have no `AC-n` lines, so each warns until it is edited.

## rev 98 (2026-10-13)

**TAI-541: the findings check notes a review that searched nothing, and a claim with no how.** After TAI-538 added a prompt step telling reviewers to search the whole PR branch for the old form of anything a change removes or renames, a Gemini review of PR 191 still ran no branch search (one grep on the diff file) and listed claims that restated the PR description, while a Claude review of the same PR ran `git grep` and found two stale comments. Decided by the human (2026-10-13): a loud note in the rendered review, not a refusal. `coverageNotes` adds a line when `commandsRun` lists no `git grep`, `git ls-tree`, `git log -S/-G`, or `git show <ref>:<path>` of a file the PR did not change, and a line counting `claimsVerified` entries with no dash or colon before the how. The check reads the command text, so it catches a review that ran no search, not a pointless one. The brief's review paragraph, `code-reviewer.md` and `review-prep`'s step and findings shape updated.

## rev 97 (2026-10-13)

**TAI-490: the status file and its `/tai-ready` label are removed; the journal is only the offline write queue's storage.** Human decision TAI-460. Nothing ever wrote a per-item `status.json`, and the root rollup was never called, so `/tai-ready`'s "local session history here" note could not appear: every In Progress line said "no local history — started elsewhere, read fresh", which was misleading. Deleted `workspace/status.ts` and its test, the two `status.json` path helpers and the label (code, `tai-ready` skill text). `journal.md` stays, described only as where queued writes are kept; a later session resumes from the ticket's `Handoff:` comment (§3.9, TAI-489). Brief §3.6 and §7 and §8 items 10 and 14 reworded; `analyst.md` and `developer.md` no longer tell the persona to read journal history. Existing `.tai/` folders may hold a `status.json` or journal entries from tests; they are ignored.

## rev 96 (2026-10-09)

**TAI-534: a recorded local check before a merge.** Nothing ran the test suite on a PR in this repo: the automatic pipeline triggers had been removed to stay inside the 50 build-minute monthly quota, and the merge gate's CI rule passes when no status exists. Decided by the human (ADR Confluence page 55672833): a new `git-pr check` runs the project's `TAI_CHECK_COMMAND` on the PR's head commit, from a clean working tree at that commit, and records the outcome as a commit status naming who ran it and where; when a check command is configured the merge gate and `readyToMerge` require a status on the current commit, a missing one being overridable with `force=true` and a failed one never; the author runs it, when the PR is ready and after each push. `GitHost` gains `createCommitStatus`. Not taken: a pipeline run per PR, running the check at PR creation, and counting only a reviewer's run. Brief §5.4. From review of the PR: the tree is read again after the command and nothing is recorded if tracked files changed or the head moved; the command runs without TAI's own settings (`TAI_*`, `BITBUCKET_*`), so the PR's code does not see TAI's credentials and a suite is not switched to live systems by them; the user is looked up before the run and a result that cannot be posted is still printed; the whole sequence is one function (`performLocalCheck`) with its own tests.

## rev 95 (2026-10-09)

**TAI-527: a review must show what it read and ran.** About ten PRs in a row had come back from review with no issues found; two side-by-side comparisons showed a second reviewer finding real issues from the same output. Decided by the human (ADR Confluence page 55640065): the findings JSON gains a required `coverage` block and a `reviewOf` block, checked by `render-findings` and `comment-findings`, with a cross-check against the PR's changed files and a line on an empty review of a large diff; `review-prep` writes the complete diff to a file under `.tai/review/`, prints the CI result for the commit under review, and puts the author's description last, labelled as claims to verify. Not taken: an unenforced coverage statement, a built-in worktree check command, hiding the description, and trimming the persona section to fit the diff inline. A findings file in the old format is refused until it has the two new blocks. Added in review: a posted review says when the PR's head has moved since it was prepared, an approval is refused when `review-prep` last ran for an older commit, and the brief no longer states as general fact that CI runs the suite (this repo runs none on a PR). Brief §3.8.

## rev 94 (2026-10-09)

**TAI-482: autocompletion, `Complete:` markers and the `blocked-external` label are retired.** Human decision TAI-455, rows 8 and 9; the human chose on 2026-10-09 to delete the module as well. Autocompletion was designed (TAI-41 ADR) and built as a standalone module (`storage/autocompletion.ts`, TAI-43) that nothing ever called; the module and its test are deleted. §3.4 is now "Human Sign-off": a human signs off work and nothing completes itself. §8 items 9, 22 and 23 read "retired". The "never autocompletes" wording is gone from the persona files, the workflow docs and code comments; the three human-gated subtask types are unchanged. The `blocked-external` label, which was never applied by any code, is out of §3.3. §3.4 as it read before is in the appendix at the end of this file.

## rev 93 (2026-10-09)

**TAI-481: an edit to an approved page is shown and reopens nothing.** Human decision TAI-455, row 7. The brief, `workflows/kickoff.md` and `personas/architect.md` said that editing a page behind a passed gate reopens the gate and requires re-approval; no code ever did that. `/tai-ready` and `/tai-groom` now list, as information, every page linked to a Done Kickoff Story that was updated after that Kickoff's latest `Approved:` comment, while the Kickoff's Epic is open. Nothing is blocked. The docs say so, and the brief's cross-references to a "gate-reopening rule" are reworded. Brief §3.9, §4, §5.4, §6.

## rev 92 (2026-10-09)

**TAI-480: the Kickoff gate reads `NEEDS CLARIFICATION` markers.** Human decision TAI-455, row 6. The docs had said since rev 23 that the gate is mechanically blocked by an unresolved marker, and no code read one. `transition()` on both backends now reads every page linked to the Kickoff Story when it is moved to Done and refuses while a marker remains, naming the page and the question. A marker inside code formatting does not count. `workflows/kickoff.md` says how it is checked; the conformance suite covers it.

## rev 91 (2026-10-09)

**TAI-479: `issue create` notes a subtask type that its parent's type does not list.** Human decision TAI-455, row 5: warn, do not block. `STORY_SUBTASK_MAP` was read by nothing; `issue create` now compares a new subtask's type with the entry for its parent's type and prints a note naming the listed types, creating the ticket regardless. A subtask created directly under an Epic or another subtask gets a note too (added in review). `workflows/kickoff.md` and `workflows/spike.md` said an outside type is "flagged on the next refresh", which was never built; they now say what happens. Brief §5.2.

## rev 90 (2026-10-09)

**TAI-478: the persona grants match the persona docs, and a mismatch is visible.** Human decision TAI-455 (rows 1 and 2). Perry's `complete` grant gains Spike, Kickoff, Story and Bug (she could not close a Spike under her own list; Epic stays out, since closing one is the human's decision). DevOps loses its `gitHost: mergePullRequest` grant: whoever owns the Dev subtask merges (TAI-456). The per-field `update` grants are deleted from all nine persona files and from the code; most named fields that do not exist. `issue create` and a transition to Done now print a note, without refusing, when the acting persona has no `create` or `complete` grant for the type. A Cancel does not trigger the note. Brief §3.1 and §4.

## rev 89 (2026-10-09)

**TAI-522: a review is of the PR's code, whatever the reviewer's clone has checked out.** Found on 2026-10-09 when PR 180 was reviewed from a clone 28 commits behind: the diff was right, the files on disk were not, and the rules file was missing. Decided by the human (ADR Confluence page 55246849): `review-prep` tells the reviewer to read surrounding files from the fetched PR branch and says whether the working tree is at the PR's head; it runs the same safe fast-forward of the local default branch as `/tai-work`; it reads `project-context.md` from the destination branch on origin; and every persona turn prints one line when the TAI install is not on its default branch. Not taken: fast-forward alone, reading the rules from the PR's own branch, a separate clone for the install, and checking out the PR for the reviewer. Brief §3.8.

## rev 88 (2026-10-09)

**TAI-520: the brief's body carries no revision labels.** The "rev N" labels left in §3.1 to §3.6, §3.8, §3.9, §5.2, §5.4 to §5.6, §6, §8, §10 and §11 are removed (human decision 2026-10-09), together with ticket labels that were provenance; ADR references and the Backlog-ticket pointers on open §8 items stay. Sentences that narrated a resolution are rewritten as current fact, and the passages that were reworded, as they read before, are in the appendix at the end of this file. A test now fails when the brief's body cites a revision. Stale statements corrected on the way: §3.4 pointed at Epics TAI-6 and TAI-8 for a call site that was never built; §6 still listed a per-repo dev → review → merge/deploy subtask chain.

## rev 87 (2026-10-09)

**TAI-512: brief sections 3.7, 4, 5.3 and 7 state current fact.** The "resolved (rev N)", "refined (rev N)" and "supersedes" narration is out of those four sections, along with their revision and ticket labels; the text as it read before is in the appendix at the end of this file. No rule changed. Stale statements corrected on the way: §3.7 and §4 still used candidate type names (`Design`, `Develop`, `Code Review`, Research/Implementation story types); §4 described a per-repo dev → review → merge/deploy subtask chain and an AI retry loop for `DesignReview`; §7 said the trigger for the root status rollup was still to be wired, when `/tai-ready` computes work in flight live and nothing calls `rollupStatus()`; §7 described the bulk sync without saying no command runs it.

## rev 86 (2026-10-09)

**TAI-516: `init` tells a project about `project-context.md` and can start one.** `init status` ends with a line saying whether the file is present, missing, or still an unfilled template. A new action, `init project-context`, writes a starter template (stack, commands, conventions, never) and never overwrites a file. The template begins with a marker line, and a file that still carries it is not printed to personas. It covers projects that were onboarded before TAI-470 and new projects with no code; a project with code gets its first draft from the mapping Spike (TAI-471). The file stays optional and is not an init step. Brief §4.

## rev 85 (2026-10-09)

**TAI-471: a brownfield project is mapped before discovery.** `/tai-kickoff`'s briefing gains an "Existing code" section, computed from the repo's tracked files and the project's Spikes. With code and no map, Perry creates a Spike, "Map the existing system", with a `Feasibility` subtask owned by the Architect, and the Kickoff depends on it; on a project that already has Epics she asks the human first. The Architect's output is the Architecture Overview page and a first draft of `project-context.md` (TAI-470), delivered as a PR. Existing ticket types, no schema change (shape agreed 2026-10-08). Adapted from GSD's `map-codebase` and BMAD's `document-project`. Brief §4, `workflows/kickoff.md`, `personas/pm.md` item 1, `personas/architect.md` item 7.

## rev 84 (2026-10-09)

**TAI-470: a project-context file in the target repo, put in front of every persona.** `project-context.md` at the target project's root holds its build and test commands, stack, conventions and things never to do. `work`, `groom`, `kickoff` and `git-pr review-prep` print it between the persona's instructions and the briefing, under its own size cap (`TAI_PROJECT_CONTEXT_BUDGET`, default 6,000 characters). It lives in the repo, not Confluence, so it is versioned with the code and reviewed in PRs (shape agreed 2026-10-08; the 2026-10-07 review had proposed a Config-folder page). Adapted from the Spec Kit constitution and BMAD's `project-context.md`. This repo has its own. Brief §4.

## rev 83 (2026-10-09)

**TAI-488: personas can find the workflow docs from a target project.** Persona docs say "see `workflows/story.md`", a path that resolves only inside the TAI checkout. `/tai-work`'s output now names the absolute path of the workflow doc for the ticket's type (a subtask uses its parent's) and of `dependencies.md`, and every loaded persona prompt ends with where the relative paths it cites are, which also covers `/tai-groom`, `/tai-kickoff` and the review flow. The docs are read on demand and not inlined (human decision TAI-459, point 4). Brief §3.1.

## rev 82 (2026-10-09)

**TAI-487: each persona doc is two files.** `src/personas/<id>.md` is the run-time prompt, rewritten as current fact with no revision or ticket references; `src/personas/rationale/<id>.md` holds the history and is not loaded (human decision TAI-459, amended to two files). The nine prompts went from 142 KB to 117 KB in total. A test fails when a prompt cites a revision or a ticket, and another warns, without failing, past a 12 KB soft target; analyst, architect and pm are still over it. Brief §3.1 states the split.

## rev 81 (2026-10-09)

**Epic TAI-452: follow-ups from the 2026-10-07 framework review (Confluence page 53608449).** These changes edited the brief in place without a revision entry of their own.

- TAI-464: the work briefing carries a state line per ticket, remote links, the last 10 comments and a character budget; ticket and page text is marked as data.
- TAI-489: the `Handoff:` comment marker (§3.9), one current hand-off comment per ticket.
- TAI-462: the merge gate (§5.4): fresh approvals, no standing request-changes, test tiers Done, green CI; `force=true` leaves a stamped override.
- TAI-475/TAI-504: stamped CLI comments and `Sign-off:` comments; descriptions and comments written for reading (§4).
- TAI-483: one verify-then-merge sequence opens §5.4.
- TAI-484: Epic decomposition per rev 70, Kickoff front-loading by Perry, nothing dispatches work (§3.7, §3.8, glossary).
- TAI-485: `DesignReview` is inherently human-gated; self-review separation reworded; `Requirements` allowed on a Story (§3.3, §4, §5.2).
- TAI-507: the merge gate requires `UAT` Done unless the subtask carries `uat-after-merge` (§5.4).
- TAI-486: this file. The revision log left the brief, resolved §8 items were collapsed to one line each, and superseded passages in the body were removed.

## rev 80 (2026-10-07)

**TAI-348/450: `/tai-kickoff` — the entry point for project initiation.** A
seventh global skill (Claude Code and Gemini CLI), backed by a read-only `kickoff [INITIATIVE]` command, loads Perry
with her Project initiation behavior and a short briefing of the Epics and Kickoff Stories that already exist, so
she dedups before creating. It needs no ticket and works on any project (a second initiative included), not only a
fresh one. It closes the one gap where a persona's only entry point was a plain-language request, and replaces the
"ask your assistant to act as Perry" fallback in `/tai-ready` and `/tai-init`. Rejected: `/tai-work` with no key
(changes its contract) and folding it into `/tai-groom`.

## rev 79

**TAI-443: a Kickoff can record a deliberately skipped subtask type.** A
first-line `Skipped: <type>[, <type>] — <reason>` comment on a Kickoff Story (new §3.9 marker) silences that type in
`/tai-ready`'s "Subtasks ready to create" hint. Perry or a human may add one with no confirmation gate (reversible;
it only silences a hint); re-read on every call, never cached. Kickoff Stories only.

## rev 78

**TAI-425/428: `git-pr review-prep` — the review flow loads the Code
Reviewer through the CLI.** A read-only command, `git-pr review-prep <REPO> [PR-ID]` (no issue key), is now the
entry point of `/tai-pr`'s review flow, the way `work` and `groom` load their personas: it refuses up front if the
acting human is not on the "PR Reviewers" roster, then prints Cole's own instructions (`loadPersonaConfig`, so a
team's extension applies) under a `# Persona: Cole (code-reviewer)` heading, the PR's details and linked ticket,
the review steps for THIS PR (findings JSON schema, `render-findings` then stop-and-wait, the numbered options,
the exact `comment-findings`/`review` commands) and the diff, last. The steps moved out of the skill body into
code so there is one copy and they sit in the output the session just read (the TAI-423 class of failure). The
diff is local git as before (no GitHost change); the whole output is budgeted (`OUTPUT_BUDGET`, 24,000 characters)
with the diff last and a visible "DIFF NOT SHOWN IN FULL" edge listing the exact per-file (or 300-line-chunk)
commands. Self-review is a note, never a block (§4, open item 8.3). ADR Confluence page 52559873 (rev 2).

## rev 77

**TAI-389/395: `/tai-groom` — backlog grooming with Perry.** A sixth
global skill (Claude Code and Gemini CLI) loads Perry with a computed, read-only briefing of the board and
needs no ticket (`groom [EPIC-KEY]`; the optional epic key narrows every section to that epic). It
deliberately **reverses the 2026-08-25 "TAI builds no planning command" decision**: the recurring planning
meeting stays the human's own cadence, and this is what Perry brings to it. Eight numbered sections: epics
with nothing under them, Backlog Kickoff Stories awaiting sequencing, Backlog tickets whose depends-on blockers
are all done (promotion candidates), flagged tickets in every open status, approved epics with nothing
scheduled, Backlog tickets untouched past `TAI_STALE_BACKLOG_DAYS` (default 60), tickets TAI cannot read
(unmapped Jira type) and tickets that need an assignee (the TAI-416 ranked list). **Authority:** Perry creates
Backlog tickets, depends-on links and phase labels on her own; every Backlog → To Do move, epic approval
(scheduling a first wave counts), flag/unflag, Cancel and assignment is proposed as a batch and applied only
after the human confirms. Each session she also reconciles the work-breakdown document's Epic table with the
board by reading, not by parser; the document wins. **A human-gated item** (DesignReview, EpicReview, UAT) moves
to To Do the moment its last blocker finishes, by the persona that finished it (new §4 bullet; every persona
doc points at it). Sections (d) and (f) filter in memory over an exhaustive read of the open tickets.
ADR Confluence page 48463873 (rev 5).

## rev 76

**TAI-389/394: Perry may create `Kickoff` and every live subtask
type, `SpikeTask` included.** Found in the DesignReview of the grooming ADR (Confluence page 48463873, now
rev 5): `personas/pm.md`'s `create` grant omitted `Kickoff` (which she already creates per Epic) and covered
only five subtask types, contradicting the ADR's "tasks already known". Human decision: if the PM knows a
task is needed she should be able to create it. This aligns the grant with the TAI-83 rule that any persona
may create any subtask once it has real, in-context judgment that it is needed (not blind pre-population);
the owner stays the type's fixed persona, a `SpikeTask` still needs its persona named (TAI-409), everything
she creates lands in Backlog, and the retired `CodeReview` stays out. A test pins the grant.
`workflows/kickoff.md`'s "Perry never creates `EpicReview`" is now scoped to the initial Kickoff moment.
`TAI_STALE_BACKLOG_DAYS` is documented in `.env.example`.

## rev 75

**TAI-416/419: ranked assignee suggestions with reasons.**
With 2 or more humans on a persona and nobody named, `issue create` now makes the ticket UNASSIGNED and
prints a ranked list (the session's human pinned first, "leave unassigned" always a choice) instead of
silently assigning the session's human; the create-time rev 54 shortcut is removed, the claim and
transition-time one stays. A named person (`assignee=`) always wins. The order is strict tiers —
continuity (same Story, a linked ticket, the same Epic; a Bug's Dev), then area knowledge from ticket
data (Done tickets with the same Component/labels within `TAI_AREA_WINDOW_DAYS`, default 90), then
open-ticket count — every line with its reason, and the author of work under review demoted, never
excluded. `IssueFilter` gains `component` and `labels`; a new `issue suggest <KEY>`, a `/tai-ready`
"needs an assignee" suggestion, and the transition-gate rejection all use the same ranking, computed
live and never stored. ADR Confluence page 50692097 (human-decided, 2026-10-05).

## rev 74

**TAI-407/409: the documented persona defaults are now
real.** Nothing in the code applied them: a bare create left the persona empty for every ticket
type, and `issue create` resolves an assignee only when a persona is set. Now an omitted persona
falls back to `SUBTASK_OWNER[type]` for a subtask and PM for every story-level ticket and Epic —
a shared pure `defaultPersonaFor`, called by `issue create` BEFORE assignment and applied by
`WorkTracker.createIssue` on both backends (an explicit `persona=` always wins). Only `SpikeTask`
has no default: the session asks the human which persona before creating it, and a create that
still ends persona-less is made anyway (a ticket is never lost) with a loud warning naming
`issue update <KEY> persona=`. Human-decided on TAI-408.

## rev 73

**TAI-397/400: session learnings that lived only in private
memory are now stated in TAI's own docs.** A new §4 bullet records how personas write Confluence
page content (one unwrapped line per paragraph/bullet, sequential list numbers, the `content=$(cat
file)` quoting rule); the authoring personas point at it; Ada's and Aria's real-links principle
also covers linking a doc to the parent Story; the setup checklist and `/tai-init` skill say a
Gemini CLI session needs a full restart to pick up refreshed skills and explain the `TA`/`TAI`
Confluence space alias; `CLAUDE.md` says to use the TAIT scratch project for throwaway tickets.
No behavior change.

## rev 72

**TAI-390: `flagged` is a first-class `Issue` field on
both backends.** Work waiting on something external with no ticket is marked with Jira's Flag
(impediment), read and set through `Issue.flagged`/`IssuePatch.flagged` (`issue update <KEY>
flagged=true|false`): the Jira backend finds the "Flagged" custom field BY NAME like the Persona
field (a site without one degrades — reads omit it, a set/clear is rejected with a clear
message), the filesystem backend stores a boolean. `issue get`/`search`/`update` show a
"🚩 flagged" marker; `/tai-ready` is hybrid — a flagged `To Do` item leaves Ready Work for a
numbered "On hold (flagged)" section, a flagged `In Progress` item stays put with the marker
(human-decided on TAI-390, TAI-389 ADR decision 8).

## rev 71

**TAI-374/387: Epics are created as they are agreed
(early Epic shells), fleshed out in Backlog, and scheduled by Perry; `To Do` now cascades
upward and a Kickoff Story never moves its Epic.** Human-directed, ADR Confluence page
47349832 (rev 4). The serial project-level Kickoff left every agreed Epic invisible on the
board until EpicReview, Requirements/UX and the review gate had all finished. Now: Ada creates
each Epic as a **Backlog shell** as it is agreed during EpicReview (a narrow `create: Epic`
grant; the shell IS the proposal) and records its Jira key in the work-breakdown doc in the
same step (the doc stays canonical, with a Jira-key index column). Perry — not Ada — gives
every Epic its per-Epic Kickoff Story and the Stories/tasks already known, in Backlog, during
grooming; an Epic is not left empty. **Epic status now describes readiness:** `Backlog` =
proposed and being fleshed out, `To Do` = fleshed out and approved to build (its Kickoff
passed its PM+UX gate and a human agreed; the persona asks first — convention, no code gate),
`In Progress` = building. An Epic's Stories do NOT all move to `To Do` with it: Perry
schedules a first wave and leaves later phases / blocked / externally-waiting work in Backlog.
The shared cascade gate (`cascade-gate.ts`, `upwardCascadeTarget`) changes accordingly: a
**Kickoff Story starting work, or being scheduled, never moves its parent Epic**; every other
child still does, and a **subtask reaching `To Do` now schedules its Backlog parent, which
schedules its Backlog Epic** (new upward To Do cascade; only a Backlog parent moves).
Scheduling a first-wave non-Kickoff Story therefore also approves a Backlog Epic, so Perry
asks the human first. Rev 28's sentence below ("`In Progress` is derived … any child that has
left Backlog") was never what the code did (the cascade fires on `In Progress`/`In Review`
only) and is rewritten. The Kickoff review gate is clarified, not changed: it governs the
project-level Kickoff Story's own Done transition and the Stories/Spikes spawned from it;
Epic shells and per-Epic Kickoffs sit outside it.

## rev 70

**TAI-354: Kickoff gains a mandatory,
human-gated `EpicReview` step — Ada's proposed Epic breakdown is probed with the
human, epic by epic, not rubber-stamped.** Found live on the same stress-test of a real target project as
revs 67–69: after Ada's `Research` subtask produced the work-breakdown doc (proposing
that project's Epic breakdown) and was marked Done, the very next thing surfaced as ready to
work was a Kickoff-subtask-level `ArchitectureDesign` deep-dive (rev 69's own
mechanism) — with no step in between where the human actually discussed the proposed
breakdown itself. The only mechanically enforced Kickoff checkpoint (the PM+UX
Designer Review Gate, rev 11) converges the PRD/UX-flow *artifacts*, not the epic
list; nothing stopped deeper subtasks from being created and surfaced before that
big-picture conversation happened. Human-confirmed: reading the Confluence doc and
clicking "looks good, approve" isn't rigorous enough on its own — real probing, epic
by epic, catches issues a rubber-stamp read misses.

Fixed: added a new, mandatory `EpicReview` subtask to Kickoff (`story-schema.ts`),
sitting between `Research` and `Requirements`/`UxDesign` in the precedence graph
(`Research` no longer unblocks either directly). Owned by Analyst, but registered in
`ALWAYS_HUMAN_GATED_SUBTASKS` — same mechanism as `UAT` (`personas/tester.md`): Ada
drives the actual discussion, going through the proposed breakdown one epic at a time
and revising the *same* work-breakdown doc in place, but only a human stakeholder can
transition the subtask to Done — no `Approved:` comment convention, the transition
itself is the signal. Deliberately a *different* gate from the existing PM+UX Kickoff
Review Gate: that one converges PRD/UX-flow content once it exists; `EpicReview` is
upstream of both, settling the epic/Story shape itself before PRD/UX work is built
against it.

**Generalized to every Epic decomposition, not just the initial project-level
Kickoff (human direction, discussed live):** `personas/pm.md` item 5 ("Epic
decomposition, invoked directly on an existing Epic") previously had Perry decompose
an Epic into Stories solo, no separate proposal required. Since Epics can't hold
subtasks in TAI's schema, the human's own proposed resolution was adopted over
extending that schema: **every Epic that needs decomposing gets its own Kickoff-type
Story** — the same container the project-level bootstrap uses, just scoped to one
Epic — reusing the `Research` → `EpicReview` → optional `Requirements`/`UxDesign`
sequence above rather than inventing a second mechanism for the narrower pass.

New Jira sub-task issue type `EpicReview` provisioned on both TAI's and a target project's Jira
projects (brief §5.2's "one native sub-task issue type per `SubtaskType`"
convention). `analyst.md` gained a new item 3 (renumbering items 3–6 to 4–7) plus
`create`/`workOn`/`alwaysHumanGated` grants — deliberately excluded from `complete`,
mirroring `tester.md`'s UAT exclusion; `pm.md` item 5 rewritten; `workflows/kickoff.md`
gained the `EpicReview` gate section and updated precedence/output/status-transition
text. Five new tests (`story-schema.test.ts`, `autocompletion.test.ts`) lock down the
new precedence edges and `hard` checkpoint classification; 758/758 passing, `tsc
--noEmit` clean.

## rev 69

**TAI-353: Ada creates `ArchitectureDesign`
herself when she recognizes the need, instead of leaving it as an unticketed
question.** Found live on the same second target project, same day as rev 68: Ada,
doing Kickoff-adjacent discussion-prep research, surfaced a genuine design trade-off
(a hierarchy-representation decision) and explicitly named "the Architect-level
conversation this doc was built to ground" as the next step — but never created a
ticket for it. `analyst.md` item 5 already had the general TAI-83 mechanic for Ada
creating `Investigate` herself (rev 57/TAI-317); it just never got generalized to
`ArchitectureDesign`, even though it's a valid Kickoff-level subtask type and her own
analysis showed she'd already formed the real, non-speculative judgment TAI-83
requires. Added the missing `Subtask:ArchitectureDesign` create grant (create only,
not `workOn`/`complete` — ownership stays Architect's, mirroring `pm.md`'s identical
grant), generalized item 5's language to cover both subtask types with the concrete
command, and cross-referenced from item 2 (Kickoff discovery) where the triggering
scenario actually happened.

## rev 68

**TAI-352: Ada's Kickoff discovery now does real
elicitation, and creates the project's Confluence home page.** Found live on the same
second target project: Ada read the project's own pre-existing rough design docs, did
external research, and produced a full Epic decomposition — all without ever having an
actual conversation with the human about purpose, requirements, or scope. Root cause:
`analyst.md` item 2 named "requirements elicitation" as something Ada performs, but
only the *separate* market/competitive/domain research activity had an explicit
opt-in ask-first gate (rev 59) — elicitation itself had no equivalent mandate for when
or how rigorously it happens. Fixed: Ada's first move at Kickoff discovery is now a
real conversation about purpose/requirements/scope, explicit and prior to synthesis.
**New Core principle: pre-existing project docs are a discussion-facilitation device,
not settled input** — human-confirmed nuance: such docs may reflect a prior version of
the project's thinking, not what's actually being built now; Ada reads them first only
to ground good questions, never as a substitute for confirming current intent.
Right-sized output still applies — not a mandate for exhaustive interrogation on every
Kickoff, just that real elicitation happens before analysis is finalized.
Market/competitive/domain research stays a separate, unchanged opt-in gate. Second,
related fix (human direction): Ada's existing Project Home Page capability (TAI-300)
was purely periodic/on-demand with no explicit trigger — a brand-new project's
Confluence space would sit on the default scaffold indefinitely. Now created during
Kickoff discovery itself, the natural first moment enough is known to make it
meaningful; ongoing refresh cadence is unchanged.

## rev 67

**TAI-351: PM's Kickoff subtask-creation
authority fixed — same contradiction shape TAI-317/rev-57 already fixed once, just
missed for Kickoff's `Research`/`UxDesign` case.** Found live setting up a second
target project: Perry created the Epic + Kickoff Story, then explicitly deferred
creating `Research` to a separate Ada invocation — even though her own reasoning had
already named it as needed, and the prior text cited TAI-83 as the rule in the same
sentence that described doing the opposite of it. `personas/pm.md` item 1 now has Perry
create `Research`/`UxDesign` directly once she's judged them needed (both immediately
startable, no precedence blocking either), under the same TAI-83 dedup-search-first
mechanics as item 7's `Investigate`/`ArchitectureDesign` case — new `Subtask:Research`/
`Subtask:UxDesign` create grants added to match. `Requirements` stays different (Perry's
own type, but precedence-blocked behind `Research`, so created naturally at PRD-drafting
time instead); `ArchitectureDesign` stays a later, situational call (judging it this
early would be speculation, not real judgment) — already covered by the existing item 7
language. `personas/analyst.md`/`personas/ux-designer.md`/`workflows/kickoff.md` updated
to match (dedup-search-first fallback if Perry hasn't already created it, same pattern
`analyst.md`'s own `Investigate` handling already uses). One real bug caught in
self-review: the actual `issue create` vocabulary for `UxDesign` is `ux-design`
(hyphenated), not `uxdesign` — a wrong value would have been a TAI-135-class bug
(a command that can't actually run) if shipped uncaught.

## rev 66

**§8 items 35/36 resolved: TAI-283/284 (the
aggregate competitor-comparison Spikes) shipped.** Synthesized from all nine
TAI-6/138-155 persona-review discussions' own competitor research (each turn already
read the relevant BMAD-METHOD/GSD/Spec Kit source directly) rather than a fresh
investigation. TAI-283: per-persona job/scope audit with an explicit like/dislike call
per competitor (Confluence page 41123841). TAI-284: whole-system comparison — where TAI
excels (Jira/Confluence/git-host as the real system of record vs. both competitors'
local-file state; the explicit permission/checkpoint model; the two-axis owner model;
rolling-wave decomposition vs. Spec Kit's rejected clarification cap; structured
git-host-native review findings), where it falls short (adversarial review discipline
was missing until this review effort itself; no AI/LLM-feature-building support,
genuinely out of v1 scope; quality-gate/NFR-assessment depth for testing is a shared
gap, not TAI-specific; heavier ticket-creation ceremony than a single-developer tool,
an honest trade-off not a flaw; the whole review's designs are reasoned but not yet
battle-tested) — and four ranked improvement candidates, the top one being simply to
execute the 14 deferred clean-session test spike-tasks (Confluence page 41156609). Both
Spikes transitioned Done, PM-confirmed Confluence-only outcome per `workflows/spike.md`
— no new Story spawned, since actionable findings already landed persona-by-persona
during the review itself.

## rev 65

**Tessa's (Tester) persona review concludes
(TAI-154/343), the eighth full persona turn under TAI-6/138-155.** Mechanical audit
came back clean (no stale prose, all `confluenceOutputs` described, rev-52/TAI-314/315/
316 test-tier-stays-open behavior consistent across `developer.md`/`story.md`/
`ready.ts`, concrete `cli.ts` invocations already present throughout). TAI-135/TAI-132
also clean. Neither competitor has a dedicated Tester/QA agent to compare Tessa against
directly — BMAD-METHOD's `bmad-qa-generate-e2e-tests` is a lightweight workflow skill
that explicitly defers quality-gate/NFR-assessment depth to a separate heavier "Test
Architect" module rather than building it in (same split-off-the-advanced-stuff pattern
Dana's turn found); GSD has no single Tester agent either, but its `verify-work`
workflow has a genuinely rich, concrete UAT mechanic worth adapting. One design change,
human-confirmed: **Tessa's UAT session gains a concrete interaction mechanic**, adapted
from GSD's `verify-work` — one scenario at a time, states what SHOULD happen and asks
the stakeholder to confirm or describe what's different; a plain yes/empty reply is a
pass, anything else is logged as an issue with severity **inferred from the
stakeholder's own wording, never asked directly** (e.g. "crashes" → blocker, "doesn't
work" → major, "works but slow/weird" → minor, "looks off" → cosmetic; defaults to
major when genuinely unclear). This replaces a previously-vague "authors the scenarios
and drives the session" with an actual described mechanic — the stakeholder's own
UAT sign-off authority (§3.3) and the existing rejected-UAT routing (Developer vs.
PM/Requirements) are both unchanged; this only concretizes *how* Tessa runs a session
she already owned driving.

## rev 64

**Cole's (Code Reviewer) persona review concludes
(TAI-153/341), the seventh full persona turn under TAI-6/138-155.** Unlike Dario's/
Dana's clean turns, the mechanical audit found two real, concrete bugs — both fixed:
- **Stale `confluenceOutputs` front-matter in `code-reviewer.md` itself.** Still
  declared `review-notes` as a Confluence output type, contradicting the body's own
  rev-52 (TAI-159 ADR) rewrite, which routes review notes to a real PR comment via
  `comment-findings`, never Confluence — the rev-52 rewrite (TAI-160) updated the rest
  of the file but missed this one block. Fixed: `confluenceOutputs: []`, with a comment
  explaining why.
- **Three stale "not yet built" annotations in this brief** (§5.4, §8 item 20), all
  describing the same rev-52/TAI-159 CodeReview-retirement redesign as unimplemented —
  it has actually been fully live in code since TAI-160 shipped (`ready.ts`'s
  `readyToReview`/`readyToTest`/`readyToMerge`, `cli.ts`'s `git-pr review`,
  `git/pr-reviewers.ts`). 11 revs stale (52→63); missed by TAI-171/177's earlier
  doc-staleness pass, which touched `story.md`/`bug.md`/`dependencies.md` but not this
  file. Fixed: reworded to "Implemented (rev 52, TAI-160)".

TAI-135/TAI-132's failure modes both came back clean (concrete `cli.ts` commands already
present; cross-references in `developer.md`/`story.md`/`pm.md` already consistent with
rev 52).

One design change, human-confirmed after comparing against competitors: **Cole gains an
explicit adversarial default stance.** Both BMAD-METHOD's `bmad-code-review` (parallel
Blind Hunter/Edge Case Hunter/Acceptance Auditor layers) and GSD's `gsd-code-reviewer`
("FORCE stance: assume every submitted implementation contains defects," named
anti-patterns for going soft) independently converge on this — Cole's prior framing was
neutral/collaborative ("verify... is sound") with no explicit instruction to resist the
pull toward rubber-stamping. New Core principle: assumes the diff has a defect until
traced through and ruled out; names concrete anti-patterns to resist (stopping at
surface issues, treating passing tests/compiling as evidence of correctness, softening a
finding's `severity` to avoid seeming harsh).

## rev 63

**Dana's (DBA) persona review concludes
(TAI-152/338), the sixth full persona turn under TAI-6/138-155.** Mechanical audit
came back clean again (no stale prose, all `confluenceOutputs` described, concrete
`cli.ts` invocations already present in Handoff). Unlike every prior turn, neither
competitor has a DBA equivalent to compare against — BMAD-METHOD folds database/schema/
migration decisions into a one-time Architecture solutioning pass with no specialized
reviewer; GSD has no dedicated agent either. Decisions instead came from real DBA
practice. Four changes:
- **Reversibility stated as explicitly as compatibility — two different axes.**
  Compatibility is whether old application code still works against the new schema;
  reversibility is whether the migration itself can be undone. A change can be one
  without the other (backwards-compatible but irreversible is a common, non-
  contradictory shape, e.g. a destructive backfill). Dana now states both, flagging the
  exact point past which rollback isn't possible, feeding `personas/devops.md`'s
  rollback runbook (already non-optional there) with information it previously had no
  guaranteed source for.
- **Blocking vs. parallel sharpened from "judgment call" into a concrete default**:
  backwards-compatible → parallel by default (old and new code both work against it);
  backwards-incompatible → blocks, because it structurally needs the expand-contract
  sequence (add → backfill → cut over → drop), which `Dev` must be sequenced against.
  Stated as a default, not an absolute — Dana still states her reasoning since deploy
  topology can change what "parallel" means.
- **New costed-option-package discipline for schema forks tied to unstated future
  business direction** — **more ownership than Aria's/Uma's version of this same brief
  §4 pattern:** rather than just flagging the fork, Dana proposes each realistic option
  with its cost/effort now vs. the cost/risk of retrofitting later, plus a stated lean —
  schema mistakes are unusually expensive to unwind compared to most code, which is why
  this turn's version goes further than Architect's/UX Designer's own "notices and
  routes" versions. The decision itself still isn't Dana's call (stays PM's/the human's,
  same as elsewhere) — only the depth of the analysis she hands over differs. Same
  TAI-83 mechanic as Aria's version to get it to PM (new `Subtask:Requirements` create
  grant, mirroring `architect.md`).
- **Closes the file's own dangling "DBA vs. data-engineering split" open item** — filed
  as a real Backlog Story (**TAI-337**) instead of left as prose. Explicitly deferred,
  not decided: only becomes real once a target project has enough analytics/pipeline
  surface to be a genuinely distinct workload, beyond TAI v1's current priority.
**Brief §4 itself sharpened** (peripheral awareness): future-direction/extensibility
noticing isn't limited to whatever's the explicit topic of the current ask — a persona
looking at a broader artifact (schema, decomposition, architecture) scans adjacent parts
of that same artifact already in view for the same costly-to-change-later risk, not just
the piece directly asked about. Applies to every future-direction-aware persona (Ada,
Aria, Uma, now Dana), not Dana-only — same right-sizing instinct as the rest of that
bullet, not a mandate to go auditing unrelated parts of the system.
This is the first review turn where Dana's Dev subtask needed the gitHost-permission-gap
workaround (persona reassigned to `pm`, TAI-317/TAI-324 precedent) — DBA has never held
`gitHost`.

## rev 62

**Dario's (Developer) persona review concludes
(TAI-151/334), the fifth full persona turn under TAI-6/138-155.** All changes landed
persona-local in `personas/developer.md` — no brief-level promotion needed. Mechanical
audit against the three recurring bug classes plus TAI-135/TAI-132's failure modes came
back clean this time (no stale prose found, unlike the first four turns) — the review
instead compared Dario directly against BMAD-METHOD's Amelia (dev-story workflow) and
GSD's `gsd-executor`. Four changes:
- **Unit-tests-are-part-of-Dev reworked to explicit red→green→refactor ordering**: write
  the failing test first, write minimal code to pass, refactor while keeping tests green
  — adopted from BMAD's Amelia, who mandates the same ordering.
- **New deviation-handling discipline for mid-implementation discovery**: a small,
  contained issue (in-reach, no new dependency) gets fixed inline and noted in
  implementation notes, whether it's a bug in the code being touched or a correctness/
  security gap the change needs to actually work. A bigger issue outside the current
  Story/Bug's actual scope doesn't get silently fixed (scope creep) or silently dropped —
  Dario drafts a Bug proposal and hands it to PM to confirm/create, reusing
  `workflows/bug.md`'s Resolved D7 PostDeploy-minor propose-then-PM-confirms mechanic
  rather than inventing new machinery. The structural backstop against scope quietly
  growing isn't this discipline alone — Cole's existing "reviews against the spec, not
  personal style preference" principle already catches anything that made it into the
  diff without being traceable to scope. Adapted from GSD's Rule-1/2/3 auto-fix vs.
  Rule-4 ask-for-architectural-changes taxonomy, simplified to fit TAI's own Bug-ticket
  vocabulary rather than importing GSD's separate deferred-items.md mechanism.
- **New never-adds-a-new-package-dependency-unilaterally gate**: flags a needed library
  the spec didn't call for to the human before adding it, naming realistic alternatives
  and a stated lean — the same alternatives-first discipline TAI-107 established for
  Architect — rather than just asking "can I add X?" The human decides, including
  whether to have that conversation with Architect out-of-band first. Adapted from
  BMAD's Amelia, who halts for user approval before any dependency beyond the story's
  own spec.
- **New 3-consecutive-failed-attempts stuck-approach rule**: after 3 failed attempts at
  making an approach work, Dario stops, documents what was tried and why it didn't work,
  and either raises a `SpikeTask` or asks the human directly. Explicitly distinct from
  the brief's own retry-once-then-escalate rule for a failed *checkpoint* (§4/§5.4) — a
  different kind of failure, not a contradicting number. Adapted from both competitors
  (BMAD: 3 consecutive implementation failures → HALT; GSD: 3 auto-fix attempts → stop
  and document).
**Future-direction/extensibility awareness (brief §4) was explicitly considered and
declined for Dario** — he doesn't decide product scope or architecture, and the new
dependency-gate and out-of-scope-discovery mechanics above already route anything with
real future-direction weight up to Architect or the human rather than Dario deciding it
himself. No permission-block changes — the Bug-propose mechanic reuses the existing
PM-confirms pattern (same as DevOps in the PostDeploy precedent) rather than granting
Dario a new `create` right, and this is the first persona turn that didn't need the
gitHost-permission-gap workaround (TAI-324/331 both did) — Dario already holds `gitHost`
from TAI-33/34 (createPullRequest) and TAI-159/rev 52 (mergePullRequest).
Competitor research this session: BMAD-METHOD's Amelia (`bmad-agent-dev`/`bmad-dev-story`
skills) and GSD's `gsd-executor` agent, read directly — feeds TAI-283/284.

## rev 61

**Uma's (UX Designer) persona review concludes
(TAI-150/331), the fourth full persona turn under TAI-6/138-155.** All changes landed
persona-local in `personas/ux-designer.md`; §3.7's shared elicitation-escalation posture
gains a third confirmed instance (no new brief-level mechanics needed, since Uma's version
is the same shape PM's/Ada's already established). Four changes:
- **New Design System capability** (living doc, may be scoped): establishes the project's
  baseline visual-identity/design-token reference (Brand & Style, Colors, Typography,
  Layout & Spacing, Elevation & Depth, Shapes, Components, Do's and Don'ts), assessed
  against the target project's real shape the same way Architect's Architecture Overview
  is (include/reframe/N/A-with-reason). Adapted from BMAD-METHOD's DESIGN.md/EXPERIENCE.md
  split — Uma's existing `ux-flow`/`story-ux-detail` outputs already covered the
  EXPERIENCE (behavior) side; `design-system` is the new DESIGN (visual identity) side.
  Deliberately **not** forced into a single global doc the way Architecture Overview/
  Project Home Page are — a genuinely distinct sub-area (e.g. an admin section with its
  own deliberately different look) gets its own scoped doc that links to and states what
  it overrides from its parent; this actually restores the framework's own *default*
  multi-instance granularity (brief §4 rev 11) rather than importing the "one per project"
  exception. First checks for a business-supplied design-system extension before creating
  her own. Genuine undeclared drift is a conflict, resolved via the same TAI-83
  dedup-search-then-comment-or-subtask mechanic Architect's altitude-inheritance principle
  uses — reused, not reinvented.
- **"Elicits, doesn't impose"** — new Core Principle, same shape as `personas/pm.md`'s
  "Elicitation, not direction": never volunteers a color, pattern, or visual direction
  unprompted, the vision being drawn out is the human's. Shares §3.7's elicitation-
  escalation posture, now confirmed for a third persona.
- **Concern-scan broadened**: the old "empty/error/loading states" check widens into a
  fuller UX-carrying-concerns scan (accessibility, i18n, dark mode, offline, input
  modalities, notifications, …), adapted from BMAD's concern-scan list, inferred from
  context rather than force-applied to every screen (same right-sizing instinct as Ada's
  ambiguity-coverage checklist).
- **Surface closure** — new completeness bar, adapted from BMAD's IA-closure test: every
  stated need has a surface, every surface has a journey; when closure fails, probe, never
  invent. Same role Aria's load-bearing bar and Ada's ambiguity checklist play for their
  own personas.
**Future-direction/extensibility awareness (brief §4) was explicitly considered and
declined for Uma** — her own new surface-closure bar and the design-system parent/child
override pattern already give her a way to flag "this assumes single-item only" without a
separate mechanic, and the brief already frames this as a scope/requirements question that
stays Ada's/Perry's call, not something UX flow work should re-raise on its own. One real
stale-wording bug caught and fixed pre-review: the Extension point section still said
"missing-state discipline" after the underlying principle was renamed/broadened.
Competitor research this session: BMAD-METHOD's Sally (UX Designer) skill and GSD's
UI-phase workflow/UI-SPEC template, read directly — feeds TAI-283/284.

## rev 60

**Aria's (Architect) persona review concludes
(TAI-149/328), the third full persona turn under TAI-6/138-155.** Closes the
future-direction-awareness thread §4/rev 59 explicitly reserved for Architect: her own
version fires only during Kickoff-early or Story-level `ArchitectureDesign` (not
Feasibility's time-box, not the WBS batch scan), she asks the human directly rather than
routing through PM/Ada, and the answer dual-records — grounding context in her own ADR,
plus a `Requirements` subtask handed to PM (TAI-83 exception, since the PRD isn't her own
output type) for the Future Considerations entry. Also resolves §3.7's other open
parenthetical (Architect + rolling-wave for system-level design): a Kickoff/Epic-level
`ArchitectureDesign` is her "full shape now" pass, and each Story's own
`ArchitectureDesign` inherits its decisions as **binding, read-only constraints** rather
than re-deciding them — a real conflict escalates to the human, never a silent override
(adapted from BMAD-METHOD's architecture-spine altitude-inheritance model). Three more
changes landed persona-local, no brief promotion needed: a concrete "is this actually
load-bearing" bar for when a design decision earns `ArchitectureDesign`/`Feasibility` at
all (adapted from BMAD's architecture-spine test), principle TAI-107 sharpened to require
showing alternatives + a stated lean rather than just posing an open question, and a new
"investigates before deciding" brownfield instinct (read the real code/conventions first,
don't invent fresh ones) — relevant since TAI is brownfield for anyone dogfooding it.
**§8 gets one stale-gap fix** (item 33: "Architect-owned architectural overview doc" was
still marked open in the brief's own prose — and misnamed the persona "Dario" instead of
"Aria" — even though its tracking ticket, TAI-281, was already closed Done back on
2026-09-04 once TAI-307's `architect.md` Architecture Overview section shipped; the brief
entry itself was never updated to match, caught during this session's own read) and
**one new deferred item** (item 38: scaling
`DesignReview`'s gate depth to stakes, BMAD-style multi-lens review — explicitly punted to
v2/v3, **see TAI-327**, Story, Backlog). Competitor research this session reused the prior
session's BMAD-METHOD/Spec Kit clones (Winston the Architect's `customize.toml` and
`bmad-architecture` skill; Spec Kit's `plan` command/constitution-check gate) — read
directly again, feeding TAI-283/284.

## rev 59

**Ada's (Analyst) persona review concludes
(TAI-147/324), the second full persona turn under TAI-6/138-155.** Two principles
promoted from persona-local to shared, since each now applies to 2+ personas (same
promotion pattern as rev 58's rolling-wave): **§3.7 gains a new "Elicitation escalation
posture" block** — collaborative by default, escalating to direct questions and explicit
pushback on thin answers (an unmeasurable acceptance criterion, an unexamined assumption)
when a conversation isn't converging, calibrated to stakes — generalized from PM's PRD-
drafting posture (rev 58) to any elicitation-heavy persona work. **§4 gains a new
"Future-direction/extensibility awareness" bullet** — during Kickoff discovery,
decomposition, or refinement, a persona notices when the current scope touches a
genuinely costly-to-change-later decision and surfaces it as a scope/requirements
question (never an implementation choice — that stays the Architect's), inferring which
areas are probe-worthy from context rather than a fixed keyword table, asking the human
when unsure whether it's worth raising at all. Reserved for Analyst/Architect's own
reviews per rev 57/58's handoff note; Ada's mechanics land first, Aria's (Architect)
still to come. `personas/analyst.md` updated with both plus two Ada-specific additions
that didn't need brief promotion: research-on-demand (ask if/how much external research
to do, generalized beyond Kickoff, light source-noting, no new doc type) and a structured
ambiguity-coverage checklist for `Investigate` refinement (adapted from Spec Kit's
`clarify` taxonomy, right-sized to scope). Competitor research this session: BMAD-
METHOD's Deep Recon/Product Brief skills and Spec Kit's specify/clarify commands, cloned
and read directly (feeds TAI-283/284).

## rev 58

**§3.7 gains a new "Rolling-wave decomposition
depth: 'done' vs. 'done enough'" principle (TAI-147/148), the first concrete output of a
dedicated persona-by-persona review (TAI-6/138-155).** For a large Epic, decomposition
creates the full set of next-level shells immediately (visible shape end to end) but only
takes a subset to full depth right now — whatever the real dependency/readiness graph
shows as unblocked, not a fixed lookahead count TAI can't calibrate to a team's actual
capacity. Explicit pull-forward stays available (same posture as TAI-83's Eager Subtask
Creation), and a shallow item already known to need a refinement pass gets that subtask
created now too, parked in `Backlog` for visibility. No new status machinery — this is an
application of the existing `Backlog`/`To Do` split (TAI-292) as a deliberate
decomposition-depth strategy, previously undescribed as such. `personas/pm.md` (items
4/5) and `personas/analyst.md` (item 4) both updated to the concrete mechanics.

## rev 57

**§8 item 13 fully resolved (TAI-317): subtask-
creation authority for `Investigate`/`ArchitectureDesign` now follows the general TAI-83
"Eager Subtask Creation" exception (`workflows/dependencies.md`) like every other subtask
type — no more type-specific carve-out.** `analyst.md`/`pm.md` previously said "regardless
of who flags it, the Analyst always creates `Investigate`," directly contradicting
TAI-83's own general rule (already referenced in `pm.md` item 1) that any persona active
on a Story/Bug with real in-context judgment may create any subtask type. Found live
twice on 2026-09-04 (TAI-280/300, TAI-281) — the human directed PM to create both
directly, then flagged the inconsistency for a dedicated persona-review session.
Resolved by dropping the carve-out: `analyst.md` item 5 and `pm.md` item 7 now let PM (or
Architect/Dev, mid-flight) create the subtask directly under the same dedup-search-first,
owner-still-Analyst mechanics every other TAI-83 case uses; `pm.md` gains explicit
`Subtask:Investigate`/`Subtask:ArchitectureDesign` `create` grants as the evidenced
cases, matching `developer.md`'s existing pattern for its own TAI-83 grants.
**§4 also gains a new principle: persona-produced artifacts/output types must be
designed to generalize to whatever future target project TAI manages, not left
TAI-specific** — raised live during TAI-307's architecture-overview-doc scoping;
`analyst.md`'s Project Home Page and `architect.md`'s Architecture Overview (both already
written this way) now cross-reference it as the standard to apply when scoping any new
output type. Both changes are documentation-only; no code changes.

## rev 56

**§8/`personas/pm.md`: the "flagged-live idea
becomes a real Backlog ticket" convention gets written down for the first time
(TAI-286).** Rev 55 (immediately below) captured seven open questions and, separately,
created real Backlog tickets for them (TAI-279-285) — following the same shape already
established by TAI-115/189/230, but that shape had never actually been documented
anywhere a persona is instructed to follow it (confirmed live: zero hits grepping every
`src/personas/*.md`/`src/workflows/*.md` file for the pattern). Human-flagged gap,
fixed same-session: `personas/pm.md` gains a new Core Principle — "Captures genuinely
open ideas as real Backlog tickets, not just brief prose or conversation-only notes" —
and §8's own preamble now states its scope explicitly: genuinely undecided DESIGN
questions stay here, anything scoped enough to investigate or build gets a real Jira
Story/Spike, backlinked from its §8 entry. Formalizes existing practice; no behavior
changes as a result.

## rev 55

**§8: seven new open questions captured live from
a human notes dump, none resolved here.** Priority-value alias mapping alongside TAI-116/
179's issue-type-only alias work (§8 item 31); an Analyst-owned Confluence project "home"
page and an Architect-owned architectural-overview doc, both flagged as possible new
skills with undecided content/cadence (§8 items 32-33); keeping local `master`/`main`
fresh across multiple machines/checkouts — distinct from §8 item 8's worktree-swap design
and TAI-115's deferred worktree-concurrency Story (§8 item 34); a systematic per-persona
job/scope audit against GSD/BMAD-METHOD/Spec Kit's equivalent roles, and a follow-on
overall TAI-vs-competition comparison — both sized as a real investigation, not a brief
edit (§8 items 35-36); and extending the existing git-host out-of-band-human-edit posture
(§6/TAI-34 — "a human acting directly is authoritative, not fought, detected on next
refresh") to direct Jira/Confluence edits, named as PM/Analyst's biggest exposure (§8
item 37). An eighth note — "link real tickets/docs, not just text" — was NOT added here;
it's already the `missing-links` check in `tai-audit` (TAI-254 ADR), so it's a sweep to
run, not a new question. Captured verbatim per items 1/28/29's "flag live, don't design
on the spot" posture.

## rev 54

**§5.5: the multi-candidate assignment-helper gains
a current-user shortcut — the driving session's own human is auto-assigned when they're
among 2+ Persona Roster candidates, rather than always falling back to asking.** Context:
TAI-244/245 both hit the §5.5 assignment gate live with no automated resolution at all —
brief §5.5's two rules (sole-candidate pre-assign, multi-candidate assignment-helper
fallback) were decided at rev 19 but never actually wired up (TAI-248/249/260). Fixing
that surfaced a real gap in the multi-candidate rule as originally written: it always
falls back to asking, even in the extremely common solo/small-team case where the human
driving the session IS one of the candidates and the answer is obvious. Ratified
live (human-confirmed 2026-08-27, TAI-249 ADR, Confluence page 30572546): auto-assign that
human without asking; only surface the full candidate list (with lightweight load
signals, unchanged) when the current session's human isn't among the candidates, or has
no resolvable session identity at all. Fires at **both** ticket-creation time and the
transition-gate moment (not reactively-only) — implemented as one shared, pure resolver
(`src/core/personas/assignment-helper.ts`) called from `cli.ts`'s `issue create`/
`issue transition` handlers, deliberately NOT from inside `WorkTracker.createIssue` in
either backend (avoids the exact per-backend rule-drift regression `assignment-gate.ts`'s
own header already documents, and keeps session-identity resolution — a host-layer
concern — out of backend internals). A human can always override either way via
`issue assign`, unchanged.

## rev 53

**§5.4: the CI-green merge gate no longer treats a
commit with zero `getCommitStatuses` as failing.** Context: `bitbucket-pipelines.yml`
became a `custom:` (manual-only) pipeline this cycle — no automatic trigger of any kind —
after this project's Bitbucket free-tier 50 build-minute/month quota was hit twice in one
session; `git-pr merge`'s CI-gate was never updated to match, so it rejected every merge
from PR #56 onward (tracked as TAI-230). `isGreen()` (`src/core/commands/git-pr.ts`)
originally read zero statuses as "pipeline never ran, treat as failing" — a deliberate
TAI-107/108 decision from when Pipelines auto-ran on every push, so an empty list was
genuinely suspicious. That assumption is gone: zero statuses is now the ORDINARY case for
every commit unless a human deliberately triggers the manual pipeline. Human-confirmed
live (2026-08-27): a merge must not be held up over a pipeline nobody asked to run.
`isGreen([])` now returns `true`; any status that IS present and non-successful (failed,
in-progress) still blocks, same as before — only the "nobody ran anything" case stopped
gating. Fixed in `git-pr.ts`, `git-pr.test.ts`, and
`bitbucket-git-host.integration.test.ts`'s live assertion (TAI-250, a Dev subtask under
TAI-230's Spike). This also unblocks `readyToMerge` (§5.4/TAI-107-108's own list), which
had been silently empty forever under the old rule once Pipelines went manual. TAI-230
itself stays open for the broader Pipelines-strategy question this was only the
`git-pr merge` half of.

## rev 52

**§5.4/§6: `CodeReview` subtask retired in favor
of git-host-driven review readiness, superseding TAI-34's design.** TAI-157/158/159: a
real, near-term company requirement for N-of-M PR approvals surfaced a structural gap
TAI-34 didn't anticipate — a Jira subtask needs exactly one `Assignee` (§5.5's hard
assignment gate), and there's no honest single assignee for "the" review under a
multi-approver policy. Resolved via TAI-159's ADR (Confluence TA space page 28704769,
supersedes TAI-34's page 13860867 — that page's out-of-band-human-action principle is
kept and extended, not replaced): the `CodeReview` subtask stops being created going
forward (though it stays in the schema permanently — `fromJiraIssueType` deliberately
throws on unrecognized types, and historical Done `CodeReview` tickets exist forever);
`Dev` stays `In Progress` until its PR actually merges, not until the PR opens; and
`tai-ready` gains three live git-host-queried lists (`readyToReview`/`readyToTest`/
`readyToMerge`) replacing the CodeReview-anchored precedence edges, extending TAI-107/
108's existing `readyToMerge` pattern rather than inventing a new one. See §5.4 and §6
for the revised chain, and the TAI-159 ADR for full detail (required-approval-threshold
handling, the new "PR Reviewers" roster, `git-pr create`/`merge` changes). **Built
(TAI-160):** two refinements found live during implementation, both human-confirmed
2026-08-24 — (1) testing runs **in parallel** with review, not gated behind it
(`readyToTest` has no approval-count check at all; only `readyToMerge` does) — protects
`master` without inverting `Deploy`'s existing merge-then-nothing-after ordering; (2)
`git-pr review` is now **roster-gated, not persona-gated** — `git-pr review <REPO>
[PR-ID] <approve|requestChanges> [COMMENT]`, no `<ISSUE-KEY>` at all, since there's no
ticket left whose `persona` field would resolve to Code Reviewer. See §8 item 30 for a
known limitation surfaced along the way (a Story can't host more than one Dev/Test/
Deploy cycle — a follow-up always needs a new Story/Bug).

## rev 51

**§3.8/§9: TAI's own command surface moved to
global skills, no MCP server required.** TAI-116/126, following TAI-90's ADR (Confluence
TA space page 26902529): `tai-work`/`tai-ready`/`tai-pr`/`tai-init` now ship as global
skills — `~/.claude/skills/tai-<name>/SKILL.md` and `~/.gemini/skills/tai-<name>/SKILL.md`
(both hosts use the identical Markdown format for their global mechanism, confirmed by
inspecting the already-installed `sess-resume`/`sess-handoff` skills) — installed once via
`install-global` (`src/hosts/cli.ts`), referencing a fixed install path (`~/.tai-framework/`
by default) rather than a path relative to whatever project the host happens to be running
in. `tai-framework`'s own project-local wrapper files (`.claude/commands/tai-work.md`/
`tai-ready.md`/`tai-pr.md`, `.gemini/commands/tai-work.toml`/`tai-ready.toml`/`tai-pr.toml`)
retired in favor of the same global installs. **Also (TAI-126):** `cli.ts` gained
`issue create|transition|comment|link`/`page create|link` subcommands, wrapping
`WorkTracker`/`DocStore` methods that already existed against direct REST (brief §3.2) —
no Atlassian MCP server is required for TAI to work end-to-end anymore; earlier sessions
used one only because these subcommands didn't exist yet.

## rev 50

**§3.1/§6: PM/Architect granted
`createPullRequest`, plus a Story-first PR title convention.** TAI-112 (found live while
landing standalone documentation-only PRs, PR #18/#21): PM and Architect held zero
`gitHost` grants, so landing framework-governance content (persona docs, this file itself)
meant borrowing an unrelated Dev subtask's key purely to get `createPullRequest`
permission — which then made `git-pr create`'s auto-linker (rev 48/TAI-108) wrongly
attach the new PR to that subtask's real CodeReview sibling. **Decided, after the user
questioned the first proposed fix (a `--no-link` flag) as "hacky":** grant PM/Architect
their own narrow `gitHost: [createPullRequest]` instead — same asymmetry as Tester (rev
48), never paired with `mergePullRequest`. Verified in code this also structurally
prevents the false-linking bug for free: `findCodeReviewSiblingForLink` already bails out
on any key without a `parentKey`, and a Story/Bug/Epic key never has one. **Also decided
in the same pass:** PR titles must be tied to the parent Story/Bug first, subtask second —
checked the 10 PRs preceding this ticket and found neither convention actually followed
consistently (some subtask-keyed, some Story-keyed). New `validatePrTitle` (mirroring
`validateBranchName`'s validate-only posture) requires `<StoryKey> - <SubtaskKey> - ` or,
with no subtask, `<StoryKey> - `. `personas/pm.md`/`architect.md` gained the grant;
`config.test.ts`'s gitHost-grant-matrix test and `.gemini/commands/tai-pr.toml` updated to
match.

## rev 49

**§8 item 29: new open question — a human-
requested review override, raisable at any stage in the chain.** User direction while
TAI-111's review was in flight: at any point (Architect, Analyst, Dev, CodeReview,
DesignReview, ...), someone — most likely a human — should be able to flag a task/Story
as needing human review even when the AI review for that stage already passed. Genuinely
undecided how to track it yet (comment convention vs. label vs. field; how it blocks; who
clears it) — added as an open item, not designed on the spot, matching the new
"ask the human on genuinely open questions" posture (rev 48's own `personas/analyst.md`/
`architect.md` addition) rather than resolving it unilaterally.

## rev 48

**§3.1/§5.4: Tester granted `createPullRequest`,
closing a real gap in the checkpoint chain.** TAI-100 (an IntegrationTest subtask, live):
Tessa hit a `PersonaPermissionError` trying to land her own test code — §5.4's canonical
checkpoint chain (`Dev subtask --opens PR--> CodeReview subtask --approves PR-->
Merge/Deploy subtask --merges PR-->`) only ever named Developer/Code Reviewer/DevOps, and
`IntegrationTest`/`SystemTest`/`E2ETest` sit entirely outside that chain in the
`SUBTASK_PRECEDENCE` graph — nothing gave a Test-tier subtask any way to open its own PR.
User direction: Tester should have PR-creation permission. `personas/tester.md` gained a
`gitHost: [createPullRequest]` grant — deliberately NOT paired with `mergePullRequest`
(no self-merge for Tester; a Tester-opened PR still goes through Code Reviewer like any
other). `config.test.ts`'s gitHost-grant-matrix test updated to match.

## rev 47

**§3.8: command surface standardized on hyphens,
`/tai-work`/`/tai-ready`, not `/tai_work`/`/tai_ready`.** TAI-89: the shipped wrapper
files used an underscore/`tai_` prefix while `git-pr` (a bare `cli.ts` subcommand about
to get its own wrapper via TAI-87) used a bare hyphen — an inconsistent command surface
otherwise. `.claude/commands/tai_work.md`/`tai_ready.md` and `.gemini/commands/
tai_work.toml`/`tai_ready.toml` renamed to `tai-work`/`tai-ready` (including their own
internal prose references to the slash command name); `personas/developer.md` updated
too. Deliberately scoped out: `src/hosts/cli.ts`'s internal subcommand strings (`work`,
`ready`, `git-pr`) and doc-comments in `src/core/commands/work.ts`/`ready.ts` mentioning
`/tai_work` as the slash-command name — not user-facing, out of this Bug's scope.

## rev 46

**§3.1/§5.6: PM now owns `workOn: Kickoff/Story/
Bug`, closing the gap rev 45 left open.** The concrete need rev 45 said to wait for
surfaced immediately: `TAI-89` (a bare Bug, parent `TAI-8`) had no persona permitted to
work it. User direction: "the vast majority of story and bug items will be owned by the
PM or the Analyst — they are the most likely 'orchestrator' types to close story-level
Jira tickets." `personas/pm.md`'s `workOn` grant already carried a comment claiming
Kickoff/Story/Bug were owned "same as Spike" — this was aspirational, not yet true in the
actual list; rev 46 makes the grant match the comment. Analyst was deliberately left
alone (still no `workOn: Story`/`Bug`) — Analyst's role stays subtask-level
(`Subtask:Research`/`Subtask:Investigate`); if a concrete need for Analyst to own a bare
Story/Bug surfaces, grant it then, same "don't build ahead of an observed need" posture
as elsewhere. `TAI-86`/`TAI-88` (Spike, parent TAI-6) still stand to produce a proper ADR
ratifying this — this rev is the fast-tracked code+brief change, not that ADR.

## rev 45

**§3.1: PM (not Architect) owns `workOn: Spike`
— corrects rev 44's wrong assignment.** `workflows/spike.md` — not consulted before rev
44 — is explicit: "PM is the default owner/driver of the Spike story itself, same as
Kickoff/Story/Bug"; subtask-level ownership (`Feasibility`→Architect, `Database`→DBA,
`Infra`→DevOps) is separate and was already correctly granted, no change needed there.
PM scopes the Spike and creates its investigating subtask for that subtask's fixed-owner
persona to actually work; PM then drives the Spike to `Done`/`Canceled` once that
persona proposes an outcome. `Kickoff`/`Story`/`Bug` still have no `workOn` grant
anywhere — the same gap noted in rev 44, still unaddressed, revisit only if a concrete
need surfaces one.

## rev 44

**§3.1: Architect owns `workOn: Spike`** (WRONG, see rev 45) — surfaced
while PM (rev 43) decomposed TAI-8 and needed to create a Spike (design the Gemini CLI
host integration model); reasoned from "who does the investigating work" without
checking `workflows/spike.md`'s already-settled story-vs-subtask ownership split first.

## rev 43

**§3.1/§3.7: PM (not Analyst) owns Epic→Story
decomposition, invoked directly on the Epic.** Surfaced by TAI-8 itself: no persona had
`workOn: Epic`, so no unit-of-work invocation could ever act on one. `Epic` is now
granted to PM's `workOn`, folding the propose/create split into a single PM turn at this
level — PM decomposes the Epic and creates the resulting Stories/Subtasks itself, no
longer waiting on a separate Analyst proposal pass for it. Analyst's `propose: Epic`
still stands for the *project→Epic* level (§3.7's first pass, unaffected); only the
**second, per-Epic pass** changes owner. `personas/pm.md` and `personas/analyst.md`
updated to match.

## rev 42

**§8.10 fully resolved: `rollupStatus()`
fires at the same refresh points §3.6 already defines for per-item caches** — no separate
trigger concept, no dedicated refresh command needed as the primary mechanism. Not
actually blocked on a not-yet-built CLI layer as previously framed — blocked (same as
§8.14/§8.15) on the orchestrator/persona-invocation loop (TAI-8) existing to call it at
those points. **§3.6 also gains a third refresh point: completing a unit of work**, not
just starting/resuming — a persona should refresh before deciding a unit of work is
actually complete, since other in-flight information may bear on that decision.

## rev 41

**§8.14 resolved: Jira comment/label
+ status rollup is sufficient for v1; active push notification is deferred, not
declined.** §3.3's escalation behavior already stops at journaling the rejection and
escalating to a human — that visibility is enough for now. An active push (email/Slack/
Teams) needs infrastructure that doesn't exist yet: no running orchestrator/CLI layer to
trigger from (§8.10's still-open trigger-timing half already flagged this gap for even an
automatic *rescan*), plus new integration config (channel, recipients, credentials) —
materially more than anything else closed so far. Deferred until the orchestrator/
persona-invocation loop (TAI-8) exists and gives a push notification an actual place to
hook in, same treatment as §8.15's learning-loop deferral.

## rev 40

**§8.17 resolved: no formal review
gate for `Investigate` output.** Unlike Kickoff's `REVIEW_GATES[Kickoff]` (a named,
multi-reviewer, story-level gate blocking downstream ticket creation), `Investigate` is
an ordinary subtask that doesn't block anything downstream (§8.13, rev 38) and isn't a
story-level gate — the generic per-subtask checkpoint (§3.4: human sign-off by default,
unless autocompletion-configured) already covers it. No dual-reviewer (PM+Architect)
structure, no unification with the Kickoff gate. **Addendum, raised during discussion:**
when `Investigate` is spawned reactively out of another in-flight subtask (e.g. Dev hits
an ambiguity mid-work), the originating subtask *can* be blocked on it — via the existing
`SubtaskDependencyOverride` ad-hoc-dependency escape hatch (`workflows/dependencies.md`),
not a new mechanism. This is a per-instance judgment call by whoever discovers the need,
same as who flags `Investigate` in the first place (§8.13) — not a change to the static
`SUBTASK_PRECEDENCE` graph, which still has no automatic edge for `Investigate`.

## rev 39

**§8.16 resolved: new-subtask-type
process mirrors §8.1's story-type taxonomy.** `SubtaskType` (`story-schema.ts:87`) is a
compile-time TypeScript enum, and `STORY_SUBTASK_MAP`/`SUBTASK_OWNER` are compile-time
`Record`s keyed off it — adding a genuinely new type is a schema/code edit, not a Jira-side
action, categorically different from `workflows/kickoff.md`'s "Human Overrides" case
(which reuses an *existing* type in a story context that doesn't formally allow it, and
already generalizes across Story/Bug/Spike). A persona (Analyst/Architect) can propose a
new type when a real case doesn't fit the existing list — same propose pattern already
used for Spike outcomes, post-deploy Bugs, and Ada's decomposition — but a human
(developer) always makes the actual schema change. No AI-driven runtime taxonomy
expansion, same "extensible but not self-expanding" posture §8.1 already set for story
types.

## rev 38

**§8.13 resolved (the "ready for
implementation" half): no formal marker or checkpoint.** `Investigate` isn't in
`SUBTASK_PRECEDENCE` at all (`workflows/dependencies.md`'s graph, `workflows/story.md`'s
own "no automatic unblock effect" note) — nothing downstream is structurally gated on it,
so there's no state for a formal "ready" signal to drive. `Investigate` reaching Done is
ordinary subtask completion, same as any other subtask; whichever persona creates the
next subtask (Dev, ArchitectureDesign, etc.) does so on its own judgment of the current
story content, same direct-creation authority §8.11/rev 36 already established. Same
"don't invent a signal without an observed failure" reasoning as rev 29's §8.28 decline —
revisit only if a concrete under-baked-requirements incident actually occurs.

## rev 37

**§8.12 resolved: no fixed decomposition-level
ladder, no `Initiative` tier above Epic.** §3.7 already establishes decomposition as
scope-relative and repeatable rather than a fixed `Project → Epic → Story` count — if a
system needs something above Epic, that's a native-Jira concept a business configures on
its own instance, not a new TAI schema type (no `Initiative` concept exists anywhere else
in the schema). Where the Analyst/Orchestrator stops decomposing is likewise not a
formula — "applicable at whatever scope is handed to it" means a human or the
Orchestrator decides scope per invocation, an inherent judgment call.

## rev 36

**§8.11 resolved: no pre-subtask work phase exists
to give a home to.** Premise declined — a persona creates the subtask as its first
action, before any exploration/brainstorming begins, so journaling/caching always has a
key. Settled alongside it, from discussion: subtask creation is **direct**, gated only by
the creating persona's existing per-issue-type `create` permission (§3.1) — PM may
pre-create a Story's whole known subtask chain, or any persona may create a subtask it
recognizes as needed mid-flight (the existing "present-when-added" pattern). **Story-level
ticket creation is unchanged** — still propose → PM confirms/creates (Spike outcomes,
PostDeploy Bug, Ada's decomposition), not direct. Precedence-link wiring for a
mid-flight-inserted subtask turned out to already be solved in code, not a gap at all:
`workflows/dependencies.md`'s "Dynamic Subtask Insertion" section and
`getNewPrecedenceEdgesForInsertedSubtask()` (`schema/story-schema.ts`) already compute the
new edges automatically — the PostDeploy example there is the exact scenario raised in
discussion. Also corrects a stale cross-reference found along the way: §5.3's rev-27
`Backlog` text pointed to "§7's dynamic-subtask-insertion note," which never existed in
§7 — the actual content is in `workflows/dependencies.md`.

## rev 35

**§8.10 half-resolved: `status.json`'s staleness
rule is neither TTL nor trust-until-mismatch — there isn't one.** `rollupStatus()`
(`src/core/workspace/status.ts`, TAI-56 ADR decision 6) always does a full rescan of
`.tai/work/**/status.json` on demand and overwrites the root file, with no comparison
against `generatedAt` at all — unlike the Jira/Confluence cache, this rollup only reads
local files TAI's own process just wrote, so there's no network cost to gate a skip on.
**Left open:** when a reconciliation scan triggers automatically (session start? every
command? explicit refresh?) — blocked on a CLI/command layer that doesn't exist yet.

## rev 34

**§8.8 resolved: worktree-swap is the default
ticket-switch mechanic, not plain checkout.** §6 already states the reason worktrees were
adopted at all — "so switching between tickets doesn't require stashing dirty state" — and
a plain-checkout default would reintroduce exactly that problem. Design decision only;
no worktree logic exists in `src/core/git/` yet.

## rev 33

**§8.7 resolved by implementation: the storage
interface's operation set already exists in code and is proven identical across
backends.** `src/core/storage/interface.ts`'s `WorkTracker`/`DocStore` cover issue/page
CRUD, the typed `search(filter)` JQL-equivalent, transitions, comments, links, and
attachments — validated by a 710-line conformance suite run against both the filesystem
and Jira backends (Jira `TAI-15`). Jira-specific concepts are kept out by construction:
no raw JQL, no raw custom-field ids (promoted to named typed fields instead), no
backend-specific content encoding (`Page.content` is always markdown). Comment/link
delete and attachment upload don't exist yet — not decided against, just not yet needed.

## rev 32

**§8.5 resolved: "re-triage" on a failed checkpoint
retry isn't a persona judgment call at all — it's deterministic plugin-layer mechanics.**
Where a failed checkpoint's retry goes is already fixed by the workflow's documented
loop-back structure (Dev ⇄ Test, ArchitectureDesign ⇄ DesignReview, UAT rejection
routing, §5.3); whether to retry-vs-escalate is already fixed by the single-retry counter
(§4). Nothing discretionary is left for the Orchestrator persona to "decide" — no
persona-level permission is needed, same enforcement pattern already used for the
Jira-rejected-transition rule (§3.3: enforced once in the storage plugin's `transition`
operation, not per-persona).

## rev 31

**§8.3 resolved: the "persona can't approve its own
work" rule is scoped to the same human, not the same persona role.** Persona role was
never actually a live dimension — every workflow (`workflows/story.md`, etc.) always
routes authored work to a *different* persona role for review (Developer → Code
Reviewer), so "the same persona role approves its own output" can't structurally happen.
The only real way self-approval occurs is the same human filling both roles — the
solo-dev case §4 already named, with the override already sketched at the Code Reviewer
persona level (rev 10 note). No code change needed; existing workflow routing already
handles it.

## rev 30

**§8.27 declined: neither gap it identified turns
out to be real.** Revisiting the two sub-questions left open at rev 26: company/global
docs are dropped from consideration outright — no cross-project scope exists to serve
(this framework's "one Confluence space per Jira project" model, §4, is sufficient as is).
The epic-level catch-all isn't missing either — untyped, non-ticket-tied content already
has a home in the existing **project-level `Config` folder** (§4, rev 13), the same one
that already holds the Persona Roster; nothing new needed for epic-scoped content either.
Both sub-questions collapse to "already covered by existing structure," not "needs a
Spike" as originally guessed.

## rev 29

**§8.28 resolved: `Backlog → To Do` stays a soft,
unenforced convention indefinitely — no hard gate built.** Revisiting the question left
open at rev 27: whether/how the readiness transition should eventually harden. Declined
as premature, per §8 item 1's own "don't build ahead of an observed need" reasoning —
none of the candidate "ready" signals (no unresolved `NEEDS CLARIFICATION`, no unresolved
`Q:` thread, precedence-unblocked) alone captures "a human/process judged this ready,"
and the rev 19 assignment gate earned hard enforcement because it prevented a concrete,
identified failure mode (§5.5) — no equivalent incident has occurred here. Revisit only if
a real "ticket left `Backlog` before it should have" incident happens in practice.

## rev 28

**§5.3 gains an Epic-status policy: `In Progress`
derives from children, `Done` never does.** The moment an Epic has any child that's left
`Backlog`, the Epic itself reads `In Progress` (simple dormant/active signal, not a
percentage rollup). But an Epic is never auto-marked `Done` just because every
currently-decomposed child is `Done`/`Canceled` — that's a false-completion trap given
Epics are open-ended (§3.7's recursive decomposition assumes more Stories can always be
added later; TAI-9's own history is the concrete proof — its GitHub `GitHost` backend
was deferred, so "current children finished" didn't mean "nothing more is coming").
Epic → `Done` is now explicitly a deliberate human judgment call (PM may propose it,
never self-closes it) — same "human sign-off is the default" posture as everywhere else
(§3.4). Applied live: TAI-8 moved to `Backlog` (nothing decomposed under it yet);
TAI-5/6/7/9 moved to `In Progress` (each has `Done` children — real work has happened).

## rev 27

**§5.3 gains a new `Backlog` status, and §8.28
captures the open question it leaves behind.** The user added `Backlog` directly in the
live Jira project — a pre-`To Do` status (native Jira behavior: excluded from the Kanban
board) for tickets that are newly created, under-specified, or otherwise judged not
ready. Resolved: it's now the **default landing status for new tickets** (superseding
rev 11's assumption that `To Do` was the entry point), sits under Jira's `To Do` status
category, and applies to every issue type (story-level and subtask, same scope as
`Canceled`, rev 16) — orthogonal to the existing `SUBTASK_PRECEDENCE`-derived readiness
machinery, which is unchanged. Deliberately left open (§8.28), not resolved here: the
`Backlog → To Do` transition is a **soft, unenforced convention for now** — no crisp
"ready" signal exists yet to hard-gate on, unlike rev 19's assignee-presence check.

## rev 26

**§8.27 added: no established place yet for
company/global-level docs or general epic-level docs.** Surfaced while scoping Epic
TAI-8, after shipping TAI-52 (persona config/permission enforcement, Epic TAI-6's first
Story — see §8.9/§8.22/§8.23, now **Implemented**, TAI-42/43). The existing Confluence
structure (§4) has two tiers — per-doc-type-instance pages tied to a Story/Epic via the
naming convention, and the project-level **Config** folder (rev 13, Persona Roster/
Personas) — but nothing for (a) docs that span **multiple TAI projects entirely**
(company coding standards, cross-team process, architecture spanning systems each with
their own Jira project/Confluence space — §4's "one space per project" model has no
answer for content that isn't scoped to any single project), or (b) a **general
epic-level doc** that isn't one instance of the fixed ADR/PRD/Test-Plan/etc. taxonomy
(e.g. an epic's own running design notes). Ideas only, nothing decided — see §8.27.
Also: §8.9/§8.22/§8.23 now read **Implemented** — TAI-42 wired checkpoint/review-gate
enforcement directly into `transition()` (both backends); TAI-43 built the
autocompletion decision engine (`autocompletion.ts`) as a standalone pure-function
module, deliberately **not yet called from `transition()`** — its own module doc says
why: which call site invokes it is an orchestration question for Epic TAI-6, not this
Story's. TAI-52 (Epic TAI-6's first Story) built the permission layer that engine will
need a caller through, but the actual autocompletion call site still awaits TAI-8's
persona-invocation loop. Corrects rev 25's "design only" status for §8.9/§8.22/§8.23,
which was accurate as of TAI-41 alone, before TAI-42/43 shipped.

## rev 25

**§8.9, §8.19, §8.20, §8.22, §8.23 updated to
reflect real implementation/design work.** §8.19/§8.20 (pluggable `GitHost`, PR-backed
CodeReview) marked **Implemented** — TAI-38/39/40 shipped `src/core/git/interface.ts`
and the Bitbucket backend; §5.4 and §6's matching "not yet implemented" notes updated to
match. §8.9/§8.22/§8.23 (autocompletion conditions, completion markers, checkpoint
taxonomy) **resolved via the TAI-41 ADR** (Confluence, TA space) — design only, not yet
built; §3.4 now points to it. §8.24/§8.26 are unaffected.

## rev 24

**§8.21 and §8.25 applied to the actual docs.**
`workflows/kickoff.md` now defines the `NEEDS CLARIFICATION` marker mechanism and blocks
its PM+UX Designer review gate on zero unresolved markers (§8.21); `personas/pm.md` and
`personas/ux-designer.md` each point back to it from their PRD/UX-flow output
descriptions. All five `workflows/*.md` files now open with the one-line brief-compliance
pointer (§8.25). §8.22–§8.24 (deferred) and §8.26 (declined) are unaffected — still
nothing to apply for those. See §8 items 21 and 25 for the updated status.

## rev 23

**§8.21–§8.26 (the six BMAD/GSD/Spec-Kit-inspired
questions from rev 22) resolved: one adopted narrowly (§8.21, uncertainty markers scoped
to Kickoff docs only), one adopted lightly (§8.25, a one-line brief-compliance pointer per
workflow doc, not a full checklist), three deferred for having no current consumer
(§8.22 completion markers, §8.23 checkpoint taxonomy, §8.24 persona manifest — all
revisit when their actual driving work, e.g. Epic TAI-7, starts), and one declined
(§8.26 retrospective/correct-course type — no real gap has surfaced yet in TAI's own
dogfooding).** These are documentation-convention decisions only — **none of the six have
been applied yet** to the actual `personas/*.md` / `workflows/*.md` files; that's
follow-on work, not done by this revision.

## rev 22

**six new open design questions added
(§8.21–§8.26)**, surfaced by surveying BMAD-METHOD, GSD (Get Sh*t Done), and GitHub Spec
Kit for ideas applicable to `src/personas/*.md` / `src/workflows/*.md`: explicit
uncertainty markers in generated artifacts (Spec Kit's `NEEDS CLARIFICATION`), a
structured completion-marker convention for persona handoff (GSD's agent-contracts
pattern), a finer-grained checkpoint taxonomy beyond the current binary
human-sign-off-default (GSD), a lightweight persona roster/manifest file separate from
the full persona docs (BMAD's module-roster pattern), a brief-compliance gate embedded in
each workflow doc (Spec Kit's "Constitution Check"), and a retrospective/correct-course
workflow type (BMAD) that the Story/Bug/Spike/Kickoff taxonomy doesn't currently have.
**Ideas only — nothing decided, nothing else in this brief changed.** See §8.21–§8.26.

## rev 21

**§8.19 and §8.20 resolved via TAI-33/TAI-34
(Spikes, dogfooded through TAI's own Jira project) — design only, nothing built yet.**
§8.19: a new sibling `GitHostBackend`/`GitHost` interface, not folded into
`StorageBackend` — git hosting is a different domain and an independent configuration
axis from Jira/Confluence, but reuses the same pattern (branded IDs, `MutationResult`/
`StorageConnectivityError`, an open `kind` discriminator). One interface, not split like
`WorkTracker`/`DocStore`, since git hosting has no internal product seam. Scoped to what
the checkpoint chain actually needs (PR CRUD, approve/request-changes, merge, commit
status) — explicitly excludes a "trigger CI" operation, since this session's own
Bitbucket work found that can't be guaranteed retroactively. §8.20: the
Develop→CodeReview→Merge/Deploy chain (§5.4) now opens and acts on a real PR; PR state
syncs one-way into the Jira subtask at existing refresh points (§3.6), never the reverse
— the Jira subtask stays authoritative for TAI's own dependency graph. A human
reviewing/merging directly on the git host, bypassing TAI, is treated as authoritative
and simply reflected, not fought (same principle as §4's Confluence-gate-reopening
rule). See §5.4 and §6 for the updated text, and TAI-33/TAI-34's ADRs (Confluence, TA
space) for full reasoning. **Recommended next step, not yet scheduled:** one
implementation Story building both the interface and the checkpoint together, per both
ADRs' Consequences sections.

## rev 20

two new open questions captured (§8.19, §8.20 above, before they were
resolved), flagged during Bitbucket Pipelines CI setup.

## rev 19

**§5.5 gains a hard assignment gate: a ticket must
have a human `Assignee` before it may leave `To Do`.** Work in progress with nobody
accountable for it is the exact failure mode this framework exists to prevent (§1), and it
is invisible on a board. Enforced centrally in the storage plugin's `transition` operation
alongside the existing checkpoint checks — an ordinary blocked checkpoint, not §3.3's
unplanned-checkpoint/escalation path. Paired with a **pre-assign-at-creation** rule: when a
ticket's `persona` resolves to exactly ONE authorized human in the Persona Roster (a solo
developer; a team with a single PM), TAI sets `Assignee` at creation rather than deferring
to a claim. With more than one candidate it does not guess — it falls back to the §5.6
assignment-helper.

## rev 18

**§4's "the Confluence space key matches the Jira
project key" rule (rev 11) is wrong and is withdrawn.** TAI's own space is keyed `TA`, not
`TAI`: Confluence derives a space key from the space *name* at creation and may shorten or
disambiguate it, and a human can rename it later — so the two drift for reasons outside
TAI's control. It went unnoticed for six revisions because the MCP tooling resolves spaces
by *name*, masking the mismatch. `projectKey` and `spaceKey` are now separate config values
that the storage backend takes independently; nothing may derive one from the other. Also
corrects rev 17's hazard note, which wrongly claimed the `mcp-atlassian` wrapper inverts
issue-link direction — it does not; that was a misreading of Atlassian's docs. Ground truth,
verified live: for the `Blocks` type, the **inward** issue blocks the **outward** one.

## rev 17

**§3.2's transport changes: Jira/Confluence are
reached via the Atlassian REST API, not the Atlassian Remote MCP Server.** The MCP-server
design (revs 1–16) was tested live in Phase 4's opening spike (Jira `TAI-16`) and does not
work: auth succeeds headlessly, but the tool surface returned is three read-only Teamwork
Graph tools — no issue creation, no transitions, no comments, no pages. The real
Jira/Confluence tools sit behind interactive OAuth 2.1, which would leave CI and the
integration tests with no headless path. Direct REST works, needs zero new dependencies,
and drops a lossy translation layer. Critically, **`StorageBackend`/`WorkTracker`/`DocStore`
needed no change at all** — the Phase 3 abstraction absorbed the swap exactly as intended.
§3.2 also now carries a hazard note about third-party MCP wrappers (`mcp-atlassian`), whose
defects were catalogued the hard way while building TAI's own backlog through one. §10
updated to match.

## rev 16

new **`Canceled`** status added to §5.3: a
second terminal state for work abandoned before completion, available on every issue
type (story-level and subtasks alike). Gap found while cross-checking the real Jira
site's full status list — nothing to reuse — surfaced by `workflows/spike.md`'s
"cancelled/deferred" outcome, which previously had no distinct status and collapsed
into `Done`. Counts as satisfied for `SUBTASK_PRECEDENCE` purposes, same as `Done`.
`spike.md`/`story.md`/`bug.md`/`kickoff.md` all updated with their own `Canceled`
transition.

## rev 15

§5.3 status names/scope corrected against the
actual TAI Jira project: the default status is **`To Do`**, not `Open` (cosmetic —
avoids renaming what's likely a shared/global Jira status across the whole site); and
**`In Review` exists on every issue type by default**, not just Kickoff — Jira's shared
default workflow doesn't allow withholding one status from most types without a
separate per-type workflow, so it's simpler to leave it universally present and let
TAI's own logic (§3.3) decide which types actually transition into it. Only Kickoff
does. Every `workflows/*.md` and `personas/tester.md` status reference updated to
match.
Then: rev 14 — §4's Confluence folder convention extended to
**config-type content**: the Persona Roster and persona extensions aren't tied to a
ticket, so they don't fit the `<JIRA-KEY> — <Doc Type>: …` naming rule below; they get
their own top-level **`Config`** folder instead. Reflects the actual TAI Confluence
space now in use — `Config` → `Persona Roster` created there, seeded with the
project's first (solo) team member across all 9 personas.

## rev 13

the ad-hoc, no-fixed-owner **subtask**-level
`Spike` type (§5.2) is renamed **`SpikeTask`**, discovered as a real naming collision
while provisioning Jira issue types for the actual TAI project: Jira issue-type names
are unique site-wide, and the pre-existing **Story**-level `Spike` type (§5.1) already
owns the name "Spike." `StoryType.Spike` is unchanged; only the subtask-level ad-hoc
escape-hatch type (`SUBTASK_OWNER[SpikeTask] = null`, `schema/story-schema.ts`) is
affected, along with every persona/workflow doc that referenced it. Also fixed two stale
"Jira Project Role" references left behind by rev 12's registry redesign below.

## rev 12

§5.6 human registry redesigned: TAI's own
storage-agnostic **Persona Roster** (Confluence-page-backed on the Jira backend, a local
file on the filesystem backend) replaces the native-Jira-Project-Role design from rev 11,
because Jira Cloud's Free plan cannot create/edit Project Roles at all — for either
project type — and a Jira-only construct doesn't work for the filesystem backend anyway.
Native Project Role sync becomes an optional, deferred paid-tier enhancement (§8.18).

## rev 11

full design-notes review pass, §3-§8: subtask taxonomy↔Jira mapping,
D7/D9/D12 resolved, scenario-workflow layer dropped, the two-axis owner model (D15),
Confluence structure/naming/gate-reopening rules, local cache bulk-sync/attachments, new
§3.9 Comment Conventions, and briefing/kickoff/connectivity-loss mechanics for a unit of
work — see DESIGN_NOTES.md for the full session-by-session history.

---

## Appendix: section 8 before it was collapsed (TAI-486, 2026-10-09)

The brief's "Open Design Questions" list as it read before each resolved item was cut to one line. Kept for the reasoning.

Carry these forward; resolve them in upcoming design sessions. **This list is for
genuinely undecided design questions only** — once an idea is scoped enough to actually
investigate or build, it gets a real Jira Story/Spike in `Backlog` status
(`personas/pm.md`'s "Captures genuinely open ideas as real Backlog tickets" principle,
rev 56, TAI-286), backlinked from its §8 entry here, not left sitting only as brief prose.

1. ~~**Story-type taxonomy**~~ — **RESOLVED (rev 11):** **Kickoff / Story / Bug / Spike**
   is final for now, no new type added ahead of a real need — the taxonomy stays open/
   extensible (§5.1/§5.2) so a business can add one later (e.g. a Chore/Maintenance type)
   if a concrete gap actually appears in practice. (Earlier candidate names Research/
   Implementation were folded into these.)
2. ~~**Jira statuses & workflows**~~ — **RESOLVED (rev 11, naming corrected rev 15):**
   default lifecycle is `To Do → In Progress → Done`, with per-type loop-backs already
   documented in `workflows/story.md`/`bug.md`; "ready"/"blocked" is derived from
   `SUBTASK_PRECEDENCE`, not stored. `In Review` exists on every issue type (Jira's shared
   default workflow), but only Kickoff's flow actually transitions into it — TAI's own
   logic decides what's meaningful per type, same as everywhere else (§3.3). See §5.3.
   Still open: per-project customization of this default beyond the built-in loop-backs.
3. ~~**Scope of the "same persona can't approve" rule:** is it scoped to the same human, the
   same persona role, or both?~~ — **RESOLVED (rev 31): the same human, not persona role.**
   Persona role was never a live dimension — every workflow always routes authored work to
   a *different* persona role for review, so "the same persona role approves its own
   output" can't structurally occur. Self-approval only happens when one human fills both
   roles, which is exactly the solo-dev case §4 already carves out, with the override
   already sketched at the Code Reviewer persona level (rev 10 note). No code change
   needed — existing workflow routing already handles it.
4. ~~**Multi-repo checkpoint chain shape**~~ — **RESOLVED (rev 11):** native Jira
   **Component** field (not a custom `repo` field), populated by deriving the repo from a
   commit's Jira-key prefix with manual fallback. See §4.
5. ~~**Failed-checkpoint triage ownership:** the retry-once-then-human rule is set; confirm
   whether the Orchestrator persona may perform the re-triage automatically within that
   single retry.~~ — **RESOLVED (rev 32): not a persona judgment call at all.** The retry
   destination is already fixed by the workflow's documented loop-back structure (§5.3),
   and retry-vs-escalate is already fixed by the single-retry counter (§4). Nothing
   discretionary is left for the Orchestrator to "decide" — deterministic plugin-layer
   mechanics, no persona-level permission needed.
6. ~~**Finalized default persona roster and default issue-type permissions**~~ —
   **RESOLVED:** the 9-persona roster (§3.1) is final, and every persona's `create`/
   `workOn`/`complete`/`update` permission block was individually audited against the
   schema (design-notes §1), fixing several real gaps in the process (e.g. Ada's missing
   `Subtask:Investigate`, Dario's missing `Subtask:Dev`). See each `personas/*.md` file.
7. ~~**Storage interface operation set:** the minimum operations the abstraction must expose
   (issue CRUD, query/JQL-equivalent, status transition, comments, issue links, custom
   fields, attachments) and what Jira-specific concepts must *not* leak so the filesystem
   backend stays clean.~~ — **RESOLVED (rev 33): already implemented and proven.** See §3.2
   — `src/core/storage/interface.ts`'s `WorkTracker`/`DocStore`, validated identical across
   the filesystem and Jira backends by the conformance suite (`TAI-15`). Comment/link delete
   and attachment upload are the only gaps, left out as not-yet-needed rather than decided
   against.
8. ~~**Ticket-switch mechanic:** worktree swap vs. plain checkout as default.~~ —
   **RESOLVED (rev 34): worktree-swap.** See §6 — that's the entire stated reason
   worktrees were adopted (avoiding stashing dirty state on ticket switch); a plain
   checkout as default would reintroduce the problem worktrees exist to solve. Design
   decision only — not yet implemented in code.
9. ~~**Autocompletion condition format**~~ — **RESOLVED (rev 25, TAI-41 ADR):**
   `AutocompletionCondition { id, description }`, `AutocompletionConfig` is
   `{ enabled: false } | { enabled: true; conditions: [...] }` — AND-only for v1.
   Configured per persona/subtask-type/per-issue-override (§3.4's three axes). The
   condition's `description` is the prompt text; `transition()` never evaluates it
   live — the deciding persona evaluates it and records the verdict via the §8.22
   `Complete:` marker, which `transition()` reads. See the TAI-41 ADR (Confluence, TA
   space). **Implemented (rev 26, TAI-43):** `AutocompletionCondition`/`AutocompletionConfig`/
   `evaluateAutocompletion` live in `autocompletion.ts` as a standalone, tested, pure-function
   module — deliberately not yet called from anywhere; see §3.4 for the current status of
   who's expected to eventually call it.
10. ~~**Root status-file reconciliation.** Exact staleness rule for `status.json` (TTL vs.
    trust-until-mismatch)~~ — **RESOLVED (rev 35): neither — always a full rescan on
    demand**, no staleness check at all (see §7, TAI-56 ADR decision 6). ~~**Still open:**
    when a reconciliation scan is triggered automatically (session start? every command?
    explicit `/tai_` refresh command?) — blocked on a CLI/command layer that doesn't exist
    yet.~~ — **RESOLVED (rev 42): same refresh points as §3.6's per-item cache rule** —
    starting/resuming a unit of work, completing one (§3.6's newly-added third refresh
    point), and first-use-in-session. Not actually blocked on a new CLI concept; blocked
    (like §8.14/§8.15) on the orchestrator/persona-invocation loop (TAI-8) existing to call
    `rollupStatus()` at those points.
11. ~~**Pre-subtask work location:** where initial brainstorming/setup work (before a
    subtask exists to key off of) is cached and journaled, and how/whether it gets
    reattached once a real subtask is created for it.~~ — **RESOLVED (rev 36): premise
    declined, no pre-subtask phase exists.** A persona creates the subtask as its first
    action, before any exploration begins — see §7. Settled alongside it: subtask creation
    is direct, by whichever persona is authorized (§3.1's per-persona `create` permission);
    story-level ticket creation stays propose → PM confirms, unchanged. Precedence-graph
    wiring for a mid-flight-inserted subtask is already solved in code
    (`workflows/dependencies.md`'s "Dynamic Subtask Insertion").
12. ~~**Decomposition scope levels:** how many levels of recursive decomposition are
    formally recognized (Project → Epic → Story, or does a very large system warrant an
    optional Initiative level above Epic?) and where the Analyst/Orchestrator decides to
    stop decomposing further.~~ — **RESOLVED (rev 37): no fixed ladder, no `Initiative`
    tier.** See §3.7 — decomposition is deliberately scope-relative and repeatable, not a
    fixed level count; where to stop is a human/Orchestrator judgment call per invocation,
    not a formula.
13. **Refinement subtask triggering:** *Fully resolved (rev 57).* Three non-exclusive
    triggers can flag a Story as needing `Investigate`: a human manually, PM (Orchestrator)
    recognizing insufficient detail while querying what's ready, or the Analyst self-
    flagging during other work (e.g. decomposition). ~~Regardless of who flags it, the
    Analyst always creates the actual `Investigate` subtask — the flagging persona never
    creates it on the Analyst's behalf.~~ — **RESOLVED (rev 57, TAI-317): creation
    authority follows the general TAI-83 "Eager Subtask Creation" exception**
    (`workflows/dependencies.md`) like any other subtask type, not a standing carve-out —
    whichever persona (PM, the Analyst herself, or Architect/Dev mid-flight) has formed the
    real in-context judgment may create `Investigate` directly, same dedup-search-first
    mechanics as every other TAI-83 case; `persona=analyst` is still set regardless of
    creator (see `personas/pm.md`, `personas/analyst.md`). The same generalization applies
    to `ArchitectureDesign` — no written carve-out existed for it, but PM's practice had
    informally treated it the same restrictive way (TAI-281 was the live instance).
    ~~**Still open:**
    what formally marks a Story "ready for implementation" once refinement is done (a
    status transition, a checkpoint, or just Orchestrator judgment)?~~ — **RESOLVED
    (rev 38): no formal marker.** `Investigate` has no entry in `SUBTASK_PRECEDENCE`
    (`workflows/dependencies.md`), and `workflows/story.md` already documents it has "no
    automatic unblock effect" — nothing structurally waits on it, so there's nothing for a
    formal signal to drive. `Investigate` going Done is ordinary subtask completion; the
    persona creating the next subtask judges readiness itself, same direct-creation
    authority as item 11 (rev 36).
14. ~~**Escalation notification channel:** a Jira-rejected transition (§3.3) gets a comment/
    label in Jira and an entry in the local status rollup (§7) — is that sufficient, or
    does human escalation need an active push notification (email, Slack, Teams) so it
    isn't only discovered by someone checking Jira or running Team AI?~~ — **RESOLVED
    (rev 41): comment/label + status rollup is sufficient for v1.** Active push is
    **deferred, not declined** — no orchestrator/CLI layer exists yet to trigger one from
    (same gap §8.10's trigger-timing half already flagged), plus it needs new integration
    config. Revisit once the orchestrator/persona-invocation loop (TAI-8) exists, same
    treatment as §8.15's learning-loop deferral.
15. **Learning-loop design (deferred, §3.3):** this entire mechanism — proactive metadata
    checks, the proposed/confirmed constraint cache, promotion authority (human only, or
    can the Orchestrator do it under a configured permission?), sharing scope (local vs.
    project-wide so other team members' sessions don't independently rediscover the same
    block), and — critically — **what a promotion actually changes** (persona extension?
    workflow adjustment? something else?) is all undesigned. Revisit as a follow-on
    refinement once the core escalation behavior (v1) is built and in use.
16. **Subtask type taxonomy completeness (§5.2):** *Partly resolved (rev 10).* DBA/DevOps
    routing types are now concrete — `Database`; `Infra` / `Deploy` / `PostDeploy` — and a
    type may carry a **default owner that is overridable per instance** (`Deploy` /
    `PostDeploy`), settling the "route to more than one eligible persona" sub-question.
    ~~**Still open:** the process for adding a brand-new type when a real case doesn't fit
    the existing list — does that require a human decision, or can the Analyst/Architect
    propose a new type during a refinement subtask?~~ — **RESOLVED (rev 39):** `SubtaskType`
    is a compile-time enum (`story-schema.ts:87`) — adding a new one is always a human
    (developer) schema edit. A persona may propose the gap, same propose pattern as
    elsewhere, but never adds the type itself. Mirrors §8.1's story-type taxonomy stance.
17. ~~**Analyst output review gate (§5.2):** does `Investigate` output need a formal review
    type (mirroring `DesignReview`), or does the default human sign-off (§3.4) already
    cover it well enough? If a formal gate is added, it may need **two independent
    reviewers checking different things** — PM for business/acceptance fit, Architect for
    whether the requirement is clearly enough defined to design and implement — rather than
    the single-reviewer shape every existing gate assumes. If both are needed: do both have
    to pass before the Story is considered refined, can they run in parallel, and does a
    disagreement between PM and Architect itself become a new kind of checkpoint?
    *Update (rev 10):* a Kickoff-stage **PM + UX Designer** review gate now exists as-built
    (§3.5, `workflows/kickoff.md`), but it gates *Kickoff discovery output*, not
    *`Investigate` story-refinement output* — so the dual-reviewer question for
    `Investigate`, and whether these two gates should be unified, both remain open.~~ —
    **RESOLVED (rev 40): no formal gate.** `Investigate` is an ordinary subtask, not a
    story-level gate like Kickoff's — the generic per-subtask checkpoint (§3.4) already
    covers it. No dual-reviewer structure, no unification with Kickoff. **Addendum:** a
    mid-flight-spawned `Investigate` blocking its originating subtask uses the existing
    `SubtaskDependencyOverride` escape hatch (`workflows/dependencies.md`), not a new
    mechanism — a per-instance call, not a static graph change.
18. **Native Project Role sync (deferred, rev 12, §5.6):** whether/when to mirror the
    TAI-owned Persona Roster into real Jira Project Roles for teams on a paid plan —
    what triggers it (automatic plan-tier detection vs. an explicit opt-in command), and
    how a conflict between the roster and hand-edited native roles is resolved. Not
    required for the registry to function; purely an optional native-Jira visibility/
    defense-in-depth enhancement once scheduled.
19. ~~**Git-hosting plugin abstraction**~~ — **RESOLVED (rev 21, TAI-33 Spike/ADR):** a
    sibling `GitHostBackend`/`GitHost` interface, not folded into `StorageBackend` — git
    hosting is an independent configuration axis from Jira/Confluence, reusing the Storage
    Plugin's *pattern* (branded IDs, `MutationResult`/`StorageConnectivityError`, an open
    `kind` discriminator) without reusing its interface. One `GitHost` interface, not split
    like `WorkTracker`/`DocStore` — git hosting has no equivalent internal product seam.
    Scoped to PR CRUD, approve/request-changes, merge, and commit status; explicitly
    excludes a "trigger CI" operation (can't be guaranteed retroactively, per this
    session's own Bitbucket Pipelines work). See §6 and the TAI-33 ADR (Confluence, TA
    space). **Implemented (rev 25, TAI-38):** `GitHost` interface and Bitbucket backend
    live at `src/core/git/interface.ts` and `src/core/git/bitbucket/`.
20. ~~**CodeReview checkpoint must act on a real git PR**~~ — **RESOLVED (rev 21, TAI-34
    Spike/ADR):** the Develop→CodeReview→Merge/Deploy chain (§5.4) now opens and acts on a
    real PR. PR state syncs **one-way** into the Jira subtask at existing refresh points
    (§3.6) — never the reverse; the Jira subtask stays what TAI's own precedence engine
    reads, answering the "which is the source of truth" question. A human reviewing or
    merging directly on the git host, outside TAI, is detected on next refresh and
    reflected, not fought — same principle as §4's Confluence-gate-reopening rule. See
    §5.4 and the TAI-34 ADR (Confluence, TA space). **Implemented (rev 25, TAI-38/39/40):**
    Develop opens a real PR, CodeReview acts on it, Merge/Deploy merges it gated on commit
    status; verified against the live TAIT scratch repo (TAI-40 integration test).
    **Further revised (rev 52, TAI-159 ADR). Implemented (rev 52, TAI-160):** the
    `CodeReview` subtask itself is retired in favor of querying the git host's PR approval
    state live — see §5.4's "Revised (rev 52 design)" block.
21. ~~**Explicit uncertainty markers in generated artifacts**~~ (rev 22, inspired by
    GitHub Spec Kit's `NEEDS CLARIFICATION` convention) — **RESOLVED (rev 23), narrow:**
    adopted, but scoped to **Kickoff-stage docs only** (PRD/UX flows, `workflows/kickoff.md`)
    — a persona leaves a `NEEDS CLARIFICATION: <question>` marker on any genuine gap, and
    the existing PM+UX Designer review gate (§3.5) is mechanically blocked while any marker
    remains, rather than depending solely on a reviewer noticing what's missing. Answers
    this session's open question about how deep Ada's clarifying conversation needs to go:
    exactly deep enough that no marker remains at gate time. **Applied (rev 24)** to
    `workflows/kickoff.md` (the gate mechanics) and `personas/pm.md`/`personas/ux-designer.md`
    (pointers from the PRD/UX-flow output descriptions) — not `personas/analyst.md`, since
    the resolution scopes this to the PRD/UX-flow docs the gate actually reads, not Ada's
    work-breakdown doc. Extending the convention to `Investigate`/ADR output later, if
    Kickoff usage proves it out, is a natural next step but not decided here.
22. ~~**Structured completion-marker convention for persona handoff**~~ (rev 22, inspired
    by GSD's `agent-contracts.md` pattern) — **RESOLVED (rev 25, TAI-41 ADR):** extends
    the existing `Approved:`/`Rejected:`/`Q:` marker convention (§3.9) with `Complete:
    <SubtaskType>` plus one `<condition-id>: PASS|FAIL` line per configured autocompletion
    condition (§8.9), posted by the deciding persona (or human) as a Jira comment when the
    subtask concludes. Deliberately **no** inference-fallback here, unlike the human-
    authored markers — a persona's output format is under TAI's own prompt control, so a
    missing/malformed marker is treated as FAIL, not inferred from prose. See the TAI-41
    ADR (Confluence, TA space). **Implemented (rev 26, TAI-43 — corrects rev 25's "see
    TAI-42," which named the wrong Story):** `parseCompletionMarker`/`latestCompletionMarker`
    live in `autocompletion.ts` alongside the condition-evaluation logic they feed.
23. ~~**Finer-grained checkpoint taxonomy**~~ (rev 22, inspired by GSD's three-way
    `human-verify` / `decision` / `human-action` split) — **RESOLVED (rev 25, TAI-41
    ADR), declined as proposed:** GSD's three-way split doesn't map onto what exists in
    `story-schema.ts` — no current checkpoint is a "pick from options" or an "external
    physical action." Instead formalizes the two kinds already implicit in the code:
    **`hard`** (never autocompletes — `ALWAYS_HUMAN_GATED_SUBTASKS`/`REVIEW_GATES`) and
    **`conditional`** (default human-sign-off, autocompletion-eligible per §8.9/§8.22).
    Additive over the existing binary default, not a breaking change. See the TAI-41 ADR
    (Confluence, TA space). **Implemented (rev 26, TAI-43 — corrects rev 25's "see
    TAI-42," which named the wrong Story):** `checkpointKind` lives in `autocompletion.ts`.
24. ~~**Lightweight persona roster/manifest file**~~ (rev 22, inspired by BMAD-METHOD's
    `module.yaml` agent-roster pattern) — **DEFERRED (rev 23):** no current consumer —
    personas are always loaded as full `personas/*.md` files today; nothing invokes a
    persona independently of that. Revisit if/when personas become independently
    invokable (e.g. individual Claude Code skills). Building this speculatively risks
    drifting out of sync with the real persona files it would summarize. *(Distinct from
    the existing **Persona Roster**, §5.6 — that's the human↔persona-id assignment mapping;
    this would have been a manifest of the personas themselves. Naming collision flagged
    here so a future revisit doesn't reuse the same term for two different things.)*
25. ~~**Brief-compliance gate embedded in each workflow doc**~~ (rev 22, inspired by
    GitHub Spec Kit's `constitution.md` + "Constitution Check" gate) — **RESOLVED
    (rev 23), light:** adopted, but as a single pointer line at the top of each
    `workflows/*.md` ("must comply with `PROJECT_BRIEF.md`; re-check before finalizing
    output"), not a duplicated checklist. `CLAUDE.md` already forces every session to read
    this brief first; a full per-workflow checklist would need to stay in sync with a brief
    that revises often (rev 23 as of this entry) — real rot risk outweighs the benefit of a
    heavier gate. **Applied (rev 24)** — the pointer line is now the first line under the H1
    in all five `workflows/*.md` files (`kickoff.md`, `story.md`, `bug.md`, `spike.md`,
    `dependencies.md`).
26. ~~**Retrospective / correct-course workflow type**~~ (rev 22, inspired by
    BMAD-METHOD's dedicated `bmad-retrospective` and `bmad-correct-course` skills) —
    **DECLINED (rev 23):** no retrospective or formal course-correction has ever actually
    been needed in TAI's own dogfooding to date — same "don't add ahead of a real need"
    reasoning as §8 item 1's Story-type stance and §5.2's subtask-type stance. A Bug covers
    post-ship issues; an edited Story covers mid-flight scope correction. Revisit only if a
    concrete gap appears in practice.
27. ~~**No established place for company/global-level docs or general epic-level docs**~~
    (rev 26) — **DECLINED (rev 30): neither gap is real.** Surfaced while scoping Epic
    TAI-8, right after Epic TAI-6's first Story (TAI-52) shipped. The Confluence structure
    resolved in §4 covers two tiers well: **per-doc-type-instance pages** (ADRs, PRDs, Test
    Plans, …) tied to a specific Story/Epic via the `<JIRA-KEY> — <Doc Type>: …` naming
    convention, and the **project-level Config folder** (rev 13) for content tied to no
    single ticket at all (Persona Roster, the `Personas` override page). Originally thought
    neither tier answered:
    - **Company/global docs** — coding standards, cross-team process, architecture spanning
      multiple systems/projects. **Dropped from consideration**: no cross-project scope
      exists to serve; §4's "one Confluence space per Jira project" model is sufficient as
      is.
    - **General epic-level docs** — an epic's own running design notes/context that isn't
      one instance of the fixed ADR/PRD/Test-Plan/etc. taxonomy. **Not actually missing**:
      the existing project-level `Config` folder (rev 13) already serves as the home for
      untyped, non-ticket-tied content — no separate epic-scoped catch-all needed. Typed
      epic-scoped docs already had a home regardless (§4: "an Epic-level decomposition
      proposal ties to the Epic itself").
    No Spike needed — both sub-questions collapse to "already covered by existing
    structure."
28. ~~**`Backlog → To Do` readiness gate: stays soft forever, or eventually hardens?**~~
    (rev 27) — **RESOLVED (rev 29): stays soft indefinitely, no hard gate built.** §5.3
    resolves that `Backlog` exists and where it sits in the lifecycle, and leaves the
    transition ungated in code — a human (or a persona, once one has the authority) just
    moves a ticket when they judge it ready, the same way every status transition worked
    before the rev 19 assignment gate existed. Declined to build a hard gate now: none of
    the candidate "ready" signals (no unresolved `NEEDS CLARIFICATION` marker, §8.21; no
    unresolved `Q:` thread, §3.9; precedence-unblocked, §5.3) alone captures "a
    human/process judged this ready," and the rev 19 assignment gate earned hard
    enforcement because it prevented a concrete, identified failure mode (§5.5's own
    reasoning) — no equivalent incident exists here yet. Per §8 item 1's "don't build
    ahead of an observed need," revisit only if a real "a ticket left `Backlog` before it
    should have" incident actually happens in practice.
29. **Human-requested review override, at any stage in the chain (rev 49, 2026-08-20,
    open).** At any point — Architect, Analyst, Dev, CodeReview, DesignReview, and so on —
    someone (most likely a human, though possibly any persona noticing something worth a
    second set of human eyes) should be able to flag a task/Story as needing human review
    before it proceeds, even when the AI review(s) for that stage already passed. Distinct
    from the existing `humanSignOffDefault`/checkpoint machinery (brief §3.4), which is
    about whether a given gate autocompletes at all — this is an override layered on TOP
    of a gate that would otherwise pass, raised at arbitrary points, not fixed to one
    subtask type. Genuinely undecided, flagged live rather than designed on the spot — same
    posture as rev 48's Analyst/Architect "ask the human" principle (`personas/analyst.md`/
    `architect.md`): this is exactly the kind of open direction question that belongs to
    the human, not a persona's unilateral call. Open: what marks it (a comment convention
    alongside the existing `Q:`/`Approved:`/`Rejected:` set, §3.9; a label; a dedicated
    field)? Does it block the same way a failed review does, or just add a required extra
    step? Who can clear it once raised? Revisit
    once a concrete case makes the shape obvious, same "don't build ahead of an observed
    need" posture as item 1/28 above.
30. **A Story doesn't support multiple Dev/Test/Deploy cycles (rev 52, 2026-08-24, known
    limitation, not planned).** `STORY_SUBTASK_MAP`/`SUBTASK_PRECEDENCE` model subtask
    *types* per Story, not *instances* — `doneSubtaskTypes` is a `Set<SubtaskType>`, one
    "is Dev done at all" flag per Story, not per Dev subtask. Nothing stops creating a
    second `Dev` subtask under an already-merged Story, but the precedence graph wouldn't
    track it correctly (once any `Dev` instance goes Done, anything gated on "Dev done"
    reads as satisfied for the whole Story). **Consequence:** any follow-up work — a small
    tweak discovered after merge, even something as small as a label rename — needs its
    own Story or Bug, not a second Dev cycle bolted onto the original one. This isn't
    ceremony for its own sake: it's the only unit the precedence graph actually tracks
    cleanly today, and the *process* around a tiny follow-up still scales down (Ada's
    "a bug-fix Story needs a paragraph, not a PRD" principle, §3.7) even though the
    *artifact* doesn't go away. Revisit only if this friction is actually felt on a real
    project — would need the precedence graph to become instance-aware, not type-aware, a
    bigger change than anything rev 52 did.
31. **Custom Jira priorities may need alias-mapping too (rev 55, 2026-08-31, open).**
    TAI-116/TAI-179 built type-alias mapping for issue *types* only (TAI-90/91's ADR). A
    target project's Jira admin may have set up custom `Priority` values that don't match
    whatever TAI reads/assumes — not yet investigated: does TAI touch `Priority` anywhere
    that would actually break on a non-default scheme, and if so, does it want the same
    alias-mapping treatment (`src/core/storage/jira/type-alias-config.ts`) extended to
    cover it, or its own lighter mechanism? Revisit once a concrete case surfaces, same
    posture as items 1/28/29. **See TAI-279 (Spike, Backlog).**
32. **Analyst-owned Confluence project "home" page (rev 55, 2026-08-31, open, possible new
    skill).** No persona currently owns keeping a project-level executive-summary/
    description page current in Confluence. Flagged as a likely Ada (Analyst) job, wholly
    undesigned: what it should contain, how/when it gets updated (once at Kickoff? every
    Epic? periodically?), and whether it's a new `confluenceOutputs` doc type or folds into
    the existing project-level `Config` folder (§4 rev 13, which already holds untyped,
    non-ticket-tied content). **See TAI-280 (Story, Backlog).**
33. **Architect-owned architectural overview doc (rev 55, 2026-08-31; underlying work
    shipped rev 57, this §8 entry itself only closed out now, rev 60).** Same shape as
    item 32 but for Aria (Architect): a living doc describing the codebase's actual
    structure/design. **Shipped:** TAI-281 (Story, Done) via TAI-307's ArchitectureDesign —
    `personas/architect.md`'s Architecture Overview section, an arc42/C4-inspired candidate
    section menu assessed against each project's real shape (include/reframe/N/A-with-
    reason, never silently dropped), linking out to real ERDs/ADRs/specs rather than
    duplicating them, one page by default, code-driven Mermaid diagrams, periodic/on-demand
    cadence (Confluence page 34963485). This entry itself went unclosed against TAI-281/307
    actually landing — caught as a stale brief-gap during Aria's own persona review
    (TAI-6/149/328), not resolved in real time the way item 34's rev 57 close-out was.
34. **Keep local master/main fresh across multiple machines/checkouts (rev 55, 2026-08-31;
    resolved rev 57, 2026-09-03).** Distinct from §8 item 8's worktree-swap-on-ticket-switch
    design (resolved, not yet implemented) and TAI-115's worktree-concurrency Story
    (explicitly deferred to v2) — this is about the same human (or team) working from more
    than one machine/folder letting a local `master`/`main` go stale before branching new
    work off it, i.e. fetching/pulling as appropriate, and often. **Shipped:** TAI-282
    (Story, Done) via TAI-287's ADR (Confluence, page 32899073) and TAI-288's
    implementation (`src/core/git/local-fetch.ts`, PR #80, merged) — `tai-work`/`tai-ready`
    now fetch `origin` and auto-fast-forward the local default branch when safe (clean
    fast-forward only, never merge/rebase/force), debounced ~10min via
    `.tai/last-fetch.json`.
35. ~~**Systematic per-persona job/scope audit against competitor frameworks**~~ — **RESOLVED
    (rev 55 → rev 66, 2026-09-23).** For each of the 9 personas: what tickets they actually
    touch, what marks their work "done," how deep they dig, and what's their focus —
    compared against GSD/BMAD-METHOD/Spec Kit's equivalent agent roles, with an explicit
    likes/dislikes call on each competitor. Delivered as a synthesis of all nine
    TAI-6/138-155 persona-review discussions' own competitor research, not a separate
    investigation — each turn already read the relevant competitor source directly.
    **Shipped:** TAI-283 (Spike, Done), Confluence page 41123841.
36. ~~**Overall TAI-vs-competition comparison**~~ — **RESOLVED (rev 55 → rev 66,
    2026-09-23).** Follow-on to item 35: a "real" comparison of TAI against GSD/BMAD-
    METHOD/Spec Kit as whole systems — where TAI wins, where it falls short, concrete
    improvement candidates. **Shipped:** TAI-284 (Spike, Done), Confluence page 41156609.
37. **Extend the out-of-band-human-edit posture from git hosts to Jira/Confluence directly
    (rev 55, 2026-08-31, open).** §6/the TAI-34 ADR already establish that a human acting
    directly on the git host (reviewing, merging) is treated as authoritative, not fought —
    detected on next refresh and reflected, same principle as §4's Confluence-gate-
    reopening rule. That posture isn't yet extended to a human creating or editing a Jira
    ticket or Confluence page directly, out of band. PM (Perry) and Analyst (Ada) are named
    as the biggest exposure — ticket/requirement content changing under them mid-flight —
    but every persona is exposed to some degree. Undesigned: how a persona notices a
    ticket/page changed since its own last read (a diff against the cache/`lastUpdated`,
    §7?), and what reconciliation looks like once noticed. **See TAI-285 (Story,
    Backlog).**
38. **Scale DesignReview gate depth to stakes (rev 60, 2026-09-22, deliberately deferred to
    v2/v3).** Raised live during Aria's (Architect) persona review (TAI-6/149/328):
    BMAD-METHOD's architecture-spine reviewer gate is a deterministic lint pass plus a
    rubric-walker plus multiple review-lens subagents, scaled to stakes — richer than
    `DesignReview`'s simple pass/fail (`workflows/story.md`; a human gate since TAI-458,
    with the Architect preparing the review notes).
    Explicitly **not** a v1 change — the human's own call, same "real investigation, not a
    brief edit" posture as items 35/36. **See TAI-327 (Story, Backlog).**

---

## Appendix: section 5.4's earlier review chains (removed from the brief by TAI-486, 2026-10-09)

The history block of "5.4 Checkpoint Chain" as it read before it was rewritten as current fact.

**History.** The original design, for an implementation Story touching one repo:
```
[Develop subtask]  --blocks-->  [Code Review subtask]  --blocks-->  [Merge/Deploy subtask]
```
- Develop subtask completes → Code Review subtask becomes actionable.
- Review **fails** → reopen the Develop subtask, put the Code Review subtask back to
  backlog, record reviewer notes as a comment (on the Develop subtask, or parent if
  multiple parties care). AI may retry once; second failure escalates to a human.
- Review **passes** → mark it done, unblocking the next subtask in the chain.

**Implemented (rev 21 design, TAI-34 ADR; rev 25 build, TAI-38/39/40, §8.20):** this chain
operates on a real git PR, not Jira transitions alone —
```
[Dev subtask] --opens PR--> [CodeReview subtask] --approves PR--> [Merge/Deploy subtask] --merges PR-->
```
- **Dev completes** → Developer persona calls `GitHost.createPullRequest` (source =
  the Story's branch, per this section; destination = the repo's default branch), then
  links the PR to the CodeReview subtask via a Jira remote issue link (the same mechanism
  already used to link a Confluence ADR to its issue). CodeReview becomes actionable.
- **CodeReview actionable** → Code Reviewer persona reviews the real PR diff, not just
  Jira ticket content. A decision makes two calls: `GitHost.reviewPullRequest` (the real
  PR) and `WorkTracker.transition` (the Jira subtask) — separate backends, same decision.
- **Review fails** (persona- or human-authored directly on the git host) → unchanged from
  above.
- **Review passes** → CodeReview done, unblocking Merge/Deploy.
- **Merge/Deploy** → `GitHost.mergePullRequest`, gated on `GitHost.getCommitStatuses`
  being green first — CI becomes a load-bearing merge gate, not advisory.
- **PR state syncs one-way into the Jira subtask**, at existing refresh points (§3.6),
  never the reverse — the Jira subtask stays what TAI's own precedence engine reads. A
  human acting directly on the git host (approve/request-changes/merge) is detected on
  next refresh and reflected, never fought — same stance as §4's Confluence-gate-
  reopening rule.

**Revised (rev 52 design, TAI-159 ADR — supersedes the CodeReview-subtask flow above).
Implemented (rev 52, TAI-160):** a real, near-term requirement for N-of-M PR approvals
surfaced a structural gap the design above didn't anticipate — a Jira subtask needs
exactly one `Assignee` (§5.5's hard gate), and there's no honest single assignee for
"the" review under a multi-approver policy. Revised chain —
```
[Dev subtask, stays In Progress] --opens PR--> [reviewed live on the git host] --merges PR--> [Dev subtask -> Done]
```
- **No `CodeReview` subtask is created going forward.** Bitbucket's own PR
  reviewer/approval state is the sole source of truth for review status, queried live —
  never mirrored into a Jira subtask. (`CodeReview` stays in the schema permanently for
  parsing historical tickets — see the ADR; it just isn't minted for new work.)
- **`Dev` stays `In Progress` until its PR actually merges, not until the PR opens** — a
  unit of work isn't really done until it's merged. `Deploy` ships what is
  already merged, so it waits on `Dev` being Done as well as on the test tiers and UAT (TAI-456/TAI-463); no
  cycle, since `Dev`'s own Done comes from the merge, not from `Deploy`.
- **Test-tier readiness moves off the static precedence graph onto three new
  live-computed `/tai-ready` lists** — `readyToReview` (open PRs where the current human
  is an eligible reviewer, per a new "PR Reviewers" roster), `readyToTest` (In-Progress
  `Dev` subtasks with an open PR — no approval requirement, testing runs alongside review), `readyToMerge`
  (PRs that pass the merge gate below and are CI-green) — extending TAI-107/108's existing `readyToMerge` pattern
  (§5.4's own live-git-host-query idiom) rather than inventing a new one.
- **The merge gate (TAI-462; human decisions TAI-455/TAI-456).** `git-pr merge` refuses unless all of
  these hold, and `/tai-ready`'s `readyToMerge` applies the same rule (one function, `core/git/merge-gate.ts`):
  1. **The required number of fresh approvals** (`TAI_PR_REQUIRED_APPROVALS`, default 1). An approval counts only
     if it was cast while the PR's head was the commit it has now — compared on the commit, from the host's
     activity feed, since an update can repeat the same commit. An older approval is reported as "approved before
     the latest changes" and not counted. TAI unapproves nothing on anyone's behalf, and the result is the same
     on a host tier that resets approvals and one that does not.
  2. **No request-changes left standing.** It is a reviewer's tool; only its author can withdraw it. Test
     failures do not use it — a failed tier already blocks the merge.
  3. **Every test tier present on the ticket is Done** (or Canceled). A tier that was never created does not
     block, and a test tier's own PR does not wait on itself.
  4. **A `UAT` subtask present on the ticket is Done** (or Canceled), unless it carries the `uat-after-merge`
     label (TAI-507). No `UAT` subtask, no wait.
  5. **CI**, as before: any commit status that exists must be successful.

  `git-pr merge … force=true` merges past rules 1 to 4 (not CI) and leaves a stamped `Merge-gate override:`
  comment on the PR listing what was not met. It **replaces the old "very minor fix → fix, test, merge"
  judgment rule**: a fix pushed after approval makes that approval stale, so the merge is refused; for a very
  minor fix (a typo or wording, no behavior change) the one merging uses `force=true` and the override is on
  record. For anything else, `force=true` is used only when the human says so. Observed on Bitbucket (scratch
  repo PR 12, 2026-10-08): a withdrawn approval or request-changes disappears from the feed, a request-changes
  replaces the same user's approval, and a PR author can request changes on their own PR.
- **`Dev` → Done has two triggers:** `git-pr merge` transitions the linked `Dev` subtask
  as part of the same call that performs the merge (self-closing, not a separate
  cross-persona action); a refresh-based fallback catches a PR merged out-of-band (a
  human on Bitbucket, or any non-TAI process) — same detected-and-reflected stance as
  this section's own out-of-band-review handling.
- **`git-pr create` links the PR directly to the `Dev` subtask** that opened it, not a
  `CodeReview` sibling — simpler than the flow above, not more complex.

Full detail (required-approval-threshold handling, the new roster, exact refresh
mechanics): TAI-159 ADR (Confluence, TA space page 28704769). TAI-34's ADR (page
13860867) is marked superseded but left in place for history — its out-of-band-human-
action principle is kept and extended above, not replaced.

---

## Appendix: sections 3.7, 4, 5.3 and 7 before they were rewritten as current fact (TAI-512, 2026-10-09)

The four sections as they read before, with their revision narration. Kept for the reasoning.

### Brief §3.7 Recursive Decomposition & Refinement

For large projects, a single decomposition pass is too coarse. Personas can be invoked
**recursively at progressively narrower scope**: the Analyst runs once against the overall
project to propose a breakdown into Epics ("a project of projects"); the **second pass —
scoped to each individual Epic, producing that Epic's Stories/Bugs — has the same shape**
(rev 70, TAI-354; confirmed TAI-457). The Epic gets its own Kickoff Story; Ada proposes the
breakdown in its `Research`; the human probes it and signs it off in `EpicReview`; Perry then
creates the tickets. Perry does not decompose an Epic on her own in one turn (the rev 43
shape, withdrawn). A small Epic still needs only `Research` and `EpicReview`. **Perry
front-loads the Kickoff's known subtasks** — `Research`, `EpicReview`, and `Requirements` and
`UxDesign` when she is pretty sure they are needed — in `Backlog` at initiation and runs
`link-precedence` straight away, so nothing shows as ready ahead of its turn (TAI-457
amendment). The framework does not fix
how many passes happen or where they stop — it fixes that decomposition is a repeatable
persona operation, applicable at whatever scope is handed to it. (This mirrors BMAD's
scale-adaptive planning depth.)

**Scope-level count resolved (rev 37, §8 item 12): no fixed level ladder, no `Initiative`
tier above Epic.** Decomposition is deliberately scope-relative and repeatable rather than
a fixed `Project → Epic → Story` ladder with named levels — if a system genuinely needs
something above Epic, that's a native-Jira concept a business configures on its own
instance, not a new TAI schema type. **Where to stop is likewise not a formula:** "applicable
at whatever scope is handed to it" means a human decides the scope for
each invocation — an inherent judgment call, not something to compute.

Separately, an **already-created Story** may need more detail before implementation
subtasks can be meaningfully created under it. For this, a Story can carry a
**refinement subtask** — e.g. an `Investigate` or `Design` type (§5.2) that routes to
Analyst, Architect, DBA, etc., rather than an implementation-chain type like `Develop` or
`Code Review`. A refinement subtask's output is not code; it's added detail (clarified
acceptance criteria, a design decision, a data model) that lands on the Story's linked
Confluence page, per §4's "who needs to know" comment rule. Refinement subtasks may spawn
further refinement subtasks (e.g. an Architect's `Design` raises a question that needs a
DBA's `Data Design`) but do not spawn implementation chains directly — turning refined
output into actual implementation subtasks is a separate decision (the human's, or Perry's in
grooming, per §3.8), made once the Story is judged ready.

**Rolling-wave decomposition depth: "done" vs. "done enough" (rev 58, TAI-147/148).**
Decomposition/refinement personas (Analyst, PM, Architect) don't uniformly flesh out
every scope-relative pass to full detail. For a large Epic, taking every eventual Story to
fully-specified acceptance criteria before any of them can start would be wasted,
premature effort — the later ones will likely need revisiting anyway once earlier work
informs them — and would delay getting started at all. Instead, decomposition follows a
**rolling-wave** pattern (a real, established project-management term for exactly this):
the full set of next-level items is created immediately, so the whole shape of the work is
visible end to end — but only a **subset is taken to full depth** right now, with the rest
landing genuinely shallow (a name and a one-line scope only) rather than either being
skipped (invisible, no board presence) or forced to premature full detail.

- **What decides which items get full depth now is not a fixed lookahead count** — not
  "the next one," not "the next N." TAI cannot know a team's real capacity/parallelism in
  advance, so a hard-coded count would either starve a team that could handle more in
  parallel or over-commit one that can't. Instead: whatever the real dependency/readiness
  graph (§5.3, `workflows/dependencies.md`) already shows as unblocked gets full depth,
  however many that turns out to be for a given Epic's actual shape — the same "compute
  readiness live, don't guess at it" posture `/tai-ready` itself already uses.
- **Explicit pull-forward stays available**, same as TAI-83's "Eager Subtask Creation"
  exception elsewhere in this brief: a persona or human with a real, concrete reason (e.g.
  requirements overlap with another in-flight project) can take a not-yet-unblocked item to
  full depth ahead of its turn — the same "any persona/human with real in-context judgment
  may act outside the default ordering" principle already established, not a new mechanism.
- **A shallow item already known to need a refinement pass before it's actionable gets
  that refinement subtask created now too**, sitting in `Backlog` alongside the shallow
  parent, not deferred until the parent's own turn comes up — board visibility for
  anticipated work, not just work already starting. This is the Story-level application of
  the same "front-load the whole anticipated chain, not just the first step" principle
  `workflows/dependencies.md`'s Eager Subtask Creation section already establishes at the
  subtask level, extended one level up.
- **No new status machinery needed** — the existing `Backlog`/`To Do` split (TAI-292, §5.3:
  `To Do` iff fully actionable as written, `Backlog` otherwise) already models exactly
  this. Rolling-wave decomposition is an application of status machinery that already
  existed, previously undescribed as a deliberate decomposition-depth strategy.

Concrete instances: `personas/pm.md`'s Epic decomposition (item 5) and Kickoff-time WBS/
issue-creation (item 4), `personas/analyst.md`'s Epic → Story decomposition proposal
(item 4), and `personas/architect.md`'s altitude-inheritance answer (rev 60, TAI-149/328,
Core Principles: "Higher-altitude decisions are binding on lower-altitude work") — a
Kickoff/Epic-level `ArchitectureDesign` is Architect's "full shape now" pass (system-level
invariants, kept minimal), and each Story's own `ArchitectureDesign` is the later,
full-depth pass that inherits it as a binding constraint rather than re-deciding it; a
genuine conflict escalates to the human rather than being silently overridden — see those
files for the persona-specific mechanics.

**Elicitation escalation posture: collaborative by default, more assertive when it isn't
converging (rev 59, TAI-147/148/324).** Elicitation-heavy personas draw requirements out of
the human rather than deciding for them — but escalate to more direct, pointed questions,
including pushing back explicitly on an answer that's too thin to build against (an
unmeasurable acceptance criterion, an unexamined assumption), when a conversation isn't
converging on its own. Ease off once it firms up or the human signals they've had enough
for now (an explicit "good enough," visible fatigue). Calibrated to stakes — a one-line
bug-fix Story doesn't warrant the same pressure as a Kickoff-level PRD or Epic
decomposition, the same right-sized-output judgment each persona already applies to depth
of *output* applied here to depth of *elicitation*. First established for PM's PRD drafting
(rev 58, TAI-147/148: Fast-path/Coaching-path pace choice, escalating within whichever path
if things stay vague); promoted to a shared posture here once Ada's own review confirmed it
applies the same way to her Kickoff discovery, decomposition, and refinement work — and
Uma's own review (rev 61) confirmed the same for her Kickoff-time flow/wireframe
elicitation, alongside a sharper "elicits, doesn't impose" principle (never volunteers a
color, pattern, or visual direction unprompted — the vision being drawn out is the human's,
not Uma's).

Concrete instances: `personas/pm.md`'s PRD drafting (item 2), `personas/analyst.md`'s
Kickoff discovery, decomposition, and refinement (items 2/3/4/5), and
`personas/ux-designer.md`'s Kickoff flow/wireframe development (item 1).

### Brief §4. Established Design Decisions

These are settled. Change them deliberately and update this file if you do.

- **Language/runtime:** TypeScript on Node.js 20+. ESM (`"type": "module"`, `NodeNext`
  module resolution). Rationale: Claude Code and the Atlassian MCP ecosystem are TS-first;
  static interfaces make the storage-plugin contract compiler-enforced. Python may be used
  for isolated utility scripts invoked as subprocesses, as needed — not as the core.
- **Repo layout:** single repo, segmented by folders (core, storage adapters, personas,
  workflows, commands).
- **Personas:** configurable default set; built-ins disableable but not deletable;
  extensions add to (never fully override) built-ins; extensions shared via Confluence.
- **Persona responsibilities are configurable:** which issue types each can create, work
  on, complete, update.
- **Human sign-off is the default;** autocompletion is opt-in and condition-gated, per
  persona / per task type / per issue.
- **A persona can never approve its own work.** In a *team* setting this is the norm and is
  ultimately enforced by the business/process — for now our code does not hard-lock it,
  because a **solo developer legitimately reviews their own work.** (Revisit if we add
  org-level enforcement.) **Scope resolved (rev 31, §8 item 3): the same-human dimension,
  not persona role** — workflow routing already guarantees a different persona role
  reviews any given persona's output, so self-approval can only happen when one human
  fills both roles (the solo-dev case named above). **What review separation means in
  practice (TAI-458):** the reviewer is a human — one on the "PR Reviewers" roster for a
  PR, the human closing a `DesignReview` for a design. The AI prepares the findings or
  review notes and the human decides. A fresh context is preferred for preparing them, not
  the session that wrote the work under review (making that the default is TAI-469).
- **Checkpoints are enforced in Team AI's plugin layer,** not via native Jira validators
  (see §3.3). Checkpoints override autocompletion.
- **A Jira-rejected transition is an unplanned checkpoint, not a normal failure.** Team AI
  always attempts the real Jira transition after its own checks pass; if Jira itself
  rejects it, work stops, the reason is journaled, and it escalates directly to a
  human — this case skips the single-retry pattern used for review failures, and is
  enforced once in the storage plugin's `transition` operation rather than per-persona
  (§3.3).
- **Learning from Jira rejections is deferred, not v1.** The core escalation behavior
  (attempt → reject → unplanned checkpoint → human, no retry) is required now. Closing the
  loop so a discovered constraint isn't rediscovered every time — proactive metadata
  checks, a proposed/confirmed constraint cache, human promotion — is an explicit
  follow-on refinement. What promotion changes (persona extension, workflow adjustment, or
  something else) is intentionally undecided until that refinement is scheduled (§3.3,
  §8.15).
- **Branching:** adopt GSD's configurable strategies (`none` / `phase` / `milestone`
  equivalents) plus git worktrees for parallel isolation. The standard **work unit is a
  Jira Story or Bug**; branch names are based on the **parent issue** (e.g.
  `PROJ-123-short-desc`), not on subtasks. Subtasks accumulate onto the parent's branch.
- **Failed-checkpoint retry:** an AI persona may retry a fix once; if it fails again, a
  human must get involved. Context passed back and forth (e.g. reviewer → developer) is
  recorded as **Jira comments.** Comment placement follows a "who needs to know?" rule:
  if only the subtask's owner needs it, comment on the subtask; if multiple parties need
  it, comment on the parent. **Triage ownership resolved (rev 32, §8 item 5):** routing a
  failed checkpoint's retry isn't a discretionary act — the destination is already fixed
  by the workflow's documented loop-back structure (§5.3's Dev ⇄ Test,
  ArchitectureDesign ⇄ DesignReview, UAT rejection routing) and the retry-vs-escalate call
  is already fixed by the single-retry counter above. It's deterministic plugin-layer
  mechanics, not a judgment call requiring Orchestrator persona permission.
- **Multi-repo:** a Story/Bug can touch **multiple repos**; a **subtask targets exactly one
  repo.** Each repo touched gets its own dev → review → merge/deploy subtask chain under the
  Story. **Decided (rev 11):** the affected repo is tracked via Jira's **native Component**
  field, not a custom field — reuses existing Jira mechanics rather than provisioning a new
  one. **Population is derived-with-manual-fallback:** a commit message beginning with the
  Jira issue key (§6) is used to look up the touched repo and auto-populate Component; a
  human or persona can still set/correct it manually before any commit exists yet (e.g. at
  subtask creation, or if the automation can't resolve it).
- **Confluence:** one Confluence space per Jira project. The space key is **configured, not
  derived** — it is **not** safe to assume it equals the Jira project key.
  - *Corrected (rev 18).* Rev 11 asserted "the space key matches the Jira project key"
    (`PROJ` → `PROJ`). That is **false in practice, and false on this very project**: TAI's
    own Confluence space is keyed **`TA`**, not `TAI`. Confluence derives a space key from
    the space *name* at creation time and will happily shorten or disambiguate it, and a
    human can rename it afterwards — so the two keys drift for reasons entirely outside
    TAI's control. The mismatch went unnoticed for six revisions because the MCP tooling
    resolves a space by *name*, silently masking it. Any code that computes a space key from
    a project key is therefore wrong: **`projectKey` and `spaceKey` are separate config
    values**, and the storage backend takes both.
  Pages link to the Jira item that **needs that page as input.** Pages tie to the
  **parent** issue (Story or Epic — whichever the content is actually scoped to; e.g. an
  Epic-level decomposition proposal ties to the Epic itself, while a Kickoff's PRD/UX
  flows/WBS tie to the Kickoff **Story** beneath that Epic), **never to subtasks.**
  Jira↔Confluence linking is the source of truth; we keep a local filesystem cache of
  those links, refreshed as needed. A doc needed by more than one ticket is **linked via
  `RelatesTo`** to the additional ticket (same bar as any other `RelatesTo` link,
  `workflows/dependencies.md`) rather than duplicated or moved to a shared ancestor.
  - **Granularity (rev 11):** one page per persona-output instance (one ADR, one PRD, one
    test-plan, …) — matches the granularity already implicit in every persona's
    `confluenceOutputs` list. The UX Designer's wireframe/wireframe-index split (one page
    per screen + an index) is the one documented exception, since a single UX flow can
    span many distinct screens — not a new general default.
  - **Folder structure (rev 11):** organized **by doc-type** within the project's space
    (an ADRs folder, a PRDs folder, a Test Plans folder, …), not by ticket hierarchy.
  - **Naming convention (rev 11):** page titles are structured —
    `<JIRA-KEY> — <Doc Type>: <short description>` (e.g. `PROJ-123 — ADR: Async job
    queue`). Unlike a Jira issue (whose native issue-type icon already distinguishes it
    in every view), a Confluence page has no equivalent type-icon affordance in its page
    tree or search results — the key and doc type need to be visible in the title itself
    for a human scanning a page list to know what's what.
  - **Config-type content (rev 13):** the Persona Roster (§5.6) and persona extensions
    (§3.1) aren't tied to any single ticket, so the `<JIRA-KEY> — <Doc Type>: …` naming
    convention above doesn't apply to them — there's no ticket key to put in the title. They
    get their own top-level **`Config`** folder in the project's space (sibling to the
    doc-type folders above), with plain descriptive titles (`Persona Roster`, and future
    persona-extension pages named after the persona).
  - **Human edits to an already-gated doc (rev 11):** editing a Confluence page backing
    an already-passed `ReviewGate` (e.g. the PRD, after the Kickoff PM+UX gate already
    signed off) **reopens that gate** — TAI flags it and requires re-approval before
    further downstream steps depending on that gate proceed. An `Approved:` sign-off
    means something about the content actually reviewed, not just that a comment once
    existed.
- **Human-gated steps are conventions, made visible (TAI-454/475).** The CLI and the human share one
  Jira/Bitbucket identity, so TAI cannot prove who performed an action. A human-only step (a UAT, EpicReview or
  DesignReview sign-off, a Kickoff `Approved:` comment, a PR approval, closing an Epic) is therefore a
  convention the **user is accountable for**: a persona performs one only when the human says so in their own
  message. TAI makes the difference visible instead of pretending to enforce it — every comment the CLI posts
  ends with a stamp line, `Posted via the TAI CLI as <Name> (<persona id>).` (or `Posted via the TAI CLI.` when
  the command named no persona, TAI-477), and a sign-off made through the CLI leaves a stamped `Sign-off:`
  comment (`storage/stamp.ts`). A comment or sign-off with no stamp was made directly, in the Jira or Bitbucket
  UI. The stamp says only what the CLI knows: it cannot tell an AI session from a human typing the command.
- **Writing Jira descriptions and comments (TAI-475, TAI-504).** A ticket description and a comment body are
  both sent as Jira wiki markup, not markdown: a blank line makes a paragraph and `* item` a bullet. They are
  read by people, so write them for reading: a short opening paragraph that says what the ticket is for, a
  blank line between paragraphs, and bullets when there are several items — scope, steps, acceptance points,
  things checked. Never one dense paragraph. On a comment, the stamp goes on its own last line and is added by
  the CLI, never typed. The CLI backs this with a note, not a refusal: after `issue create`, `issue update` or
  `issue comment` writes text with an unbroken paragraph of more than 500 characters, it says so and names the
  command that rewrites it. Every persona doc carries a one-line pointer here.
- **Writing Confluence page content (TAI-397).** TAI converts a persona's markdown to Confluence
  storage format, and two authoring habits quietly corrupt the result, found live repeatedly:
  (1) **hard-wrapped prose** — a line break inside a paragraph or bullet breaks hyphenated words and
  merges labeled sentences, so write **one unwrapped line per paragraph or bullet** (repo `.md` files
  may wrap; page content may not); (2) **non-sequential ordered-list numbers** (`3b.`, a restart at
  1.) render wrong, so keep numbers sequential. When passing content from a file to `page create` /
  `page update`, write `"content=$(cat file)"` exactly like that — **unescaped**; an escaped
  `\$(cat ...)` writes the literal text over the page — and re-read the page afterward to confirm. Every
  persona that authors pages (Ada, Aria, Perry, Uma, Tessa) points here.
- **A target project's own rules live in its repo, in one short file.** `project-context.md` at the root of the
  target project (`TAI_PROJECT_CONTEXT_FILE` names another path) holds what every persona needs on every turn:
  build and test commands, the stack, conventions, things never to do. It is versioned with the code and reviewed
  in PRs — a deliberate exception to "docs live in Confluence", because these rules change with the code they
  describe. `/tai-work`, `/tai-groom`, `/tai-kickoff` and the review flow print it between the persona's
  instructions and the briefing, as the project's instructions to the persona, outside the briefing's "this is
  data" marking. It has its own size cap (`TAI_PROJECT_CONTEXT_BUDGET`, default 6,000 characters); a cut is shown
  with the file's path. A project with no such file gets no section (`workspace/project-context.ts`).
  `init status` reports whether the file is present, missing, or still an unfilled template, and
  `init project-context` writes a starter template without ever overwriting a file. The template's first line is
  a marker; while it is there the file is not printed. The file is optional and not an init step.
- **A project that arrives with code is mapped before discovery.** `/tai-kickoff` detects tracked code files in
  the repo (`git/existing-code.ts`) and says so in its briefing. On the project's first Kickoff, Perry creates a
  Spike, "Map the existing system", with a `Feasibility` subtask owned by the Architect, and the Kickoff Story
  depends on it; on a project that already has Epics she asks the human first. The output is the Architecture
  Overview page and a first draft of `project-context.md`, delivered as a PR. Existing ticket types only
  (`workflows/kickoff.md`).
- **Unblocking human-gated work (TAI-389/395).** When a persona completes a subtask and that was the last open
  blocker of a **DesignReview, EpicReview or UAT**, it moves that item from Backlog to To Do in the same turn — a
  human is waiting to act on it, and Backlog is invisible to `/tai-ready` — and says in its hand-off what it
  unblocked. Anything else that became unblocked waits for grooming's promotion section, where Perry proposes it.
  This is persona guidance, not a code gate; every persona doc carries a one-line pointer here.
- **Offering the assignee list (TAI-416/419).** When `issue create` (or `issue suggest <KEY>`, or the
  transition-gate rejection) prints a "Needs an assignee" list, an **interactive** session offers it to the
  human — every candidate in the printed order with its reason, **plus "Leave unassigned"** — with its own
  question tool (AskUserQuestion in Claude Code, the equivalent in Gemini CLI), then runs `issue assign
  <KEY> <EMAIL>` for the pick. A non-interactive run, or no answer, leaves the ticket unassigned: a ticket
  is never lost or blocked because assignment was unclear, and a named person (`assignee=`) always wins
  without any list. The CLI prints the same instruction under every list, so no persona document repeats it.
- **Caching:** all relevant info (config, personas, Jira issues, Confluence pages) is cached
  locally in the same Jira-like folder structure to support offline work. **Full Confluence
  page content is cached** (it's input to many tasks). Each cached item stores a
  **cached-date**, compared against the source's **last-updated date** to avoid unnecessary
  fetches. Refresh happens: manually on demand, and automatically the first time an item is
  used in a session. **Before saving a locally-edited Confluence page or Jira item, always
  fetch first and warn with a diff** so the user can resolve conflicts (no silent
  overwrite).
- **Issue types:** Epics do **not** hold subtasks directly. Hierarchy is
  **Epic → Story/Bug → Subtask.** We will use **distinct Story-level types** (e.g. Spike,
  Research, Bug, Implementation — names not final) so a human scanning the backlog can tell
  the kind of work at a glance. New types can be introduced as needed.
- **Subtasks are typed too, not generic.** Type is what routes a subtask to a persona
  (e.g. `Dev` → Developer, `CodeReview` → Code Reviewer). Like Story types, this is an
  open, extensible taxonomy — see §5.2 for the current set, which has evolved past the
  original candidate names and now includes the DBA/DevOps routing types.
- **Decomposition is recursive, not one-shot.** The Analyst (or another persona) can be
  invoked at Project scope to propose Epics, then invoked again scoped to each Epic to
  propose Stories — the same operation applied at progressively narrower scope (§3.7).
- **Refinement subtasks** let a Story get more detail before implementation subtasks are
  created under it, via a subtask routed to Analyst/Architect/DBA/etc. rather than
  Dev/Review/Merge. Their output is documentation/decisions, not code, and does not itself
  spawn implementation work — that remains a separate human/Orchestrator decision (§3.7).
- **Persona outputs and processes must generalize to unknown future target projects, not
  stay TAI-specific (rev 57, TAI-317).** TAI exists to manage *other* projects, not just
  itself (§1) — when scoping a new persona output type or capability (a new Confluence doc
  type, a new subtask type, a new checkpoint), the design question is "does this work for
  whatever project TAI is pointed at," not just "does this work for TAI's own single-repo
  TypeScript shape." A concrete first-pass mapping onto TAI's own project is fine, but the
  underlying *process* — which parts of a candidate structure apply, how to reframe or mark
  N/A the parts that don't for a given project's actual shape — must be captured as
  reusable persona guidance, not left baked into a one-off TAI-specific doc. Raised live
  during TAI-307's architecture-overview-doc scoping. `personas/analyst.md`'s Project Home
  Page and `personas/architect.md`'s Architecture Overview already model this explicitly
  and are the reference examples for future output types.
- **Future-direction/extensibility awareness during elicitation (rev 59, TAI-147/324).**
  During Kickoff discovery, decomposition, or refinement, a persona stays alert for scope
  that touches a genuinely costly-to-change-later decision (e.g. a data model or tenancy
  shape that would be expensive to retrofit) and surfaces it as an explicit question —
  "what does this need today, where might it go in 3/6/12 months" — rather than silently
  scoping to only the immediate ask. This is discovery-time *awareness*, not speculative
  building: the answer becomes a scope/requirements fact (a Future Considerations entry in
  PM's PRD, `personas/pm.md`'s Outputs), never an implementation decision — a
  technical direction question (e.g. "should the datastore scale horizontally") still hands
  to the Architect as usual. No fixed checklist of domain areas to probe — which areas are
  worth raising is inferred from context, since a table can't anticipate every project's
  actual shape (reconciled directly against this same bullet's own anti-premature-
  abstraction posture: probing costs little, building unrequested flexibility does).
  **This awareness isn't limited to whatever's the explicit topic of the current ask
  (sharpened rev 63, Dana's/TAI-152 persona review):** when a persona is looking at a
  broader artifact (a schema, a proposed decomposition, an architecture) while working
  the immediate piece of it, it scans adjacent parts of that same artifact it already has
  in view for the same class of costly-to-change-later risk, not just the piece directly
  in front of it — e.g. a DBA designing one table's schema who notices an adjacent table
  in the same design has an analogous extensibility gap raises that too, not just the
  table she was asked about. This is peripheral awareness of what's already visible while
  doing the work, not a mandate to go auditing unrelated parts of the system — same
  right-sizing instinct as the rest of this bullet. When a
  persona is unsure whether something clears the "worth raising" bar, it asks the human
  whether they want to explore future-direction thoughts here at all, rather than deciding
  unilaterally to raise or skip it. Reserved at rev 57/58 for Analyst's and Architect's own
  persona reviews to work out the concrete mechanics — `personas/analyst.md` landed it
  first (rev 59, items 2/3/4/5); `personas/architect.md`'s own version (rev 60,
  TAI-149/328) differs where the two personas' work differs: Aria's trigger fires only
  during Kickoff-early or Story-level `ArchitectureDesign` (not Feasibility's time-boxed
  scope, not the WBS batch scan), she asks the human directly rather than routing through
  PM/Ada, and the answer gets dual-recorded — grounding context in her own ADR, plus a
  `Requirements` subtask handed to PM (TAI-83 exception) for the PRD's Future
  Considerations entry, since that document isn't Aria's own output type.

---

### Brief §5.3 Statuses & Dependencies

Issues carry statuses (pending / in-progress / done, plus blocked/ready as derived from
dependencies) and **"blocks / depends-on"** links that determine what is ready to be picked
up vs. blocked. The default status lifecycle is
**`Backlog → To Do → In Progress → Done`** for both story-level tickets and subtasks, with specific
per-type loop-backs documented in `workflows/story.md`/`bug.md` (Dev ⇄ Test,
ArchitectureDesign ⇄ DesignReview, UAT rejection routing). "Ready" vs. "blocked" is
**derived**, not a stored status — computed from `SUBTASK_PRECEDENCE`
(`isSubtaskReady()`/`resolveApplicablePrecedence()`, `schema/story-schema.ts`). The same graph is
**enforced when a subtask is started** (TAI-476, `storage/precedence-gate.ts`): `transition()` refuses the
start while a present subtask upstream is open, a test tier or UAT may start once `Dev` has started, and
`force=true` is the human's override, recorded as a comment on the ticket. Still
open: whether a business ever needs to customize this default lifecycle per-project,
beyond the built-in loop-backs already modeled.

**Naming and `In Review`, corrected against the actual Jira project (rev 15):** the
status is natively named **`To Do`**, not `Open` — cosmetic, but this doc now uses Jira's
real name rather than a made-up one. More substantively: Jira's default shared workflow
carries an **`In Review`** status on *every* issue type by default, not just Kickoff — it
isn't practical (or worth the ongoing maintenance) to give Kickoff a separate workflow
just to withhold one status from every other type. Consistent with §3.3's "TAI's own
plugin layer is the enforcer, not native Jira" philosophy: `In Review` being *available*
on a Story/Bug/Spike/subtask is harmless — TAI's own logic decides which transitions are
meaningful for a given type and never drives a non-Kickoff ticket into it. Only Kickoff's
workflow (`workflows/kickoff.md`) actually uses it.

**`Canceled` (rev 16) — a second terminal state, for work abandoned before completion.**
Gap found while reconciling against the real Jira site: no status for "we decided not to
do this" existed anywhere (confirmed via the site's full Statuses admin list — nothing to
reuse, a genuinely new status). Applies to **every issue type — story-level tickets and
subtasks alike** — not just the Spike outcome that surfaced it (`workflows/spike.md`'s
"cancelled/deferred" outcome previously had no distinct status to land in; it was marked
`Done` with the outcome buried in a note, which this fixes). Reachable from `To Do` or
`In Progress`, terminal like `Done`.
- **Precedence treatment:** a `Canceled` subtask counts as **satisfied** for
  `SUBTASK_PRECEDENCE` purposes, same as `Done` — it unblocks dependents rather than
  leaving them permanently stuck (`isSubtaskReady()`, `schema/story-schema.ts`; the
  function already takes a caller-supplied "done" set rather than hardcoding a status
  string, so no code change is needed there — just documenting, here and at the call
  site, that "done" for precedence purposes means `Done` **or** `Canceled`).
- **Status category:** create it under Jira's **`Done`** category (not `To Do`/
  `In Progress`) — Jira only has three status categories, and `Canceled` is terminal
  work, not pending work, even though it isn't "completed" in the original sense.
- Like the other statuses (§5.3 above), this is a manual Jira admin step (Issues →
  Statuses → Add status, then add it to the actual workflow) — no MCP tool creates
  statuses.

**`Backlog` (rev 27) — a new PRE-`To Do` status; the default landing status for newly
created tickets.** Added by the user directly in the live Jira project (manual admin
step, same as `Canceled`). Distinct from a "blocked" ticket in the existing derived-
readiness sense (§5.3's `SUBTASK_PRECEDENCE` machinery, unchanged and orthogonal — that's
about a subtask waiting on a *sibling* subtask within an already-active Story) — `Backlog`
is a coarser, upstream gate about whether a ticket should even be considered part of the
active pipeline yet at all. A ticket sits in `Backlog` when it's newly created, has an
incomplete spec, is blocked by something outside the precedence graph (another Story, an
external dependency), or a human/process has otherwise judged it "not ready." Native Jira
behavior, not something TAI enforces: `Backlog` items don't appear on the Kanban board.

- **Lifecycle position:** `Backlog → To Do → In Progress → (In Review) → Done/Canceled`.
  `To Do` is reached only once a ticket is judged ready. `Backlog → Done`/`Canceled` directly
  (skipping `To Do`) is also valid, for a ticket that turns out unnecessary before ever
  becoming ready.
- **Default landing status:** any newly-created ticket lands in `Backlog`, not `To Do` —
  Ada's proposed Epic/Story decomposition output, PM-created Story/Bug/Spike from a WBS
  (§3.1), a refinement subtask's own output.
- **Status category:** Jira's **`To Do`** category (not a new one) — matches how Jira's
  own default Kanban/Scrum templates categorize a `Backlog` status; it's still pending
  work, just not yet actionable.
- **Readiness gate (`Backlog` → `To Do`) is a SOFT convention for now, not a hard-enforced
  gate.** Unlike §5.5's assignment gate (rev 19, hard-enforced in `transition()` because
  "has a human assignee" is a crisp boolean) — "ready" here has no single crisp signal yet
  (spec-complete, unblocked, and human/process-judged are three different kinds of check).
  A human (or a persona, once one exists with the authority to judge readiness) moves a
  ticket `Backlog → To Do` manually; TAI's plugin layer does not currently gate this
  transition. **Resolved (rev 29, §8 item 28): stays soft indefinitely** — no hard gate
  planned; revisit only if a concrete "left `Backlog` too early" incident actually occurs.
  **Refined (rev 57, TAI-292, 2026-09-03): a persona creating a subtask now IS one of
  those "authority to judge readiness" cases, narrowly** — lands the subtask directly in
  `To Do` instead of `Backlog` iff its description is fully actionable as written (no
  further scoping/triage needed first); otherwise still `Backlog`, unchanged. See
  `workflows/dependencies.md`'s "Initial Status & Priority for a Created Subtask" for the
  full rule, including the companion priority decision (a created subtask's `Priority`
  field is now always explicitly written to match its parent's, not left to `tai-ready`'s
  display-only fallback).
- Applies to **every issue type — story-level tickets and subtasks alike** — same scope
  as `Canceled` (rev 16), for the same reason: a subtask can just as easily be created
  ahead of its own readiness (e.g. a `Database` subtask flagged during Architecture work
  but not yet detailed enough to start, `workflows/dependencies.md`'s "Dynamic Subtask
  Insertion" section — corrected rev 36, previously mislabeled "§7's" note) as a
  story-level ticket can.

**Epic status (rev 28) — `In Progress` is derived from children; `Done` is never
auto-derived, always a deliberate human decision.**

- **`In Progress` is a simple derived signal (rewritten rev 71, TAI-374/387):** an Epic reads
  `In Progress` once real BUILD work has started under it — a non-Kickoff child (Story, Bug,
  Spike) reaching `In Progress`/`In Review`, written by the shared cascade gate. A child merely
  in `To Do` does not make it `In Progress`; instead a non-Kickoff Story reaching `To Do`
  schedules a Backlog Epic to `To Do` (the To Do cascade), and a **Kickoff Story never moves
  its Epic in either direction** — an epic's own Kickoff is refinement, so an Epic in `Backlog`
  may have its Kickoff running (`Backlog` = proposed and being fleshed out, `To Do` = approved
  to build). Coarse by design — this isn't a percentage-complete rollup, just a
  proposed/approved/building signal.
- **Waiting work is marked, not given a status (TAI-390):** `To Do` means scheduled to start now.
  Work waiting on another ticket carries a `depends-on` link, a later phase a `phase-N` label, and
  work waiting on something external with no ticket carries Jira's **Flag** (`Issue.flagged`).
  A flagged `To Do` ticket is not Ready Work (`/tai-ready` lists it under "On hold (flagged)");
  unflagging returns it.
- **`Done` is NOT derived from "all current children are `Done`/`Canceled`."** That's a
  false-completion trap: Epics are open-ended thematic groupings (§5.1: "a feature set"),
  and more Stories can always be decomposed under one later — brief §3.7's own recursive-
  decomposition model assumes exactly this. TAI-9 ("Source control & multi-repo") is the
  concrete proof already sitting in this project's own history: its GitHub `GitHost`
  backend was explicitly deferred (§8.19's ADR decision), so "every currently-decomposed
  child finished" did not mean "nothing more is coming" — the Epic correctly needed to
  stay open rather than auto-closing the moment its first (Bitbucket-only) slice shipped.
- **Epic → `Done` requires an explicit human judgment call:** someone decides "no more
  Stories are realistically planned under this Epic" and transitions it manually. A
  persona (PM, most naturally, given its role proposing/creating story-level tickets,
  §3.1) MAY propose that an Epic looks complete, but never self-closes it — the same
  "human sign-off is the default" posture as everywhere else (§3.4). Not a joint
  two-persona gate like Kickoff's PM+UX sign-off — that pattern exists because a PRD+UX-
  flow artifact has two genuinely distinct expert concerns; a single "is more work coming"
  judgment doesn't need two reviewers.
- **Explicitly deferred, not v1:** any automated "surface candidates for review" nudge
  (e.g., a saved query for "all children `Done`/`Canceled`, no activity in N days") —
  plausible future quality-of-life tooling, not an enforcement mechanism, and not
  scheduled until a real need for it appears (same "don't build ahead of an observed
  need" reasoning used throughout this brief).

### Brief §7. Local Cache & Workspace Layout

A `.tai/` directory (gitignored) holds two distinct things: a **cache** (raw mirrored
Jira/Confluence data) and a **workspace** (active work-in-progress state, keyed by
subtask). Keeping these separate matters — the cache is disposable and always rebuildable
from source; the workspace holds state that may not exist anywhere else yet.

```
.tai/
  cache/
    <project-key>/
      config/                    # project + workflow + persona config
      personas/                  # cached persona extensions (from Confluence);
                                  #   roster.json (rev 12) — the Persona Roster (§5.6),
                                  #   cached from its Confluence page (Jira backend) or
                                  #   read directly (filesystem backend)
      issues/
        <ISSUE-KEY>.json         # raw cached issue (epic/story/bug/subtask), + cachedAt;
                                  #   comments are part of this payload, not separate files
        <ISSUE-KEY>/attachments/ # cached attachments/images, fetched lazily on first use (rev 11)
      confluence/
        <PAGE-ID>.md             # raw cached page content, + cachedAt; comments likewise
                                  #   part of this payload (§3.9 for the Q:/Approved:/
                                  #   Rejected: marker convention that reads them)
        <PAGE-ID>/attachments/   # cached images/diagrams, fetched lazily on first use (rev 11)
      links/                     # cached Jira↔Confluence link index
      last-sync.json             # checkpoint timestamp for the bulk "what changed since
                                  #   last sync" JQL/CQL query (rev 11, see below)
      discovered-constraints.json  # DEFERRED (§3.3) — not built in v1
  work/
    <project-key>/
      <SUBTASK-KEY>/
        briefing.md              # aggregated snapshot: subtask + parent (state, links,
                                  #   comments) + linked Confluence pages and tickets,
                                  #   size-capped, regenerated at each refresh point
        journal.md                # append-only log of steps taken + intermediate results
        status.json                # structured state: current step, in-progress/blocked/
                                    #   done, last-updated
  status.json                     # root-level rollup of in-flight subtasks (see below)
```

**Refresh & briefing (§3.6):** cached items store `cachedAt`, compared against the source's
`lastUpdated`. Refresh happens at defined points — starting/resuming a unit of work, and
first use of an item in a session — not live. Each refresh regenerates that subtask's
`briefing.md` from the freshly-checked cache. Before saving any local edit back to a Jira
item or Confluence page, always fetch first and warn on conflict (per §4) — never
silently overwrite.

**Work journal:** `journal.md` is append-only, one entry per step, each with a timestamp
and enough detail to resume mid-task after an interruption. It is the record of *what
happened*, distinct from `briefing.md` (context going in) and `status.json` (current
state).

**Unit-of-work keying:** every unit of work below the initial brainstorming/setup phase is
tied to a Jira **subtask**, and the subtask key is the folder name for its cache/workspace
files (§4). **Resolved (rev 36, §8 item 11): there is no pre-subtask phase to give a home
to.** The premise is declined — a persona creates the subtask as its first action, before
doing any exploration/brainstorming, so journaling/caching always has a key to hang off of.
This composes with **who may create a subtask** (§3.1's per-persona `create` permission,
per issue type): any persona authorized to create a given subtask type may do so directly
and proactively — PM pre-creating a Story's whole known `Dev`/`CodeReview`/`Deploy` chain
up front, or a `SpikeTask` assigned at creation — the same "present-when-added" pattern
already used for optional subtasks (`DesignReview`, `UAT`, `PostDeploy`, …) covers a
subtask recognized as needed only mid-flight. **Story-level ticket creation is different
and unchanged:** it keeps the existing **propose → PM confirms/creates** pattern (DevOps
proposing a post-deploy Bug, Spike outcomes, Ada's Epic/Story decomposition) — a persona
discovering the need for a whole new Story doesn't create it directly, only proposes it.
Precedence-graph wiring for a subtask inserted mid-flight is already solved, not something
a human/persona manages by hand — see `workflows/dependencies.md`'s "Dynamic Subtask
Insertion" (`getNewPrecedenceEdgesForInsertedSubtask()`, `schema/story-schema.ts`).

**Root status file:** `status.json` at the repo root is a **rollup/index**, not an
authoritative source — it is itself a cache, of the same kind as everything else in this
layout. It is built by scanning `.tai/work/**/status.json` and carries its own
`generatedAt`.

**Staleness rule resolved by implementation (rev 35, §8 item 10, TAI-56 ADR decision 6):
there isn't one — always a full rescan on demand, never a TTL or trust-until-mismatch
check.** `rollupStatus()` (`src/core/workspace/status.ts`) doesn't compare `generatedAt`
against anything; it rescans `.tai/work/**/status.json` and overwrites the root file every
time it's called. Unlike the Jira/Confluence cache (where staleness checks exist to avoid
unnecessary *network* calls), this rollup only reads local files TAI's own process just
wrote — no network cost to avoid, so nothing to gate a skip on. **Still open:** *when*
`rollupStatus()` is invoked automatically (session start? every command? explicit refresh?)
— unresolved because no CLI/command layer exists yet to wire a trigger into; nothing calls
it outside its own tests today.

**Bulk change detection & explicit offline sync (rev 11):** the per-item `cachedAt`-vs-
`lastUpdated` check above answers "is *this* item stale" but not "what changed while I
was away." For that, TAI runs a bulk **JQL** (`updated >= "<last-sync>"`) / **CQL**
equivalent query at defined refresh points, using `last-sync.json`'s checkpoint —
reusing native search rather than polling every cached item individually. Day-to-day
refresh stays **lazy** (on-demand, or first use in a session, per §4's existing rule);
on top of that, an explicit full-sync command lets someone about to go offline (flight,
no wifi) eagerly prime the whole project's cache once, rather than discovering gaps
mid-flight.

**Attachments (rev 11):** images and other attachments (wireframes, diagrams) are cached
the same lazy way as everything else — fetched and stored under the owning issue's or
page's `attachments/` folder on first use, not proactively for the whole project. This
matters specifically for UX/diagram-heavy docs, where the image often *is* the content.

**No cache locking, no eviction (rev 11):** the cache is disposable and always
rebuildable from source (this section's opening line) — if two sessions write the same
cached file concurrently, whichever write lands last simply reflects the most recently
fetched state; nothing authoritative lives only in the cache, so this isn't a corruption
risk worth solving for. (Two humans working the *same* subtask concurrently is a
claiming/assignment question, §5.5, not a cache-locking one.) Nothing is pruned from
`.tai/cache` for v1 — not worth building ahead of an observed need.

*(Exact structure is provisional and will be finalized when the filesystem storage adapter
is designed.)*

---

---

## Appendix: brief passages reworded when the revision labels were removed (TAI-520, 2026-10-09)

Each block is a passage as it read before. Simple label removals, such as "(rev 11)" after a heading, are not listed.

```text
  - **Not the Atlassian Remote MCP Server** (`https://mcp.atlassian.com`) — this was the
    original design (revs 1–16) and it does **not work** for TAI. Tested live (rev 17, Jira
    `TAI-16`): authentication is fine
```

```text
**Operation set resolved by implementation (rev 33, §8 item 7):** `src/core/storage/
interface.ts` defines
```

```text
> *(Corrected: an earlier revision of this note also claimed the wrapper inverted issue-link
> direction. It does not — it passes `inwardIssue`/`outwardIssue` through faithfully. The
> error was in reading Atlassian's docs, not in the wrapper. Ground truth, verified against
> the live API: for the `Blocks` link type, the **inward** issue blocks the **outward** one.)*
```

```text
**Design resolved (rev 25, TAI-41 ADR, §8.9/§8.22/§8.23):** `AutocompletionCondition
```

```text
**Implemented (rev 26):** checkpoint/review-gate enforcement (TAI-42, `review-gate.ts`) is
wired directly into `transition()` on both backends. The autocompletion decision engine
itself (TAI-43, `autocompletion.ts`) is built and tested as a standalone pure-function
module — `checkpointKind`, `evaluateAutocompletion`, `parseCompletionMarker` — but
deliberately **not yet called from anywhere**: its own module doc explains why, whether
an Orchestrator pauses for a human before invoking it or proceeds automatically is an
orchestration decision that belongs to Epic TAI-6, not this engine. TAI-52 (Epic TAI-6's
first Story) built the permission layer (`PersonaScopedWorkTracker`) that a future caller
will sit behind, but the actual call site — something invoking `evaluateAutocompletion`
and acting on its verdict — still doesn't exist; that's TAI-8's persona-invocation loop.
```

```text
**Resolved (rev 11): there is only one sense of "workflow" — the per-Story-type process,**
documented in `workflows/*.md` for **Kickoff**, **Story**, **Bug**, and **Spike**. The
earlier idea of a separate, named "scenario" layer (`complete`/`quick`/`bugfix`,
configuring which personas participate and what each does) was considered during the §4
workflow-design pass and **dropped as unnecessary** — it turned out to already be absorbed
by the story-type + optional-subtask design:
```

```text
of work, when **completing** one (rev 41, §8.10 — refreshed before the completion decision
itself,
```

```text
**Review has no ticket entry (rev 78, TAI-425).** The `CodeReview` subtask is retired (rev 52), so the Code
Reviewer
```

```text
### 3.9 Comment Conventions (rev 11 — formalized here, previously design-notes-only)
```

```text
| CodeReview | Code Reviewer | Implementation gate — **retired going forward, rev 52 (TAI-159 ADR, §5.4)**; kept in the schema only to parse historical tickets |
```

```text
(renamed from `Spike`, rev 12 — collided with the `Spike` **Story**-level type; Jira issue-type names must be unique site-wide)
```

```text
**How review, readiness and the merge work (rev 52, TAI-159 ADR; merge gate TAI-462):**
```

```text
TA space, page 28704769). The earlier chains this replaced — the original Develop → Code Review → Merge/Deploy
subtask chain and the rev 21 `CodeReview`-subtask flow (TAI-34 ADR, page 13860867, marked superseded) — are in
`CHANGELOG.md`.
```

```text
**Test-tier subtasks (rev 48, revised TAI-456):** a test
```

```text
repo**, each subtask tagged with its repo via the native Jira **Component** field (§4,
rev 11 — not a custom `repo` field).
```

```text
TAI does **not blindly guess**, and (rev 75) **does not assign the session's human at creation
  either**
```

```text
At **claim and transition time** the rev 54 shortcut stays: when a ticket
```

```text
### 5.6 Human Registry & the Two-Axis Owner Model (rev 12)
```

```text
it has no default human Assignee (rev 74: the defaults above are applied in code on create;
   for a `SpikeTask` the session asks
```

```text
still succeeds with a loud warning).
```

```text
**ranks** them (rev 75, ADR page 50692097) and surfaces
```

```text
- **Git host is pluggable (rev 21, design resolved via TAI-33, §8.19).** A sibling
```

```text
status — not the full breadth of either host's API. See the TAI-33 ADR (Confluence, TA
  space). **Implemented (rev 25, TAI-38):** `src/core/git/interface.ts` plus a Bitbucket
  backend at `src/core/git/bitbucket/`.
```

```text
- **Review and merge act on a real git PR (TAI-34 ADR; revised rev 52, TAI-159 ADR).** See
```

```text
- **PR title (rev 50, TAI-112): tied to the parent Story/Bug first, subtask second** —
```

```text
stashing dirty state. **Resolved (rev 34, §8 item 8): worktree-swap is the default**
  switch behavior — a plain checkout would reintroduce exactly the stashing problem
  worktrees were adopted to avoid. Not yet implemented in code.
```

```text
derive the affected repo for the Component field (§4, rev 11).
```

```text
- **Multi-repo Story:** one dev→review→merge/deploy subtask chain per repo.
```

```text
Remote MCP Server; see §3.2 for why that was tried and rejected (rev 17).
```

```text
humans` (rev 12; supersedes the earlier native-Jira-Project-Role design, dropped
  because Jira's Free plan can't create Project Roles and the filesystem backend has no
  equivalent). Confluence-page-backed
```

```text
defining subtask structure, precedence, and gates. (An earlier "named scenario"
  sense — complete/quick/bugfix — was considered and dropped, rev 11 §3.5; absorbed by
  the story-type + optional-subtask design.)
```

```text
rev 56, TAI-286), backlinked from its §8 entry here
```

```text
posture as rev 48's Analyst/Architect "ask the human" principle
```

```text
bigger change than anything rev 52 did.
```

```text
the existing project-level `Config` folder (§4 rev 13, which already holds untyped,
```

---

## Appendix: brief §3.4 Autocompletion before it was retired (TAI-482, 2026-10-09)

The ability for a persona to complete work without human sign-off, when configurable
conditions are met. **Human sign-off is the default.** Autocompletion is configurable by:
persona, by task type, and per-Jira-issue (likely via a custom field), each with a
configurable set of conditions that must be satisfied.

Conditions are richer than a simple checklist and are likely themselves prompt-based, e.g.:
- "Code review has no major issues and fewer than *X* minor ones."
- "DB design passes DBA review and satisfies the Analyst's requirements."

**The design (TAI-41 ADR; §8 items 9, 22, 23):** `AutocompletionCondition
{ id, description }` (the `description` is the prompt text above); `transition()` never
evaluates a condition live — the deciding persona evaluates it and records PASS/FAIL via a
`Complete:` Jira-comment marker (extending §3.9's convention), which `transition()` reads.
Checkpoints are `hard` (never autocompletes — `ALWAYS_HUMAN_GATED_SUBTASKS`/
`REVIEW_GATES`) or `conditional` (this section's default, autocompletion-eligible per the
above). See the TAI-41 ADR (Confluence, TA space).

**What is built:** checkpoint and review-gate enforcement (`review-gate.ts`) is wired into
`transition()` on both backends. The autocompletion decision engine (`autocompletion.ts`:
`checkpointKind`, `evaluateAutocompletion`, `parseCompletionMarker`) is built and tested as a
standalone pure-function module but is **not called from anywhere**. Whether something
pauses for a human before invoking it, or proceeds automatically, is an orchestration
decision that has not been made; the permission layer a future caller would sit behind
(`PersonaScopedWorkTracker`) exists, the call site does not.
