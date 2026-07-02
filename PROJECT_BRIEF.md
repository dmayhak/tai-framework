# Team AI (TAI) — Project Brief

> **Status:** Living document. This is the source of truth for the Team AI framework's
> vision, design decisions, and open questions. Every persona and every AI session must
> read this file first. When decisions change, update this file — do not let it drift.
>
> **Last updated:** 2026-07-01 (rev 4 — added persona display-name convention, §3.1)
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
(see §5.3). Human-gated checkpoints **take priority over all autocompletion settings** —
if a checkpoint requires a human, work pauses there even when autocompletion is otherwise
enabled.

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
Named, configurable scenarios that define which personas participate and which steps run.
The default is a **"complete"** workflow (full chain). We will also support shortcut
variants like **"quick"** (skips some steps/roles) and **"bugfix"**, etc. Businesses can
configure their own workflow scenarios: which roles are enabled, which roles own which
issue types, and what each role does.

### 3.6 Cache Refresh Points & Resumability
Jira/Confluence are shared, externally-editable sources of truth — a human or another AI
agent may change a ticket or page at any time. Team AI does **not** attempt live sync.
Instead, freshness is checked at defined **refresh points**: when starting/resuming a unit
of work, and whenever an item is first used in a session (per §4's caching rule). At a
refresh point, cached items are compared against source `lastUpdated` and re-pulled if
stale.

Each refresh regenerates a **briefing** — a single aggregated markdown file combining the
subtask, its parent Story/Epic, and all linked Confluence pages into one readable snapshot.
This is what a persona actually reads to resume work; it avoids re-assembling context from
scattered cache files every time, and gives a human something reviewable too.

Alongside the briefing, Team AI maintains an **append-only work journal** per unit of work,
recording every step taken and intermediate result as it happens — not just a final state.
If a session is interrupted, the journal shows exactly what was done and where to pick back
up. See §7 for the concrete file layout.

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
**refinement subtask** — a subtask whose type routes it to Analyst, Architect, DBA, etc.
rather than Dev/Review/Merge. A refinement subtask's output is not code; it's added detail
(clarified acceptance criteria, a design decision, a data model) that lands on the Story's
linked Confluence page, per §4's "who needs to know" comment rule. Refinement subtasks may
spawn further refinement subtasks (e.g. an Architect's refinement raises a question that
needs a DBA's refinement) but do not spawn implementation chains directly — turning
refined output into actual dev subtasks is a separate decision (human or Orchestrator, per
§3.8), made once the Story is judged ready.

### 3.8 Interaction Modes
- A human can **initiate a persona** and interact with it (e.g. "what's ready for you to
  do?").
- A human can **initiate new work** (create a bug, request review of prior work, etc.).
- A human can **query what's "ready"** for any persona.
- An **AI Orchestrator** persona may (if granted permission) query what's next *and* kick
  off that work via the appropriate persona — but human-gated checkpoints still stop/pause
  the chain regardless.

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
  Story. The affected repo is tracked via a Jira **Component** or a custom `repo` field.
  (Candidate automation: a commit's message begins with the Jira key; we look up the repo
  from the commit and populate the field.)
- **Confluence:** one Confluence space/area per Jira project; organized by role-deliverable
  type. Pages link to the Jira item that **needs that page as input.** Pages tie to the
  **parent** issue (Story/Epic), **never to subtasks.** Jira↔Confluence linking is the
  source of truth; we keep a local filesystem cache of those links, refreshed as needed.
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
    Story / Bug    → the standard unit of work; typed (Spike, Research, Bug, Implementation, …)
      Subtask      → leaf work, typed by the persona/checkpoint role; single-repo
```

### 5.2 Statuses & Dependencies
Issues carry statuses (pending / in-progress / done, plus blocked/ready as derived from
dependencies) and **"blocks / depends-on"** links that determine what is ready to be picked
up vs. blocked. **Open item:** the exact status set and workflow transitions still need to
be defined (see §8).

### 5.3 Checkpoint Chain (canonical example)
For an implementation Story touching one repo:
```
[Dev subtask]  --blocks-->  [Code Review subtask]  --blocks-->  [Commit/Merge subtask]
```
- Dev subtask completes → Code Review subtask becomes actionable.
- Review **fails** → reopen the Dev subtask, put the Review subtask back to backlog,
  record reviewer notes as a comment (on the dev subtask, or parent if multiple parties
  care). AI may retry once; second failure escalates to a human.
- Review **passes** → mark it done, unblocking the next subtask in the chain.

For a **multi-repo** Story: repeat the dev→review→merge/deploy chain **once per repo**,
each subtask tagged with its repo (Component / `repo` field).

Story-level work is not always dev-related — Stories may be brainstorm, design, research,
etc., differentiated by their type and their subtasks.

### 5.4 Assignment & Claiming
- Jira **Assignee is a real human.** Our plugin layer (not Jira) enforces "act on tickets
  assigned to you, or claim an unassigned 'ready' ticket first."
- Ready, unassigned tickets are **claimable.** People *should* work their own tickets, but
  we deliberately do **not** hard-lock this — people take time off, need help, hand work
  off. So a branch for some work may already exist in the repo from a prior owner.
- **On claiming a ticket where a branch already exists:** prompt the user to either
  **fetch/continue the existing branch** or **create a new one.**

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
  derive the affected repo for the `repo`/Component field.
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
      personas/                  # cached persona extensions (from Confluence)
      issues/
        <ISSUE-KEY>.json         # raw cached issue (epic/story/bug/subtask), + cachedAt
      confluence/
        <PAGE-ID>.md             # raw cached page content, + cachedAt
      links/                     # cached Jira↔Confluence link index
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

*(Exact structure is provisional and will be finalized when the filesystem storage adapter
is designed.)*

---

## 8. Open Design Questions

Carry these forward; resolve them in upcoming design sessions.

1. **Story-type taxonomy:** finalize the Story-level type names/set
   (Spike / Research / Bug / Implementation / …) and whether Story further splits into
   phase-specific types.
2. **Jira statuses & workflows:** define the concrete status set and allowed transitions
   for each issue type, including how "ready" vs. "blocked" is derived from dependencies.
3. **Scope of the "same persona can't approve" rule:** is it scoped to the same human, the
   same persona role, or both? (Currently: business-enforced, not code-locked, to allow
   solo self-review.)
4. **Multi-repo checkpoint chain shape:** confirm the per-repo dev→review→deploy chain
   modeling and how Component vs. custom `repo` field is populated (manual vs. derived from
   commit).
5. **Failed-checkpoint triage ownership:** the retry-once-then-human rule is set; confirm
   whether the Orchestrator persona may perform the re-triage automatically within that
   single retry.
6. **Finalized default persona roster** and each persona's default issue-type permissions.
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
13. **Refinement subtask triggering:** who/what flags a Story as needing a refinement
    subtask — a human manually, or can the Orchestrator/Analyst detect insufficient detail
    and propose one? And what formally marks a Story "ready for implementation" once
    refinement is done (a status transition, a checkpoint, or just Orchestrator judgment)?

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
  the backlog. Wire in the Atlassian MCP storage adapter. Add workflows (quick, bugfix).
  Layer in checkpoints, autocompletion, multi-repo, caching.

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

- **Persona** — an AI role (Analyst, Architect, Dev, …) with a configurable definition and
  permission set.
- **Storage plugin / backend** — a swappable implementation of the source-of-truth
  interface (Jira, filesystem, other).
- **Checkpoint** — a human-oversight gate modeled as a dependent subtask; overrides
  autocompletion.
- **Autocompletion** — condition-gated completion of work without human sign-off.
- **Workflow** — a named scenario (complete / quick / bugfix / …) defining participating
  personas and steps.
- **Work unit** — the standard branch/work granularity: a Jira Story or Bug.
- **Orchestrator** — the PM persona that can query "what's ready" and dispatch work to other
  personas, subject to checkpoints.

---

*End of brief. Keep this current — it is the contract every persona and session relies on.*