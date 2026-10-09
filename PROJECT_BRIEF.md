# Team AI (TAI) — Project Brief

> **Status:** Living document. This is the source of truth for the Team AI framework's
> vision, design decisions, and open questions. Every persona and every AI session must
> read this file first. When decisions change, update this file — do not let it drift.
>
> **Last updated:** 2026-10-09 (rev 86). The revision history is in `CHANGELOG.md`; this file states what is
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
  create / work on / complete / update, and its permitted transitions).
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
enabled. Three subtask types are **inherently human-gated**: `UAT`, `EpicReview` and
`DesignReview` (`ALWAYS_HUMAN_GATED_SUBTASKS`, `story-schema.ts`; `DesignReview` joined them
with TAI-458). A persona prepares or drives each one, holds no `complete` grant for it, and
a human closes it.

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
- **What each ticket shows (TAI-464).** Every ticket in the briefing carries a state line:
  type, status, owning persona, assignee (or "unassigned"), priority and the flag. The
  subtask and the parent also show their own remote links (where a PR link lives) and
  their **last 10 comments**, oldest first, with a note on how many older ones there are.
  The latest `Handoff:` comment is lifted out and shown first, under its own heading.
  Linked tickets show state and description only, no comments and no links — the same
  one-hop bound. Live PR state (approvals, CI) is not in the briefing; it needs the git
  host; `/tai-ready` is where an approved PR surfaces.
- **A size budget (TAI-464).** The briefing is capped at 60,000 characters by default
  (`TAI_BRIEFING_BUDGET` in `.env`). The subtask and the parent are never cut. Linked pages
  and linked tickets share what is left, smallest first, so a short page is not cut to
  make room for a long one; one that does not fit ends with `NOT SHOWN IN FULL — N more
  characters` and the `page get` / `issue get` command that reads the rest. If the subtask
  and parent alone exceed the budget, the briefing exceeds it too.
- **Ticket and page text is data, not instructions (TAI-464).** The briefing is appended to
  the persona prompt, so text in it must not be able to pose as that prompt. It opens with
  a notice saying so; a heading inside ticket, comment or page text is pushed below the
  briefing's own heading for that section; a `---` line becomes `* * *`. Code fences are
  left as written. This makes external text visibly external; it is not a guarantee
  against a model following it.
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

