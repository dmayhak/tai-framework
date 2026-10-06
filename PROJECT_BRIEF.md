# Team AI (TAI) — Project Brief

> **Status:** Living document. This is the source of truth for the Team AI framework's
> vision, design decisions, and open questions. Every persona and every AI session must
> read this file first. When decisions change, update this file — do not let it drift.
>
> **Last updated:** 2026-10-06 (rev 78 — **TAI-425/428: `git-pr review-prep` — the review flow loads the Code
> Reviewer through the CLI.** A read-only command, `git-pr review-prep <REPO> [PR-ID]` (no issue key), is now the
> entry point of `/tai-pr`'s review flow, the way `work` and `groom` load their personas: it refuses up front if the
> acting human is not on the "PR Reviewers" roster, then prints Cole's own instructions (`loadPersonaConfig`, so a
> team's extension applies) under a `# Persona: Cole (code-reviewer)` heading, the PR's details and linked ticket,
> the review steps for THIS PR (findings JSON schema, `render-findings` then stop-and-wait, the numbered options,
> the exact `comment-findings`/`review` commands) and the diff, last. The steps moved out of the skill body into
> code so there is one copy and they sit in the output the session just read (the TAI-423 class of failure). The
> diff is local git as before (no GitHost change); the whole output is budgeted (`OUTPUT_BUDGET`, 24,000 characters)
> with the diff last and a visible "DIFF NOT SHOWN IN FULL" edge listing the exact per-file (or 300-line-chunk)
> commands. Self-review is a note, never a block (§4, open item 8.3). ADR Confluence page 52559873 (rev 2).
>
> Prior: rev 77 — **TAI-389/395: `/tai-groom` — backlog grooming with Perry.** A sixth
> global skill (Claude Code and Gemini CLI) loads Perry with a computed, read-only briefing of the board and
> needs no ticket (`groom [EPIC-KEY]`; the optional epic key narrows every section to that epic). It
> deliberately **reverses the 2026-08-25 "TAI builds no planning command" decision**: the recurring planning
> meeting stays the human's own cadence, and this is what Perry brings to it. Eight numbered sections: epics
> with nothing under them, Backlog Kickoff Stories awaiting sequencing, Backlog tickets whose depends-on blockers
> are all done (promotion candidates), flagged tickets in every open status, approved epics with nothing
> scheduled, Backlog tickets untouched past `TAI_STALE_BACKLOG_DAYS` (default 60), tickets TAI cannot read
> (unmapped Jira type) and tickets that need an assignee (the TAI-416 ranked list). **Authority:** Perry creates
> Backlog tickets, depends-on links and phase labels on her own; every Backlog → To Do move, epic approval
> (scheduling a first wave counts), flag/unflag, Cancel and assignment is proposed as a batch and applied only
> after the human confirms. Each session she also reconciles the work-breakdown document's Epic table with the
> board by reading, not by parser; the document wins. **A human-gated item** (DesignReview, EpicReview, UAT) moves
> to To Do the moment its last blocker finishes, by the persona that finished it (new §4 bullet; every persona
> doc points at it). Sections (d) and (f) filter in memory over an exhaustive read of the open tickets.
> ADR Confluence page 48463873 (rev 5).
>
> Prior: rev 76 — **TAI-389/394: Perry may create `Kickoff` and every live subtask
> type, `SpikeTask` included.** Found in the DesignReview of the grooming ADR (Confluence page 48463873, now
> rev 5): `personas/pm.md`'s `create` grant omitted `Kickoff` (which she already creates per Epic) and covered
> only five subtask types, contradicting the ADR's "tasks already known". Human decision: if the PM knows a
> task is needed she should be able to create it. This aligns the grant with the TAI-83 rule that any persona
> may create any subtask once it has real, in-context judgment that it is needed (not blind pre-population);
> the owner stays the type's fixed persona, a `SpikeTask` still needs its persona named (TAI-409), everything
> she creates lands in Backlog, and the retired `CodeReview` stays out. A test pins the grant.
> `workflows/kickoff.md`'s "Perry never creates `EpicReview`" is now scoped to the initial Kickoff moment.
> `TAI_STALE_BACKLOG_DAYS` is documented in `.env.example`.
>
> Prior: rev 75 — **TAI-416/419: ranked assignee suggestions with reasons.**
> With 2 or more humans on a persona and nobody named, `issue create` now makes the ticket UNASSIGNED and
> prints a ranked list (the session's human pinned first, "leave unassigned" always a choice) instead of
> silently assigning the session's human; the create-time rev 54 shortcut is removed, the claim and
> transition-time one stays. A named person (`assignee=`) always wins. The order is strict tiers —
> continuity (same Story, a linked ticket, the same Epic; a Bug's Dev), then area knowledge from ticket
> data (Done tickets with the same Component/labels within `TAI_AREA_WINDOW_DAYS`, default 90), then
> open-ticket count — every line with its reason, and the author of work under review demoted, never
> excluded. `IssueFilter` gains `component` and `labels`; a new `issue suggest <KEY>`, a `/tai-ready`
> "needs an assignee" suggestion, and the transition-gate rejection all use the same ranking, computed
> live and never stored. ADR Confluence page 50692097 (human-decided, 2026-10-05).
>
> Prior: rev 74 — **TAI-407/409: the documented persona defaults are now
> real.** Nothing in the code applied them: a bare create left the persona empty for every ticket
> type, and `issue create` resolves an assignee only when a persona is set. Now an omitted persona
> falls back to `SUBTASK_OWNER[type]` for a subtask and PM for every story-level ticket and Epic —
> a shared pure `defaultPersonaFor`, called by `issue create` BEFORE assignment and applied by
> `WorkTracker.createIssue` on both backends (an explicit `persona=` always wins). Only `SpikeTask`
> has no default: the session asks the human which persona before creating it, and a create that
> still ends persona-less is made anyway (a ticket is never lost) with a loud warning naming
> `issue update <KEY> persona=`. Human-decided on TAI-408.
>
> Prior: rev 73 — **TAI-397/400: session learnings that lived only in private
> memory are now stated in TAI's own docs.** A new §4 bullet records how personas write Confluence
> page content (one unwrapped line per paragraph/bullet, sequential list numbers, the `content=$(cat
> file)` quoting rule); the authoring personas point at it; Ada's and Aria's real-links principle
> also covers linking a doc to the parent Story; the setup checklist and `/tai-init` skill say a
> Gemini CLI session needs a full restart to pick up refreshed skills and explain the `TA`/`TAI`
> Confluence space alias; `CLAUDE.md` says to use the TAIT scratch project for throwaway tickets.
> No behavior change.
>
> Prior: rev 72 — **TAI-390: `flagged` is a first-class `Issue` field on
> both backends.** Work waiting on something external with no ticket is marked with Jira's Flag
> (impediment), read and set through `Issue.flagged`/`IssuePatch.flagged` (`issue update <KEY>
> flagged=true|false`): the Jira backend finds the "Flagged" custom field BY NAME like the Persona
> field (a site without one degrades — reads omit it, a set/clear is rejected with a clear
> message), the filesystem backend stores a boolean. `issue get`/`search`/`update` show a
> "🚩 flagged" marker; `/tai-ready` is hybrid — a flagged `To Do` item leaves Ready Work for a
> numbered "On hold (flagged)" section, a flagged `In Progress` item stays put with the marker
> (human-decided on TAI-390, TAI-389 ADR decision 8).
>
> Prior: rev 71 — **TAI-374/387: Epics are created as they are agreed
> (early Epic shells), fleshed out in Backlog, and scheduled by Perry; `To Do` now cascades
> upward and a Kickoff Story never moves its Epic.** Human-directed, ADR Confluence page
> 47349832 (rev 4). The serial project-level Kickoff left every agreed Epic invisible on the
> board until EpicReview, Requirements/UX and the review gate had all finished. Now: Ada creates
> each Epic as a **Backlog shell** as it is agreed during EpicReview (a narrow `create: Epic`
> grant; the shell IS the proposal) and records its Jira key in the work-breakdown doc in the
> same step (the doc stays canonical, with a Jira-key index column). Perry — not Ada — gives
> every Epic its per-Epic Kickoff Story and the Stories/tasks already known, in Backlog, during
> grooming; an Epic is not left empty. **Epic status now describes readiness:** `Backlog` =
> proposed and being fleshed out, `To Do` = fleshed out and approved to build (its Kickoff
> passed its PM+UX gate and a human agreed; the persona asks first — convention, no code gate),
> `In Progress` = building. An Epic's Stories do NOT all move to `To Do` with it: Perry
> schedules a first wave and leaves later phases / blocked / externally-waiting work in Backlog.
> The shared cascade gate (`cascade-gate.ts`, `upwardCascadeTarget`) changes accordingly: a
> **Kickoff Story starting work, or being scheduled, never moves its parent Epic**; every other
> child still does, and a **subtask reaching `To Do` now schedules its Backlog parent, which
> schedules its Backlog Epic** (new upward To Do cascade; only a Backlog parent moves).
> Scheduling a first-wave non-Kickoff Story therefore also approves a Backlog Epic, so Perry
> asks the human first. Rev 28's sentence below ("`In Progress` is derived … any child that has
> left Backlog") was never what the code did (the cascade fires on `In Progress`/`In Review`
> only) and is rewritten. The Kickoff review gate is clarified, not changed: it governs the
> project-level Kickoff Story's own Done transition and the Stories/Spikes spawned from it;
> Epic shells and per-Epic Kickoffs sit outside it.
>
> Prior: rev 70 — **TAI-354: Kickoff gains a mandatory,
> human-gated `EpicReview` step — Ada's proposed Epic breakdown is probed with the
> human, epic by epic, not rubber-stamped.** Found live on the same EXA stress-test as
> revs 67–69: after Ada's `Research` subtask produced the work-breakdown doc (proposing
> EXA's Epic breakdown) and was marked Done, the very next thing surfaced as ready to
> work was a Kickoff-subtask-level `ArchitectureDesign` deep-dive (rev 69's own
> mechanism) — with no step in between where the human actually discussed the proposed
> breakdown itself. The only mechanically enforced Kickoff checkpoint (the PM+UX
> Designer Review Gate, rev 11) converges the PRD/UX-flow *artifacts*, not the epic
> list; nothing stopped deeper subtasks from being created and surfaced before that
> big-picture conversation happened. Human-confirmed: reading the Confluence doc and
> clicking "looks good, approve" isn't rigorous enough on its own — real probing, epic
> by epic, catches issues a rubber-stamp read misses.
>
> Fixed: added a new, mandatory `EpicReview` subtask to Kickoff (`story-schema.ts`),
> sitting between `Research` and `Requirements`/`UxDesign` in the precedence graph
> (`Research` no longer unblocks either directly). Owned by Analyst, but registered in
> `ALWAYS_HUMAN_GATED_SUBTASKS` — same mechanism as `UAT` (`personas/tester.md`): Ada
> drives the actual discussion, going through the proposed breakdown one epic at a time
> and revising the *same* work-breakdown doc in place, but only a human stakeholder can
> transition the subtask to Done — no `Approved:` comment convention, the transition
> itself is the signal. Deliberately a *different* gate from the existing PM+UX Kickoff
> Review Gate: that one converges PRD/UX-flow content once it exists; `EpicReview` is
> upstream of both, settling the epic/Story shape itself before PRD/UX work is built
> against it.
>
> **Generalized to every Epic decomposition, not just the initial project-level
> Kickoff (human direction, discussed live):** `personas/pm.md` item 5 ("Epic
> decomposition, invoked directly on an existing Epic") previously had Perry decompose
> an Epic into Stories solo, no separate proposal required. Since Epics can't hold
> subtasks in TAI's schema, the human's own proposed resolution was adopted over
> extending that schema: **every Epic that needs decomposing gets its own Kickoff-type
> Story** — the same container the project-level bootstrap uses, just scoped to one
> Epic — reusing the `Research` → `EpicReview` → optional `Requirements`/`UxDesign`
> sequence above rather than inventing a second mechanism for the narrower pass.
>
> New Jira sub-task issue type `EpicReview` provisioned on both TAI's and EXA's Jira
> projects (brief §5.2's "one native sub-task issue type per `SubtaskType`"
> convention). `analyst.md` gained a new item 3 (renumbering items 3–6 to 4–7) plus
> `create`/`workOn`/`alwaysHumanGated` grants — deliberately excluded from `complete`,
> mirroring `tester.md`'s UAT exclusion; `pm.md` item 5 rewritten; `workflows/kickoff.md`
> gained the `EpicReview` gate section and updated precedence/output/status-transition
> text. Five new tests (`story-schema.test.ts`, `autocompletion.test.ts`) lock down the
> new precedence edges and `hard` checkpoint classification; 758/758 passing, `tsc
> --noEmit` clean.
>
> Prior: rev 69 — **TAI-353: Ada creates `ArchitectureDesign`
> herself when she recognizes the need, instead of leaving it as an unticketed
> question.** Found live on the same second target project, same day as rev 68: Ada,
> doing Kickoff-adjacent discussion-prep research, surfaced a genuine design trade-off
> (a hierarchy-representation decision) and explicitly named "the Architect-level
> conversation this doc was built to ground" as the next step — but never created a
> ticket for it. `analyst.md` item 5 already had the general TAI-83 mechanic for Ada
> creating `Investigate` herself (rev 57/TAI-317); it just never got generalized to
> `ArchitectureDesign`, even though it's a valid Kickoff-level subtask type and her own
> analysis showed she'd already formed the real, non-speculative judgment TAI-83
> requires. Added the missing `Subtask:ArchitectureDesign` create grant (create only,
> not `workOn`/`complete` — ownership stays Architect's, mirroring `pm.md`'s identical
> grant), generalized item 5's language to cover both subtask types with the concrete
> command, and cross-referenced from item 2 (Kickoff discovery) where the triggering
> scenario actually happened.
>
> Prior: rev 68 — **TAI-352: Ada's Kickoff discovery now does real
> elicitation, and creates the project's Confluence home page.** Found live on the same
> second target project: Ada read the project's own pre-existing rough design docs, did
> external research, and produced a full Epic decomposition — all without ever having an
> actual conversation with the human about purpose, requirements, or scope. Root cause:
> `analyst.md` item 2 named "requirements elicitation" as something Ada performs, but
> only the *separate* market/competitive/domain research activity had an explicit
> opt-in ask-first gate (rev 59) — elicitation itself had no equivalent mandate for when
> or how rigorously it happens. Fixed: Ada's first move at Kickoff discovery is now a
> real conversation about purpose/requirements/scope, explicit and prior to synthesis.
> **New Core principle: pre-existing project docs are a discussion-facilitation device,
> not settled input** — human-confirmed nuance: such docs may reflect a prior version of
> the project's thinking, not what's actually being built now; Ada reads them first only
> to ground good questions, never as a substitute for confirming current intent.
> Right-sized output still applies — not a mandate for exhaustive interrogation on every
> Kickoff, just that real elicitation happens before analysis is finalized.
> Market/competitive/domain research stays a separate, unchanged opt-in gate. Second,
> related fix (human direction): Ada's existing Project Home Page capability (TAI-300)
> was purely periodic/on-demand with no explicit trigger — a brand-new project's
> Confluence space would sit on the default scaffold indefinitely. Now created during
> Kickoff discovery itself, the natural first moment enough is known to make it
> meaningful; ongoing refresh cadence is unchanged.
>
> Prior: rev 67 — **TAI-351: PM's Kickoff subtask-creation
> authority fixed — same contradiction shape TAI-317/rev-57 already fixed once, just
> missed for Kickoff's `Research`/`UxDesign` case.** Found live setting up a second
> target project: Perry created the Epic + Kickoff Story, then explicitly deferred
> creating `Research` to a separate Ada invocation — even though her own reasoning had
> already named it as needed, and the prior text cited TAI-83 as the rule in the same
> sentence that described doing the opposite of it. `personas/pm.md` item 1 now has Perry
> create `Research`/`UxDesign` directly once she's judged them needed (both immediately
> startable, no precedence blocking either), under the same TAI-83 dedup-search-first
> mechanics as item 7's `Investigate`/`ArchitectureDesign` case — new `Subtask:Research`/
> `Subtask:UxDesign` create grants added to match. `Requirements` stays different (Perry's
> own type, but precedence-blocked behind `Research`, so created naturally at PRD-drafting
> time instead); `ArchitectureDesign` stays a later, situational call (judging it this
> early would be speculation, not real judgment) — already covered by the existing item 7
> language. `personas/analyst.md`/`personas/ux-designer.md`/`workflows/kickoff.md` updated
> to match (dedup-search-first fallback if Perry hasn't already created it, same pattern
> `analyst.md`'s own `Investigate` handling already uses). One real bug caught in
> self-review: the actual `issue create` vocabulary for `UxDesign` is `ux-design`
> (hyphenated), not `uxdesign` — a wrong value would have been a TAI-135-class bug
> (a command that can't actually run) if shipped uncaught.
>
> Prior: rev 66 — **§8 items 35/36 resolved: TAI-283/284 (the
> aggregate competitor-comparison Spikes) shipped.** Synthesized from all nine
> TAI-6/138-155 persona-review discussions' own competitor research (each turn already
> read the relevant BMAD-METHOD/GSD/Spec Kit source directly) rather than a fresh
> investigation. TAI-283: per-persona job/scope audit with an explicit like/dislike call
> per competitor (Confluence page 41123841). TAI-284: whole-system comparison — where TAI
> excels (Jira/Confluence/git-host as the real system of record vs. both competitors'
> local-file state; the explicit permission/checkpoint model; the two-axis owner model;
> rolling-wave decomposition vs. Spec Kit's rejected clarification cap; structured
> git-host-native review findings), where it falls short (adversarial review discipline
> was missing until this review effort itself; no AI/LLM-feature-building support,
> genuinely out of v1 scope; quality-gate/NFR-assessment depth for testing is a shared
> gap, not TAI-specific; heavier ticket-creation ceremony than a single-developer tool,
> an honest trade-off not a flaw; the whole review's designs are reasoned but not yet
> battle-tested) — and four ranked improvement candidates, the top one being simply to
> execute the 14 deferred clean-session test spike-tasks (Confluence page 41156609). Both
> Spikes transitioned Done, PM-confirmed Confluence-only outcome per `workflows/spike.md`
> — no new Story spawned, since actionable findings already landed persona-by-persona
> during the review itself.
>
> Prior: rev 65 — **Tessa's (Tester) persona review concludes
> (TAI-154/343), the eighth full persona turn under TAI-6/138-155.** Mechanical audit
> came back clean (no stale prose, all `confluenceOutputs` described, rev-52/TAI-314/315/
> 316 test-tier-stays-open behavior consistent across `developer.md`/`story.md`/
> `ready.ts`, concrete `cli.ts` invocations already present throughout). TAI-135/TAI-132
> also clean. Neither competitor has a dedicated Tester/QA agent to compare Tessa against
> directly — BMAD-METHOD's `bmad-qa-generate-e2e-tests` is a lightweight workflow skill
> that explicitly defers quality-gate/NFR-assessment depth to a separate heavier "Test
> Architect" module rather than building it in (same split-off-the-advanced-stuff pattern
> Dana's turn found); GSD has no single Tester agent either, but its `verify-work`
> workflow has a genuinely rich, concrete UAT mechanic worth adapting. One design change,
> human-confirmed: **Tessa's UAT session gains a concrete interaction mechanic**, adapted
> from GSD's `verify-work` — one scenario at a time, states what SHOULD happen and asks
> the stakeholder to confirm or describe what's different; a plain yes/empty reply is a
> pass, anything else is logged as an issue with severity **inferred from the
> stakeholder's own wording, never asked directly** (e.g. "crashes" → blocker, "doesn't
> work" → major, "works but slow/weird" → minor, "looks off" → cosmetic; defaults to
> major when genuinely unclear). This replaces a previously-vague "authors the scenarios
> and drives the session" with an actual described mechanic — the stakeholder's own
> UAT sign-off authority (§3.3) and the existing rejected-UAT routing (Developer vs.
> PM/Requirements) are both unchanged; this only concretizes *how* Tessa runs a session
> she already owned driving.
>
> Prior: rev 64 — **Cole's (Code Reviewer) persona review concludes
> (TAI-153/341), the seventh full persona turn under TAI-6/138-155.** Unlike Dario's/
> Dana's clean turns, the mechanical audit found two real, concrete bugs — both fixed:
> - **Stale `confluenceOutputs` front-matter in `code-reviewer.md` itself.** Still
>   declared `review-notes` as a Confluence output type, contradicting the body's own
>   rev-52 (TAI-159 ADR) rewrite, which routes review notes to a real PR comment via
>   `comment-findings`, never Confluence — the rev-52 rewrite (TAI-160) updated the rest
>   of the file but missed this one block. Fixed: `confluenceOutputs: []`, with a comment
>   explaining why.
> - **Three stale "not yet built" annotations in this brief** (§5.4, §8 item 20), all
>   describing the same rev-52/TAI-159 CodeReview-retirement redesign as unimplemented —
>   it has actually been fully live in code since TAI-160 shipped (`ready.ts`'s
>   `readyToReview`/`readyToTest`/`readyToMerge`, `cli.ts`'s `git-pr review`,
>   `git/pr-reviewers.ts`). 11 revs stale (52→63); missed by TAI-171/177's earlier
>   doc-staleness pass, which touched `story.md`/`bug.md`/`dependencies.md` but not this
>   file. Fixed: reworded to "Implemented (rev 52, TAI-160)".
>
> TAI-135/TAI-132's failure modes both came back clean (concrete `cli.ts` commands already
> present; cross-references in `developer.md`/`story.md`/`pm.md` already consistent with
> rev 52).
>
> One design change, human-confirmed after comparing against competitors: **Cole gains an
> explicit adversarial default stance.** Both BMAD-METHOD's `bmad-code-review` (parallel
> Blind Hunter/Edge Case Hunter/Acceptance Auditor layers) and GSD's `gsd-code-reviewer`
> ("FORCE stance: assume every submitted implementation contains defects," named
> anti-patterns for going soft) independently converge on this — Cole's prior framing was
> neutral/collaborative ("verify... is sound") with no explicit instruction to resist the
> pull toward rubber-stamping. New Core principle: assumes the diff has a defect until
> traced through and ruled out; names concrete anti-patterns to resist (stopping at
> surface issues, treating passing tests/compiling as evidence of correctness, softening a
> finding's `severity` to avoid seeming harsh).
>
> Prior: rev 63 — **Dana's (DBA) persona review concludes
> (TAI-152/338), the sixth full persona turn under TAI-6/138-155.** Mechanical audit
> came back clean again (no stale prose, all `confluenceOutputs` described, concrete
> `cli.ts` invocations already present in Handoff). Unlike every prior turn, neither
> competitor has a DBA equivalent to compare against — BMAD-METHOD folds database/schema/
> migration decisions into a one-time Architecture solutioning pass with no specialized
> reviewer; GSD has no dedicated agent either. Decisions instead came from real DBA
> practice. Four changes:
> - **Reversibility stated as explicitly as compatibility — two different axes.**
>   Compatibility is whether old application code still works against the new schema;
>   reversibility is whether the migration itself can be undone. A change can be one
>   without the other (backwards-compatible but irreversible is a common, non-
>   contradictory shape, e.g. a destructive backfill). Dana now states both, flagging the
>   exact point past which rollback isn't possible, feeding `personas/devops.md`'s
>   rollback runbook (already non-optional there) with information it previously had no
>   guaranteed source for.
> - **Blocking vs. parallel sharpened from "judgment call" into a concrete default**:
>   backwards-compatible → parallel by default (old and new code both work against it);
>   backwards-incompatible → blocks, because it structurally needs the expand-contract
>   sequence (add → backfill → cut over → drop), which `Dev` must be sequenced against.
>   Stated as a default, not an absolute — Dana still states her reasoning since deploy
>   topology can change what "parallel" means.
> - **New costed-option-package discipline for schema forks tied to unstated future
>   business direction** — **more ownership than Aria's/Uma's version of this same brief
>   §4 pattern:** rather than just flagging the fork, Dana proposes each realistic option
>   with its cost/effort now vs. the cost/risk of retrofitting later, plus a stated lean —
>   schema mistakes are unusually expensive to unwind compared to most code, which is why
>   this turn's version goes further than Architect's/UX Designer's own "notices and
>   routes" versions. The decision itself still isn't Dana's call (stays PM's/the human's,
>   same as elsewhere) — only the depth of the analysis she hands over differs. Same
>   TAI-83 mechanic as Aria's version to get it to PM (new `Subtask:Requirements` create
>   grant, mirroring `architect.md`).
> - **Closes the file's own dangling "DBA vs. data-engineering split" open item** — filed
>   as a real Backlog Story (**TAI-337**) instead of left as prose. Explicitly deferred,
>   not decided: only becomes real once a target project has enough analytics/pipeline
>   surface to be a genuinely distinct workload, beyond TAI v1's current priority.
> **Brief §4 itself sharpened** (peripheral awareness): future-direction/extensibility
> noticing isn't limited to whatever's the explicit topic of the current ask — a persona
> looking at a broader artifact (schema, decomposition, architecture) scans adjacent parts
> of that same artifact already in view for the same costly-to-change-later risk, not just
> the piece directly asked about. Applies to every future-direction-aware persona (Ada,
> Aria, Uma, now Dana), not Dana-only — same right-sizing instinct as the rest of that
> bullet, not a mandate to go auditing unrelated parts of the system.
> This is the first review turn where Dana's Dev subtask needed the gitHost-permission-gap
> workaround (persona reassigned to `pm`, TAI-317/TAI-324 precedent) — DBA has never held
> `gitHost`.
> Prior: rev 62 — **Dario's (Developer) persona review concludes
> (TAI-151/334), the fifth full persona turn under TAI-6/138-155.** All changes landed
> persona-local in `personas/developer.md` — no brief-level promotion needed. Mechanical
> audit against the three recurring bug classes plus TAI-135/TAI-132's failure modes came
> back clean this time (no stale prose found, unlike the first four turns) — the review
> instead compared Dario directly against BMAD-METHOD's Amelia (dev-story workflow) and
> GSD's `gsd-executor`. Four changes:
> - **Unit-tests-are-part-of-Dev reworked to explicit red→green→refactor ordering**: write
>   the failing test first, write minimal code to pass, refactor while keeping tests green
>   — adopted from BMAD's Amelia, who mandates the same ordering.
> - **New deviation-handling discipline for mid-implementation discovery**: a small,
>   contained issue (in-reach, no new dependency) gets fixed inline and noted in
>   implementation notes, whether it's a bug in the code being touched or a correctness/
>   security gap the change needs to actually work. A bigger issue outside the current
>   Story/Bug's actual scope doesn't get silently fixed (scope creep) or silently dropped —
>   Dario drafts a Bug proposal and hands it to PM to confirm/create, reusing
>   `workflows/bug.md`'s Resolved D7 PostDeploy-minor propose-then-PM-confirms mechanic
>   rather than inventing new machinery. The structural backstop against scope quietly
>   growing isn't this discipline alone — Cole's existing "reviews against the spec, not
>   personal style preference" principle already catches anything that made it into the
>   diff without being traceable to scope. Adapted from GSD's Rule-1/2/3 auto-fix vs.
>   Rule-4 ask-for-architectural-changes taxonomy, simplified to fit TAI's own Bug-ticket
>   vocabulary rather than importing GSD's separate deferred-items.md mechanism.
> - **New never-adds-a-new-package-dependency-unilaterally gate**: flags a needed library
>   the spec didn't call for to the human before adding it, naming realistic alternatives
>   and a stated lean — the same alternatives-first discipline TAI-107 established for
>   Architect — rather than just asking "can I add X?" The human decides, including
>   whether to have that conversation with Architect out-of-band first. Adapted from
>   BMAD's Amelia, who halts for user approval before any dependency beyond the story's
>   own spec.
> - **New 3-consecutive-failed-attempts stuck-approach rule**: after 3 failed attempts at
>   making an approach work, Dario stops, documents what was tried and why it didn't work,
>   and either raises a `SpikeTask` or asks the human directly. Explicitly distinct from
>   the brief's own retry-once-then-escalate rule for a failed *checkpoint* (§4/§5.4) — a
>   different kind of failure, not a contradicting number. Adapted from both competitors
>   (BMAD: 3 consecutive implementation failures → HALT; GSD: 3 auto-fix attempts → stop
>   and document).
> **Future-direction/extensibility awareness (brief §4) was explicitly considered and
> declined for Dario** — he doesn't decide product scope or architecture, and the new
> dependency-gate and out-of-scope-discovery mechanics above already route anything with
> real future-direction weight up to Architect or the human rather than Dario deciding it
> himself. No permission-block changes — the Bug-propose mechanic reuses the existing
> PM-confirms pattern (same as DevOps in the PostDeploy precedent) rather than granting
> Dario a new `create` right, and this is the first persona turn that didn't need the
> gitHost-permission-gap workaround (TAI-324/331 both did) — Dario already holds `gitHost`
> from TAI-33/34 (createPullRequest) and TAI-159/rev 52 (mergePullRequest).
> Competitor research this session: BMAD-METHOD's Amelia (`bmad-agent-dev`/`bmad-dev-story`
> skills) and GSD's `gsd-executor` agent, read directly — feeds TAI-283/284.
> Prior: rev 61 — **Uma's (UX Designer) persona review concludes
> (TAI-150/331), the fourth full persona turn under TAI-6/138-155.** All changes landed
> persona-local in `personas/ux-designer.md`; §3.7's shared elicitation-escalation posture
> gains a third confirmed instance (no new brief-level mechanics needed, since Uma's version
> is the same shape PM's/Ada's already established). Four changes:
> - **New Design System capability** (living doc, may be scoped): establishes the project's
>   baseline visual-identity/design-token reference (Brand & Style, Colors, Typography,
>   Layout & Spacing, Elevation & Depth, Shapes, Components, Do's and Don'ts), assessed
>   against the target project's real shape the same way Architect's Architecture Overview
>   is (include/reframe/N/A-with-reason). Adapted from BMAD-METHOD's DESIGN.md/EXPERIENCE.md
>   split — Uma's existing `ux-flow`/`story-ux-detail` outputs already covered the
>   EXPERIENCE (behavior) side; `design-system` is the new DESIGN (visual identity) side.
>   Deliberately **not** forced into a single global doc the way Architecture Overview/
>   Project Home Page are — a genuinely distinct sub-area (e.g. an admin section with its
>   own deliberately different look) gets its own scoped doc that links to and states what
>   it overrides from its parent; this actually restores the framework's own *default*
>   multi-instance granularity (brief §4 rev 11) rather than importing the "one per project"
>   exception. First checks for a business-supplied design-system extension before creating
>   her own. Genuine undeclared drift is a conflict, resolved via the same TAI-83
>   dedup-search-then-comment-or-subtask mechanic Architect's altitude-inheritance principle
>   uses — reused, not reinvented.
> - **"Elicits, doesn't impose"** — new Core Principle, same shape as `personas/pm.md`'s
>   "Elicitation, not direction": never volunteers a color, pattern, or visual direction
>   unprompted, the vision being drawn out is the human's. Shares §3.7's elicitation-
>   escalation posture, now confirmed for a third persona.
> - **Concern-scan broadened**: the old "empty/error/loading states" check widens into a
>   fuller UX-carrying-concerns scan (accessibility, i18n, dark mode, offline, input
>   modalities, notifications, …), adapted from BMAD's concern-scan list, inferred from
>   context rather than force-applied to every screen (same right-sizing instinct as Ada's
>   ambiguity-coverage checklist).
> - **Surface closure** — new completeness bar, adapted from BMAD's IA-closure test: every
>   stated need has a surface, every surface has a journey; when closure fails, probe, never
>   invent. Same role Aria's load-bearing bar and Ada's ambiguity checklist play for their
>   own personas.
> **Future-direction/extensibility awareness (brief §4) was explicitly considered and
> declined for Uma** — her own new surface-closure bar and the design-system parent/child
> override pattern already give her a way to flag "this assumes single-item only" without a
> separate mechanic, and the brief already frames this as a scope/requirements question that
> stays Ada's/Perry's call, not something UX flow work should re-raise on its own. One real
> stale-wording bug caught and fixed pre-review: the Extension point section still said
> "missing-state discipline" after the underlying principle was renamed/broadened.
> Competitor research this session: BMAD-METHOD's Sally (UX Designer) skill and GSD's
> UI-phase workflow/UI-SPEC template, read directly — feeds TAI-283/284.
> Prior: rev 60 — **Aria's (Architect) persona review concludes
> (TAI-149/328), the third full persona turn under TAI-6/138-155.** Closes the
> future-direction-awareness thread §4/rev 59 explicitly reserved for Architect: her own
> version fires only during Kickoff-early or Story-level `ArchitectureDesign` (not
> Feasibility's time-box, not the WBS batch scan), she asks the human directly rather than
> routing through PM/Ada, and the answer dual-records — grounding context in her own ADR,
> plus a `Requirements` subtask handed to PM (TAI-83 exception, since the PRD isn't her own
> output type) for the Future Considerations entry. Also resolves §3.7's other open
> parenthetical (Architect + rolling-wave for system-level design): a Kickoff/Epic-level
> `ArchitectureDesign` is her "full shape now" pass, and each Story's own
> `ArchitectureDesign` inherits its decisions as **binding, read-only constraints** rather
> than re-deciding them — a real conflict escalates to the human, never a silent override
> (adapted from BMAD-METHOD's architecture-spine altitude-inheritance model). Three more
> changes landed persona-local, no brief promotion needed: a concrete "is this actually
> load-bearing" bar for when a design decision earns `ArchitectureDesign`/`Feasibility` at
> all (adapted from BMAD's architecture-spine test), principle TAI-107 sharpened to require
> showing alternatives + a stated lean rather than just posing an open question, and a new
> "investigates before deciding" brownfield instinct (read the real code/conventions first,
> don't invent fresh ones) — relevant since TAI is brownfield for anyone dogfooding it.
> **§8 gets one stale-gap fix** (item 33: "Architect-owned architectural overview doc" was
> still marked open in the brief's own prose — and misnamed the persona "Dario" instead of
> "Aria" — even though its tracking ticket, TAI-281, was already closed Done back on
> 2026-09-04 once TAI-307's `architect.md` Architecture Overview section shipped; the brief
> entry itself was never updated to match, caught during this session's own read) and
> **one new deferred item** (item 38: scaling
> `DesignReview`'s gate depth to stakes, BMAD-style multi-lens review — explicitly punted to
> v2/v3, **see TAI-327**, Story, Backlog). Competitor research this session reused the prior
> session's BMAD-METHOD/Spec Kit clones (Winston the Architect's `customize.toml` and
> `bmad-architecture` skill; Spec Kit's `plan` command/constitution-check gate) — read
> directly again, feeding TAI-283/284.
> Prior: rev 59 — **Ada's (Analyst) persona review concludes
> (TAI-147/324), the second full persona turn under TAI-6/138-155.** Two principles
> promoted from persona-local to shared, since each now applies to 2+ personas (same
> promotion pattern as rev 58's rolling-wave): **§3.7 gains a new "Elicitation escalation
> posture" block** — collaborative by default, escalating to direct questions and explicit
> pushback on thin answers (an unmeasurable acceptance criterion, an unexamined assumption)
> when a conversation isn't converging, calibrated to stakes — generalized from PM's PRD-
> drafting posture (rev 58) to any elicitation-heavy persona work. **§4 gains a new
> "Future-direction/extensibility awareness" bullet** — during Kickoff discovery,
> decomposition, or refinement, a persona notices when the current scope touches a
> genuinely costly-to-change-later decision and surfaces it as a scope/requirements
> question (never an implementation choice — that stays the Architect's), inferring which
> areas are probe-worthy from context rather than a fixed keyword table, asking the human
> when unsure whether it's worth raising at all. Reserved for Analyst/Architect's own
> reviews per rev 57/58's handoff note; Ada's mechanics land first, Aria's (Architect)
> still to come. `personas/analyst.md` updated with both plus two Ada-specific additions
> that didn't need brief promotion: research-on-demand (ask if/how much external research
> to do, generalized beyond Kickoff, light source-noting, no new doc type) and a structured
> ambiguity-coverage checklist for `Investigate` refinement (adapted from Spec Kit's
> `clarify` taxonomy, right-sized to scope). Competitor research this session: BMAD-
> METHOD's Deep Recon/Product Brief skills and Spec Kit's specify/clarify commands, cloned
> and read directly (feeds TAI-283/284).
> Prior: rev 58 — **§3.7 gains a new "Rolling-wave decomposition
> depth: 'done' vs. 'done enough'" principle (TAI-147/148), the first concrete output of a
> dedicated persona-by-persona review (TAI-6/138-155).** For a large Epic, decomposition
> creates the full set of next-level shells immediately (visible shape end to end) but only
> takes a subset to full depth right now — whatever the real dependency/readiness graph
> shows as unblocked, not a fixed lookahead count TAI can't calibrate to a team's actual
> capacity. Explicit pull-forward stays available (same posture as TAI-83's Eager Subtask
> Creation), and a shallow item already known to need a refinement pass gets that subtask
> created now too, parked in `Backlog` for visibility. No new status machinery — this is an
> application of the existing `Backlog`/`To Do` split (TAI-292) as a deliberate
> decomposition-depth strategy, previously undescribed as such. `personas/pm.md` (items
> 4/5) and `personas/analyst.md` (item 4) both updated to the concrete mechanics.
> Prior: rev 57 — **§8 item 13 fully resolved (TAI-317): subtask-
> creation authority for `Investigate`/`ArchitectureDesign` now follows the general TAI-83
> "Eager Subtask Creation" exception (`workflows/dependencies.md`) like every other subtask
> type — no more type-specific carve-out.** `analyst.md`/`pm.md` previously said "regardless
> of who flags it, the Analyst always creates `Investigate`," directly contradicting
> TAI-83's own general rule (already referenced in `pm.md` item 1) that any persona active
> on a Story/Bug with real in-context judgment may create any subtask type. Found live
> twice on 2026-09-04 (TAI-280/300, TAI-281) — the human directed PM to create both
> directly, then flagged the inconsistency for a dedicated persona-review session.
> Resolved by dropping the carve-out: `analyst.md` item 5 and `pm.md` item 7 now let PM (or
> Architect/Dev, mid-flight) create the subtask directly under the same dedup-search-first,
> owner-still-Analyst mechanics every other TAI-83 case uses; `pm.md` gains explicit
> `Subtask:Investigate`/`Subtask:ArchitectureDesign` `create` grants as the evidenced
> cases, matching `developer.md`'s existing pattern for its own TAI-83 grants.
> **§4 also gains a new principle: persona-produced artifacts/output types must be
> designed to generalize to whatever future target project TAI manages, not left
> TAI-specific** — raised live during TAI-307's architecture-overview-doc scoping;
> `analyst.md`'s Project Home Page and `architect.md`'s Architecture Overview (both already
> written this way) now cross-reference it as the standard to apply when scoping any new
> output type. Both changes are documentation-only; no code changes.
> Prior: rev 56 — **§8/`personas/pm.md`: the "flagged-live idea
> becomes a real Backlog ticket" convention gets written down for the first time
> (TAI-286).** Rev 55 (immediately below) captured seven open questions and, separately,
> created real Backlog tickets for them (TAI-279-285) — following the same shape already
> established by TAI-115/189/230, but that shape had never actually been documented
> anywhere a persona is instructed to follow it (confirmed live: zero hits grepping every
> `src/personas/*.md`/`src/workflows/*.md` file for the pattern). Human-flagged gap,
> fixed same-session: `personas/pm.md` gains a new Core Principle — "Captures genuinely
> open ideas as real Backlog tickets, not just brief prose or conversation-only notes" —
> and §8's own preamble now states its scope explicitly: genuinely undecided DESIGN
> questions stay here, anything scoped enough to investigate or build gets a real Jira
> Story/Spike, backlinked from its §8 entry. Formalizes existing practice; no behavior
> changes as a result.
> Prior: rev 55 — **§8: seven new open questions captured live from
> a human notes dump, none resolved here.** Priority-value alias mapping alongside TAI-116/
> 179's issue-type-only alias work (§8 item 31); an Analyst-owned Confluence project "home"
> page and an Architect-owned architectural-overview doc, both flagged as possible new
> skills with undecided content/cadence (§8 items 32-33); keeping local `master`/`main`
> fresh across multiple machines/checkouts — distinct from §8 item 8's worktree-swap design
> and TAI-115's deferred worktree-concurrency Story (§8 item 34); a systematic per-persona
> job/scope audit against GSD/BMAD-METHOD/Spec Kit's equivalent roles, and a follow-on
> overall TAI-vs-competition comparison — both sized as a real investigation, not a brief
> edit (§8 items 35-36); and extending the existing git-host out-of-band-human-edit posture
> (§6/TAI-34 — "a human acting directly is authoritative, not fought, detected on next
> refresh") to direct Jira/Confluence edits, named as PM/Analyst's biggest exposure (§8
> item 37). An eighth note — "link real tickets/docs, not just text" — was NOT added here;
> it's already the `missing-links` check in `tai-audit` (TAI-254 ADR), so it's a sweep to
> run, not a new question. Captured verbatim per items 1/28/29's "flag live, don't design
> on the spot" posture.
> Prior: rev 54 — **§5.5: the multi-candidate assignment-helper gains
> a current-user shortcut — the driving session's own human is auto-assigned when they're
> among 2+ Persona Roster candidates, rather than always falling back to asking.** Context:
> TAI-244/245 both hit the §5.5 assignment gate live with no automated resolution at all —
> brief §5.5's two rules (sole-candidate pre-assign, multi-candidate assignment-helper
> fallback) were decided at rev 19 but never actually wired up (TAI-248/249/260). Fixing
> that surfaced a real gap in the multi-candidate rule as originally written: it always
> falls back to asking, even in the extremely common solo/small-team case where the human
> driving the session IS one of the candidates and the answer is obvious. Ratified
> live (human-confirmed 2026-08-27, TAI-249 ADR, Confluence page 30572546): auto-assign that
> human without asking; only surface the full candidate list (with lightweight load
> signals, unchanged) when the current session's human isn't among the candidates, or has
> no resolvable session identity at all. Fires at **both** ticket-creation time and the
> transition-gate moment (not reactively-only) — implemented as one shared, pure resolver
> (`src/core/personas/assignment-helper.ts`) called from `cli.ts`'s `issue create`/
> `issue transition` handlers, deliberately NOT from inside `WorkTracker.createIssue` in
> either backend (avoids the exact per-backend rule-drift regression `assignment-gate.ts`'s
> own header already documents, and keeps session-identity resolution — a host-layer
> concern — out of backend internals). A human can always override either way via
> `issue assign`, unchanged.
> Prior: rev 53 — **§5.4: the CI-green merge gate no longer treats a
> commit with zero `getCommitStatuses` as failing.** Context: `bitbucket-pipelines.yml`
> became a `custom:` (manual-only) pipeline this cycle — no automatic trigger of any kind —
> after this project's Bitbucket free-tier 50 build-minute/month quota was hit twice in one
> session; `git-pr merge`'s CI-gate was never updated to match, so it rejected every merge
> from PR #56 onward (tracked as TAI-230). `isGreen()` (`src/core/commands/git-pr.ts`)
> originally read zero statuses as "pipeline never ran, treat as failing" — a deliberate
> TAI-107/108 decision from when Pipelines auto-ran on every push, so an empty list was
> genuinely suspicious. That assumption is gone: zero statuses is now the ORDINARY case for
> every commit unless a human deliberately triggers the manual pipeline. Human-confirmed
> live (2026-08-27): a merge must not be held up over a pipeline nobody asked to run.
> `isGreen([])` now returns `true`; any status that IS present and non-successful (failed,
> in-progress) still blocks, same as before — only the "nobody ran anything" case stopped
> gating. Fixed in `git-pr.ts`, `git-pr.test.ts`, and
> `bitbucket-git-host.integration.test.ts`'s live assertion (TAI-250, a Dev subtask under
> TAI-230's Spike). This also unblocks `readyToMerge` (§5.4/TAI-107-108's own list), which
> had been silently empty forever under the old rule once Pipelines went manual. TAI-230
> itself stays open for the broader Pipelines-strategy question this was only the
> `git-pr merge` half of.
> Prior: rev 52 — **§5.4/§6: `CodeReview` subtask retired in favor
> of git-host-driven review readiness, superseding TAI-34's design.** TAI-157/158/159: a
> real, near-term company requirement for N-of-M PR approvals surfaced a structural gap
> TAI-34 didn't anticipate — a Jira subtask needs exactly one `Assignee` (§5.5's hard
> assignment gate), and there's no honest single assignee for "the" review under a
> multi-approver policy. Resolved via TAI-159's ADR (Confluence TA space page 28704769,
> supersedes TAI-34's page 13860867 — that page's out-of-band-human-action principle is
> kept and extended, not replaced): the `CodeReview` subtask stops being created going
> forward (though it stays in the schema permanently — `fromJiraIssueType` deliberately
> throws on unrecognized types, and historical Done `CodeReview` tickets exist forever);
> `Dev` stays `In Progress` until its PR actually merges, not until the PR opens; and
> `tai-ready` gains three live git-host-queried lists (`readyToReview`/`readyToTest`/
> `readyToMerge`) replacing the CodeReview-anchored precedence edges, extending TAI-107/
> 108's existing `readyToMerge` pattern rather than inventing a new one. See §5.4 and §6
> for the revised chain, and the TAI-159 ADR for full detail (required-approval-threshold
> handling, the new "PR Reviewers" roster, `git-pr create`/`merge` changes). **Built
> (TAI-160):** two refinements found live during implementation, both human-confirmed
> 2026-08-24 — (1) testing runs **in parallel** with review, not gated behind it
> (`readyToTest` has no approval-count check at all; only `readyToMerge` does) — protects
> `master` without inverting `Deploy`'s existing merge-then-nothing-after ordering; (2)
> `git-pr review` is now **roster-gated, not persona-gated** — `git-pr review <REPO>
> [PR-ID] <approve|requestChanges> [COMMENT]`, no `<ISSUE-KEY>` at all, since there's no
> ticket left whose `persona` field would resolve to Code Reviewer. See §8 item 30 for a
> known limitation surfaced along the way (a Story can't host more than one Dev/Test/
> Deploy cycle — a follow-up always needs a new Story/Bug).
> Prior: rev 51 — **§3.8/§9: TAI's own command surface moved to
> global skills, no MCP server required.** TAI-116/126, following TAI-90's ADR (Confluence
> TA space page 26902529): `tai-work`/`tai-ready`/`tai-pr`/`tai-init` now ship as global
> skills — `~/.claude/skills/tai-<name>/SKILL.md` and `~/.gemini/skills/tai-<name>/SKILL.md`
> (both hosts use the identical Markdown format for their global mechanism, confirmed by
> inspecting the already-installed `sess-resume`/`sess-handoff` skills) — installed once via
> `install-global` (`src/hosts/cli.ts`), referencing a fixed install path (`~/.tai-framework/`
> by default) rather than a path relative to whatever project the host happens to be running
> in. `tai-framework`'s own project-local wrapper files (`.claude/commands/tai-work.md`/
> `tai-ready.md`/`tai-pr.md`, `.gemini/commands/tai-work.toml`/`tai-ready.toml`/`tai-pr.toml`)
> retired in favor of the same global installs. **Also (TAI-126):** `cli.ts` gained
> `issue create|transition|comment|link`/`page create|link` subcommands, wrapping
> `WorkTracker`/`DocStore` methods that already existed against direct REST (brief §3.2) —
> no Atlassian MCP server is required for TAI to work end-to-end anymore; earlier sessions
> used one only because these subcommands didn't exist yet.
> Prior: rev 50 — **§3.1/§6: PM/Architect granted
> `createPullRequest`, plus a Story-first PR title convention.** TAI-112 (found live while
> landing standalone documentation-only PRs, PR #18/#21): PM and Architect held zero
> `gitHost` grants, so landing framework-governance content (persona docs, this file itself)
> meant borrowing an unrelated Dev subtask's key purely to get `createPullRequest`
> permission — which then made `git-pr create`'s auto-linker (rev 48/TAI-108) wrongly
> attach the new PR to that subtask's real CodeReview sibling. **Decided, after the user
> questioned the first proposed fix (a `--no-link` flag) as "hacky":** grant PM/Architect
> their own narrow `gitHost: [createPullRequest]` instead — same asymmetry as Tester (rev
> 48), never paired with `mergePullRequest`. Verified in code this also structurally
> prevents the false-linking bug for free: `findCodeReviewSiblingForLink` already bails out
> on any key without a `parentKey`, and a Story/Bug/Epic key never has one. **Also decided
> in the same pass:** PR titles must be tied to the parent Story/Bug first, subtask second —
> checked the 10 PRs preceding this ticket and found neither convention actually followed
> consistently (some subtask-keyed, some Story-keyed). New `validatePrTitle` (mirroring
> `validateBranchName`'s validate-only posture) requires `<StoryKey> - <SubtaskKey> - ` or,
> with no subtask, `<StoryKey> - `. `personas/pm.md`/`architect.md` gained the grant;
> `config.test.ts`'s gitHost-grant-matrix test and `.gemini/commands/tai-pr.toml` updated to
> match.
> Prior: rev 49 — **§8 item 29: new open question — a human-
> requested review override, raisable at any stage in the chain.** User direction while
> TAI-111's review was in flight: at any point (Architect, Analyst, Dev, CodeReview,
> DesignReview, ...), someone — most likely a human — should be able to flag a task/Story
> as needing human review even when the AI review for that stage already passed. Genuinely
> undecided how to track it yet (comment convention vs. label vs. field; how it blocks; who
> clears it) — added as an open item, not designed on the spot, matching the new
> "ask the human on genuinely open questions" posture (rev 48's own `personas/analyst.md`/
> `architect.md` addition) rather than resolving it unilaterally.
> Prior: rev 48 — **§3.1/§5.4: Tester granted `createPullRequest`,
> closing a real gap in the checkpoint chain.** TAI-100 (an IntegrationTest subtask, live):
> Tessa hit a `PersonaPermissionError` trying to land her own test code — §5.4's canonical
> checkpoint chain (`Dev subtask --opens PR--> CodeReview subtask --approves PR-->
> Merge/Deploy subtask --merges PR-->`) only ever named Developer/Code Reviewer/DevOps, and
> `IntegrationTest`/`SystemTest`/`E2ETest` sit entirely outside that chain in the
> `SUBTASK_PRECEDENCE` graph — nothing gave a Test-tier subtask any way to open its own PR.
> User direction: Tester should have PR-creation permission. `personas/tester.md` gained a
> `gitHost: [createPullRequest]` grant — deliberately NOT paired with `mergePullRequest`
> (no self-merge for Tester; a Tester-opened PR still goes through Code Reviewer like any
> other). `config.test.ts`'s gitHost-grant-matrix test updated to match.
> Prior: rev 47 — **§3.8: command surface standardized on hyphens,
> `/tai-work`/`/tai-ready`, not `/tai_work`/`/tai_ready`.** TAI-89: the shipped wrapper
> files used an underscore/`tai_` prefix while `git-pr` (a bare `cli.ts` subcommand about
> to get its own wrapper via TAI-87) used a bare hyphen — an inconsistent command surface
> otherwise. `.claude/commands/tai_work.md`/`tai_ready.md` and `.gemini/commands/
> tai_work.toml`/`tai_ready.toml` renamed to `tai-work`/`tai-ready` (including their own
> internal prose references to the slash command name); `personas/developer.md` updated
> too. Deliberately scoped out: `src/hosts/cli.ts`'s internal subcommand strings (`work`,
> `ready`, `git-pr`) and doc-comments in `src/core/commands/work.ts`/`ready.ts` mentioning
> `/tai_work` as the slash-command name — not user-facing, out of this Bug's scope.
> Prior: rev 46 — **§3.1/§5.6: PM now owns `workOn: Kickoff/Story/
> Bug`, closing the gap rev 45 left open.** The concrete need rev 45 said to wait for
> surfaced immediately: `TAI-89` (a bare Bug, parent `TAI-8`) had no persona permitted to
> work it. User direction: "the vast majority of story and bug items will be owned by the
> PM or the Analyst — they are the most likely 'orchestrator' types to close story-level
> Jira tickets." `personas/pm.md`'s `workOn` grant already carried a comment claiming
> Kickoff/Story/Bug were owned "same as Spike" — this was aspirational, not yet true in the
> actual list; rev 46 makes the grant match the comment. Analyst was deliberately left
> alone (still no `workOn: Story`/`Bug`) — Analyst's role stays subtask-level
> (`Subtask:Research`/`Subtask:Investigate`); if a concrete need for Analyst to own a bare
> Story/Bug surfaces, grant it then, same "don't build ahead of an observed need" posture
> as elsewhere. `TAI-86`/`TAI-88` (Spike, parent TAI-6) still stand to produce a proper ADR
> ratifying this — this rev is the fast-tracked code+brief change, not that ADR.
> Prior: rev 45 — **§3.1: PM (not Architect) owns `workOn: Spike`
> — corrects rev 44's wrong assignment.** `workflows/spike.md` — not consulted before rev
> 44 — is explicit: "PM is the default owner/driver of the Spike story itself, same as
> Kickoff/Story/Bug"; subtask-level ownership (`Feasibility`→Architect, `Database`→DBA,
> `Infra`→DevOps) is separate and was already correctly granted, no change needed there.
> PM scopes the Spike and creates its investigating subtask for that subtask's fixed-owner
> persona to actually work; PM then drives the Spike to `Done`/`Canceled` once that
> persona proposes an outcome. `Kickoff`/`Story`/`Bug` still have no `workOn` grant
> anywhere — the same gap noted in rev 44, still unaddressed, revisit only if a concrete
> need surfaces one.
> Prior: rev 44 — **§3.1: Architect owns `workOn: Spike`** (WRONG, see rev 45) — surfaced
> while PM (rev 43) decomposed TAI-8 and needed to create a Spike (design the Gemini CLI
> host integration model); reasoned from "who does the investigating work" without
> checking `workflows/spike.md`'s already-settled story-vs-subtask ownership split first.
> Prior: rev 43 — **§3.1/§3.7: PM (not Analyst) owns Epic→Story
> decomposition, invoked directly on the Epic.** Surfaced by TAI-8 itself: no persona had
> `workOn: Epic`, so no unit-of-work invocation could ever act on one. `Epic` is now
> granted to PM's `workOn`, folding the propose/create split into a single PM turn at this
> level — PM decomposes the Epic and creates the resulting Stories/Subtasks itself, no
> longer waiting on a separate Analyst proposal pass for it. Analyst's `propose: Epic`
> still stands for the *project→Epic* level (§3.7's first pass, unaffected); only the
> **second, per-Epic pass** changes owner. `personas/pm.md` and `personas/analyst.md`
> updated to match.
> Prior: rev 42 — **§8.10 fully resolved: `rollupStatus()`
> fires at the same refresh points §3.6 already defines for per-item caches** — no separate
> trigger concept, no dedicated refresh command needed as the primary mechanism. Not
> actually blocked on a not-yet-built CLI layer as previously framed — blocked (same as
> §8.14/§8.15) on the orchestrator/persona-invocation loop (TAI-8) existing to call it at
> those points. **§3.6 also gains a third refresh point: completing a unit of work**, not
> just starting/resuming — a persona should refresh before deciding a unit of work is
> actually complete, since other in-flight information may bear on that decision.
> Prior: rev 41 — **§8.14 resolved: Jira comment/label
> + status rollup is sufficient for v1; active push notification is deferred, not
> declined.** §3.3's escalation behavior already stops at journaling the rejection and
> escalating to a human — that visibility is enough for now. An active push (email/Slack/
> Teams) needs infrastructure that doesn't exist yet: no running orchestrator/CLI layer to
> trigger from (§8.10's still-open trigger-timing half already flagged this gap for even an
> automatic *rescan*), plus new integration config (channel, recipients, credentials) —
> materially more than anything else closed so far. Deferred until the orchestrator/
> persona-invocation loop (TAI-8) exists and gives a push notification an actual place to
> hook in, same treatment as §8.15's learning-loop deferral.
> Prior: rev 40 — **§8.17 resolved: no formal review
> gate for `Investigate` output.** Unlike Kickoff's `REVIEW_GATES[Kickoff]` (a named,
> multi-reviewer, story-level gate blocking downstream ticket creation), `Investigate` is
> an ordinary subtask that doesn't block anything downstream (§8.13, rev 38) and isn't a
> story-level gate — the generic per-subtask checkpoint (§3.4: human sign-off by default,
> unless autocompletion-configured) already covers it. No dual-reviewer (PM+Architect)
> structure, no unification with the Kickoff gate. **Addendum, raised during discussion:**
> when `Investigate` is spawned reactively out of another in-flight subtask (e.g. Dev hits
> an ambiguity mid-work), the originating subtask *can* be blocked on it — via the existing
> `SubtaskDependencyOverride` ad-hoc-dependency escape hatch (`workflows/dependencies.md`),
> not a new mechanism. This is a per-instance judgment call by whoever discovers the need,
> same as who flags `Investigate` in the first place (§8.13) — not a change to the static
> `SUBTASK_PRECEDENCE` graph, which still has no automatic edge for `Investigate`.
> Prior: rev 39 — **§8.16 resolved: new-subtask-type
> process mirrors §8.1's story-type taxonomy.** `SubtaskType` (`story-schema.ts:87`) is a
> compile-time TypeScript enum, and `STORY_SUBTASK_MAP`/`SUBTASK_OWNER` are compile-time
> `Record`s keyed off it — adding a genuinely new type is a schema/code edit, not a Jira-side
> action, categorically different from `workflows/kickoff.md`'s "Human Overrides" case
> (which reuses an *existing* type in a story context that doesn't formally allow it, and
> already generalizes across Story/Bug/Spike). A persona (Analyst/Architect) can propose a
> new type when a real case doesn't fit the existing list — same propose pattern already
> used for Spike outcomes, post-deploy Bugs, and Ada's decomposition — but a human
> (developer) always makes the actual schema change. No AI-driven runtime taxonomy
> expansion, same "extensible but not self-expanding" posture §8.1 already set for story
> types.
> Prior: rev 38 — **§8.13 resolved (the "ready for
> implementation" half): no formal marker or checkpoint.** `Investigate` isn't in
> `SUBTASK_PRECEDENCE` at all (`workflows/dependencies.md`'s graph, `workflows/story.md`'s
> own "no automatic unblock effect" note) — nothing downstream is structurally gated on it,
> so there's no state for a formal "ready" signal to drive. `Investigate` reaching Done is
> ordinary subtask completion, same as any other subtask; whichever persona creates the
> next subtask (Dev, ArchitectureDesign, etc.) does so on its own judgment of the current
> story content, same direct-creation authority §8.11/rev 36 already established. Same
> "don't invent a signal without an observed failure" reasoning as rev 29's §8.28 decline —
> revisit only if a concrete under-baked-requirements incident actually occurs.
> Prior: rev 37 — **§8.12 resolved: no fixed decomposition-level
> ladder, no `Initiative` tier above Epic.** §3.7 already establishes decomposition as
> scope-relative and repeatable rather than a fixed `Project → Epic → Story` count — if a
> system needs something above Epic, that's a native-Jira concept a business configures on
> its own instance, not a new TAI schema type (no `Initiative` concept exists anywhere else
> in the schema). Where the Analyst/Orchestrator stops decomposing is likewise not a
> formula — "applicable at whatever scope is handed to it" means a human or the
> Orchestrator decides scope per invocation, an inherent judgment call.
> Prior: rev 36 — **§8.11 resolved: no pre-subtask work phase exists
> to give a home to.** Premise declined — a persona creates the subtask as its first
> action, before any exploration/brainstorming begins, so journaling/caching always has a
> key. Settled alongside it, from discussion: subtask creation is **direct**, gated only by
> the creating persona's existing per-issue-type `create` permission (§3.1) — PM may
> pre-create a Story's whole known subtask chain, or any persona may create a subtask it
> recognizes as needed mid-flight (the existing "present-when-added" pattern). **Story-level
> ticket creation is unchanged** — still propose → PM confirms/creates (Spike outcomes,
> PostDeploy Bug, Ada's decomposition), not direct. Precedence-link wiring for a
> mid-flight-inserted subtask turned out to already be solved in code, not a gap at all:
> `workflows/dependencies.md`'s "Dynamic Subtask Insertion" section and
> `getNewPrecedenceEdgesForInsertedSubtask()` (`schema/story-schema.ts`) already compute the
> new edges automatically — the PostDeploy example there is the exact scenario raised in
> discussion. Also corrects a stale cross-reference found along the way: §5.3's rev-27
> `Backlog` text pointed to "§7's dynamic-subtask-insertion note," which never existed in
> §7 — the actual content is in `workflows/dependencies.md`.
> Prior: rev 35 — **§8.10 half-resolved: `status.json`'s staleness
> rule is neither TTL nor trust-until-mismatch — there isn't one.** `rollupStatus()`
> (`src/core/workspace/status.ts`, TAI-56 ADR decision 6) always does a full rescan of
> `.tai/work/**/status.json` on demand and overwrites the root file, with no comparison
> against `generatedAt` at all — unlike the Jira/Confluence cache, this rollup only reads
> local files TAI's own process just wrote, so there's no network cost to gate a skip on.
> **Left open:** when a reconciliation scan triggers automatically (session start? every
> command? explicit refresh?) — blocked on a CLI/command layer that doesn't exist yet.
> Prior: rev 34 — **§8.8 resolved: worktree-swap is the default
> ticket-switch mechanic, not plain checkout.** §6 already states the reason worktrees were
> adopted at all — "so switching between tickets doesn't require stashing dirty state" — and
> a plain-checkout default would reintroduce exactly that problem. Design decision only;
> no worktree logic exists in `src/core/git/` yet.
> Prior: rev 33 — **§8.7 resolved by implementation: the storage
> interface's operation set already exists in code and is proven identical across
> backends.** `src/core/storage/interface.ts`'s `WorkTracker`/`DocStore` cover issue/page
> CRUD, the typed `search(filter)` JQL-equivalent, transitions, comments, links, and
> attachments — validated by a 710-line conformance suite run against both the filesystem
> and Jira backends (Jira `TAI-15`). Jira-specific concepts are kept out by construction:
> no raw JQL, no raw custom-field ids (promoted to named typed fields instead), no
> backend-specific content encoding (`Page.content` is always markdown). Comment/link
> delete and attachment upload don't exist yet — not decided against, just not yet needed.
> Prior: rev 32 — **§8.5 resolved: "re-triage" on a failed checkpoint
> retry isn't a persona judgment call at all — it's deterministic plugin-layer mechanics.**
> Where a failed checkpoint's retry goes is already fixed by the workflow's documented
> loop-back structure (Dev ⇄ Test, ArchitectureDesign ⇄ DesignReview, UAT rejection
> routing, §5.3); whether to retry-vs-escalate is already fixed by the single-retry counter
> (§4). Nothing discretionary is left for the Orchestrator persona to "decide" — no
> persona-level permission is needed, same enforcement pattern already used for the
> Jira-rejected-transition rule (§3.3: enforced once in the storage plugin's `transition`
> operation, not per-persona).
> Prior: rev 31 — **§8.3 resolved: the "persona can't approve its own
> work" rule is scoped to the same human, not the same persona role.** Persona role was
> never actually a live dimension — every workflow (`workflows/story.md`, etc.) always
> routes authored work to a *different* persona role for review (Developer → Code
> Reviewer), so "the same persona role approves its own output" can't structurally happen.
> The only real way self-approval occurs is the same human filling both roles — the
> solo-dev case §4 already named, with the override already sketched at the Code Reviewer
> persona level (rev 10 note). No code change needed; existing workflow routing already
> handles it.
> Prior: rev 30 — **§8.27 declined: neither gap it identified turns
> out to be real.** Revisiting the two sub-questions left open at rev 26: company/global
> docs are dropped from consideration outright — no cross-project scope exists to serve
> (this framework's "one Confluence space per Jira project" model, §4, is sufficient as is).
> The epic-level catch-all isn't missing either — untyped, non-ticket-tied content already
> has a home in the existing **project-level `Config` folder** (§4, rev 13), the same one
> that already holds the Persona Roster; nothing new needed for epic-scoped content either.
> Both sub-questions collapse to "already covered by existing structure," not "needs a
> Spike" as originally guessed.
> Prior: rev 29 — **§8.28 resolved: `Backlog → To Do` stays a soft,
> unenforced convention indefinitely — no hard gate built.** Revisiting the question left
> open at rev 27: whether/how the readiness transition should eventually harden. Declined
> as premature, per §8 item 1's own "don't build ahead of an observed need" reasoning —
> none of the candidate "ready" signals (no unresolved `NEEDS CLARIFICATION`, no unresolved
> `Q:` thread, precedence-unblocked) alone captures "a human/process judged this ready,"
> and the rev 19 assignment gate earned hard enforcement because it prevented a concrete,
> identified failure mode (§5.5) — no equivalent incident has occurred here. Revisit only if
> a real "ticket left `Backlog` before it should have" incident happens in practice.
> Prior: rev 28 — **§5.3 gains an Epic-status policy: `In Progress`
> derives from children, `Done` never does.** The moment an Epic has any child that's left
> `Backlog`, the Epic itself reads `In Progress` (simple dormant/active signal, not a
> percentage rollup). But an Epic is never auto-marked `Done` just because every
> currently-decomposed child is `Done`/`Canceled` — that's a false-completion trap given
> Epics are open-ended (§3.7's recursive decomposition assumes more Stories can always be
> added later; TAI-9's own history is the concrete proof — its GitHub `GitHost` backend
> was deferred, so "current children finished" didn't mean "nothing more is coming").
> Epic → `Done` is now explicitly a deliberate human judgment call (PM may propose it,
> never self-closes it) — same "human sign-off is the default" posture as everywhere else
> (§3.4). Applied live: TAI-8 moved to `Backlog` (nothing decomposed under it yet);
> TAI-5/6/7/9 moved to `In Progress` (each has `Done` children — real work has happened).
> Prior: rev 27 — **§5.3 gains a new `Backlog` status, and §8.28
> captures the open question it leaves behind.** The user added `Backlog` directly in the
> live Jira project — a pre-`To Do` status (native Jira behavior: excluded from the Kanban
> board) for tickets that are newly created, under-specified, or otherwise judged not
> ready. Resolved: it's now the **default landing status for new tickets** (superseding
> rev 11's assumption that `To Do` was the entry point), sits under Jira's `To Do` status
> category, and applies to every issue type (story-level and subtask, same scope as
> `Canceled`, rev 16) — orthogonal to the existing `SUBTASK_PRECEDENCE`-derived readiness
> machinery, which is unchanged. Deliberately left open (§8.28), not resolved here: the
> `Backlog → To Do` transition is a **soft, unenforced convention for now** — no crisp
> "ready" signal exists yet to hard-gate on, unlike rev 19's assignee-presence check.
> Prior: rev 26 — **§8.27 added: no established place yet for
> company/global-level docs or general epic-level docs.** Surfaced while scoping Epic
> TAI-8, after shipping TAI-52 (persona config/permission enforcement, Epic TAI-6's first
> Story — see §8.9/§8.22/§8.23, now **Implemented**, TAI-42/43). The existing Confluence
> structure (§4) has two tiers — per-doc-type-instance pages tied to a Story/Epic via the
> naming convention, and the project-level **Config** folder (rev 13, Persona Roster/
> Personas) — but nothing for (a) docs that span **multiple TAI projects entirely**
> (company coding standards, cross-team process, architecture spanning systems each with
> their own Jira project/Confluence space — §4's "one space per project" model has no
> answer for content that isn't scoped to any single project), or (b) a **general
> epic-level doc** that isn't one instance of the fixed ADR/PRD/Test-Plan/etc. taxonomy
> (e.g. an epic's own running design notes). Ideas only, nothing decided — see §8.27.
> Also: §8.9/§8.22/§8.23 now read **Implemented** — TAI-42 wired checkpoint/review-gate
> enforcement directly into `transition()` (both backends); TAI-43 built the
> autocompletion decision engine (`autocompletion.ts`) as a standalone pure-function
> module, deliberately **not yet called from `transition()`** — its own module doc says
> why: which call site invokes it is an orchestration question for Epic TAI-6, not this
> Story's. TAI-52 (Epic TAI-6's first Story) built the permission layer that engine will
> need a caller through, but the actual autocompletion call site still awaits TAI-8's
> persona-invocation loop. Corrects rev 25's "design only" status for §8.9/§8.22/§8.23,
> which was accurate as of TAI-41 alone, before TAI-42/43 shipped.
> Prior: rev 25 — **§8.9, §8.19, §8.20, §8.22, §8.23 updated to
> reflect real implementation/design work.** §8.19/§8.20 (pluggable `GitHost`, PR-backed
> CodeReview) marked **Implemented** — TAI-38/39/40 shipped `src/core/git/interface.ts`
> and the Bitbucket backend; §5.4 and §6's matching "not yet implemented" notes updated to
> match. §8.9/§8.22/§8.23 (autocompletion conditions, completion markers, checkpoint
> taxonomy) **resolved via the TAI-41 ADR** (Confluence, TA space) — design only, not yet
> built; §3.4 now points to it. §8.24/§8.26 are unaffected.
> Prior: rev 24 — **§8.21 and §8.25 applied to the actual docs.**
> `workflows/kickoff.md` now defines the `NEEDS CLARIFICATION` marker mechanism and blocks
> its PM+UX Designer review gate on zero unresolved markers (§8.21); `personas/pm.md` and
> `personas/ux-designer.md` each point back to it from their PRD/UX-flow output
> descriptions. All five `workflows/*.md` files now open with the one-line brief-compliance
> pointer (§8.25). §8.22–§8.24 (deferred) and §8.26 (declined) are unaffected — still
> nothing to apply for those. See §8 items 21 and 25 for the updated status.
> Prior: rev 23 — **§8.21–§8.26 (the six BMAD/GSD/Spec-Kit-inspired
> questions from rev 22) resolved: one adopted narrowly (§8.21, uncertainty markers scoped
> to Kickoff docs only), one adopted lightly (§8.25, a one-line brief-compliance pointer per
> workflow doc, not a full checklist), three deferred for having no current consumer
> (§8.22 completion markers, §8.23 checkpoint taxonomy, §8.24 persona manifest — all
> revisit when their actual driving work, e.g. Epic TAI-7, starts), and one declined
> (§8.26 retrospective/correct-course type — no real gap has surfaced yet in TAI's own
> dogfooding).** These are documentation-convention decisions only — **none of the six have
> been applied yet** to the actual `personas/*.md` / `workflows/*.md` files; that's
> follow-on work, not done by this revision.
> Prior: rev 22 — **six new open design questions added
> (§8.21–§8.26)**, surfaced by surveying BMAD-METHOD, GSD (Get Sh*t Done), and GitHub Spec
> Kit for ideas applicable to `src/personas/*.md` / `src/workflows/*.md`: explicit
> uncertainty markers in generated artifacts (Spec Kit's `NEEDS CLARIFICATION`), a
> structured completion-marker convention for persona handoff (GSD's agent-contracts
> pattern), a finer-grained checkpoint taxonomy beyond the current binary
> human-sign-off-default (GSD), a lightweight persona roster/manifest file separate from
> the full persona docs (BMAD's module-roster pattern), a brief-compliance gate embedded in
> each workflow doc (Spec Kit's "Constitution Check"), and a retrospective/correct-course
> workflow type (BMAD) that the Story/Bug/Spike/Kickoff taxonomy doesn't currently have.
> **Ideas only — nothing decided, nothing else in this brief changed.** See §8.21–§8.26.
> Prior: rev 21 — **§8.19 and §8.20 resolved via TAI-33/TAI-34
> (Spikes, dogfooded through TAI's own Jira project) — design only, nothing built yet.**
> §8.19: a new sibling `GitHostBackend`/`GitHost` interface, not folded into
> `StorageBackend` — git hosting is a different domain and an independent configuration
> axis from Jira/Confluence, but reuses the same pattern (branded IDs, `MutationResult`/
> `StorageConnectivityError`, an open `kind` discriminator). One interface, not split like
> `WorkTracker`/`DocStore`, since git hosting has no internal product seam. Scoped to what
> the checkpoint chain actually needs (PR CRUD, approve/request-changes, merge, commit
> status) — explicitly excludes a "trigger CI" operation, since this session's own
> Bitbucket work found that can't be guaranteed retroactively. §8.20: the
> Develop→CodeReview→Merge/Deploy chain (§5.4) now opens and acts on a real PR; PR state
> syncs one-way into the Jira subtask at existing refresh points (§3.6), never the reverse
> — the Jira subtask stays authoritative for TAI's own dependency graph. A human
> reviewing/merging directly on the git host, bypassing TAI, is treated as authoritative
> and simply reflected, not fought (same principle as §4's Confluence-gate-reopening
> rule). See §5.4 and §6 for the updated text, and TAI-33/TAI-34's ADRs (Confluence, TA
> space) for full reasoning. **Recommended next step, not yet scheduled:** one
> implementation Story building both the interface and the checkpoint together, per both
> ADRs' Consequences sections.
> Prior: rev 20 — two new open questions captured (§8.19, §8.20 above, before they were
> resolved), flagged during Bitbucket Pipelines CI setup.
> Prior: rev 19 — **§5.5 gains a hard assignment gate: a ticket must
> have a human `Assignee` before it may leave `To Do`.** Work in progress with nobody
> accountable for it is the exact failure mode this framework exists to prevent (§1), and it
> is invisible on a board. Enforced centrally in the storage plugin's `transition` operation
> alongside the existing checkpoint checks — an ordinary blocked checkpoint, not §3.3's
> unplanned-checkpoint/escalation path. Paired with a **pre-assign-at-creation** rule: when a
> ticket's `persona` resolves to exactly ONE authorized human in the Persona Roster (a solo
> developer; a team with a single PM), TAI sets `Assignee` at creation rather than deferring
> to a claim. With more than one candidate it does not guess — it falls back to the §5.6
> assignment-helper.
> Prior: rev 18 — **§4's "the Confluence space key matches the Jira
> project key" rule (rev 11) is wrong and is withdrawn.** TAI's own space is keyed `TA`, not
> `TAI`: Confluence derives a space key from the space *name* at creation and may shorten or
> disambiguate it, and a human can rename it later — so the two drift for reasons outside
> TAI's control. It went unnoticed for six revisions because the MCP tooling resolves spaces
> by *name*, masking the mismatch. `projectKey` and `spaceKey` are now separate config values
> that the storage backend takes independently; nothing may derive one from the other. Also
> corrects rev 17's hazard note, which wrongly claimed the `mcp-atlassian` wrapper inverts
> issue-link direction — it does not; that was a misreading of Atlassian's docs. Ground truth,
> verified live: for the `Blocks` type, the **inward** issue blocks the **outward** one.
> Prior: rev 17 — **§3.2's transport changes: Jira/Confluence are
> reached via the Atlassian REST API, not the Atlassian Remote MCP Server.** The MCP-server
> design (revs 1–16) was tested live in Phase 4's opening spike (Jira `TAI-16`) and does not
> work: auth succeeds headlessly, but the tool surface returned is three read-only Teamwork
> Graph tools — no issue creation, no transitions, no comments, no pages. The real
> Jira/Confluence tools sit behind interactive OAuth 2.1, which would leave CI and the
> integration tests with no headless path. Direct REST works, needs zero new dependencies,
> and drops a lossy translation layer. Critically, **`StorageBackend`/`WorkTracker`/`DocStore`
> needed no change at all** — the Phase 3 abstraction absorbed the swap exactly as intended.
> §3.2 also now carries a hazard note about third-party MCP wrappers (`mcp-atlassian`), whose
> defects were catalogued the hard way while building TAI's own backlog through one. §10
> updated to match.
> Prior: rev 16 — new **`Canceled`** status added to §5.3: a
> second terminal state for work abandoned before completion, available on every issue
> type (story-level and subtasks alike). Gap found while cross-checking the real Jira
> site's full status list — nothing to reuse — surfaced by `workflows/spike.md`'s
> "cancelled/deferred" outcome, which previously had no distinct status and collapsed
> into `Done`. Counts as satisfied for `SUBTASK_PRECEDENCE` purposes, same as `Done`.
> `spike.md`/`story.md`/`bug.md`/`kickoff.md` all updated with their own `Canceled`
> transition.
> Prior: rev 15 — §5.3 status names/scope corrected against the
> actual TAI Jira project: the default status is **`To Do`**, not `Open` (cosmetic —
> avoids renaming what's likely a shared/global Jira status across the whole site); and
> **`In Review` exists on every issue type by default**, not just Kickoff — Jira's shared
> default workflow doesn't allow withholding one status from most types without a
> separate per-type workflow, so it's simpler to leave it universally present and let
> TAI's own logic (§3.3) decide which types actually transition into it. Only Kickoff
> does. Every `workflows/*.md` and `personas/tester.md` status reference updated to
> match.
> Then: rev 14 — §4's Confluence folder convention extended to
> **config-type content**: the Persona Roster and persona extensions aren't tied to a
> ticket, so they don't fit the `<JIRA-KEY> — <Doc Type>: …` naming rule below; they get
> their own top-level **`Config`** folder instead. Reflects the actual TAI Confluence
> space now in use — `Config` → `Persona Roster` created there, seeded with the
> project's first (solo) team member across all 9 personas.
> Before that: rev 13 — the ad-hoc, no-fixed-owner **subtask**-level
> `Spike` type (§5.2) is renamed **`SpikeTask`**, discovered as a real naming collision
> while provisioning Jira issue types for the actual TAI project: Jira issue-type names
> are unique site-wide, and the pre-existing **Story**-level `Spike` type (§5.1) already
> owns the name "Spike." `StoryType.Spike` is unchanged; only the subtask-level ad-hoc
> escape-hatch type (`SUBTASK_OWNER[SpikeTask] = null`, `schema/story-schema.ts`) is
> affected, along with every persona/workflow doc that referenced it. Also fixed two stale
> "Jira Project Role" references left behind by rev 12's registry redesign below.
> Before that: rev 12 — §5.6 human registry redesigned: TAI's own
> storage-agnostic **Persona Roster** (Confluence-page-backed on the Jira backend, a local
> file on the filesystem backend) replaces the native-Jira-Project-Role design from rev 11,
> because Jira Cloud's Free plan cannot create/edit Project Roles at all — for either
> project type — and a Jira-only construct doesn't work for the filesystem backend anyway.
> Native Project Role sync becomes an optional, deferred paid-tier enhancement (§8.18).
> Before that: rev 11 — full design-notes review pass, §3-§8: subtask taxonomy↔Jira mapping,
> D7/D9/D12 resolved, scenario-workflow layer dropped, the two-axis owner model (D15),
> Confluence structure/naming/gate-reopening rules, local cache bulk-sync/attachments, new
> §3.9 Comment Conventions, and briefing/kickoff/connectivity-loss mechanics for a unit of
> work — see DESIGN_NOTES.md for the full session-by-session history)
> **Working title:** Team AI · **Package/repo:** `tai-framework` · **Command prefix:** `/tai_`

---

## 1. Vision

Team AI is a multi-persona, spec-driven development framework for AI coding assistants
(Claude Code and Gemini CLI first; Antigravity CLI later). It layers structured process,
role-based AI personas, and human oversight on top of an external, pluggable
"source of truth" for project state.

Where existing tools like BMAD-METHOD and GSD (Get Shit Done) target primarily solo
developers with local file-based state, **Team AI's defining requirement is real
multi-person team collaboration.** State lives in a shared system of record — Jira by
default, with Confluence for design documents — so that a human in each role can oversee,
review, and gate the corresponding AI persona's work.

The core idea: **a human architect oversees the AI Architect persona; a human developer
oversees the AI Developer persona; and so on.** Jira/Confluence make that oversight
concrete, auditable, and shared across a team, rather than trapped in one person's local
folder or chat history.

---

## 2. Inspiration & Differentiation

**Borrowed from BMAD-METHOD:** the multi-persona planning model (Analyst → PM → Architect
→ Dev → QA, etc.), the idea that each persona is a complete unit (role definition +
dependencies + workflows), and scale-adaptive planning depth.

**Borrowed from GSD:** coding-workflow discipline — atomic commits tied to units of work,
configurable git branching strategies, fresh-context execution to avoid context rot, and
quality gates before work is considered done.

**How Team AI differs from both:**

- **Team-first, not solo-first.** Multiple humans collaborate through AI personas
  simultaneously.
- **External source of truth via a plugin model.** Jira/Confluence by default, but the
  storage layer is an abstraction — a local filesystem backend (mimicking the Jira
  hierarchy) serves solo developers and offline work, and other Jira-competitor products
  can be swapped in via their own MCP servers.
- **Human-gated checkpoints are first-class.** Notably, GSD explicitly *rejects* Jira,
  sprints, and story points as unwanted overhead. Team AI deliberately embraces that
  structure because it is what enables auditable multi-person oversight. This is a
  conscious inversion, not an oversight.

**Build strategy:** Built from scratch in TypeScript. We borrow *ideas and patterns* from
BMAD and GSD, not code. (Both are independently licensed projects; we are not forking
either.)

---

## 3. Core Concepts

### 3.1 Personas
AI roles that Claude/Gemini assume to do work. Each persona:
- Has a **built-in default configuration** (its base prompt, the Jira issue types it may
  create / work on / complete / update, and its permitted transitions).
- Can be **extended** by a user/business-supplied prompt file that *adds to* the built-in
  definition — extensions layer on, they do **not** fully override the built-in behavior.
- Built-in personas can be **disabled** but **not deleted**. Users may also **add** wholly
  new personas.
- Persona extensions are stored in a standard place in **Confluence** so they can be shared
  across the team, and cached locally.
- Has a stable **`id`** (used for config, permissions, and issue-type routing) and a
  separate, human-facing **`displayName`** — a conversational first name, used in chat and
  UI so interacting with personas feels like working with teammates rather than invoking
  functions. Display names are **configurable/renamable** per team; the `id` never changes.
  Convention: the display name's first letter echoes the role's first letter, and gender is
  intentionally mixed across the roster.

**Default persona roster (starting point, configurable):**

| Role (`id`) | Display name |
|---|---|
| Analyst (`analyst`) | **Ada** |
| PM / Orchestrator (`pm`) | **Perry** |
| UX Designer (`ux-designer`) | **Uma** |
| Architect (`architect`) | **Aria** |
| Developer (`developer`) | **Dario** |
| DBA (`dba`) | **Dana** |
| Code Reviewer (`code-reviewer`) | **Cole** |
| Tester (`tester`) | **Tessa** |
| DevOps (`devops`) | **Duncan** |

### 3.2 Storage Plugin (Source of Truth)
An abstraction with swappable backends:
- **Jira** (default, source of truth) + **Confluence** (design docs), accessed via the
  **Atlassian REST API** (`/rest/api/3` for Jira, `/wiki/api/v2` for Confluence),
  authenticated as the actual human user. Access respects that human's existing
  Jira/Confluence permissions — a feature, not a limitation: an AI persona acts with exactly
  the authority of the human driving it.
  - **Auth (v1):** the human's own **API token** (`Authorization: Basic base64(email:token)`).
    Works headlessly, which is what lets CI and the integration tests run without a browser.
    **OAuth 2.1 (3LO)** can be layered on later if true per-user delegation is wanted; the
    backend takes auth as an injected provider, so this is a config change, not a redesign.
  - **Not the Atlassian Remote MCP Server** (`https://mcp.atlassian.com`) — this was the
    original design (revs 1–16) and it does **not work** for TAI. Tested live (rev 17, Jira
    `TAI-16`): authentication is fine (API-token Basic auth initializes cleanly over
    streamable HTTP, no browser needed), but the tool surface returned under headless auth is
    **three read-only Teamwork Graph tools** — `getTeamworkGraphContext`,
    `getTeamworkGraphObject`, `addTeamworkGraphContext`. No `createIssue`, no `transition`,
    no `addComment`, no `createPage`. The full Jira/Confluence tool surface appears to sit
    behind interactive OAuth 2.1, which would leave CI and the integration tests with no
    headless path at all. Going direct to REST also removes an entire lossy translation
    layer — see the MCP-wrapper hazards note below.
- **Local filesystem** fallback — a directory structure + naming convention that mimics the
  Jira hierarchy, for solo developers and offline work.
- **Other systems** (Jira competitors) can be added via their own adapters (REST or MCP,
  whichever that product actually offers), implementing the same storage interface.

The storage interface contract is the single most important design artifact in the system.
TypeScript interfaces enforce that every backend implements it identically — but note that
**types enforce shape, not behavior.** A shared **conformance suite**, run against every
backend, is what actually enforces identical behavior (Jira `TAI-15`).

**Operation set resolved by implementation (rev 33, §8 item 7):** `src/core/storage/
interface.ts` defines `WorkTracker` (issue CRUD minus delete — cancellation via `Canceled`,
§5.3, covers that case instead; `transition`/`getAvailableTransitions`; `addComment`/
`editComment`, no delete, matching the edit-only comment model elsewhere; `createLink`/
`getLinkedIssues`; `linkPage`/`getLinkedPages`; `listAttachments`/`getAttachment`, read-only;
`search(filter: IssueFilter)` as the typed JQL-equivalent) and `DocStore` (page CRUD,
comments, children, linked issues, attachments), bundled as `StorageBackend`. Proven
identical across the filesystem and Jira backends by the conformance suite referenced above.
**What stays out, so the filesystem backend stays clean:** no raw JQL strings (`IssueFilter`
is a typed object); no raw Jira custom-field ids (`persona`/`component`/`severity`/
`priority` are promoted to named, typed fields instead of a generic field bag); no
backend-specific content encoding (`Page.content` is always markdown — Confluence's
storage/XHTML and ADF diagram-macro wrangling, documented in `interface.ts`, is internal to
the Jira backend only). No comment/link delete or attachment upload exist yet — left out as
not-yet-needed rather than decided against, same "don't build ahead of an observed need"
posture as elsewhere (§8 item 1).

> **Hazard, for anyone driving Jira/Confluence through a third-party MCP wrapper**
> (e.g. `mcp-atlassian`, which is what a Claude Code / Gemini session typically has
> configured — a local Python server hitting REST with an API token; *not* Atlassian's own
> remote server). Observed live while building TAI's own backlog through it: JQL errors are
> **silently swallowed** (an invalid query returns `[]`, not an error — so "empty" is never
> authoritative); `create` and `update` use **different description encodings** (`create`
> stores the string raw and uninterpreted, `update` converts markdown → Jira wiki markup);
> `create` was seen **corrupting** input nondeterministically (escaping `**`, eating `+`
> characters); `create` responses **omit custom fields**, so a re-fetch is required; and
> Confluence comment editing has no tool at all. TAI's own backend does not go through this
> layer, and must not inherit these.
>
> *(Corrected: an earlier revision of this note also claimed the wrapper inverted issue-link
> direction. It does not — it passes `inwardIssue`/`outwardIssue` through faithfully. The
> error was in reading Atlassian's docs, not in the wrapper. Ground truth, verified against
> the live API: for the `Blocks` link type, the **inward** issue blocks the **outward** one.)*

### 3.3 Checkpoints
Human oversight gates on work progression. **Critical constraint discovered during
research:** native Jira workflow conditions/validators/post-functions can only be created
programmatically by Atlassian *Connect/Forge apps*, not by a normal OAuth-authenticated
integration (which is what our MCP-based access is). Therefore:

> **Team AI's own plugin layer is the enforcer of checkpoints and autocompletion rules.**
> We check conditions *before* ever calling the Jira "transition" API. Native Jira
> validators, if an admin chooses to configure matching ones by hand, serve only as
> optional defense-in-depth — they are not something Team AI deploys itself.

Checkpoints are modeled as **dependent subtasks in a "blocks / depends-on" chain**
(see §5.4). Human-gated checkpoints **take priority over all autocompletion settings** —
if a checkpoint requires a human, work pauses there even when autocompletion is otherwise
enabled.

**A Jira-side transition rejection is itself treated as an unplanned checkpoint.** Even
after Team AI's own checks pass, the actual Jira transition call can still be rejected —
an admin-configured validator, a missing required field, a permission gap, or a concurrent
change by another human or agent. This resolves an earlier open question: **Team AI always
attempts the real Jira transition** (it doesn't skip straight past Jira based on our own
checks alone), and if Jira rejects it, that rejection is never treated as an ordinary
failure. Work stops immediately, the Jira-returned reason is captured verbatim in the
unit's work journal (§3.6/§7), and the item is flagged for human intervention.

Because the AI usually cannot self-diagnose an admin's validator or a permissions problem,
**this case is explicitly excluded from the single-retry pattern** used for review
failures (§4) — it escalates straight to a human every time, no retry attempt first.

This is enforced **once, centrally, in the storage plugin's `transition` operation**
(§3.2), not repeated in each persona's own instructions. The operation returns either
success or a structured "blocked-by-source" result; every persona and the Orchestrator
react to that result identically, so no persona needs its own logic for this case.

Where possible, the block is also surfaced **inside Jira itself** — a comment stating the
reason, and (if configured) a label such as `blocked-external` — so it's visible to anyone
looking directly at the Jira board, not only to someone checking Team AI's local status
file.

> **Deferred (not v1): learning from Jira-side rejections.** The core behavior above —
> attempt the real transition, treat rejection as an unplanned checkpoint, escalate, no
> retry — is the v1 requirement. A **follow-on refinement**, explicitly out of scope for
> the first build, is closing the loop so a discovered constraint isn't rediscovered every
> time: proactively checking Jira's transition metadata before attempting a call (catches
> the common "forgot a required field" case for free), and reactively caching anything
> still discovered the hard way as a **proposed constraint** that a human can **promote**
> to confirmed. What promotion actually *changes* is deliberately left open — it might be a
> persona extension (§3.1), a workflow adjustment (§3.5), or something else this project
> hasn't hit yet. Don't presuppose the mechanism; figure that out when this refinement is
> actually scheduled. See open question §8.15.

### 3.4 Autocompletion
The ability for a persona to complete work without human sign-off, when configurable
conditions are met. **Human sign-off is the default.** Autocompletion is configurable by:
persona, by task type, and per-Jira-issue (likely via a custom field), each with a
configurable set of conditions that must be satisfied.

Conditions are richer than a simple checklist and are likely themselves prompt-based, e.g.:
- "Code review has no major issues and fewer than *X* minor ones."
- "DB design passes DBA review and satisfies the Analyst's requirements."

**Design resolved (rev 25, TAI-41 ADR, §8.9/§8.22/§8.23):** `AutocompletionCondition
{ id, description }` (the `description` is the prompt text above); `transition()` never
evaluates a condition live — the deciding persona evaluates it and records PASS/FAIL via a
`Complete:` Jira-comment marker (extending §3.9's convention), which `transition()` reads.
Checkpoints are `hard` (never autocompletes — `ALWAYS_HUMAN_GATED_SUBTASKS`/
`REVIEW_GATES`) or `conditional` (this section's default, autocompletion-eligible per the
above). See the TAI-41 ADR (Confluence, TA space).

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

**Hard rule:** a persona may **never** approve/self-certify its own work. (See §4, item on
same-persona approval.)

### 3.5 Workflows
**Resolved (rev 11): there is only one sense of "workflow" — the per-Story-type process,**
documented in `workflows/*.md` for **Kickoff**, **Story**, **Bug**, and **Spike**. The
earlier idea of a separate, named "scenario" layer (`complete`/`quick`/`bugfix`,
configuring which personas participate and what each does) was considered during the §4
workflow-design pass and **dropped as unnecessary** — it turned out to already be absorbed
by the story-type + optional-subtask design:
- **"bugfix"** is just `StoryType.Bug`, which already skips Kickoff-style discovery
  entirely (see `workflows/bug.md`).
- **"quick"** is just a Story/Bug instance with fewer optional subtasks present —
  `DesignReview`/`UAT`/`UxDesign`/etc. are already **present-when-added**, per-instance
  judgment calls (see `workflows/dependencies.md`), not a separate configuration mode.
- **"complete"** is simply the full optional-subtask set being present.

Businesses configuring "which roles are enabled, which roles own which issue types, and
what each role does" is still supported — but as **persona configuration** (§3.1: personas
are configurable, extensible, disableable), not a distinct scenario-workflow concept
layered on top.

Notably, the **Kickoff** workflow (discovery / requirements / UX before implementation is
scheduled) carries a **review gate requiring joint PM + UX Designer sign-off** before it
may spawn Story/Spike tickets.

### 3.6 Cache Refresh Points & Resumability
Jira/Confluence are shared, externally-editable sources of truth — a human or another AI
agent may change a ticket or page at any time. Team AI does **not** attempt live sync.
Instead, freshness is checked at defined **refresh points**: when starting/resuming a unit
of work, when **completing** one (rev 41, §8.10 — refreshed before the completion decision
itself, since other in-flight information may bear on what to do next), and whenever an
item is first used in a session (per §4's caching rule). At a refresh point, cached items
are compared against source `lastUpdated` and re-pulled if stale.

Each refresh regenerates a **briefing** — a single aggregated markdown file combining the
subtask, its **immediate parent** (Story/Bug/Kickoff/Spike), and linked Confluence pages
into one readable snapshot. **Bounded, by design (rev 11):**
- **Ancestor depth stops at the immediate parent — the Epic is not auto-included.** The
  parent's own linked docs necessarily come along (the Confluence rule above, §4, already
  ties every persona-output doc to the parent, never the subtask, so this is how a
  subtask's briefing gets its ADR/PRD/schema-notes/etc. at all) — but the briefing does
  not also walk up to the Epic. Consistent with `workflows/dependencies.md`'s one-hop
  bounding rule for `RelatesTo` traversal (see below); if Epic-level context is genuinely
  needed for a specific unit of work, that's a targeted follow-up read, not a default.
- **Confluence page-to-page links get the same one-hop treatment as `RelatesTo`'s
  ticket-to-ticket traversal rule** (`workflows/dependencies.md`): the briefing includes
  pages linked directly to the subtask/parent, but does **not** transitively follow those
  pages' own outgoing links to further pages.
This is what a persona actually reads to resume work; it avoids re-assembling context from
scattered cache files every time, and gives a human something reviewable too.

Alongside the briefing, Team AI maintains an **append-only work journal** per unit of work,
recording every step taken and intermediate result as it happens — not just a final state.
If a session is interrupted, the journal shows exactly what was done and where to pick back
up. See §7 for the concrete file layout.

**Connectivity loss mid-unit-of-work (rev 11):** distinct from the filesystem backend's
offline mode (§3.2, a deliberate backend choice) — this is a *Jira-backed* project
losing connectivity transiently. TAI **degrades to the local cache** for reads (clearly
flagged to the human as possibly stale) and **queues writes** (comments, transitions,
assignments) in the work journal rather than failing outright, replaying them
automatically once connectivity returns — the journal is already the append-only "what
happened, what's next" record (above), so queuing pending writes there is the same
mechanism, not a new one.

### 3.7 Recursive Decomposition & Refinement
For large projects, a single decomposition pass is too coarse. Personas can be invoked
**recursively at progressively narrower scope**: the Analyst runs once against the overall
project to propose a breakdown into Epics ("a project of projects"); the **second pass —
scoped to each individual Epic, producing that Epic's Stories/Bugs — is PM's, not
Analyst's** (rev 43). PM is invoked directly on the Epic (`workOn: Epic`) and both
decomposes and creates the resulting Stories/Bugs/Subtasks in that same turn, rather than
waiting on a separate Analyst proposal pass at this level. (Ada remains available to PM
as a research input if a specific question needs investigating, same as any other persona
interaction — she just isn't the default owner of this pass.) The framework does not fix
how many passes happen or where they stop — it fixes that decomposition is a repeatable
persona operation, applicable at whatever scope is handed to it. (This mirrors BMAD's
scale-adaptive planning depth.)

**Scope-level count resolved (rev 37, §8 item 12): no fixed level ladder, no `Initiative`
tier above Epic.** Decomposition is deliberately scope-relative and repeatable rather than
a fixed `Project → Epic → Story` ladder with named levels — if a system genuinely needs
something above Epic, that's a native-Jira concept a business configures on its own
instance, not a new TAI schema type. **Where to stop is likewise not a formula:** "applicable
at whatever scope is handed to it" means a human or the Orchestrator decides the scope for
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
output into actual implementation subtasks is a separate decision (human or Orchestrator,
per §3.8), made once the Story is judged ready.

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

### 3.8 Interaction Modes
- A human can **initiate a persona** and interact with it (e.g. "what's ready for you to
  do?").
- A human can **initiate new work** (create a bug, request review of prior work, etc.).
- A human can **query what's "ready"** for any persona.
- An **AI Orchestrator** persona may (if granted permission) query what's next *and* kick
  off that work via the appropriate persona — but human-gated checkpoints still stop/pause
  the chain regardless.

**Concrete kickoff commands (rev 11):** `/tai-work <KEY>` loads/refreshes that unit of
work's briefing (§3.6) and invokes its owning persona directly. `/tai-ready [persona]`
answers "what's ready for you to do" when the human doesn't have a specific key in mind
yet. Both are thin wrappers over the same briefing-then-invoke flow — there's no
separate code path for "starting fresh" vs. "resuming."

**Review has no ticket entry (rev 78, TAI-425).** The `CodeReview` subtask is retired (rev 52), so the Code
Reviewer is not loaded by `/tai-work`. Its entry point is `/tai-pr`'s review flow, which runs
`git-pr review-prep <REPO> [PR-ID]` — same persona-heading-then-body shape as `work` and `groom`, keyed by a PR
instead of a ticket. A ticketless `/tai-review` skill was considered and deferred.

### 3.9 Comment Conventions (rev 11 — formalized here, previously design-notes-only)

TAI's own comment-scanning logic (§3.6) is what interprets these — none of them are
native Jira/Confluence features (plain Jira comments have no built-in resolved flag;
Confluence's native inline-comment resolve checkmark exists but isn't used for this, see
below). All three apply to **both** Jira issue comments and Confluence comments
(page-level and inline) — not just Jira.

- **`Q:`** — an open question. Native reply-threading (Jira) or the comment/reply
  relationship (Confluence) keeps the discussion together; a thread is **closed** once a
  terminal resolution comment appears within it, not merely by any reply existing.
- **`Approved:`** — review-gate sign-off (`REVIEW_GATES`). One such comment required from
  each persona in the gate's `requiredReviewers`, and the commenting human must appear in
  that persona's Persona Roster entry (§5.6) for it to count.
- **`Rejected: <Dev|Requirements|...>`** — rejection routing (e.g. UAT failure). Marker
  preferred; when absent, TAI infers intent from the comment text, escalating to a human
  only if genuinely ambiguous (humans can't be relied on to type structured markers every
  time) — the **marker-with-inference-fallback** pattern.

**Why not Confluence's native inline-comment resolve checkmark:** considered and
rejected as the signal for any of the above, for two concrete reasons — (1) the
Atlassian MCP server exposes no tool to set/toggle a thread's resolved state, only to
add/read comments, so TAI couldn't drive it even if it wanted to; (2) even reading it
wouldn't be reliable — a human may click resolve purely to declutter their view, not as
a substantive signal. The marker-text convention doesn't depend on either concern.

**Freshness, not cached memory:** since comments are human-**deletable** in both
systems, marker-scanning is always a **fresh re-scan**, never a cached "I already saw an
`Approved:` comment" memory. If a previously-satisfying marker comment is later deleted,
the gate/question reverts to unsatisfied — the same principle as §4's "editing an
already-approved doc reopens the gate" (Confluence bullet), just triggered by deletion
instead of an edit.

---

## 4. Established Design Decisions

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
  fills both roles (the solo-dev case named above).
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
- **Writing Confluence page content (TAI-397).** TAI converts a persona's markdown to Confluence
  storage format, and two authoring habits quietly corrupt the result, found live repeatedly:
  (1) **hard-wrapped prose** — a line break inside a paragraph or bullet breaks hyphenated words and
  merges labeled sentences, so write **one unwrapped line per paragraph or bullet** (repo `.md` files
  may wrap; page content may not); (2) **non-sequential ordered-list numbers** (`3b.`, a restart at
  1.) render wrong, so keep numbers sequential. When passing content from a file to `page create` /
  `page update`, write `"content=$(cat file)"` exactly like that — **unescaped**; an escaped
  `\$(cat ...)` writes the literal text over the page — and re-read the page afterward to confirm. Every
  persona that authors pages (Ada, Aria, Perry, Uma, Tessa) points here.
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

## 5. Jira Model

### 5.1 Hierarchy
```
Project            → one per "system" we build (a system may span multiple repos)
  Epic             → a feature set (no subtasks directly attached)
    Story / Bug    → the standard unit of work; typed (Kickoff, Story, Bug, Spike; earlier draft names Research/Implementation folded in)
      Subtask      → leaf work; typed (§5.2), not generic; single-repo
```

### 5.2 Subtask Types & Persona Routing
Subtasks are **typed**, not one generic "Subtask" — the type is what routes work to the
right persona. This taxonomy is **open and extensible**, and it has **evolved beyond the
original candidate list** as the persona/workflow files were built. The table below is the
**current set** and supersedes the earlier candidate names (`Develop`→`Dev`,
`Code Review`→`CodeReview`, `Design`→`ArchitectureDesign`/`Feasibility`, `Test`→the three
test tiers).

| Type | Typical persona | Category |
|---|---|---|
| Research | Analyst | Refinement — Kickoff discovery |
| Requirements | PM | Refinement — PRD drafting |
| UxDesign | UX Designer | Refinement — flows/wireframes |
| Investigate | Analyst | Refinement — Story-level (§3.7) |
| Feasibility | Architect | Refinement — quick technical go/no-go |
| ArchitectureDesign | Architect | Refinement — deeper design |
| DesignReview | Architect (second pass, or a peer) | Refinement gate — gates `ArchitectureDesign` → `Dev` (workflows/story.md) |
| Database | DBA | Implementation input (schema / migration / performance) |
| Infra | DevOps | Implementation input |
| Dev | Developer | Implementation (unit tests folded in) |
| CodeReview | Code Reviewer | Implementation gate — **retired going forward, rev 52 (TAI-159 ADR, §5.4)**; kept in the schema only to parse historical tickets |
| IntegrationTest / SystemTest / E2ETest | Tester | Verification |
| UAT | Tester + a human stakeholder | Verification — inherently human-gated (§3.3); gates `Deploy` (workflows/story.md, workflows/bug.md) |
| Triage | Tester | Bug entry point |
| Deploy | DevOps (default, overridable) | Implementation |
| PostDeploy | DevOps (default, overridable) | Implementation follow-up |
| SpikeTask | No fixed owner — assigned at creation | Ad-hoc investigation inside a Story/Bug (renamed from `Spike`, rev 12 — collided with the `Spike` **Story**-level type; Jira issue-type names must be unique site-wide) |

**Resolved (was Open gap #1 / §8.16):** the DBA and DevOps personas now have concrete
routing types — `Database` for DBA; `Infra` / `Deploy` / `PostDeploy` for DevOps. A type
may name a **default owner that is overridable per instance** (`Deploy` / `PostDeploy`),
which resolves the "can a type route to more than one eligible persona" sub-question.
Still open: the process for adding a brand-new type when a real case doesn't fit (§8.16).

**Still open (was Open gap #2 / §8.17):** `Investigate` (the Analyst's Story-level
refinement type) still has no dedicated AI-review gate. A Kickoff-stage **PM + UX Designer**
review gate now exists as-built (§3.5, `workflows/kickoff.md`), but it gates Kickoff
discovery output, not `Investigate` refinement output — the dual-reviewer question, and
whether the two gates should unify, remain open (§8.17).

**Now wired in (rev 10):** `DesignReview` and `UAT` — retained from the original
taxonomy — are now defined as optional gates in the workflow docs and the schema.
`DesignReview` gates `ArchitectureDesign` → `Dev` (mirroring `CodeReview`); `UAT` is
inherently human-gated (§3.3) and gates `Deploy`. Both are **present-when-added** and
purely additive to the precedence graph — see `workflows/story.md` and
`workflows/dependencies.md`.

Subtask-type-to-persona routing is configurable the same way persona permissions are
(§3.1): a business can add types, change routing, or restrict which types a given persona
handles.

**Subtask↔Jira mapping (rev 11):** each `SubtaskType` maps to its own **native Jira
sub-task issue type** (a Jira admin provisions one custom sub-task issue type per
`SubtaskType`, the same mechanism already assumed for `StoryType` — Kickoff/Spike aren't
native Jira types either). This is what lets the "no title prefix, the issue-type field
carries the signal" naming convention — already established per Story type in
`workflows/kickoff.md`/`story.md`/`bug.md`/`spike.md` — apply at the subtask level too,
not just the story level.

**No time-box/estimate custom field.** Time-boxed work (`Feasibility`, the ad-hoc
`SpikeTask` subtask) uses Jira's own native Original Estimate/Time Tracking field if a team wants to
track it — no TAI-specific field, consistent with reusing `Priority` rather than inventing
a field for the Bug D5 expedited path.

### 5.3 Statuses & Dependencies
Issues carry statuses (pending / in-progress / done, plus blocked/ready as derived from
dependencies) and **"blocks / depends-on"** links that determine what is ready to be picked
up vs. blocked. **Resolved (rev 11, was §8 item #2):** the default status lifecycle is
**`To Do → In Progress → Done`** for both story-level tickets and subtasks (rev 27 below
prepends a `Backlog` entry point ahead of `To Do` — the `In Progress`→`Done` portion here
is unchanged), with specific
per-type loop-backs documented in `workflows/story.md`/`bug.md` (Dev ⇄ Test,
ArchitectureDesign ⇄ DesignReview, UAT rejection routing). "Ready" vs. "blocked" is
**derived**, not a stored status — computed from `SUBTASK_PRECEDENCE`
(`isSubtaskReady()`/`resolveApplicablePrecedence()`, `schema/story-schema.ts`). Still
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
  Supersedes rev 11's assumption that `To Do` is the entry point — it's now the second
  step, reached only once a ticket is judged ready. `Backlog → Done`/`Canceled` directly
  (skipping `To Do`) is also valid, for a ticket that turns out unnecessary before ever
  becoming ready.
- **Default landing status:** any newly-created ticket lands in `Backlog`, not `To Do` —
  Ada's proposed Epic/Story decomposition output, PM-created Story/Bug/Spike from a WBS
  (§3.1), a refinement subtask's own output. This is a real behavior change from the
  rev 11 default (everything previously landed straight in `To Do`).
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

### 5.4 Checkpoint Chain (canonical example)
For an implementation Story touching one repo:
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
  unit of work isn't really done until it's merged. Verified this doesn't create a cycle
  with `Deploy`, which is gated only by the test tiers, never directly by `Dev`.
- **Test-tier readiness moves off the static precedence graph onto three new
  live-computed `/tai-ready` lists** — `readyToReview` (open PRs where the current human
  is an eligible reviewer, per a new "PR Reviewers" roster), `readyToTest` (In-Progress
  `Dev` subtasks whose PR has met its required-approval count), `readyToMerge` (same,
  additionally CI-green) — extending TAI-107/108's existing `readyToMerge` pattern
  (§5.4's own live-git-host-query idiom) rather than inventing a new one.
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

**Test-tier subtasks (rev 48):** `IntegrationTest`/`SystemTest`/`E2ETest` sit outside this
canonical chain in the `SUBTASK_PRECEDENCE` graph (they gate `Deploy`, not `Merge/Deploy`
directly), but a Test tier can still carry its own real code (e.g. a live-backend
integration test). When it does, Tester opens that PR herself (`gitHost: createPullRequest`,
same mechanics as Developer's step above) and it goes through Code Reviewer like any other —
Tester was NOT also granted `mergePullRequest`, so there's still no self-merge path for her.

See TAI-33's ADR for the `GitHost` interface this depends on.

For a **multi-repo** Story: repeat the Develop→Code Review→Merge/Deploy chain **once per
repo**, each subtask tagged with its repo via the native Jira **Component** field (§4,
rev 11 — not a custom `repo` field).

**Note:** the as-built Story/Bug graph elaborates this canonical shape with parallel
prerequisites (`ArchitectureDesign` / `Database` / `Infra` → `Dev`), parallel test tiers
between `CodeReview` and `Deploy`, and a `PostDeploy` follow-up — see
`workflows/dependencies.md` for the full precedence graph.

Story-level work is not always dev-related — Stories may be brainstorm, design, research,
etc., differentiated by their type and their subtasks.

### 5.5 Assignment & Claiming
- Jira **Assignee is a real human.** Our plugin layer (not Jira) enforces "act on tickets
  assigned to you, or claim an unassigned 'ready' ticket first."
- **No unassigned work in progress (rev 19).** A ticket **must have a human `Assignee`
  before it may leave `To Do`** — for *any* non-terminal onward status (`In Progress`,
  `In Review`). This is a **hard gate, enforced in the storage plugin's `transition`
  operation** (§3.3), alongside the checkpoint checks that already live there — not
  re-implemented per persona.
  - **Why a hard gate and not a nudge:** the entire premise of the framework is that a
    *named human* oversees the AI persona doing the work (§1). Work that is in progress with
    nobody accountable for it is precisely the failure mode Team AI exists to prevent — and
    it is invisible on a board, because an unassigned in-progress ticket looks like
    everything else. Unlike `Canceled`/`Done` (terminal, where an owner no longer matters),
    an in-flight ticket always has someone answerable for it.
  - **Rejection shape:** attempting such a transition fails the same way any other blocked
    transition does — the storage layer returns a `MutationResult` rejection with a reason,
    and the caller surfaces it. It is an ordinary blocked checkpoint, **not** the §3.3
    unplanned-checkpoint/escalation path (nothing surprising happened; the rule is known).
- **Pre-assign at creation when the assignee is unambiguous (rev 19).** When a ticket's
  `persona` (§5.6) resolves to **exactly one** authorized human in the Persona Roster, TAI
  sets `Assignee` **at creation time** rather than leaving it to be claimed later. Common
  cases: a solo developer (every persona maps to the same one person), or a team with a
  single PM/DBA/etc. When the roster lists **more than one** candidate for that persona,
  TAI does **not blindly guess**, and (rev 75) **does not assign the session's human at creation
  either**: someone logging a ticket for a colleague must not become its owner. The ticket is created
  **unassigned** and the assignment-helper (§5.6) prints the ranked candidates with a reason on every
  line — the session's human pinned first when they are a candidate — and "leave unassigned" is always a
  valid choice. A **named** person (`issue create assignee=`, `issue assign`) always wins with no list.
  At **claim and transition time** the rev 54 shortcut stays: when a ticket is moved out of `To Do` and
  the **human currently driving the session** is among the candidates, that human is assigned (a ticket
  that predates this rule, or was created by a different session, still gets it) — never a guess beyond
  "the person already here is an authorized candidate," and always overridable via a normal
  `issue assign`.
- Ready, unassigned tickets are **claimable.** People *should* work their own tickets, but
  we deliberately do **not** hard-lock *who* may pick a ticket up — people take time off,
  need help, hand work off. (Distinct from the rule above, which lock*s* that *somebody* is
  assigned, not *which* somebody.) So a branch for some work may already exist in the repo
  from a prior owner.
- **On claiming a ticket where a branch already exists:** prompt the user to either
  **fetch/continue the existing branch** or **create a new one.**

### 5.6 Human Registry & the Two-Axis Owner Model (rev 12)

**Human↔persona registry: TAI's own Persona Roster, not a native Jira construct.**
Originally scoped (rev 11) as one native Jira Project Role per persona, reusing Jira's
role mechanism the same way `Component` reuses Jira for repo tracking (§4). **Revisited
(rev 12):** Jira Cloud's **Free plan cannot create or edit Project Roles at all**, for
either team-managed or company-managed projects — only a site *downgraded* from a paid
plan keeps its old roles, frozen and read-only. Since Team AI is meant to be usable by
free-tier teams (not just paid), and since a Jira-only role mechanism has no equivalent
for the **filesystem backend** at all (a Jira-specific concept leaking into what should
be a storage-agnostic model — the exact concern open question §8.7 asks about), the
registry is redesigned around a mechanism TAI owns outright:

- TAI maintains its own **Persona Roster**: per project, a mapping of
  `persona id → [authorized humans]`. A human can appear under **multiple** personas
  (small-team/solo flexibility — e.g. one person is both Developer and Code Reviewer,
  consistent with the existing self-review carve-out, brief §4/§8.3).
- **Stored through the storage plugin, like everything else (§3.2):** on the Jira/
  Confluence backend, the roster is a page in the project's Confluence space — same
  "shared, human-editable, cached locally" treatment already established for persona
  extensions (§3.1). On the filesystem backend, it's a plain local file alongside the
  other project config (§7). Either way, editing it is a normal document edit — no Jira
  admin rights, no plan-tier dependency, no provisioning step.
- TAI caches the roster locally like everything else (§7), refreshed at the usual
  refresh points (§3.6).

**Deferred (not v1): native Jira Project Role as an optional sync target.** On a paid
plan (Standard+) where real custom Project Roles exist, TAI could additionally mirror the
Persona Roster into native Project Roles — giving a team native-Jira visibility into
"who's the Architect" without leaving Jira, and optional defense-in-depth (an admin could
hand-configure a validator against it), consistent with §3.3's general stance that native
Jira mechanisms are optional reinforcement, never a dependency. The TAI-owned roster is
authoritative and fully sufficient on its own, on any tier or backend, with or without
this sync. What triggers the sync (automatic plan-tier detection vs. an explicit opt-in
command) and how conflicts between the two are handled is left undesigned until this is
actually scheduled — same posture as §3.3's learning-loop deferral. See open question
§8.18.

**The two-axis owner model.** Every Story-level ticket (Kickoff/Story/Bug/Spike) and every
Subtask carries **two distinct fields**, never conflated:
1. **Native Jira `Assignee`** — the real human doing the work.
2. **A `persona` custom field** (single-select, one `Persona` enum value) — which role
   they're acting in *for this specific ticket*. Defaults to `SUBTASK_OWNER[type]` for
   subtasks (§5.2) or **PM** for story-level tickets (the established default story-owner
   pattern, `workflows/*.md`), and is always overridable, exactly like `Deploy`/
   `PostDeploy`'s existing "default owner, overridable per instance" note. The ad-hoc
   `SpikeTask` subtask has no default and must have it set explicitly at creation, same as
   it has no default human Assignee (rev 74: the defaults above are applied in code on create;
   for a `SpikeTask` the session asks the human which persona, and a create left persona-less
   still succeeds with a loud warning).

**Why a stored field, not a derived value:** since a human can appear under multiple
personas in the Persona Roster, looking up "which persona is this" purely from roster
membership is ambiguous whenever they're listed under more than one relevant persona. An
explicit, stored `persona`
field removes that ambiguity and is what makes effort/time-tracking roll up correctly by
persona regardless of which human actually did the work (the schema-level rationale
already stated for `SUBTASK_OWNER`).

**Assignment-helper (answers "does TAI help PM assign tickets to humans"):** when a
ticket needs a human `Assignee`, TAI looks up which humans are listed under that ticket's
`persona` field in the **Persona Roster**, **ranks** them (rev 75, ADR page 50692097) and surfaces the list
with a **reason on every line** to whoever is driving the session. The order is strict tiers, never a
score: **continuity** first (assigned to a sibling under the same Story, to a ticket linked to this one, or
to a ticket under the same Epic; for a Bug, the Dev of the Story it relates to), then **area knowledge** from
ticket data (who was assigned Done tickets with the same Component or labels within the window), then the
**open-ticket count**, then name. The author of the work under review is **demoted** below the rest with a
visible reason, never excluded (solo developers and one-off exceptions still work). Git-history signals
are a later ticket. The list is computed live and never stored. Once a human is picked, **TAI
performs the actual Jira `Assignee`-set call itself**, under the driving human's own
already-authenticated MCP session (§3.2) — no separate manual Jira login/assignment step
is needed. A human can always reassign directly in Jira too; that's an ordinary override,
handled the same "flag on refresh, don't block" way as any other human-made change
(§3.6/§7).

**Permission caching:** TAI does **not** pre-validate or cache what a given human is
*permitted* to do in Jira beyond membership in the Persona Roster above. Consistent
with §3.3's existing pattern: TAI attempts the real Jira call (an assignment, same as a
transition), and if Jira itself rejects it (e.g. missing "Assign Issues" permission), that
rejection is treated as the same kind of unplanned checkpoint already defined for
transitions — no new mechanism needed.

**Review-gate validation, updated:** a `ReviewGate`'s `Approved:` comment (§3.3/`REVIEW_GATES`)
now additionally requires the commenting human to appear in the **Persona Roster** under
the required persona — closes a gap where TAI previously had no way to verify a raw Jira
comment author actually corresponds to "the PM" or "the UX Designer" beyond trusting the
comment's content.

---

## 6. Source Control / Branching Model

- **Git host is pluggable (rev 21, design resolved via TAI-33, §8.19).** A sibling
  `GitHostBackend`/`GitHost` interface alongside `StorageBackend` — not folded into it,
  since git hosting is an independent configuration axis (a team can mix Jira+Bitbucket,
  Jira+GitHub, filesystem+GitHub) — reusing the Storage Plugin's *pattern* (branded IDs,
  `MutationResult`/`StorageConnectivityError`, an open `kind` discriminator) without
  reusing its interface. Scoped to PR CRUD, approve/request-changes, merge, and commit
  status — not the full breadth of either host's API. See the TAI-33 ADR (Confluence, TA
  space). **Implemented (rev 25, TAI-38):** `src/core/git/interface.ts` plus a Bitbucket
  backend at `src/core/git/bitbucket/`.
- **The CodeReview checkpoint acts on a real git PR (rev 21, design resolved via TAI-34,
  §8.20).** See §5.4 for the revised chain. PR state syncs one-way into the Jira subtask
  at existing refresh points (§3.6) — never the reverse; the Jira subtask stays what
  TAI's own precedence engine reads. A human reviewing/merging directly on the git host
  is treated as authoritative, not fought — same principle as this section's own
  human-authority stance and §4's Confluence-gate-reopening rule. See the TAI-34 ADR.
  **Implemented (rev 25, TAI-38/39/40)**, verified against the live TAIT scratch repo.
  **Superseded (rev 52, TAI-159 ADR). Implemented (rev 52, TAI-160):** the `CodeReview`
  subtask is retired going forward in favor of querying Bitbucket's own PR approval state
  live — see §5.4's "Revised (rev 52 design)" block. The one-way-sync and human-authority
  principles stated above are kept and extended, not replaced.
- **Branch unit:** parent Story/Bug. Name = parent issue key + very short slug
  (e.g. `PROJ-123-user-login`).
- **Subtasks accumulate** onto their parent Story's branch; they do not get their own
  branches.
- **PR title (rev 50, TAI-112): tied to the parent Story/Bug first, subtask second** —
  `<StoryKey> - <SubtaskKey> - <description>` when `git-pr create` is invoked against a
  subtask, or `<StoryKey> - <description>` when invoked directly against a Story/Bug/Epic
  key with no subtask (e.g. a PM/Architect governance-content PR). Enforced by
  `validatePrTitle` (`src/core/commands/git-pr.ts`), same validate-only/fail-loudly posture
  as branch-name validation above — the persona still writes the title, the framework only
  rejects a malformed one.
- **Branching strategies** (from GSD): `none` (commit to current branch), per-unit branch,
  and a milestone-style long-lived branch — configurable.
- **Git worktrees** for parallel isolation, so switching between tickets doesn't require
  stashing dirty state. **Resolved (rev 34, §8 item 8): worktree-swap is the default**
  switch behavior — a plain checkout would reintroduce exactly the stashing problem
  worktrees were adopted to avoid. Not yet implemented in code.
- **Commits** begin with the Jira issue key so Jira's dev panel links them and so we can
  derive the affected repo for the Component field (§4, rev 11).
- **Multi-repo Story:** one dev→review→merge/deploy subtask chain per repo.

---

## 7. Local Cache & Workspace Layout (concept)

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
        briefing.md              # aggregated snapshot: subtask + parent + linked
                                  #   Confluence pages, regenerated at each refresh point
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

## 8. Open Design Questions

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
    `DesignReview`'s current simple pass/fail-with-one-retry (`workflows/story.md`).
    Explicitly **not** a v1 change — the human's own call, same "real investigation, not a
    brief edit" posture as items 35/36. **See TAI-327 (Story, Backlog).**

---

## 9. Phased Implementation ("Eat Your Own Dogfood")

Team AI will be built using Team AI, implementing the persona chain incrementally and using
each new persona to help build the next.

- **Phase 0 (manual, now):** Write this brief. Define the Analyst persona prompt file.
  These bootstrap everything.
- **Phase 1:** Use the Analyst persona (prompt only, no tooling yet) to produce the formal
  requirements spec, stored as local markdown (Jira/Confluence not yet wired in).
- **Phase 2:** Analyst output + PM persona → define Team AI's own Epic/Story breakdown in
  Jira. Now there is a real backlog.
- **Phase 3:** Architect persona designs the plugin architecture. Developer persona begins
  building — **start with the storage plugin interface and the local filesystem backend,**
  since that unblocks everything before the Jira MCP path is fully wired.
- **Phase 4+:** Implement each remaining persona and immediately use it on the next Story in
  the backlog. Wire in the Atlassian MCP storage adapter. Layer in checkpoints,
  autocompletion, multi-repo, caching.

---

## 10. Tech Stack & Environment

- **Language:** TypeScript (strict), Node.js 20+, ESM.
- **Runtimes targeted:** Claude Code and Gemini CLI first; Antigravity CLI later.
- **Storage/integration:** Atlassian **REST API** (`/rest/api/3`, `/wiki/api/v2`),
  authenticated as the human via API token (OAuth 2.1 3LO layerable later); local filesystem
  adapter as fallback. Native `fetch` — no HTTP client dependency. **Not** the Atlassian
  Remote MCP Server; see §3.2 for why that was tried and rejected (rev 17).
- **Dev tooling:** `tsx` for watch/dev, `tsc` for build, ESLint + `@typescript-eslint`.
- **Session bootstrap files:** `CLAUDE.md` and `GEMINI.md` at repo root both point every
  session to **read this brief first.**
- **Persona/agent definitions:** markdown + YAML front-matter (parseable, human-editable,
  reviewable in PRs).

---

## 11. Glossary

- **Persona** — an AI role (Analyst, Architect, Developer, …) with a configurable definition and
  permission set.
- **Persona field** — a stored per-ticket custom field naming which persona is acting in
  this specific ticket; distinct from the native Jira `Assignee` (a real human) — the
  two-axis owner model, §5.6.
- **Persona Roster** — TAI's own storage-agnostic mapping of `persona id → authorized
  humans` (rev 12; supersedes the earlier native-Jira-Project-Role design, dropped
  because Jira's Free plan can't create Project Roles and the filesystem backend has no
  equivalent). Confluence-page-backed on the Jira backend, a local file on the
  filesystem backend. Backs the human registry and assignment-helper, §5.6. Syncing it
  into real Jira Project Roles on paid tiers is an optional, deferred enhancement
  (§8.18), never a dependency.
- **Storage plugin / backend** — a swappable implementation of the source-of-truth
  interface (Jira, filesystem, other).
- **Checkpoint** — a human-oversight gate modeled as a dependent subtask; overrides
  autocompletion.
- **Autocompletion** — condition-gated completion of work without human sign-off.
- **Workflow** — the per-Story-type process (Kickoff/Story/Bug/Spike, `workflows/*.md`)
  defining subtask structure, precedence, and gates. (An earlier "named scenario"
  sense — complete/quick/bugfix — was considered and dropped, rev 11 §3.5; absorbed by
  the story-type + optional-subtask design.)
- **Work unit** — the standard branch/work granularity: a Jira Story or Bug.
- **Orchestrator** — the PM persona that can query "what's ready" and dispatch work to other
  personas, subject to checkpoints.

---

*End of brief. Keep this current — it is the contract every persona and session relies on.*