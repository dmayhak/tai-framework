# Team AI (TAI) — Project Brief

> **Status:** Living document. This is the source of truth for the Team AI framework's
> vision, design decisions, and open questions. Every persona and every AI session must
> read this file first. When decisions change, update this file — do not let it drift.
>
> **Last updated:** 2026-10-15 (rev 111). The revision history is in `CHANGELOG.md`; this file states what is
> true now. A change to the brief adds an entry there, not here.
>
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
  create / work on / complete, and its permitted transitions).
- Can be **extended** by a user/business-supplied prompt file that *adds to* the built-in
  definition — extensions layer on, they do **not** fully override the built-in behavior.
- Built-in personas can be **disabled** but **not deleted**. Users may also **add** wholly
  new personas.
- Persona extensions are stored in a standard place in **Confluence** so they can be shared
  across the team, and cached locally.
- Cites other docs by a short relative path (`workflows/story.md`). Those resolve only inside the TAI
  install, so every loaded prompt ends with where they are, and `/tai-work`'s output names the absolute path
  of the workflow doc for the ticket's type (a subtask uses its parent's) and of `dependencies.md`. The docs
  are read on demand, never inlined.
- Is **two files**: `src/personas/<id>.md` is the run-time prompt — role, principles, behaviours,
  commands and hand-offs, stated as current fact — and `src/personas/rationale/<id>.md` holds why each
  rule exists and its history, and is never loaded. A rule change is written into the prompt as fact and
  its reason into the rationale file. The prompt carries no revision or ticket references (a test fails
  on one) and has a soft size target of about 12 KB (a test warns past it).
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
| PM (`pm`) | **Perry** |
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
  - **Not the Atlassian Remote MCP Server** (`https://mcp.atlassian.com`) — it does **not
    work** for TAI. Tested live: authentication is fine (API-token Basic auth initializes cleanly over
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
backend, is what actually enforces identical behavior.

**The operation set (§8 item 7):** `src/core/storage/
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
> The wrapper does pass `inwardIssue`/`outwardIssue` through faithfully. Verified against the
> live API: for the `Blocks` link type, the **inward** issue blocks the **outward** one.

### 3.3 Checkpoints
Human oversight gates on work progression. **Critical constraint discovered during
research:** native Jira workflow conditions/validators/post-functions can only be created
programmatically by Atlassian *Connect/Forge apps*, not by a normal OAuth-authenticated
integration (which is what our MCP-based access is). Therefore:

> **Team AI's own plugin layer is the enforcer of checkpoints.**
> We check conditions *before* ever calling the Jira "transition" API. Native Jira
> validators, if an admin chooses to configure matching ones by hand, serve only as
> optional defense-in-depth — they are not something Team AI deploys itself.

Checkpoints are modeled as **dependent subtasks in a "blocks / depends-on" chain**
(see §5.4). If a checkpoint requires a human, work pauses there. Three subtask types are **inherently human-gated**: `UAT`, `EpicReview` and
`DesignReview` (`ALWAYS_HUMAN_GATED_SUBTASKS`, `story-schema.ts`). A persona prepares or drives each one, holds no `complete` grant for it, and
a human closes it.

**A Jira-side transition rejection is itself treated as an unplanned checkpoint.** Even
after Team AI's own checks pass, the actual Jira transition call can still be rejected —
an admin-configured validator, a missing required field, a permission gap, or a concurrent
change by another human or agent. This resolves an earlier open question: **Team AI always
attempts the real Jira transition** (it doesn't skip straight past Jira based on our own
checks alone), and if Jira rejects it, that rejection is never treated as an ordinary
failure. Work stops immediately and the Jira-returned reason is returned verbatim to whoever
ran the command, for a human to deal with. It is not written to the work journal, and nothing
is marked on the ticket.

Because the AI usually cannot self-diagnose an admin's validator or a permissions problem,
**this case is explicitly excluded from the single-retry pattern** used for review
failures (§4) — it escalates straight to a human every time, no retry attempt first.

This is enforced **once, centrally, in the storage plugin's `transition` operation**
(§3.2), not repeated in each persona's own instructions. The operation returns either
success or a structured "blocked-by-source" result; every persona and the Orchestrator
react to that result identically, so no persona needs its own logic for this case.

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

### 3.4 Human Sign-off
**A human signs off work; nothing completes itself.** A persona finishes its own subtask when
its work is done, as the human driving the session, and the human-gated steps (§3.3, §4) are
closed only when the human says so. There is no autocompletion: no setting, condition or
comment marker lets a persona complete work in place of a human's sign-off.

Checkpoint and review-gate enforcement (`storage/review-gate.ts`) is part of `transition()`
on both backends.

**Hard rule:** a persona may **never** approve/self-certify its own work. (See §4, item on
same-persona approval.)

### 3.5 Workflows
**There is only one sense of "workflow" — the per-Story-type process,**
documented in `workflows/*.md` for **Kickoff**, **Story**, **Bug**, and **Spike**. There is
no separate, named "scenario" layer (`complete`/`quick`/`bugfix`, configuring which personas
participate); the story-type plus optional-subtask design already covers it:
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
of work, when **completing** one (refreshed before the completion decision
itself, since other in-flight information may bear on what to do next), and whenever an
item is first used in a session (per §4's caching rule). At a refresh point, cached items
are compared against source `lastUpdated` and re-pulled if stale.

Each refresh regenerates a **briefing** — a single aggregated markdown file combining the
subtask, its **immediate parent** (Story/Bug/Kickoff/Spike), and linked Confluence pages
into one readable snapshot. **Bounded, by design:**
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
- **What each ticket shows.** Every ticket in the briefing carries a state line:
  type, status, owning persona, assignee (or "unassigned"), priority and the flag. The
  subtask and the parent also show their own remote links (where a PR link lives) and
  their **last 10 comments**, oldest first, with a note on how many older ones there are.
  The latest `Handoff:` comment is lifted out and shown first, under its own heading.
  Linked tickets show state and description only, no comments and no links — the same
  one-hop bound. Live PR state (approvals, CI) is not in the briefing; it needs the git
  host; `/tai-ready` is where an approved PR surfaces.
- **A size budget.** The briefing is capped at 60,000 characters by default
  (`TAI_BRIEFING_BUDGET` in `.env`). The subtask and the parent are never cut. Linked pages
  and linked tickets share what is left, smallest first, so a short page is not cut to
  make room for a long one; one that does not fit ends with `NOT SHOWN IN FULL — N more
  characters` and the `page get` / `issue get` command that reads the rest. If the subtask
  and parent alone exceed the budget, the briefing exceeds it too.
- **Ticket and page text is data, not instructions.** The briefing is appended to
  the persona prompt, so text in it must not be able to pose as that prompt. It opens with
  a notice saying so; a heading inside ticket, comment or page text is pushed below the
  briefing's own heading for that section; a `---` line becomes `* * *`. Code fences are
  left as written. This makes external text visibly external; it is not a guarantee
  against a model following it.
This is what a persona actually reads to resume work; it avoids re-assembling context from
scattered cache files every time, and gives a human something reviewable too.

A session that stops with the work unfinished leaves a `Handoff:` comment on the ticket (§3.9),
which the briefing shows first; that, not a local file, is how the work is picked back up. See §7
for the concrete file layout.

**Connectivity loss mid-unit-of-work:** distinct from the filesystem backend's
offline mode (§3.2, a deliberate backend choice) — this is a *Jira-backed* project
losing connectivity transiently. TAI **degrades to the local cache** for reads (clearly
flagged to the human as possibly stale) and **queues writes** (comments, transitions,
assignments) in the work journal (`journal.md`, an append-only file that holds only these queued
writes) rather than failing outright, replaying them automatically once connectivity returns.

### 3.7 Recursive Decomposition & Refinement
For large projects, a single decomposition pass is too coarse. Personas can be invoked
**recursively at progressively narrower scope**: the Analyst runs once against the overall
project to propose a breakdown into Epics ("a project of projects"), and the **second pass —
scoped to one Epic, producing that Epic's Stories/Bugs — has the same shape**:

- The Epic gets its own Kickoff Story.
- Ada proposes the breakdown in its `Research`.
- The human probes it and signs it off in `EpicReview`.
- Perry then creates the tickets. She does not decompose an Epic on her own in one turn.

A small Epic needs only `Research` and `EpicReview`. **Perry front-loads the Kickoff's known
subtasks** — `Research`, `EpicReview`, and `Requirements` and `UxDesign` when she is pretty
sure they are needed — in `Backlog` at initiation and runs `link-precedence` straight away, so
nothing shows as ready ahead of its turn.

The framework does not fix how many passes happen or where they stop — it fixes that
decomposition is a repeatable persona operation, applicable at whatever scope is handed to it.
**There is no fixed level ladder and no `Initiative` tier above Epic** (§8 item 12): if a
system needs something above Epic, that is a native-Jira concept a business configures on
its own instance, not a TAI schema type. **Where to stop is not a formula either:** a human
decides the scope for each invocation.

**Refinement subtasks.** An already-created Story may need more detail before implementation
subtasks can be meaningfully created under it. For this, a Story can carry a **refinement
subtask** — `Investigate`, `ArchitectureDesign`, `Database` and the like (§5.2), which route
to the Analyst, Architect or DBA — rather than an implementation type like `Dev`.

- Its output is not code; it is added detail (clarified acceptance criteria, a design
  decision, a data model) that lands on the Story's linked Confluence page, per §4's "who
  needs to know" comment rule.
- A refinement subtask may spawn further refinement subtasks (an `ArchitectureDesign` raises
  a question that needs a `Database` pass).
- It does not spawn implementation work directly. Turning refined output into implementation
  subtasks is a separate decision (the human's, or Perry's in grooming, per §3.8), made once
  the Story is judged ready.

**Rolling-wave decomposition depth: "done" vs. "done enough".**
Decomposition and refinement personas (Analyst, PM, Architect) don't flesh out every pass to
full detail. For a large Epic, taking every eventual Story to fully-specified acceptance
criteria before any can start would be wasted, premature effort — the later ones will need
revisiting once earlier work informs them — and would delay starting at all. Decomposition
follows a **rolling-wave** pattern instead: the full set of next-level items is created
immediately, so the whole shape of the work is visible end to end, but only a **subset is
taken to full depth** now. The rest land shallow (a name and a one-line scope), neither
skipped nor forced to premature detail.

- **Which items get full depth now is not a fixed lookahead count.** TAI cannot know a team's
  capacity or parallelism in advance. Whatever the dependency/readiness graph (§5.3,
  `workflows/dependencies.md`) already shows as unblocked gets full depth, however many that
  is for the Epic's actual shape.
- **Explicit pull-forward stays available.** A persona or human with a concrete reason (for
  example, requirements overlap with another in-flight project) can take a not-yet-unblocked
  item to full depth ahead of its turn — the same rule as eager subtask creation
  (`workflows/dependencies.md`).
- **A shallow item already known to need a refinement pass gets that refinement subtask
  created now too**, in `Backlog` alongside the shallow parent, not deferred until the
  parent's turn comes up: board visibility for anticipated work, not only work already
  starting.
- **No extra status machinery.** The `Backlog`/`To Do` split (§5.3: `To Do` only if fully
  actionable as written, `Backlog` otherwise) already models this.

Concrete instances: `personas/pm.md`'s Epic decomposition (item 5) and issue creation with
the subtask assessment (item 4); `personas/analyst.md`'s Epic → Story decomposition proposal
(item 5); and `personas/architect.md`'s altitude inheritance ("Higher-altitude decisions are
binding on lower-altitude work") — a Kickoff/Epic-level `ArchitectureDesign` is the "full
shape now" pass (system-level invariants, kept minimal), and each Story's own
`ArchitectureDesign` is the later, full-depth pass that inherits it as a binding constraint;
a genuine conflict escalates to the human rather than being silently overridden.

**Elicitation escalation posture: collaborative by default, more assertive when it isn't
converging.** Elicitation-heavy personas (PM, Analyst, UX Designer) draw requirements out of
the human rather than deciding for them — but escalate to more direct, pointed questions,
including pushing back explicitly on an answer that's too thin to build against (an
unmeasurable acceptance criterion, an unexamined assumption), when a conversation isn't
converging on its own. They ease off once it firms up or the human signals they've had enough
for now (an explicit "good enough," visible fatigue). It is calibrated to stakes: a one-line
bug-fix Story doesn't warrant the same pressure as a Kickoff-level PRD or Epic decomposition.

Concrete instances: `personas/pm.md`'s PRD drafting (item 2, with its Fast-path/Coaching-path
pace choice); `personas/analyst.md`'s Kickoff discovery, decomposition and refinement (items
2 to 6); and `personas/ux-designer.md`'s Kickoff flow/wireframe development (item 1) with its
"elicits, doesn't impose" principle.

### 3.8 Interaction Modes
- A human can **initiate a persona** and interact with it (e.g. "what's ready for you to
  do?").
- A human can **initiate new work** (create a bug, request review of prior work, etc.).
- A human can **query what's "ready"** for any persona.
- **Nothing dispatches work.** Perry — the "Orchestrator" in older text — owns the
  story-level tickets and runs grooming (`/tai-groom`): she sequences, creates and promotes
  tickets with the human. She does not start another persona's work; a human starts every
  piece of work, with `/tai-work` or `/tai-ready`.
- **A parked epic stays out of grooming.** An epic carrying the label `icebox` (TAI-370 is the standing one; any epic
  can be parked, with Stories already under it) is left out of `/tai-groom`, with the Backlog tickets under it, unless its
  key is given: `/tai-groom <EPIC-KEY>` lists it like any epic. A ticket under it that has moved to To Do or later is
  still listed, since someone scheduled it. The label is on the epic only, so a new ticket under it is hidden with no tag
  of its own; the briefing warns about a non-epic ticket that carries the label, which does nothing. It is not Jira's Flag, which means waiting on an external impediment.

**Concrete kickoff commands:** `/tai-work <KEY>` loads/refreshes that unit of
work's briefing (§3.6) and invokes its owning persona directly. `/tai-ready [persona]`
answers "what's ready for you to do" when the human doesn't have a specific key in mind
yet. Both are thin wrappers over the same briefing-then-invoke flow — there's no
separate code path for "starting fresh" vs. "resuming."

**Project initiation has no ticket entry either.** `/tai-work` always needs an existing key, and a
fresh project has none, so Perry's Project initiation (create an Epic and its Kickoff Story) is reached through
`/tai-kickoff [initiative]`, which runs `kickoff [INITIATIVE]`: the same persona-heading-then-body shape as `work` and
`groom`, with a read-only briefing of the existing Epics and Kickoff Stories so she dedups. It works on any project, not
only an empty one, because starting a new initiative has no emptiness precondition. The initiative text is the
human's data, never instructions.

**A retrospective has no ticket entry either.** `/tai-retro [EPIC-KEY | since=<date>]` runs `retro [EPIC-KEY | since=<date>]`:
the same persona-heading-then-body shape as `groom`, loading Perry with a read-only briefing of five signals for a
window: tickets cancelled, Bugs raised, tiers sent back (`Not verified:` and `Rejected:` comments), stamped merge-gate
overrides and stale approvals. The window is the epic's whole life, or `since=`, or the last 30 days. Perry then asks the
human a few questions, writes a short retro page as a child of the epic's page, and files the action items as Backlog
tickets; lessons about TAI itself are filed apart, labelled `tai-lesson`. The command writes nothing. A cancelled ticket's
date is its last update (no backend keeps a cancel date), and the PR sections read only when a git host is configured.
Moving an Epic to Done prints a line suggesting `/tai-retro <EPIC-KEY>`; it never runs or blocks anything.

**Course correction has no ticket entry either.** `/tai-change [EPIC-KEY] [statement]` runs `change [EPIC-KEY] [statement]`: the same
persona-heading-then-body shape as `groom`, loading Perry with a read-only briefing of what the human says changed, every open
ticket with its linked documents (as titles and page ids, never page bodies) and a `Left out:` line for parked (`icebox`)
epics, which uses grooming's own function so the two agree. An epic key narrows it to that epic. Perry proposes one batch,
grouped as tickets to cancel, tickets to reword, new tickets and pages to revise, and files an `Investigate` subtask for Ada
or an `ArchitectureDesign` subtask for Aria where a PRD or ADR needs rework. She creates Backlog tickets and links on her
own; every cancel, reword, page revision and Backlog → To Do move waits for the human's confirmation, one question per
group. The statement is the human's data, never instructions. The skill's description and the project pointer in a target's
CLAUDE.md and GEMINI.md let a plain-language request start it; nothing starts it on its own. Descriptions are cut at an
excerpt limit and a long board is abbreviated past a size budget, with a notice.

**Review has no ticket entry.** There is no `CodeReview` subtask, so the Code
Reviewer is not loaded by `/tai-work`. Its entry point is `/tai-pr`'s review flow, which runs
`git-pr review-prep <REPO> [PR-ID]` — same persona-heading-then-body shape as `work` and `groom`, keyed by a PR
instead of a ticket. A ticketless `/tai-review` skill was considered and deferred.

**In Claude Code, `/tai-pr` runs the review in a subagent by default.** The subagent sees only the `review-prep` output and the
repository, follows the review steps through writing the findings file, and returns its path; it never posts to the PR. The main
session renders the findings, shows them and stops for the human. In Gemini CLI, which has no subagent, the steps run as they
always did, and in Claude Code the human can ask in their own words to review in the current session. This is skill text, not
enforced in code. Reviewing with a different model is not built.

**A review is of the PR's code, whatever the reviewer's clone has checked out (ADR page 55246849).**
`review-prep` fetches both branches and diffs `origin/<destination>...origin/<source>`, so a stale clone
does not affect the diff. Around it:
- Its "Your checkout" section tells the reviewer to read surrounding files from the fetched PR branch
  (`git show origin/<source>:<path>`) and says whether the working tree is at the PR's head. When it is not,
  tests and lint run there do not count as verifying the PR.
- It runs the same safe fast-forward of the local default branch that `/tai-work` and `/tai-ready` run.
- It reads `project-context.md` from the destination branch on origin: the rules in force, which a PR cannot
  rewrite for its own review.

**A review must show what it read and ran (ADR page 55640065).** A review with no findings and a review that
did not look must not be indistinguishable.
- The findings JSON carries a required `coverage` block — files read, commands run, claims verified, what was
  not checked — and a `reviewOf` block naming the repo, PR and commit. `render-findings` and
  `comment-findings` refuse a payload without them, print the coverage as part of the review, name every
  changed file not listed as read, add a line when a large diff draws no issue, add a line when no listed command
  searched the branch (`git grep`, `git ls-tree`, `git log -S`, or `git show` of an unchanged file — TAI-541), and add a
  line counting verified claims that give no how (no dash or colon before it). `comment-findings` refuses
  findings written for a different PR. The coverage is self-declared; the point is that it is on the record.
- `review-prep` writes the complete diff to a file under `.tai/review/` and tells the reviewer to read it in
  full; the diff is not printed, because long tool output is cut.
- `review-prep` prints the CI result for the commit under review. When a result exists and is green, a
  reviewer's effort goes into reading. When none exists — a project with no pipeline that runs on a PR, as
  this repo has none — the output says nothing has run the suite, and the reviewer says what they ran.
- A review is tied to a commit. `comment-findings` says so, in the posted review, when the PR's head has moved
  since the review was prepared, and `git-pr review … approve` is refused when `review-prep` last ran in that
  clone for an older commit: the newer changes have not been reviewed. Known limit: an approval carries no
  findings, so this gate sees only when `review-prep` last ran. A reviewer who re-runs `review-prep` after a
  push and then approves on findings written for the older commit is not stopped; the review posted earlier
  carries the warning.
- The author's PR description comes last in the output, labelled as claims to verify; the review's overview is
  the reviewer's own account.

**Every persona turn says when TAI itself is not running from its default branch.** The CLI and persona
docs run from the install directory at whatever branch it has checked out; `work`, `groom`, `kickoff` and
`review-prep` print one line naming that branch and commit when it is not the default
(`git/install-state.ts`). Nothing is changed for the user, and being behind origin is not detected.

### 3.9 Comment Conventions

TAI's own comment-scanning logic (§3.6) is what interprets these — none of them are
native Jira/Confluence features (plain Jira comments have no built-in resolved flag;
Confluence's native inline-comment resolve checkmark exists but isn't used for this, see
below). `Q:`, `Approved:` and `Rejected:` apply to **both** Jira issue comments and Confluence
comments (page-level and inline) — not just Jira; `Skipped:`, `Handoff:` and `Verified:` are Jira-only.

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
- **`Skipped: <subtask-type>[, <type>...] — <reason>`** — on a Kickoff Story: the named
  subtask types were left out on purpose, so `/tai-ready`'s "Subtasks ready to create" hint stops listing
  them. Type names are case- and hyphen-insensitive (`ux-design`, `UxDesign`, `ux design`); the reason must
  follow a dash (`—`, `–`, ` - ` or ` -- `) and is free text — without a dash the whole line is read as the
  type list. Perry or a human may post one with no confirmation gate — it only silences a hint, and editing
  or deleting the comment brings the hint back. It does not stop anyone creating the subtask later.
- **`Handoff:`** — Jira issue comments only: the ticket's **one living hand-off
  comment**, written by whoever stops with the ticket still In Progress and the work unfinished. It says what
  is done, what is in flight, the next step, and the assumptions made. It is edited in place, never appended
  to: `issue comment <KEY> "Handoff: …"` replaces the ticket's latest `Handoff:` comment (and adds one if
  there is none, or if the old one cannot be edited). Nothing scans it to decide anything; the work briefing
  shows it first (§3.6), which is how the next session — any host, or a human — picks the work up. A
  hand-off covering several tickets at once is the human's own business, outside TAI.
- **`Verified:` / `Not verified:`** — Jira issue comments only: the result of `verify <STORY-KEY>` (the
  `/tai-verify` skill), which loads Tessa with a Story's or Bug's `AC-n` acceptance criteria and the diff of every
  Dev PR on it, open or merged. She posts one stamped comment whose first line is `Verified: all N criteria met`
  or `Not verified: M of N criteria not met`, then one bullet per criterion with its verdict and evidence; a
  criterion she could not tell counts as not met. It is a record for a human to read, not a gate: `/tai-ready`
  marks an In Progress Story or Bug whose Dev subtasks are all Done and which has neither comment "not verified"
  and lists it in its own numbered "Ready to verify" section, where its number means `/tai-verify <KEY>` (the
  grooming briefing's section 9 lists the same set, from one shared function),
  and moving a Story or Bug to Done without one prints a warning, but nothing blocks the merge or the close. A
  later Dev commit does not invalidate an earlier comment; run `verify` again to get a fresh one.

**Why not Confluence's native inline-comment resolve checkmark:** considered and
rejected as the signal for any of the above, for two concrete reasons — (1) the
Atlassian MCP server exposes no tool to set/toggle a thread's resolved state, only to
add/read comments, so TAI couldn't drive it even if it wanted to; (2) even reading it
wouldn't be reliable — a human may click resolve purely to declutter their view, not as
a substantive signal. The marker-text convention doesn't depend on either concern.

**Freshness, not cached memory:** since comments are human-**deletable** in both
systems, marker-scanning is always a **fresh re-scan**, never a cached "I already saw an
`Approved:` comment" memory. If a previously-satisfying marker comment is later deleted,
the gate/question reverts to unsatisfied. (An edit to an approved *page* is different: it
is shown, and reopens nothing — §4, the Confluence bullet.)

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
  on, complete. **What is enforced and what is noted:** `workOn` is checked when `/tai-work` loads
  a persona, and `gitHost` grants when a PR is created or merged. `create` and `complete` are not
  enforced by the issue commands: when a command names the acting persona (`--as`) and that persona
  has no grant for the type it created or moved to Done, the CLI prints a note and the command still
  goes ahead. There are no per-field `update` grants.
- **A human signs off work.** There is no autocompletion (§3.4).
- **A persona can never approve its own work.** In a *team* setting this is the norm and is
  ultimately enforced by the business/process — for now our code does not hard-lock it,
  because a **solo developer legitimately reviews their own work.** (Revisit if we add
  org-level enforcement.) **The rule is about the same human, not the persona role** (§8
  item 3): workflow routing already sends a persona's output to a different persona role
  for review, so self-approval can only happen when one human fills both roles (the
  solo-dev case named above). **What review separation means in practice:** the reviewer is a human — one on the "PR Reviewers" roster for a
  PR, the human closing a `DesignReview` for a design. The AI prepares the findings or
  review notes and the human decides. A fresh context is preferred for preparing them, not
  the session that wrote the work under review.
- **Checkpoints are enforced in Team AI's plugin layer,** not via native Jira validators
  (see §3.3).
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
  it, comment on the parent. **Routing a failed checkpoint is not a judgment call** (§8 item
  5): the destination is fixed by the workflow's documented loop-backs (`workflows/story.md`,
  `workflows/bug.md`) and retry-versus-escalate by the single-retry rule above. A human-gated
  step (UAT, EpicReview, DesignReview) has no AI retry: every round ends with the human.
- **Multi-repo:** a Story/Bug can touch **multiple repos**; a **subtask targets exactly one
  repo.** Each repo touched gets its own PR → review and test → merge chain under the Story
  (§5.4). The affected repo is tracked in Jira's **native Component** field, not a custom
  field. **It is derived, with a manual fallback:** a commit message beginning with the
  Jira issue key (§6) is used to look up the touched repo and auto-populate Component; a
  human or persona can still set/correct it manually before any commit exists yet (e.g. at
  subtask creation, or if the automation can't resolve it).
- **Confluence:** one Confluence space per Jira project. The space key is **configured, not
  derived** — it is **not** safe to assume it equals the Jira project key.
  Confluence derives a space key from the space *name* at creation and may shorten or
  disambiguate it, and a human can rename it afterwards (TAI's own space is keyed `TA`, not
  `TAI`). **`projectKey` and `spaceKey` are separate config values**, and the storage backend
  takes both; code that computes one from the other is wrong.
  Pages link to the Jira item that **needs that page as input.** Pages tie to the
  **parent** issue (Story or Epic — whichever the content is actually scoped to; e.g. an
  Epic-level decomposition proposal ties to the Epic itself, while a Kickoff's PRD/UX
  flows/WBS tie to the Kickoff **Story** beneath that Epic), **never to subtasks.**
  Jira↔Confluence linking is the source of truth; we keep a local filesystem cache of
  those links, refreshed as needed. A doc needed by more than one ticket is **linked via
  `RelatesTo`** to the additional ticket (same bar as any other `RelatesTo` link,
  `workflows/dependencies.md`) rather than duplicated or moved to a shared ancestor.
  - **Granularity:** one page per persona-output instance (one ADR, one PRD, one
    test-plan, …) — matches the granularity already implicit in every persona's
    `confluenceOutputs` list. The UX Designer's wireframe/wireframe-index split (one page
    per screen + an index) is the one documented exception, since a single UX flow can
    span many distinct screens — not a new general default.
  - **Folder structure:** organized **by doc-type** within the project's space
    (an ADRs folder, a PRDs folder, a Test Plans folder, …), not by ticket hierarchy.
  - **Naming convention:** page titles are structured —
    `<JIRA-KEY> — <Doc Type>: <short description>` (e.g. `PROJ-123 — ADR: Async job
    queue`). Unlike a Jira issue (whose native issue-type icon already distinguishes it
    in every view), a Confluence page has no equivalent type-icon affordance in its page
    tree or search results — the key and doc type need to be visible in the title itself
    for a human scanning a page list to know what's what.
  - **Config-type content:** the Persona Roster (§5.6) and persona extensions
    (§3.1) aren't tied to any single ticket, so the `<JIRA-KEY> — <Doc Type>: …` naming
    convention above doesn't apply to them — there's no ticket key to put in the title. They
    get their own top-level **`Config`** folder in the project's space (sibling to the
    doc-type folders above), with plain descriptive titles (`Persona Roster`, and future
    persona-extension pages named after the persona).
  - **Edits to an already-approved doc are shown, not blocked:** an `Approved:` sign-off
    says something about the page as it was when it was approved. When a page linked to a
    Done Kickoff Story is edited after that Kickoff's latest `Approved:` comment, `/tai-ready`
    and `/tai-groom` list it in an information section (while the Kickoff's Epic is open).
    **Nothing reopens** and no re-approval is required; the human decides whether the change
    matters (`commands/edited-after-approval.ts`).
- **Human-gated steps are conventions, made visible.** The CLI and the human share one
  Jira/Bitbucket identity, so TAI cannot prove who performed an action. A human-only step (a UAT, EpicReview or
  DesignReview sign-off, a Kickoff `Approved:` comment, a PR approval, closing an Epic) is therefore a
  convention the **user is accountable for**: a persona performs one only when the human says so in their own
  message. TAI makes the difference visible instead of pretending to enforce it — every comment the CLI posts
  ends with a stamp line, `Posted via the TAI CLI as <Name> (<persona id>).` (or `Posted via the TAI CLI.` when
  the command named no persona), and a sign-off made through the CLI leaves a stamped `Sign-off:`
  comment (`storage/stamp.ts`). A comment or sign-off with no stamp was made directly, in the Jira or Bitbucket
  UI. The stamp says only what the CLI knows: it cannot tell an AI session from a human typing the command.
  The difference is shown, never enforced (`storage/sign-off-provenance.ts`): the `/tai-work` briefing says on a
  Kickoff, UAT, EpicReview, DesignReview or Epic whether it was signed off through the TAI CLI, directly, or not
  yet (a Kickoff lists each `Approved:` comment, and counts as direct unless every one is stamped); `/tai-ready`
  and `/tai-groom` add it to an open row only once something is signed off. They list open work and read no
  extra tickets, so a sign-off already closed to Done appears in the briefing of its own ticket, not in those
  lists. PR approvals are not shown: that would be a git-host read per PR.
- **Writing Jira descriptions and comments.** A ticket description and a comment body are
  both sent as Jira wiki markup, not markdown: a blank line makes a paragraph and `* item` a bullet. They are
  read by people, so write them for reading: a short opening paragraph that says what the ticket is for, a
  blank line between paragraphs, and bullets when there are several items — scope, steps, acceptance points,
  things checked. Never one dense paragraph. On a comment, the stamp goes on its own last line and is added by
  the CLI, never typed. The CLI backs this with a note, not a refusal: after `issue create`, `issue update` or
  `issue comment` writes text with an unbroken paragraph of more than 500 characters, it says so and names the
  command that rewrites it. Every persona doc carries a one-line pointer here. **Acceptance criteria** in a
  Story, Bug or Spike description are numbered lines, `AC-1`, `AC-2`, …, so a reader and the grooming check can
  find and refer to each one; `verify <STORY-KEY>` (§3.9) checks the finished work against them.
- **Writing Confluence page content.** TAI converts a persona's markdown to Confluence
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
- **Unblocking human-gated work.** When a persona completes a subtask and that was the last open
  blocker of a **DesignReview, EpicReview or UAT**, it moves that item from Backlog to To Do in the same turn — a
  human is waiting to act on it, and Backlog is invisible to `/tai-ready` — and says in its hand-off what it
  unblocked. Anything else that became unblocked waits for grooming's promotion section, where Perry proposes it.
  This is persona guidance, not a code gate; every persona doc carries a one-line pointer here.
- **Offering the assignee list.** When `issue create` (or `issue suggest <KEY>`, or the
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
  fetches. Refresh happens at defined points (§3.6): starting or resuming a unit of work,
  completing one, and the first time an item is used in a session. **Before saving a locally-edited Confluence page or Jira item, always
  fetch first and warn with a diff** so the user can resolve conflicts (no silent
  overwrite).
- **Issue types:** Epics do **not** hold subtasks directly. Hierarchy is
  **Epic → Story/Bug → Subtask.** Story-level tickets have **distinct types** — Kickoff,
  Story, Bug, Spike (§5.1) — so a human scanning the backlog can tell the kind of work at a
  glance. New types can be introduced as needed.
- **Subtasks are typed too, not generic.** Type is what routes a subtask to a persona
  (e.g. `Dev` → Developer, `Database` → DBA). Like Story types, this is an open, extensible
  taxonomy — see §5.2 for the current set.
- **Decomposition is recursive, not one-shot.** The Analyst (or another persona) can be
  invoked at Project scope to propose Epics, then invoked again scoped to each Epic to
  propose Stories — the same operation applied at progressively narrower scope (§3.7).
- **Refinement subtasks** let a Story get more detail before implementation subtasks are
  created under it, via a subtask routed to the Analyst, Architect or DBA rather than to
  `Dev`. Their output is documentation and decisions, not code, and does not itself spawn
  implementation work — that remains a separate decision, the human's or Perry's in grooming
  (§3.7).
- **Persona outputs and processes must generalize to unknown future target projects, not
  stay TAI-specific.** TAI exists to manage *other* projects, not just
  itself (§1) — when scoping a new persona output type or capability (a new Confluence doc
  type, a new subtask type, a new checkpoint), the design question is "does this work for
  whatever project TAI is pointed at," not just "does this work for TAI's own single-repo
  TypeScript shape." A concrete first-pass mapping onto TAI's own project is fine, but the
  underlying *process* — which parts of a candidate structure apply, how to reframe or mark
  N/A the parts that don't for a given project's actual shape — must be captured as
  reusable persona guidance, not left baked into a one-off TAI-specific doc. `personas/analyst.md`'s Project Home
  Page and `personas/architect.md`'s Architecture Overview already model this explicitly
  and are the reference examples for future output types.
- **Future-direction/extensibility awareness during elicitation.**
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
  actual shape. Probing costs little; building unrequested flexibility does.
  **This awareness isn't limited to whatever's the explicit topic of the current ask:** when a persona is looking at a
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
  unilaterally to raise or skip it. The concrete mechanics are in the persona docs:
  `personas/analyst.md` (items 2 to 6) and `personas/architect.md`, whose version differs
  where the work differs — Aria's trigger fires only during Kickoff-early or Story-level
  `ArchitectureDesign`, she asks the human directly, and the answer is recorded twice: as
  grounding context in her ADR, and as a `Requirements` subtask handed to the PM for the
  PRD's Future Considerations entry. `personas/dba.md` does the same for schema forks.

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
right persona. This taxonomy is **open and extensible**; the table below is the current set.

| Type | Typical persona | Category |
|---|---|---|
| Research | Analyst | Refinement — Kickoff discovery |
| Requirements | PM | Refinement — PRD drafting. Also allowed on a Story: a future-direction question the Architect or DBA hands to the PM, with no precedence edge |
| UxDesign | UX Designer | Refinement — flows/wireframes |
| Investigate | Analyst | Refinement — Story-level (§3.7) |
| Feasibility | Architect | Refinement — quick technical go/no-go |
| ArchitectureDesign | Architect | Refinement — deeper design |
| DesignReview | Architect prepares + a human reviews and closes it | Refinement gate — inherently human-gated (§3.3); gates `ArchitectureDesign` → `Dev` (workflows/story.md) |
| Database | DBA | Implementation input (schema / migration / performance) |
| Infra | DevOps | Implementation input |
| Dev | Developer | Implementation (unit tests folded in) |
| CodeReview | Code Reviewer | **Retired** (TAI-159 ADR, §5.4): review happens on the PR. Kept in the schema only to parse historical tickets |
| IntegrationTest / SystemTest / E2ETest | Tester | Verification |
| UAT | Tester + a human stakeholder | Verification — inherently human-gated (§3.3); gates `Deploy` (workflows/story.md, workflows/bug.md) |
| Triage | Tester | Bug entry point |
| Deploy | DevOps (default, overridable) | Implementation |
| PostDeploy | DevOps (default, overridable) | Implementation follow-up |
| SpikeTask | No fixed owner — assigned at creation | Ad-hoc investigation inside a Story/Bug (not named `Spike`: that would collide with the `Spike` **Story**-level type, and Jira issue-type names must be unique site-wide) |

A type may name a **default owner that is overridable per instance** (`Deploy` / `PostDeploy`). Adding a
brand-new type is always a human schema edit, which a persona may propose (§8.16).

`Investigate` has no review gate of its own; the ordinary per-subtask checkpoint covers it (§8.17).

`DesignReview` and `UAT` are optional gates: `DesignReview` gates `ArchitectureDesign` → `Dev`, and `UAT`
gates `Deploy`. Both are inherently human-gated (§3.3) and **present-when-added**, purely additive to the
precedence graph — see `workflows/story.md` and `workflows/dependencies.md`.

**Which subtask types belong under which story type** is `STORY_SUBTASK_MAP` (`story-schema.ts`). It is not
enforced: `issue create` prints a note when a subtask's type is not listed for its parent's type, or when the
subtask is created directly under an Epic or another subtask, and creates the ticket anyway.

**The light lane.** `/tai-small` is the entry point: the human types it, and the skill drafts the summary and an `AC-1`
line and runs `issue create-small <PROJECT-KEY> story|bug <SUMMARY> description=<TEXT> [parent=<EPIC-KEY>]`. That creates a
Story or Bug together with its `Dev` subtask, assigned as a normal create assigns them, both in To Do, and prints both
keys. The description must carry an `AC-1` line, so `/tai-verify` and grooming still have criteria. It makes no other
subtask, adds no label and exempts nothing: review and the merge gate apply as to any Story. "Very small" (a change that can be described in two
sentences) is a convention in the persona docs and the skill, not checked in code. A failure after the first ticket exists names what was
created and how to finish or undo it; nothing is created when the type or the description is refused.

Subtask-type-to-persona routing is configurable the same way persona permissions are
(§3.1): a business can add types, change routing, or restrict which types a given persona
handles.

**Subtask↔Jira mapping:** each `SubtaskType` maps to its own **native Jira
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
Issues carry statuses and **"blocks / depends-on"** links that determine what is ready to be
picked up and what is blocked. The status lifecycle, for story-level tickets and subtasks
alike, is:

```
Backlog → To Do → In Progress → (In Review) → Done / Canceled
```

Per-type loop-backs are documented in `workflows/story.md` and `workflows/bug.md` (a failed
test tier, a `DesignReview` that asks for changes, UAT rejection routing). Whether a business
ever needs to customize this lifecycle per project, beyond those loop-backs, is still open.

**Ready and blocked are derived, not stored.** They are computed from `SUBTASK_PRECEDENCE`
(`isSubtaskReady()`/`resolveApplicablePrecedence()`, `schema/story-schema.ts`). The same
graph is **enforced when a subtask is started** (`storage/precedence-gate.ts`):
`transition()` refuses the start while a present subtask upstream is open, a test tier or UAT
may start once `Dev` has started, and `force=true` is the human's override, recorded as a
comment on the ticket.

**The statuses are created by hand in Jira.** `Backlog` and `Canceled` are not Jira defaults:
an admin adds each one (Issues → Statuses → Add status) and adds it to the workflow. No API
or MCP tool creates statuses.

**`To Do` and `In Review`.** The names are Jira's own. Jira's default shared workflow carries
`In Review` on every issue type, and it is not worth a separate workflow to withhold it:
TAI's own logic decides which transitions are meaningful for a type (§3.3) and never drives
a non-Kickoff ticket into it. Only the Kickoff workflow uses `In Review`
(`workflows/kickoff.md`).

**`Canceled` — a second terminal state, for work abandoned before completion.** It applies to
every issue type, is reachable from `To Do` or `In Progress`, and is terminal like `Done`.

- **Precedence:** a `Canceled` subtask counts as **satisfied**, the same as `Done` — it
  unblocks its dependents rather than leaving them stuck. "Done" for precedence purposes
  means `Done` or `Canceled`.
- **Status category:** Jira's **`Done`** category. Jira has three categories, and `Canceled`
  is terminal work, not pending work.

**`Backlog` — the status before `To Do`, and where every new ticket lands.** It is a coarser,
earlier question than derived readiness (which is about a subtask waiting on a sibling inside
an active Story): whether the ticket is part of the active pipeline yet at all. A ticket sits
in `Backlog` when it is newly created, has an incomplete spec, is blocked by something outside
the precedence graph (another Story, an external dependency), or has otherwise been judged
not ready. `Backlog` items do not appear on Jira's Kanban board.

- **Lifecycle position:** `To Do` is reached only once a ticket is judged ready. Going from
  `Backlog` straight to `Done` or `Canceled` is valid, for a ticket that turns out to be
  unnecessary.
- **Default landing status:** any newly created ticket lands in `Backlog` — Epic shells,
  Stories/Bugs/Spikes the PM creates, a refinement subtask's output. One exception: a
  persona creating a subtask lands it in `To Do` if its description is fully actionable as
  written, and in `Backlog` otherwise. A created subtask's `Priority` is always written to
  match its parent's. See `workflows/dependencies.md`, "Initial Status & Priority for a
  Created Subtask".
- **Status category:** Jira's **`To Do`** category — pending work that is not yet actionable.
- **The move from `Backlog` to `To Do` is a soft convention, not an enforced gate** (§8 item
  28). "Ready" has no single crisp signal (spec-complete, unblocked and judged-ready are
  three different checks), unlike §5.5's assignment gate, which is enforced because "has a
  human assignee" is a plain yes or no. A human moves the ticket, or Perry proposes the move
  in grooming and applies it after the human confirms (§3.8). Grooming's promotion section lists every Backlog
  ticket with no open blocker and, for a Story, Bug or Spike, **warns** of what is missing — no numbered
  acceptance criteria (`AC-n` lines), a `NEEDS CLARIFICATION` marker in the description, no `Dev` subtask (not
  asked of a Spike), no issue link and no linked page. The warnings are advice for the conversation; nothing
  blocks the move (TAI-472).
- It applies to **every issue type**: a subtask can be created ahead of its own readiness
  just as a story-level ticket can (`workflows/dependencies.md`, "Dynamic Subtask Insertion").

**Epic status — `In Progress` is derived from children; `Done` is always a deliberate human
decision.**

- **`In Progress` is a simple derived signal.** An Epic reads `In Progress` once real build
  work has started under it: a non-Kickoff child (Story, Bug, Spike) reaching `In Progress`
  or `In Review`, written by the shared cascade gate. A child merely in `To Do` does not make
  it `In Progress`; instead, a non-Kickoff Story reaching `To Do` moves a `Backlog` Epic to
  `To Do` (the To Do cascade). **A Kickoff Story never moves its Epic in either direction** —
  an Epic's own Kickoff is refinement, so an Epic in `Backlog` may have its Kickoff running
  (`Backlog` = proposed and being fleshed out, `To Do` = approved to build). It is a
  proposed/approved/building signal, not a percentage-complete rollup.
- **Waiting work is marked, not given a status.** `To Do` means scheduled to start now. Work
  waiting on another ticket carries a `depends-on` link, a later phase a `phase-N` label, and
  work waiting on something external with no ticket carries Jira's **Flag**
  (`Issue.flagged`). A flagged `To Do` ticket is not Ready Work (`/tai-ready` lists it under
  "On hold (flagged)"); unflagging returns it.
- **`Done` is not derived from "all current children are `Done` or `Canceled`".** Epics are
  open-ended thematic groupings (§5.1), and more Stories can always be decomposed under one
  later (§3.7), so "every child so far is finished" does not mean "nothing more is coming".
- **Epic → `Done` is an explicit human judgment:** someone decides no more Stories are
  realistically planned under it and transitions it. A persona (most naturally the PM) may
  propose that an Epic looks complete but never closes it herself (§3.4). It is a single
  judgment, not a two-persona gate like Kickoff's.
- **Not built:** any automated nudge that surfaces Epics as candidates for closing (for
  example, all children finished and no activity in N days).

### 5.4 Checkpoint Chain (canonical example)

**The sequence: verify, then merge.**
```
[Dev opens PR, stays In Progress] --> [review + test tiers, in parallel; UAT] --> [merge, by whoever owns Dev] --> [Deploy] --> [PostDeploy]
```
1. **PR open.** Developer opens the PR from the Story's branch; `Dev` stays In Progress.
2. **Review and the test tiers run in parallel** against that PR. **Test code goes in the same branch and PR**
   as the `Dev` work it tests. Tester marks a tier **Done on a pass**; a tier does not wait for a merge.
3. **UAT, when present, is before merge by default** — the stakeholder accepts what is about to be merged. A
   ticket may place it after the merge instead: the `uat-after-merge` label on the `UAT` subtask records that.
   The merge gate checks it: an open `UAT` without that label blocks the merge.
4. **Merge**, through the merge gate below. **Whoever owns the `Dev` subtask merges, always.** PM and Architect
   merge their own governance PRs; Tester never merges; `Deploy` is not where a PR gets merged.
5. **Deploy ships what is already merged.** It waits on `Dev` being Done, the present test tiers and `UAT`.
6. **A test failure before the merge** sends that tier back to To Do. `Dev` never left In Progress, and the fix
   is more commits on the same PR.
7. **A failure found after the merge is a new linked Bug.** Nothing reopens `Dev`.
8. **Test code discovered only after the merge** opens its own PR, reviewed like any other and merged by the
   `Dev` owner; that tier stays In Progress until its PR merges. Nothing goes straight to the default branch.

**How review, readiness and the merge work (TAI-159 ADR):**
- **Review happens on the real PR, and there is no `CodeReview` subtask.** The git host's own reviewer and
  approval state is the only source of truth for review status, queried live and never mirrored into Jira. A
  Jira subtask needs exactly one assignee (§5.5), and an N-of-M approval policy has no honest single assignee.
  (`CodeReview` stays in the schema to parse historical tickets; it is not created for new work.)
- **`git-pr create` links the PR to the `Dev` subtask** that opened it, with a Jira remote issue link.
- **`Dev` stays In Progress until its PR merges**, not until the PR opens. `Deploy` ships what is already
  merged, so it waits on `Dev` being Done as well as on the test tiers and UAT.
- **Readiness for review, testing and merging is computed live**, as three `/tai-ready` lists rather than from
  the static precedence graph: `readyToReview` (open PRs where the current human is on the "PR Reviewers"
  roster and has not decided yet, or approved or requested changes before the PR's latest commit: that line is marked
  a re-review and names the new commit, because the host keeps an old decision across new commits; freshness is read
  from the PR's history, as the merge gate reads it), `readyToTest` (In-Progress `Dev` subtasks with an open PR; no approval needed, testing runs alongside
  review) `readyToMerge` (PRs that pass the merge gate and are CI-green) and `waitingToMerge` (open PRs with an approval that the gate still holds, each with the gate's own reasons; show-only, a PR with no approval is in neither).
- **The merge gate.** `git-pr merge` refuses unless all of
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
     label. No `UAT` subtask, no wait.
  5. **A check result on the current commit, when the project has a check command** (`TAI_CHECK_COMMAND`).
     `git-pr check` runs that command on the PR's head commit — from a clean working tree at exactly that
     commit, or it refuses — and records the outcome on the commit as a status naming who ran it and where
     (`git/local-check.ts`, ADR page 55672833). The tree is read again after the command: if it changed
     tracked files or the head moved, nothing is recorded. The command runs without TAI's own settings (no
     `TAI_*` or `BITBUCKET_*` variable reaches it), so the PR's code does not see TAI's credentials. No status
     at all on the commit refuses the merge. It is how a
     project with no CI on pull requests gets its suite run before a merge; the result is self-attested. A
     project that sets no check command skips this rule.
  6. **CI**, as before: any commit status that exists must be successful, whether a pipeline or `git-pr
     check` produced it.

  `git-pr merge … force=true` merges past rules 1 to 5 (never a failed or running status) and leaves a stamped `Merge-gate override:`
  comment on the PR listing what was not met. It **replaces the old "very minor fix → fix, test, merge"
  judgment rule**: a fix pushed after approval makes that approval stale, so the merge is refused; for a very
  minor fix (a typo or wording, no behavior change) the one merging uses `force=true` and the override is on
  record. For anything else, `force=true` is used only when the human says so. Observed on Bitbucket (scratch
  repo PR 12, 2026-10-08): a withdrawn approval or request-changes disappears from the feed, a request-changes
  replaces the same user's approval, and a PR author can request changes on their own PR.
- **`Dev` → Done has two triggers:** `git-pr merge` moves the linked `Dev` subtask to Done in the same call
  that performs the merge; a refresh-based fallback catches a PR merged out of band.
- **A human acting directly on the git host is detected and reflected, never fought** (approve, request
  changes, merge) — picked up at the next refresh, the same stance as §4's rule for edits to an approved page: shown, not fought.

Full detail (approval-threshold handling, the reviewer roster, refresh mechanics): the TAI-159 ADR (Confluence,
TA space, page 28704769). The earlier chains this replaced, including the `CodeReview`-subtask flow
(TAI-34 ADR, page 13860867, marked superseded), are in `CHANGELOG.md`.

**Test-tier subtasks:** a test tier's code normally lands in the `Dev` branch and PR
(item 2 above), and the tiers gate both the merge (the merge gate) and `Deploy`. Tester keeps
`gitHost: createPullRequest` for one case only: test code discovered after the `Dev` PR has merged (item 8). She
opens that PR herself, it is reviewed like any other, and the `Dev` owner merges it — Tester was not granted
`mergePullRequest`, so there is no self-merge path for her.

See TAI-33's ADR for the `GitHost` interface this depends on.

For a **multi-repo** Story: repeat the PR → review and test → merge chain **once per
repo**, each subtask tagged with its repo via the native Jira **Component** field (§4 —
not a custom `repo` field).

**Note:** the as-built Story/Bug graph elaborates this canonical shape with parallel
prerequisites (`ArchitectureDesign` / `Database` / `Infra` → `Dev`), test tiers and `UAT`
between `Dev` and `Deploy`, and a `PostDeploy` follow-up — see
`workflows/dependencies.md` for the full precedence graph.

Story-level work is not always dev-related — Stories may be brainstorm, design, research,
etc., differentiated by their type and their subtasks.

### 5.5 Assignment & Claiming
- Jira **Assignee is a real human.** Our plugin layer (not Jira) enforces "act on tickets
  assigned to you, or claim an unassigned 'ready' ticket first."
- **No unassigned work in progress.** A ticket **must have a human `Assignee`
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
- **Pre-assign at creation when the assignee is unambiguous.** When a ticket's
  `persona` (§5.6) resolves to **exactly one** authorized human in the Persona Roster, TAI
  sets `Assignee` **at creation time** rather than leaving it to be claimed later. Common
  cases: a solo developer (every persona maps to the same one person), or a team with a
  single PM/DBA/etc. When the roster lists **more than one** candidate for that persona,
  TAI does **not blindly guess**, and **does not assign the session's human at creation
  either**: someone logging a ticket for a colleague must not become its owner. The ticket is created
  **unassigned** and the assignment-helper (§5.6) prints the ranked candidates with a reason on every
  line — the session's human pinned first when they are a candidate — and "leave unassigned" is always a
  valid choice. A **named** person (`issue create assignee=`, `issue assign`) always wins with no list.
  At **claim and transition time** there is one shortcut: when a ticket is moved out of `To Do` and
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

### 5.6 Human Registry & the Two-Axis Owner Model

**Human↔persona registry: TAI's own Persona Roster, not a native Jira construct.**
Jira Cloud's **Free plan cannot create or edit Project Roles at all**, and a Jira-only role mechanism has no
equivalent on the **filesystem backend**, so the registry is a mechanism TAI owns outright (native Project Role
sync is an optional, deferred extra, §8.18):

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
   it has no default human Assignee. The defaults above are applied in code on create;
   for a `SpikeTask` the session asks the human which persona, and a create left persona-less
   still succeeds with a loud warning.

**Why a stored field, not a derived value:** since a human can appear under multiple
personas in the Persona Roster, looking up "which persona is this" purely from roster
membership is ambiguous whenever they're listed under more than one relevant persona. An
explicit, stored `persona`
field removes that ambiguity and is what makes effort/time-tracking roll up correctly by
persona regardless of which human actually did the work (the schema-level rationale
already stated for `SUBTASK_OWNER`).

**Assignment-helper (answers "does TAI help PM assign tickets to humans"):** when a
ticket needs a human `Assignee`, TAI looks up which humans are listed under that ticket's
`persona` field in the **Persona Roster**, **ranks** them (ADR page 50692097) and surfaces the list
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

- **Git host is pluggable (TAI-33 ADR, §8 item 19).** A sibling
  `GitHostBackend`/`GitHost` interface alongside `StorageBackend` — not folded into it,
  since git hosting is an independent configuration axis (a team can mix Jira+Bitbucket,
  Jira+GitHub, filesystem+GitHub) — reusing the Storage Plugin's *pattern* (branded IDs,
  `MutationResult`/`StorageConnectivityError`, an open `kind` discriminator) without
  reusing its interface. Scoped to PR CRUD, approve/request-changes, merge, and commit
  status — not the full breadth of either host's API. It lives at
  `src/core/git/interface.ts`, with a Bitbucket backend at `src/core/git/bitbucket/`.
- **Review and merge act on a real git PR (TAI-159 ADR).** See §5.4. The git
  host's own approval state is the source of truth for review, queried live; there is no `CodeReview`
  subtask. A human reviewing or merging directly on the git host is treated as authoritative, not fought —
  the same stance as §4's rule for edits to an approved page: shown, not fought.
- **Branch unit:** parent Story/Bug. Name = parent issue key + very short slug
  (e.g. `PROJ-123-user-login`).
- **Subtasks accumulate** onto their parent Story's branch; they do not get their own
  branches.
- **PR title: tied to the parent Story/Bug first, subtask second** —
  `<StoryKey> - <SubtaskKey> - <description>` when `git-pr create` is invoked against a
  subtask, or `<StoryKey> - <description>` when invoked directly against a Story/Bug/Epic
  key with no subtask (e.g. a PM/Architect governance-content PR). Enforced by
  `validatePrTitle` (`src/core/commands/git-pr.ts`), same validate-only/fail-loudly posture
  as branch-name validation above — the persona still writes the title, the framework only
  rejects a malformed one.
- **Branching strategies** (from GSD): `none` (commit to current branch), per-unit branch,
  and a milestone-style long-lived branch — configurable.
- **Git worktrees** for parallel isolation, so switching between tickets doesn't require
  stashing dirty state. **Worktree-swap is the default** switch behavior (§8 item 8) — a
  plain checkout would reintroduce the stashing problem worktrees avoid. Not yet
  implemented in code.
- **Commits** begin with the Jira issue key so Jira's dev panel links them and so we can
  derive the affected repo for the Component field (§4).
- **Multi-repo Story:** one PR → review and test → merge chain per repo (§5.4).

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
                                  #   roster.json — the Persona Roster (§5.6),
                                  #   cached from its Confluence page (Jira backend) or
                                  #   read directly (filesystem backend)
      issues/
        <ISSUE-KEY>.json         # raw cached issue (epic/story/bug/subtask), + cachedAt;
                                  #   comments are part of this payload, not separate files
        <ISSUE-KEY>/attachments/ # cached attachments/images, fetched lazily on first use
      confluence/
        <PAGE-ID>.md             # raw cached page content, + cachedAt; comments likewise
                                  #   part of this payload (§3.9 for the Q:/Approved:/
                                  #   Rejected: marker convention that reads them)
        <PAGE-ID>/attachments/   # cached images/diagrams, fetched lazily on first use
      links/                     # cached Jira↔Confluence link index
      last-sync.json             # checkpoint timestamp for the bulk "what changed since
                                  #   last sync" JQL/CQL query (see below)
      discovered-constraints.json  # DEFERRED (§3.3) — not built in v1
  work/
    <project-key>/
      <SUBTASK-KEY>/
        briefing.md              # aggregated snapshot: subtask + parent (state, links,
                                  #   comments) + linked Confluence pages and tickets,
                                  #   size-capped, regenerated at each refresh point
        journal.md                # the offline write queue: queued and replayed writes
                                  #   (§3.6); not a record of a session's steps
```

**Refresh & briefing (§3.6):** cached items store `cachedAt`, compared against the source's
`lastUpdated`. Refresh happens at defined points — starting or resuming a unit of work,
completing one, and first use of an item in a session — not live. Each refresh regenerates
that subtask's `briefing.md` from the freshly-checked cache. Before saving any local edit back
to a Jira item or Confluence page, always fetch first and warn on conflict (§4) — never
silently overwrite.

**Work journal:** `journal.md` is append-only, one entry per queued write or replay, each with
a timestamp. It is the offline write queue's storage and nothing else, distinct from
`briefing.md` (context going in). Resuming work uses the ticket's `Handoff:` comment (§3.9), not a
local file; a per-item `status.json` and a root status rollup were designed here and removed
(TAI-490) because nothing ever wrote them.

**Unit-of-work keying:** every unit of work is tied to a Jira **subtask**, and the subtask
key is the folder name for its cache and workspace files (§4). There is no pre-subtask phase
(§8 item 11): a persona creates the subtask as its first action, before any exploration, so
journaling and caching always have a key to hang off.

- **Who may create a subtask:** any persona whose `create` permission covers that subtask
  type (§3.1) may create it directly and proactively — the PM attaching a Story's known
  subtask set up front, or a subtask recognized as needed only mid-flight
  (`workflows/dependencies.md`, eager subtask creation).
- **Story-level tickets are different:** a persona that discovers the need for a whole new
  Story, Bug or Spike **proposes** it and the PM confirms and creates it (DevOps proposing a
  post-deploy Bug, a Spike's outcome, Ada's decomposition).
- **Precedence for a subtask inserted mid-flight** is computed, not managed by hand — see
  `workflows/dependencies.md`'s "Dynamic Subtask Insertion"
  (`getNewPrecedenceEdgesForInsertedSubtask()`, `schema/story-schema.ts`).

**Bulk change detection:** the per-item `cachedAt`-versus-`lastUpdated` check answers "is
*this* item stale" but not "what changed while I was away". For that there is a bulk **JQL**
query (`updated >= "<last-sync>"`, with a CQL equivalent planned for pages) driven by
`last-sync.json`'s checkpoint — native search rather than polling every cached item
(`bulkSync()`, `src/core/cache/sync.ts`). Day-to-day refresh stays **lazy**. **No command
runs the bulk sync yet**; an explicit full-sync command, for someone about to go offline, is
the intended use.

**Attachments:** images and other attachments (wireframes, diagrams) are cached the same lazy
way — fetched and stored under the owning issue's or page's `attachments/` folder on first
use, not proactively for the whole project. This matters for UX and diagram-heavy docs,
where the image often *is* the content.

**No cache locking, no eviction:** the cache is disposable and always rebuildable from
source. If two sessions write the same cached file concurrently, whichever write lands last
reflects the most recently fetched state; nothing authoritative lives only in the cache.
(Two humans working the *same* subtask concurrently is a claiming question, §5.5, not a
cache-locking one.) Nothing is pruned from `.tai/cache`.

---

## 8. Open Design Questions

Carry these forward; resolve them in upcoming design sessions. **This list is for
genuinely undecided design questions only** — once an idea is scoped enough to actually
investigate or build, it gets a real Jira Story/Spike in `Backlog` status
(`personas/pm.md`'s "Captures genuinely open ideas as real Backlog tickets" principle,
TAI-286), backlinked from its §8 entry here, not left sitting only as brief prose.

A resolved, declined or shipped item is kept as one line (what was decided, and where it lives now) so its
number still resolves; the reasoning it once carried is in `CHANGELOG.md`. Open and deferred questions are in full.

1. **Story-type taxonomy** — resolved: Kickoff / Story / Bug / Spike, no new type ahead of a real need; the taxonomy stays extensible (§5.1, §5.2).
2. **Jira statuses and workflows** — resolved: `To Do → In Progress → Done` with per-type loop-backs; ready and blocked are derived from `SUBTASK_PRECEDENCE` (§5.3). Still open: per-project customization of the default.
3. **Scope of the "can't approve its own work" rule** — resolved: the same human, not the persona role; what review separation means in practice is in §4 (TAI-458).
4. **Multi-repo checkpoint chain shape** — resolved: the native Jira Component field, derived from a commit's Jira-key prefix with a manual fallback (§4).
5. **Failed-checkpoint triage ownership** — resolved: not a persona judgment; the loop-back destination and the single retry are fixed by the workflow (§5.3, §4).
6. **Default persona roster and permissions** — resolved: nine personas, each permission block audited against the schema (§3.1, `personas/*.md`).
7. **Storage interface operation set** — resolved: `WorkTracker`/`DocStore` in `src/core/storage/interface.ts`, proven identical across backends by the conformance suite (§3.2).
8. **Ticket-switch mechanic** — resolved: worktree swap, not plain checkout (§6). Design only; TAI-115, deferred to v2.
9. **Autocompletion condition format** — retired (TAI-482): there is no autocompletion (§3.4). The TAI-41 ADR in Confluence records the design that was retired; it does not describe how TAI works.
10. **Root status-file reconciliation** — withdrawn (TAI-490): there is no status file; nothing ever wrote one (§7).
11. **Pre-subtask work location** — resolved: there is no pre-subtask phase; a persona creates the subtask as its first action (§7).
12. **Decomposition scope levels** — resolved: no fixed ladder and no Initiative tier; decomposition is scope-relative and repeatable (§3.7).
13. **Refinement subtask triggering** — resolved (TAI-317): a human, the PM or the Analyst may flag a Story for `Investigate`; whoever has the in-context judgment creates it (`workflows/dependencies.md`, eager subtask creation); no formal "ready for implementation" marker.
14. **Escalation notification channel** — resolved: a comment or label is enough for v1; active push is deferred, not declined.
15. **Learning-loop design (deferred, §3.3):** this entire mechanism — proactive metadata
    checks, the proposed/confirmed constraint cache, promotion authority (human only, or
    can the Orchestrator do it under a configured permission?), sharing scope (local vs.
    project-wide so other team members' sessions don't independently rediscover the same
    block), and — critically — **what a promotion actually changes** (persona extension?
    workflow adjustment? something else?) is all undesigned. Revisit as a follow-on
    refinement once the core escalation behavior (v1) is built and in use.
16. **Subtask type taxonomy completeness** — resolved: `Database`, `Infra`, `Deploy`, `PostDeploy` exist with overridable default owners; a new type is always a human schema edit, which a persona may propose (§5.2).
17. **Analyst output review gate** — resolved: no formal gate for `Investigate`; the ordinary per-subtask checkpoint covers it (§3.4).
18. **Native Project Role sync (deferred, §5.6):** whether/when to mirror the
    TAI-owned Persona Roster into real Jira Project Roles for teams on a paid plan —
    what triggers it (automatic plan-tier detection vs. an explicit opt-in command), and
    how a conflict between the roster and hand-edited native roles is resolved. Not
    required for the registry to function; purely an optional native-Jira visibility/
    defense-in-depth enhancement once scheduled.
19. **Git-hosting plugin abstraction** — resolved (TAI-33 ADR; TAI-38): a sibling `GitHost` interface, not part of `StorageBackend`, at `src/core/git/` (§6).
20. **Code review must act on a real git PR** — resolved (TAI-34 ADR; TAI-159 ADR): review and merge act on the real PR, and the `CodeReview` subtask is retired in favour of the host's live approval state (§5.4).
21. **Explicit uncertainty markers** — resolved, narrow: `NEEDS CLARIFICATION:` in Kickoff-stage docs only, blocking the PM + UX review gate while one remains (`workflows/kickoff.md`).
22. **Structured completion marker** — retired (TAI-482) with autocompletion: there is no `Complete:` marker.
23. **Finer-grained checkpoint taxonomy** — retired (TAI-482): with no autocompletion there is one kind of gate, human-gated (§3.3).
24. **Lightweight persona manifest file** — deferred: no consumer yet. Not the same thing as the Persona Roster (§5.6).
25. **Brief-compliance gate in each workflow doc** — resolved: one pointer line at the top of each `workflows/*.md`, not a duplicated checklist.
26. **Retrospective / correct-course workflow type** — retrospective resolved: `/tai-retro` (§3.8), on demand, with no new workflow type; correct-course resolved: `/tai-change`, also on demand, with no new workflow type.
27. **A place for company-level or general epic-level docs** — declined: the per-ticket doc pages and the project-level `Config` folder already cover it (§4).
28. **`Backlog → To Do` readiness gate** — resolved: stays soft, no hard gate (§5.3).
29. **Human-requested review override, at any stage in the chain (2026-08-20,
    open).** At any point — Architect, Analyst, Dev, CodeReview, DesignReview, and so on —
    someone (most likely a human, though possibly any persona noticing something worth a
    second set of human eyes) should be able to flag a task/Story as needing human review
    before it proceeds, even when the AI review(s) for that stage already passed. Distinct
    from the existing human-gated checkpoints (§3.3) — this is an override layered on TOP
    of a gate that would otherwise pass, raised at arbitrary points, not fixed to one
    subtask type. Genuinely undecided, flagged live rather than designed on the spot — same
    posture as the Analyst/Architect "ask the human" principle (`personas/analyst.md`/
    `architect.md`): this is exactly the kind of open direction question that belongs to
    the human, not a persona's unilateral call. Open: what marks it (a comment convention
    alongside the existing `Q:`/`Approved:`/`Rejected:` set, §3.9; a label; a dedicated
    field)? Does it block the same way a failed review does, or just add a required extra
    step? Who can clear it once raised? Revisit
    once a concrete case makes the shape obvious, same "don't build ahead of an observed
    need" posture as item 1/28 above.
30. **A Story doesn't support multiple Dev/Test/Deploy cycles (2026-08-24, known
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
    bigger change than retiring the `CodeReview` subtask was.
31. **Custom Jira priorities may need alias-mapping too (2026-08-31, open).**
    TAI-116/TAI-179 built type-alias mapping for issue *types* only (TAI-90/91's ADR). A
    target project's Jira admin may have set up custom `Priority` values that don't match
    whatever TAI reads/assumes — not yet investigated: does TAI touch `Priority` anywhere
    that would actually break on a non-default scheme, and if so, does it want the same
    alias-mapping treatment (`src/core/storage/jira/type-alias-config.ts`) extended to
    cover it, or its own lighter mechanism? Revisit once a concrete case surfaces, same
    posture as items 1/28/29. **See TAI-279 (Spike, Backlog).**
32. **Analyst-owned Confluence project "home" page (2026-08-31, open, possible new
    skill).** No persona currently owns keeping a project-level executive-summary/
    description page current in Confluence. Flagged as a likely Ada (Analyst) job, wholly
    undesigned: what it should contain, how/when it gets updated (once at Kickoff? every
    Epic? periodically?), and whether it's a new `confluenceOutputs` doc type or folds into
    the existing project-level `Config` folder (§4, which already holds untyped,
    non-ticket-tied content). **See TAI-280 (Story, Backlog).**
33. **Architect-owned architecture overview doc** — shipped (TAI-281/TAI-307): `personas/architect.md`'s Architecture Overview section; Confluence page 34963485.
34. **Keeping local master fresh across machines** — shipped (TAI-282, TAI-287 ADR): `tai-work` and `tai-ready` fetch and fast-forward the default branch when safe (`src/core/git/local-fetch.ts`).
35. **Per-persona job and scope audit against competitor frameworks** — resolved: TAI-283, Confluence page 41123841.
36. **Overall TAI-versus-competition comparison** — resolved: TAI-284, Confluence page 41156609.
37. **Extend the out-of-band-human-edit posture from git hosts to Jira/Confluence directly
    (2026-08-31, open).** §6/the TAI-34 ADR already establish that a human acting
    directly on the git host (reviewing, merging) is treated as authoritative, not fought —
    detected on next refresh and reflected, same principle as §4's rule for edits to an
    approved page (shown, not fought). That posture isn't yet extended to a human creating or editing a Jira
    ticket or Confluence page directly, out of band. PM (Perry) and Analyst (Ada) are named
    as the biggest exposure — ticket/requirement content changing under them mid-flight —
    but every persona is exposed to some degree. Undesigned: how a persona notices a
    ticket/page changed since its own last read (a diff against the cache/`lastUpdated`,
    §7?), and what reconciliation looks like once noticed. **See TAI-285 (Story,
    Backlog).**
38. **Scale DesignReview gate depth to stakes (2026-09-22, deliberately deferred to
    v2/v3).** Raised live during Aria's (Architect) persona review (TAI-6/149/328):
    BMAD-METHOD's architecture-spine reviewer gate is a deterministic lint pass plus a
    rubric-walker plus multiple review-lens subagents, scaled to stakes — richer than
    `DesignReview`'s simple pass/fail (`workflows/story.md`; a human gate since TAI-458,
    with the Architect preparing the review notes).
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
  multi-repo, caching.

---

## 10. Tech Stack & Environment

- **Language:** TypeScript (strict), Node.js 20+, ESM.
- **Runtimes targeted:** Claude Code and Gemini CLI first; Antigravity CLI later.
- **Storage/integration:** Atlassian **REST API** (`/rest/api/3`, `/wiki/api/v2`),
  authenticated as the human via API token (OAuth 2.1 3LO layerable later); local filesystem
  adapter as fallback. Native `fetch` — no HTTP client dependency. **Not** the Atlassian
  Remote MCP Server; see §3.2 for why.
- **Dev tooling:** `tsx` for watch/dev, `tsc` for build, ESLint + `@typescript-eslint`.
- **Session bootstrap files:** `CLAUDE.md` and `GEMINI.md` at repo root both point every
  session to **read this brief first.**
- **Persona/agent definitions:** markdown + YAML front-matter (parseable, human-editable,
  reviewable in PRs). A persona doc writes a CLI command as `{{TAI_CLI}} <subcommand> …`; `loadPersonaConfig`
  fills the placeholder with the running install's own invocation, so the command works from any target project. The filled-in command also carries
  `--as <persona id>`, so a command copied from a persona's prompt tells the CLI who is acting; a command without it is
  unattributed, and nothing guesses. Self-declared: it makes actions attributable, it does not prove who acted.

---

## 11. Glossary

- **Persona** — an AI role (Analyst, Architect, Developer, …) with a configurable definition and
  permission set.
- **Persona field** — a stored per-ticket custom field naming which persona is acting in
  this specific ticket; distinct from the native Jira `Assignee` (a real human) — the
  two-axis owner model, §5.6.
- **Persona Roster** — TAI's own storage-agnostic mapping of `persona id → authorized
  humans` (not native Jira Project Roles: Jira's Free plan can't create them and the
  filesystem backend has no equivalent). Confluence-page-backed on the Jira backend, a local file on the
  filesystem backend. Backs the human registry and assignment-helper, §5.6. Syncing it
  into real Jira Project Roles on paid tiers is an optional, deferred enhancement
  (§8.18), never a dependency.
- **Storage plugin / backend** — a swappable implementation of the source-of-truth
  interface (Jira, filesystem, other).
- **Checkpoint** — a human-oversight gate modeled as a dependent subtask.
- **Workflow** — the per-Story-type process (Kickoff/Story/Bug/Spike, `workflows/*.md`)
  defining subtask structure, precedence, and gates. There is no separate "named scenario"
  sense (complete/quick/bugfix); the story-type plus optional-subtask design covers it (§3.5).
- **Work unit** — the standard branch/work granularity: a Jira Story or Bug.
- **Orchestrator** — an older name for the PM persona's role: she owns the story-level tickets
  and runs grooming. She does not dispatch work to other personas; a human starts every piece
  of work (§3.8).

---

*End of brief. Keep this current — it is the contract every persona and session relies on.*