### 3.8 Interaction Modes
- A human can **initiate a persona** and interact with it (e.g. "what's ready for you to
  do?").
- A human can **initiate new work** (create a bug, request review of prior work, etc.).
- A human can **query what's "ready"** for any persona.
- **Nothing dispatches work (TAI-457).** Perry — the "Orchestrator" in older text — owns the
  story-level tickets and runs grooming (`/tai-groom`): she sequences, creates and promotes
  tickets with the human. She does not start another persona's work; a human starts every
  piece of work, with `/tai-work` or `/tai-ready`.

**Concrete kickoff commands (rev 11):** `/tai-work <KEY>` loads/refreshes that unit of
work's briefing (§3.6) and invokes its owning persona directly. `/tai-ready [persona]`
answers "what's ready for you to do" when the human doesn't have a specific key in mind
yet. Both are thin wrappers over the same briefing-then-invoke flow — there's no
separate code path for "starting fresh" vs. "resuming."

**Project initiation has no ticket entry either (rev 80, TAI-348/450).** `/tai-work` always needs an existing key, and a
fresh project has none, so Perry's Project initiation (create an Epic and its Kickoff Story) is reached through
`/tai-kickoff [initiative]`, which runs `kickoff [INITIATIVE]`: the same persona-heading-then-body shape as `work` and
`groom`, with a read-only briefing of the existing Epics and Kickoff Stories so she dedups. It works on any project, not
only an empty one, because starting a new initiative has no emptiness precondition. The initiative text is the
human's data, never instructions.

**Review has no ticket entry (rev 78, TAI-425).** The `CodeReview` subtask is retired (rev 52), so the Code
Reviewer is not loaded by `/tai-work`. Its entry point is `/tai-pr`'s review flow, which runs
`git-pr review-prep <REPO> [PR-ID]` — same persona-heading-then-body shape as `work` and `groom`, keyed by a PR
instead of a ticket. A ticketless `/tai-review` skill was considered and deferred.

### 3.9 Comment Conventions (rev 11 — formalized here, previously design-notes-only)

TAI's own comment-scanning logic (§3.6) is what interprets these — none of them are
native Jira/Confluence features (plain Jira comments have no built-in resolved flag;
Confluence's native inline-comment resolve checkmark exists but isn't used for this, see
below). `Q:`, `Approved:` and `Rejected:` apply to **both** Jira issue comments and Confluence
comments (page-level and inline) — not just Jira; `Skipped:` and `Handoff:` are Jira-only.

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
- **`Skipped: <subtask-type>[, <type>...] — <reason>`** (TAI-443) — on a Kickoff Story: the named
  subtask types were left out on purpose, so `/tai-ready`'s "Subtasks ready to create" hint stops listing
  them. Type names are case- and hyphen-insensitive (`ux-design`, `UxDesign`, `ux design`); the reason must
  follow a dash (`—`, `–`, ` - ` or ` -- `) and is free text — without a dash the whole line is read as the
  type list. Perry or a human may post one with no confirmation gate — it only silences a hint, and editing
  or deleting the comment brings the hint back. It does not stop anyone creating the subtask later.
- **`Handoff:`** (TAI-489, deciding TAI-460) — Jira issue comments only: the ticket's **one living hand-off
  comment**, written by whoever stops with the ticket still In Progress and the work unfinished. It says what
  is done, what is in flight, the next step, and the assumptions made. It is edited in place, never appended
  to: `issue comment <KEY> "Handoff: …"` replaces the ticket's latest `Handoff:` comment (and adds one if
  there is none, or if the old one cannot be edited). Nothing scans it to decide anything; the work briefing
  shows it first (§3.6), which is how the next session — any host, or a human — picks the work up. A
  hand-off covering several tickets at once is the human's own business, outside TAI.

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
| Requirements | PM | Refinement — PRD drafting. Also allowed on a Story (TAI-458): a future-direction question the Architect or DBA hands to the PM, with no precedence edge |
| UxDesign | UX Designer | Refinement — flows/wireframes |
| Investigate | Analyst | Refinement — Story-level (§3.7) |
| Feasibility | Architect | Refinement — quick technical go/no-go |
| ArchitectureDesign | Architect | Refinement — deeper design |
| DesignReview | Architect prepares + a human reviews and closes it | Refinement gate — inherently human-gated (§3.3, TAI-458); gates `ArchitectureDesign` → `Dev` (workflows/story.md) |
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

A type may name a **default owner that is overridable per instance** (`Deploy` / `PostDeploy`). Adding a
brand-new type is always a human schema edit, which a persona may propose (§8.16).

`Investigate` has no review gate of its own; the ordinary per-subtask checkpoint covers it (§8.17).

`DesignReview` and `UAT` are optional gates: `DesignReview` gates `ArchitectureDesign` → `Dev`, and `UAT`
gates `Deploy`. Both are inherently human-gated (§3.3) and **present-when-added**, purely additive to the
precedence graph — see `workflows/story.md` and `workflows/dependencies.md`.

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

### 5.4 Checkpoint Chain (canonical example)

**The sequence (TAI-456, human decision 2026-10-08): verify, then merge.**
```
[Dev opens PR, stays In Progress] --> [review + test tiers, in parallel; UAT] --> [merge, by whoever owns Dev] --> [Deploy] --> [PostDeploy]
```
1. **PR open.** Developer opens the PR from the Story's branch; `Dev` stays In Progress.
2. **Review and the test tiers run in parallel** against that PR. **Test code goes in the same branch and PR**
   as the `Dev` work it tests. Tester marks a tier **Done on a pass**; a tier does not wait for a merge.
