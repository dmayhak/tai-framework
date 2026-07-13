# Team AI (TAI) — Project Brief

> **Status:** Living document. This is the source of truth for the Team AI framework's
> vision, design decisions, and open questions. Every persona and every AI session must
> read this file first. When decisions change, update this file — do not let it drift.
>
> **Last updated:** 2026-07-12 (rev 16 — new **`Canceled`** status added to §5.3: a
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
  **Atlassian Remote MCP Server** (`https://mcp.atlassian.com`). The MCP server
  authenticates *as the actual human user* and respects their existing Jira/Confluence
  permissions — this is a feature, not a limitation: an AI persona acts with exactly the
  authority of the human driving it.
- **Local filesystem** fallback — a directory structure + naming convention that mimics the
  Jira hierarchy, for solo developers and offline work.
- **Other systems** (Jira competitors) can be added via their own MCP servers, implementing
  the same storage interface.

The storage interface contract is the single most important design artifact in the system.
TypeScript interfaces enforce that every backend implements it identically.

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
of work, and whenever an item is first used in a session (per §4's caching rule). At a
refresh point, cached items are compared against source `lastUpdated` and re-pulled if
stale.

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
project to propose a breakdown into Epics ("a project of projects"), then runs again
**scoped to each individual Epic** to produce that Epic's Stories/Bugs. The framework does
not fix how many passes happen or where they stop — it fixes that decomposition is a
repeatable persona operation, applicable at whatever scope is handed to it. (This mirrors
BMAD's scale-adaptive planning depth.)

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

### 3.8 Interaction Modes
- A human can **initiate a persona** and interact with it (e.g. "what's ready for you to
  do?").
- A human can **initiate new work** (create a bug, request review of prior work, etc.).
- A human can **query what's "ready"** for any persona.
- An **AI Orchestrator** persona may (if granted permission) query what's next *and* kick
  off that work via the appropriate persona — but human-gated checkpoints still stop/pause
  the chain regardless.

**Concrete kickoff commands (rev 11):** `/tai_work <KEY>` loads/refreshes that unit of
work's briefing (§3.6) and invokes its owning persona directly. `/tai_ready [persona]`
answers "what's ready for you to do" when the human doesn't have a specific key in mind
yet. Both are thin wrappers over the same briefing-then-invoke flow — there's no
separate code path for "starting fresh" vs. "resuming."

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
  org-level enforcement.)
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
  it, comment on the parent.
- **Multi-repo:** a Story/Bug can touch **multiple repos**; a **subtask targets exactly one
  repo.** Each repo touched gets its own dev → review → merge/deploy subtask chain under the
  Story. **Decided (rev 11):** the affected repo is tracked via Jira's **native Component**
  field, not a custom field — reuses existing Jira mechanics rather than provisioning a new
  one. **Population is derived-with-manual-fallback:** a commit message beginning with the
  Jira issue key (§6) is used to look up the touched repo and auto-populate Component; a
  human or persona can still set/correct it manually before any commit exists yet (e.g. at
  subtask creation, or if the automation can't resolve it).
- **Confluence:** one Confluence space per Jira project — **the space key matches the
  Jira project key** (rev 11; e.g. Jira project `PROJ` gets Confluence space `PROJ`).
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
| CodeReview | Code Reviewer | Implementation gate |
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
**`To Do → In Progress → Done`** for both story-level tickets and subtasks, with specific
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
- Ready, unassigned tickets are **claimable.** People *should* work their own tickets, but
  we deliberately do **not** hard-lock this — people take time off, need help, hand work
  off. So a branch for some work may already exist in the repo from a prior owner.
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
   it has no default human Assignee.

**Why a stored field, not a derived value:** since a human can appear under multiple
personas in the Persona Roster, looking up "which persona is this" purely from roster
membership is ambiguous whenever they're listed under more than one relevant persona. An
explicit, stored `persona`
field removes that ambiguity and is what makes effort/time-tracking roll up correctly by
persona regardless of which human actually did the work (the schema-level rationale
already stated for `SUBTASK_OWNER`).

**Assignment-helper (answers "does TAI help PM assign tickets to humans"):** when a
ticket needs a human `Assignee`, TAI looks up which humans are listed under that ticket's
`persona` field in the **Persona Roster**, and surfaces the candidates — plus lightweight
signals
(current open-ticket count per person, whether one already has a branch/related work in
flight) — to whoever is driving the PM/Orchestrator session. Once a human is picked, **TAI
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

- **Branch unit:** parent Story/Bug. Name = parent issue key + very short slug
  (e.g. `PROJ-123-user-login`).
- **Subtasks accumulate** onto their parent Story's branch; they do not get their own
  branches.
- **Branching strategies** (from GSD): `none` (commit to current branch), per-unit branch,
  and a milestone-style long-lived branch — configurable.
- **Git worktrees** for parallel isolation, so switching between tickets doesn't require
  stashing dirty state. **Open item:** confirm worktree-swap vs. plain checkout as the
  default switch behavior.
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
files (§4). Work that predates a subtask existing (e.g. initial brainstorming) has no fixed
home yet — see open question in §8.

**Root status file:** `status.json` at the repo root is a **rollup/index**, not an
authoritative source — it is itself a cache, of the same kind as everything else in this
layout. It is built by scanning `.tai/work/**/status.json` and carries its own
`generatedAt`. Any tool reading it should trust it only if fresh; if stale or missing,
regenerate by scanning. This avoids paying the cost of a full scan on every read while
never letting the root file become a second, driftable source of truth.

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

Carry these forward; resolve them in upcoming design sessions.

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
3. **Scope of the "same persona can't approve" rule:** is it scoped to the same human, the
   same persona role, or both? (Currently: business-enforced, not code-locked, to allow
   solo self-review.) *Note (rev 10):* the Code Reviewer persona expresses a "should not
   review own authored work by default, overridable for solo dev" stance — the scope
   question here is still what's unresolved.
4. ~~**Multi-repo checkpoint chain shape**~~ — **RESOLVED (rev 11):** native Jira
   **Component** field (not a custom `repo` field), populated by deriving the repo from a
   commit's Jira-key prefix with manual fallback. See §4.
5. **Failed-checkpoint triage ownership:** the retry-once-then-human rule is set; confirm
   whether the Orchestrator persona may perform the re-triage automatically within that
   single retry.
6. ~~**Finalized default persona roster and default issue-type permissions**~~ —
   **RESOLVED:** the 9-persona roster (§3.1) is final, and every persona's `create`/
   `workOn`/`complete`/`update` permission block was individually audited against the
   schema (design-notes §1), fixing several real gaps in the process (e.g. Ada's missing
   `Subtask:Investigate`, Dario's missing `Subtask:Dev`). See each `personas/*.md` file.
7. **Storage interface operation set:** the minimum operations the abstraction must expose
   (issue CRUD, query/JQL-equivalent, status transition, comments, issue links, custom
   fields, attachments) and what Jira-specific concepts must *not* leak so the filesystem
   backend stays clean.
8. **Ticket-switch mechanic:** worktree swap vs. plain checkout as default.
9. **Autocompletion condition format:** the schema/prompt structure for extensible
   condition definitions.
10. **Root status-file reconciliation:** exact staleness rule for `status.json` (TTL vs.
    trust-until-mismatch) and when a reconciliation scan is triggered automatically
    (session start? every command? explicit `/tai_` refresh command?).
11. **Pre-subtask work location:** where initial brainstorming/setup work (before a subtask
    exists to key off of) is cached and journaled, and how/whether it gets reattached once
    a real subtask is created for it.
12. **Decomposition scope levels:** how many levels of recursive decomposition are formally
    recognized (Project → Epic → Story, or does a very large system warrant an optional
    Initiative level above Epic?) and where the Analyst/Orchestrator decides to stop
    decomposing further.
13. **Refinement subtask triggering:** *Partly resolved.* Three non-exclusive triggers can
    flag a Story as needing `Investigate`: a human manually, PM (Orchestrator) recognizing
    insufficient detail while querying what's ready, or the Analyst self-flagging during
    other work (e.g. decomposition). Regardless of who flags it, the Analyst always
    creates the actual `Investigate` subtask — the flagging persona never creates it on
    the Analyst's behalf (see `personas/pm.md`, `personas/analyst.md`). **Still open:**
    what formally marks a Story "ready for implementation" once refinement is done (a
    status transition, a checkpoint, or just Orchestrator judgment)?
14. **Escalation notification channel:** a Jira-rejected transition (§3.3) gets a comment/
    label in Jira and an entry in the local status rollup (§7) — is that sufficient, or
    does human escalation need an active push notification (email, Slack, Teams) so it
    isn't only discovered by someone checking Jira or running Team AI?
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
    **Still open:** the process for adding a brand-new type when a real case doesn't fit
    the existing list — does that require a human decision, or can the Analyst/Architect
    propose a new type during a refinement subtask?
17. **Analyst output review gate (§5.2):** does `Investigate` output need a formal review
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
    `Investigate`, and whether these two gates should be unified, both remain open.
18. **Native Project Role sync (deferred, rev 12, §5.6):** whether/when to mirror the
    TAI-owned Persona Roster into real Jira Project Roles for teams on a paid plan —
    what triggers it (automatic plan-tier detection vs. an explicit opt-in command), and
    how a conflict between the roster and hand-edited native roles is resolved. Not
    required for the registry to function; purely an optional native-Jira visibility/
    defense-in-depth enhancement once scheduled.

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
- **Storage/integration:** Atlassian Remote MCP Server (OAuth 2.1, permission-respecting)
  for Jira + Confluence; local filesystem adapter as fallback.
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