3. **UAT, when present, is before merge by default** — the stakeholder accepts what is about to be merged. A
   ticket may place it after the merge instead: the `uat-after-merge` label on the `UAT` subtask records that.
   The merge gate checks it (TAI-507): an open `UAT` without that label blocks the merge.
4. **Merge**, through the merge gate below. **Whoever owns the `Dev` subtask merges, always.** PM and Architect
   merge their own governance PRs; Tester never merges; `Deploy` is not where a PR gets merged.
5. **Deploy ships what is already merged.** It waits on `Dev` being Done, the present test tiers and `UAT`.
6. **A test failure before the merge** sends that tier back to To Do. `Dev` never left In Progress, and the fix
   is more commits on the same PR.
7. **A failure found after the merge is a new linked Bug.** Nothing reopens `Dev`.
8. **Test code discovered only after the merge** opens its own PR, reviewed like any other and merged by the
   `Dev` owner; that tier stays In Progress until its PR merges. Nothing goes straight to the default branch.

**How review, readiness and the merge work (rev 52, TAI-159 ADR; merge gate TAI-462):**
- **Review happens on the real PR, and there is no `CodeReview` subtask.** The git host's own reviewer and
  approval state is the only source of truth for review status, queried live and never mirrored into Jira. A
  Jira subtask needs exactly one assignee (§5.5), and an N-of-M approval policy has no honest single assignee.
  (`CodeReview` stays in the schema to parse historical tickets; it is not created for new work.)
- **`git-pr create` links the PR to the `Dev` subtask** that opened it, with a Jira remote issue link.
- **`Dev` stays In Progress until its PR merges**, not until the PR opens. `Deploy` ships what is already
  merged, so it waits on `Dev` being Done as well as on the test tiers and UAT (TAI-456/TAI-463).
- **Readiness for review, testing and merging is computed live**, as three `/tai-ready` lists rather than from
  the static precedence graph: `readyToReview` (open PRs where the current human is on the "PR Reviewers"
  roster), `readyToTest` (In-Progress `Dev` subtasks with an open PR; no approval needed, testing runs alongside
  review) and `readyToMerge` (PRs that pass the merge gate and are CI-green).
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
- **`Dev` → Done has two triggers:** `git-pr merge` moves the linked `Dev` subtask to Done in the same call
  that performs the merge; a refresh-based fallback catches a PR merged out of band.
- **A human acting directly on the git host is detected and reflected, never fought** (approve, request
  changes, merge) — picked up at the next refresh, the same stance as §4's Confluence gate-reopening rule.

Full detail (approval-threshold handling, the reviewer roster, refresh mechanics): the TAI-159 ADR (Confluence,
TA space, page 28704769). The earlier chains this replaced — the original Develop → Code Review → Merge/Deploy
subtask chain and the rev 21 `CodeReview`-subtask flow (TAI-34 ADR, page 13860867, marked superseded) — are in
`CHANGELOG.md`.

**Test-tier subtasks (rev 48, revised TAI-456):** a test tier's code normally lands in the `Dev` branch and PR
(item 2 above), and the tiers gate both the merge (the merge gate) and `Deploy`. Tester keeps
`gitHost: createPullRequest` for one case only: test code discovered after the `Dev` PR has merged (item 8). She
opens that PR herself, it is reviewed like any other, and the `Dev` owner merges it — Tester was not granted
`mergePullRequest`, so there is no self-merge path for her.

See TAI-33's ADR for the `GitHost` interface this depends on.

For a **multi-repo** Story: repeat the PR → review and test → merge chain **once per
repo**, each subtask tagged with its repo via the native Jira **Component** field (§4,
rev 11 — not a custom `repo` field).

**Note:** the as-built Story/Bug graph elaborates this canonical shape with parallel
prerequisites (`ArchitectureDesign` / `Database` / `Infra` → `Dev`), test tiers and `UAT`
between `Dev` and `Deploy`, and a `PostDeploy` follow-up — see
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
- **Review and merge act on a real git PR (TAI-34 ADR; revised rev 52, TAI-159 ADR).** See §5.4. The git
  host's own approval state is the source of truth for review, queried live; there is no `CodeReview`
  subtask. A human reviewing or merging directly on the git host is treated as authoritative, not fought —
  the same stance as §4's Confluence gate-reopening rule.
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

## 8. Open Design Questions

Carry these forward; resolve them in upcoming design sessions. **This list is for
genuinely undecided design questions only** — once an idea is scoped enough to actually
investigate or build, it gets a real Jira Story/Spike in `Backlog` status
(`personas/pm.md`'s "Captures genuinely open ideas as real Backlog tickets" principle,
rev 56, TAI-286), backlinked from its §8 entry here, not left sitting only as brief prose.

A resolved, declined or shipped item is kept as one line (what was decided, and where it lives now) so its
number still resolves; the reasoning it once carried is in `CHANGELOG.md`. Open and deferred questions are in full.

1. **Story-type taxonomy** — resolved (rev 11): Kickoff / Story / Bug / Spike, no new type ahead of a real need; the taxonomy stays extensible (§5.1, §5.2).
2. **Jira statuses and workflows** — resolved (rev 11, rev 15): `To Do → In Progress → Done` with per-type loop-backs; ready and blocked are derived from `SUBTASK_PRECEDENCE` (§5.3). Still open: per-project customization of the default.
3. **Scope of the "can't approve its own work" rule** — resolved (rev 31): the same human, not the persona role; what review separation means in practice is in §4 (TAI-458).
4. **Multi-repo checkpoint chain shape** — resolved (rev 11): the native Jira Component field, derived from a commit's Jira-key prefix with a manual fallback (§4).
5. **Failed-checkpoint triage ownership** — resolved (rev 32): not a persona judgment; the loop-back destination and the single retry are fixed by the workflow (§5.3, §4).
6. **Default persona roster and permissions** — resolved: nine personas, each permission block audited against the schema (§3.1, `personas/*.md`).
7. **Storage interface operation set** — resolved (rev 33): `WorkTracker`/`DocStore` in `src/core/storage/interface.ts`, proven identical across backends by the conformance suite (§3.2).
8. **Ticket-switch mechanic** — resolved (rev 34): worktree swap, not plain checkout (§6). Design only; TAI-115, deferred to v2.
9. **Autocompletion condition format** — resolved (rev 25, TAI-41 ADR; built rev 26, TAI-43): `AutocompletionCondition`/`AutocompletionConfig`, AND-only, in `autocompletion.ts`; not yet called from anywhere (§3.4).
10. **Root status-file reconciliation** — resolved (rev 35, rev 42): always a full rescan on demand, at the same refresh points as §3.6 (§7).
11. **Pre-subtask work location** — resolved (rev 36): there is no pre-subtask phase; a persona creates the subtask as its first action (§7).
12. **Decomposition scope levels** — resolved (rev 37): no fixed ladder and no Initiative tier; decomposition is scope-relative and repeatable (§3.7).
13. **Refinement subtask triggering** — resolved (rev 38, rev 57, TAI-317): a human, the PM or the Analyst may flag a Story for `Investigate`; whoever has the in-context judgment creates it (`workflows/dependencies.md`, eager subtask creation); no formal "ready for implementation" marker.
14. **Escalation notification channel** — resolved (rev 41): a comment or label plus the status rollup is enough for v1; active push is deferred, not declined.
15. **Learning-loop design (deferred, §3.3):** this entire mechanism — proactive metadata
    checks, the proposed/confirmed constraint cache, promotion authority (human only, or
    can the Orchestrator do it under a configured permission?), sharing scope (local vs.
    project-wide so other team members' sessions don't independently rediscover the same
    block), and — critically — **what a promotion actually changes** (persona extension?
    workflow adjustment? something else?) is all undesigned. Revisit as a follow-on
    refinement once the core escalation behavior (v1) is built and in use.
16. **Subtask type taxonomy completeness** — resolved (rev 10, rev 39): `Database`, `Infra`, `Deploy`, `PostDeploy` exist with overridable default owners; a new type is always a human schema edit, which a persona may propose (§5.2).
17. **Analyst output review gate** — resolved (rev 40): no formal gate for `Investigate`; the ordinary per-subtask checkpoint covers it (§3.4).
18. **Native Project Role sync (deferred, rev 12, §5.6):** whether/when to mirror the
    TAI-owned Persona Roster into real Jira Project Roles for teams on a paid plan —
    what triggers it (automatic plan-tier detection vs. an explicit opt-in command), and
    how a conflict between the roster and hand-edited native roles is resolved. Not
    required for the registry to function; purely an optional native-Jira visibility/
    defense-in-depth enhancement once scheduled.
19. **Git-hosting plugin abstraction** — resolved (rev 21, TAI-33 ADR; built rev 25, TAI-38): a sibling `GitHost` interface, not part of `StorageBackend`, at `src/core/git/` (§6).
20. **Code review must act on a real git PR** — resolved (rev 21, TAI-34 ADR; revised rev 52, TAI-159 ADR): review and merge act on the real PR, and the `CodeReview` subtask is retired in favour of the host's live approval state (§5.4).
21. **Explicit uncertainty markers** — resolved (rev 23), narrow: `NEEDS CLARIFICATION:` in Kickoff-stage docs only, blocking the PM + UX review gate while one remains (`workflows/kickoff.md`).
22. **Structured completion marker** — resolved (rev 25, TAI-41 ADR; built rev 26, TAI-43): `Complete: <SubtaskType>` with one PASS/FAIL line per condition, no inference fallback (§3.9, `autocompletion.ts`).
23. **Finer-grained checkpoint taxonomy** — resolved (rev 25, TAI-41 ADR): two kinds, `hard` and `conditional`; the three-way split was declined (`checkpointKind`, `autocompletion.ts`).
24. **Lightweight persona manifest file** — deferred (rev 23): no consumer yet. Not the same thing as the Persona Roster (§5.6).
25. **Brief-compliance gate in each workflow doc** — resolved (rev 23, applied rev 24): one pointer line at the top of each `workflows/*.md`, not a duplicated checklist.
26. **Retrospective / correct-course workflow type** — declined (rev 23): no real need yet; a Bug or an edited Story covers it.
27. **A place for company-level or general epic-level docs** — declined (rev 30): the per-ticket doc pages and the project-level `Config` folder already cover it (§4).
28. **`Backlog → To Do` readiness gate** — resolved (rev 29): stays soft, no hard gate (§5.3).
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
33. **Architect-owned architecture overview doc** — shipped (rev 57, TAI-281/TAI-307): `personas/architect.md`'s Architecture Overview section; Confluence page 34963485.
34. **Keeping local master fresh across machines** — shipped (rev 57, TAI-282, TAI-287 ADR): `tai-work` and `tai-ready` fetch and fast-forward the default branch when safe (`src/core/git/local-fetch.ts`).
35. **Per-persona job and scope audit against competitor frameworks** — resolved (rev 66): TAI-283, Confluence page 41123841.
36. **Overall TAI-versus-competition comparison** — resolved (rev 66): TAI-284, Confluence page 41156609.
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
  reviewable in PRs). A persona doc writes a CLI command as `{{TAI_CLI}} <subcommand> …`; `loadPersonaConfig`
  fills the placeholder with the running install's own invocation, so the command works from any target project (TAI-465). The filled-in command also carries
  `--as <persona id>` (TAI-477), so a command copied from a persona's prompt tells the CLI who is acting; a command without it is
  unattributed, and nothing guesses. Self-declared: it makes actions attributable, it does not prove who acted.

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
- **Orchestrator** — an older name for the PM persona's role: she owns the story-level tickets
  and runs grooming. She does not dispatch work to other personas; a human starts every piece
  of work (§3.8, TAI-457).

---

*End of brief. Keep this current — it is the contract every persona and session relies on.*