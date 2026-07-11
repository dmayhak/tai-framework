# TAI Design Notes (working document)

> **Status:** Scratch / in-progress. This is a **temporary** discussion document, not a
> source of truth. `PROJECT_BRIEF.md` remains authoritative for anything settled.
> Findings here get integrated into the brief, `src/personas/*.md`, `src/workflows/*.md`,
> and `src/core/schema/story-schema.ts` once ironed out — then this doc is trimmed or
> retired. Don't cite this doc from code or from the brief; cite the destination instead.
>
> **How we're working through this:** one topic at a time, in the order below, in
> conversation — not all at once. This file accumulates the conclusions as we go so
> nothing gets lost between sessions. Items are visited from multiple deliberate angles
> (e.g. "spike ownership" shows up under Personas, Subtask Types, and Humans) — that's
> intentional, not duplication to clean up.

---

## Cross-cutting conventions (confirmed; now integrated into brief §3.9, rev 11)

**Comment resolution tracking — applies framework-wide, not tied to any one persona or
workflow.** Surfaced during the PM/WBS discussion below, but the convention itself is
general:

- A comment posing an open question is prefixed `Q:`.
- Jira's **native reply-to-comment threading** keeps related discussion together — no
  separate quote-matching scheme needed; the reply relationship itself gives the linkage.
- A thread is **closed** once a terminal comment (e.g. "Resolved" — exact wording/marker
  still a detail to nail down) appears within it. This is the authoritative signal, not
  merely the presence of *any* reply — a thread can have several rounds of back-and-forth
  before actually being settled.
- TAI's own comment-scanning logic determines this when regenerating a briefing (brief
  §3.6) — not a native Jira feature (plain Jira issue comments don't have a built-in
  resolved/unresolved flag the way Confluence inline comments do), consistent with brief
  §3.3's "TAI's own plugin layer is the enforcer" philosophy.
- **Separate, not the same problem:** "new since last looked" vs. "already seen" is pure
  notification churn — solved by extending the existing cachedAt/lastUpdated comparison
  (§3.6/§7) to track the last comment already surfaced. This is orthogonal to whether a
  question is actually *resolved*.
- **Integrated (§7, rev 11):** now formalized in `PROJECT_BRIEF.md` §3.9, including the
  extension to Confluence comments (page-level and inline) and the "fresh re-scan, not
  cached" rule for human-deletable comments. §8 (unit of work, 8c1) still gets to decide
  the mechanics of *when during a unit of work* comments get re-read, not revisited here.

**Review-gate approval tracking — also framework-wide, symmetric with the `Q:` convention
above.** Surfaced during the Kickoff story-type review (§2), but applies to any
`ReviewGate` in the schema (`REVIEW_GATES`), not just Kickoff's PM+UX gate:

- Each required reviewer posts a comment prefixed `Approved:` (optionally followed by
  notes) once they sign off.
- **No custom Jira field** — TAI's plugin layer scans for one `Approved:` comment from
  each persona listed in that gate's `requiredReviewers` before allowing the gate to
  pass (brief §3.3 — TAI's own plugin layer is the enforcer, not native Jira validators).
- Consistent with the `Q:` convention: human-readable, no Jira admin provisioning
  required, same "TAI scans comments" enforcement model.
- **Updated (§5, rev 11):** the commenting human must also hold that persona's Jira
  Project Role (brief §5.6, the human registry) — this is what lets an `Approved:`
  comment actually be verified as coming from someone authorized to act as "the PM" or
  "the UX Designer," not just anyone typing the marker text.
- **Updated (§7, rev 11):** applies to Confluence comments too (page-level and inline),
  not just Jira issue comments — see §7 tracker below for the "why not the native resolve
  checkmark" research finding. Integrated into `PROJECT_BRIEF.md` §3.9.

**Marker-with-inference-fallback — refinement surfaced during the Story review (§2),
for the UAT rejection-routing case specifically.** A human can't be relied on to
reliably type a structured marker (e.g. `Rejected: Dev` / `Rejected: Requirements`)
every time. **Pattern:** prefer the structured marker when present; when absent, TAI
reads the actual comment text and infers intent, escalating to the human for
clarification only if the comment doesn't give enough signal either way. Currently
scoped to UAT rejection (`workflows/story.md`) — not yet generalized to `Q:`/`Approved:`,
but likely the same underlying pattern would apply if those markers are ever missed too.
**Integrated (§7, rev 11):** now formalized alongside `Q:`/`Approved:` in
`PROJECT_BRIEF.md` §3.9.

---

## Already resolved and integrated (not re-litigated here)

These came out of the D1–D15 round and are already live in the main docs — listed here
only so we don't accidentally reopen them while working through the sections below.

- **D1** Kickoff review gate stays fixed at PM + UX Designer; Architect never required. →
  `workflows/kickoff.md`, schema.
- **D2** No `Feasibility`/`Database`/`Infra` under Kickoff; a technical question during
  discovery spawns a Spike story afterward. → `workflows/kickoff.md`, `personas/dba.md`,
  schema.
- **D3** Reopen/retest count derived from Jira transition history on demand, no counter
  field. → `workflows/story.md`.
- **D4** Failed test subtask returns to plain `Open`, not a distinct `Ready for Retest`. →
  `workflows/story.md`, `personas/tester.md`.
- **D6** Bug never requires a Kickoff-style gate; Triage sign-off is always sufficient. →
  `workflows/bug.md`, schema.
- **D10** A Spike does not always spawn a Story — it can conclude as a Story, Confluence
  page(s), or a cancelled/deferred initiative; the investigating persona proposes the
  outcome, PM confirms it. Spike's specific case is fully resolved (§2 Spike tracker);
  the broader D9 output-taxonomy question (what *every* ticket type produces) stays open.
  → `workflows/spike.md`.
- **D8** Spike ownership: PM is the default story-level owner (uniform with
  Kickoff/Story/Bug), distinct from the raiser's scoping authority. Subtask-level
  ownership was already unambiguous (`Feasibility`/`Database`/`Infra` have fixed owners;
  the ad-hoc `Spike` subtask has no fixed owner, assigned at creation). → `workflows/spike.md`.
- **D11** `RelatesTo` creates a real Jira link, gated by "does B materially help complete A
  more efficiently" (not blanket linking); traversal is **one hop only**. →
  `workflows/dependencies.md`.
- **D13** A late-arriving precedence edge (target already In Progress/Done) creates/adjusts
  the link **and flags it**. → `workflows/dependencies.md`.
- **D14** Artifacts (wireframes, flows, images, diagrams) live as Confluence pages, linked
  to tickets at the right level, embeddable in the PRD — no dedicated storage-layer
  `design` type. → `personas/ux-designer.md`.

---

## Parking lot — harder items, mapped to where they'll get resolved

These are **not decided yet**. Each is genuinely multi-angle, so rather than resolve them
in isolation, they're tied to the section(s) below where they'll actually get worked.

| Item | What's open | Resolve during |
|---|---|---|
| **D5** | ~~Severe/hotfix Bug expedited path~~ — **RESOLVED**, see §2 Bug tracker below. | §2 (Bug story type) — done |
| **D7** | ~~PostDeploy failure: minor → spawn linked Bug; major/showstopper → rollback~~ — **RESOLVED**, see §3 Deploy/PostDeploy tracker below. | §3 (subtask types) — done |
| **D8** | ~~Spike ownership model~~ — **RESOLVED**, see §2 Spike tracker below. | §1/§3/§5 — done |
| **D9** | ~~Output taxonomy generalization~~ — **RESOLVED**, see §3 D9 tracker below (prose documentation is sufficient; no formal `OutputType` schema construct). | §3 (subtask types — outputs) — done |
| **D12** | ~~Test tiers sequential vs. parallel, and tier applicability~~ — **RESOLVED**, see §3 test-tiers tracker below. | §3 (Test subtask types) — done |
| **D15** | ~~PostDeploy ownership + the two-axis owner model~~ — **RESOLVED**, see §5 tracker below. PostDeploy has a default owner (DevOps), overridable per instance (`SUBTASK_OWNER`) — **not** "no default owner, assigned at creation" like Spike; a stale note claiming otherwise was found and fixed during §3 (see `schema/story-schema.ts` TODO #2, DevOps tracker below). The bigger question — **human Assignee vs. persona-routing are two different axes** — is now resolved via an explicit stored `persona` field (§5.6). | §5 (Humans) — done |

### The two-axis "owner" model — RESOLVED, see §5 tracker below

Jira **Assignee = a human** (brief §5.5) — but personas ≠ humans 1:1 (one person can run
many personas, and hold more than one persona's Project Role). **Resolved (rev 11):**
split into **(a) human Assignee** (native Jira, unchanged) and **(b) a `persona` field**
stating which persona is being acted in for this ticket, defaulting from `SUBTASK_OWNER`
(subtasks) or PM (story-level) but always overridable, and **nullable only for the ad-hoc
`Spike` subtask** (no default, set explicitly at creation — same as it has no default
human Assignee). A stored field, not derived from Project Role membership, precisely
because a human can hold more than one relevant role. See §5 (Humans) for the full
write-up, including the new human-registry mechanism (Jira Project Roles) and the
assignment-helper this unlocks.

---

## 1. Personas (one at a time)

For each persona, work through:
- **1a.** Purpose, personality — refine the actual `.md` prompt file.
- **1b.** What ticket types can they work on?
- **1c.** Outputs, by ticket type.
- **1d.** What does this persona *unblock*, by ticket type?

Roster to work through (brief §3.1, now 9 with UX Designer): Analyst, PM, UX Designer,
Architect, DBA, Code Reviewer, Developer, Tester, DevOps.

*(Added question, optional: what happens when a persona is disabled (brief §3.1 allows
this) — does its ticket types just have no eligible worker, or does something else own
them by default?)*

**Working note on process:** conclusions below get integrated directly into the relevant
`.md`/schema files as each point is confirmed (not batched to the end) — this doc tracks
*that it happened and where*, not a staging draft of the prose itself.

### Analyst (Ada) — in progress

Resolved and integrated:
- `Investigate` added to `SubtaskType` enum (it never existed there — a real gap, not just
  a missing map entry) and to `STORY_SUBTASK_MAP` for both `Story` and `Bug`. →
  `schema/story-schema.ts`, `personas/analyst.md`.
- Permission verb split: Ada holds `propose` (not `create`) for Epic/Story — PM is the only
  persona with actual `create`. Fixes a real overlap where both files granted `create` for
  the same ticket types with no enforceable distinction. → `personas/analyst.md`.
- Added missing `Subtask:Research` to Ada's permission block (flagged in 1b, fixed here).
- **Analyst output is always a Confluence doc**, at whatever level the work is scoped to.
- New pattern: **PM creates the initial Jira shell** (Epic + Kickoff Story) to start a new
  initiative — the one point PM creates *before* any Analyst output exists. Ada's `Research`
  subtask is the first substantive work inside that shell, producing a **work-breakdown**
  Confluence doc attached to the Kickoff Story, proposing the initial Epic/Story
  decomposition. → `personas/pm.md`, `personas/analyst.md`, `workflows/kickoff.md`.
- **No default Analyst role in Spike scoping.** A Spike is scoped to the raiser's specific
  question; Ada only participates if explicitly asked or assigned a subtask. →
  `workflows/spike.md`.
- Confirmed: `Research` unblocks `Requirements` + `UxDesign` in parallel — already matched
  the schema (`SUBTASK_PRECEDENCE[Kickoff]`); no change needed.

**Analyst (Ada) — closed.** All four follow-up questions resolved.

### PM (Perry) — in progress

**Subtask WBS at story-creation time** — resolved shape, sub-questions still open:
- The Epic→Story split (business/feature-shaped, Ada-proposes/PM-creates) and the
  Story→Subtask split (technical/implementation-shaped) are **two different levels**,
  owned by different personas at each stage — not a single "who owns the breakdown"
  question. This wasn't a new invention: `architect.md`/`dba.md`/`devops.md` already give
  each of those personas the judgment call on whether their subtask type applies to a
  given Story; it was just exercised *reactively* (discovered as work progresses).
- **Decided:** Ada's decomposition doc feeds **Architect, DBA, DevOps** — each assesses,
  per proposed Story, whether their subtask type applies. That assessed set is the WBS
  content; **PM then creates** the Story tickets with that initial subtask set attached
  (Perry proposes/assembles, Architect et al. confirm the technical content — mirrors the
  `propose`/`create` split already used for Ada/PM).
- **Decided:** `UxDesign` is now a valid Story-level subtask too (not just Kickoff) — for
  detailing/tweaking beyond Kickoff's higher-level flows, or a smaller Story-scoped design
  doc when Epic-level granularity isn't the right fit. Gates `Dev`, same as its siblings.
  Not valid on Bug. → schema, `workflows/story.md`, `workflows/dependencies.md`,
  `personas/ux-designer.md`.
- Also fixed in passing: `Investigate` was added to the schema/Analyst review earlier but
  never made it into `workflows/story.md`'s or `bug.md`'s subtask tables — added now.

**WBS assembly — fully resolved:**
1. **Independent scan** — each technical persona (Architect/`ArchitectureDesign`,
   DBA/`Database`, DevOps/`Infra`, UX Designer/Story-level `UxDesign`) reviews the whole
   proposed Story list on its own, for its own subtask type only. Not a joint pass.
2. **Informal** — no new subtask type or ticket-level artifact for the scan itself.
3. **Batch, at the end of Kickoff** — happens as part of PM's existing "Issue creation"
   step (after the PM+UX review gate passes, before the Story/Spike tickets are created).
   Necessarily a batch pass, since individual Story tickets don't exist yet at this point —
   they're the *output* of this step, not something to scope a per-Story pass to.
4. **Where it attaches:** the WBS content lives on the **same Kickoff Story ticket** as
   Ada's work-breakdown doc — either an extension of that same Confluence page or a
   sibling page linked to the same ticket (exact granularity is a §6 question).
5. **Q&A mechanism:** clarifying questions during this scan use the framework-wide comment
   convention above (`Q:`/native threading/closing resolution comment) — not a dedicated
   sibling doc for this case (that idea was floated and set aside in favor of comments).

→ Integrated into `personas/pm.md`, `workflows/kickoff.md`, `personas/architect.md`,
`personas/dba.md`, `personas/devops.md`, `personas/ux-designer.md`.

Still open on PM (asked one at a time, per user's request):
- **Resolved:** brief §8.13, first half. Three non-exclusive triggers can flag a Story as
  needing `Investigate` — human manually, PM (Orchestrator) while querying what's ready, or
  Ada self-flagging during other work. Whoever flags it, **Ada always creates the actual
  subtask** — the flagger never creates it on her behalf. §8.13's other half ("what marks a
  Story ready for implementation") stays open. → `PROJECT_BRIEF.md` §8.13, `personas/pm.md`,
  `personas/analyst.md`.
- **Resolved:** both paths are valid, not exclusive — a human can file a Bug directly
  (brief §3.8, the common case), and Perry can also create one if asked to on a human's
  behalf. Unlike Epic/Story/Spike, Bug isn't decomposition-sourced from Ada's proposals. →
  `personas/pm.md`, `workflows/bug.md`.

**PM (Perry) — closed.** All three follow-up questions resolved.

*Addendum (found during §2 Kickoff review):* two more stale-doc-drift bugs in `pm.md` —
the `kickoffGateRequiresJointApproval` front-matter comment still said "not in brief (see
gap note)" (same fix already applied to `ux-designer.md`), and the Handoff section still
posed "open question... whether Architect should also join this gate" even though D1
already decided the gate stays fixed at PM+UX always. Both fixed. → `personas/pm.md`.

### UX Designer (Uma) — in progress

Resolved and integrated:
- **Stale front-matter cleaned up.** `ux-designer.md`'s "GAP" notes (persona not in
  brief's roster; joint gate not in brief) were already resolved by brief rev 10 (§3.1
  roster table, §3.5 gate description) — removed the stale comments, no design change.
- **Kickoff precedence gap found and fixed:** Uma's doc says flows and requirements
  "are expected to converge before the Architect finalizes any design," but
  `SUBTASK_PRECEDENCE[Kickoff]` only had `Requirements → ArchitectureDesign`, no
  `UxDesign → ArchitectureDesign` edge — so ArchitectureDesign could complete before UX
  flows existed. **Decided:** add the `UxDesign → ArchitectureDesign` edge; when
  ArchitectureDesign is used during Kickoff it now waits on both Requirements and
  UxDesign. → `schema/story-schema.ts`, `workflows/kickoff.md`.
- **Wireframe output gap found and fixed:** the Outputs section named `ux-flow` and
  `wireframe-index` but nothing for the actual wireframe/mockup pages the index is
  supposed to point at. **Decided:** each wireframe/mockup gets its own Confluence page
  (`wireframe` output type, distinct from embedding images in the flow doc); the existing
  `wireframe-index` page ties the set together and is what the flow doc/ticket link to. →
  `personas/ux-designer.md`.

**UX Designer (Uma) — closed.** Both follow-up findings resolved.

### Architect (Aria) — in progress

Resolved and integrated:
- **Outputs/Handoff gap found and fixed:** front matter declared a `design-review-notes`
  output type and "when invoked" item 5 already described `DesignReview` pass/fail
  behavior, but the Outputs and Handoff sections never actually documented it (unlike
  Cole's parallel `CodeReview` structure). Added the missing output description and
  pass/fail handoff bullets — no new design decision, just closing a doc-completeness
  gap against behavior already decided in `workflows/story.md`. → `personas/architect.md`.
- **Schema TODO #6 resolved:** Kickoff-stage `ArchitectureDesign` stays **ungated** — no
  `DesignReview` under Kickoff. It's early/exploratory technical input, not a committed
  design; real design rigor applies later once the Story exists. Consistent with the
  existing pattern of keeping Kickoff's subtask set lean (Feasibility/Database/Infra
  already excluded). Moved from TODO into the RESOLVED block. → `schema/story-schema.ts`.
- **Confirmed: one ADR per `ArchitectureDesign` subtask, no `adr-index` type.** Considered
  mirroring the wireframe/wireframe-index split just made for Uma, but decided against —
  if a Story needs multiple distinct architecture decisions, that's multiple
  `ArchitectureDesign` subtasks, not one subtask producing many ADRs. No change made.

**Architect (Aria) — closed.** All follow-up findings resolved.

### DBA (Dana) — in progress

Resolved and integrated:
- **Stale front-matter/Role note cleaned up (same pattern as Uma's GAP note):**
  `dba.md` described the `Database` routing type as resolving an "UNRESOLVED" brief gap
  (§5.2 gap #1/§8.16) — but brief rev 10 already marks this **Resolved**. Same stale note
  found in `devops.md` for `Infra`/`Deploy`/`PostDeploy` — fixed both, no design change.
  → `personas/dba.md`, `personas/devops.md`.

Everything else checked cleanly against the schema: `Database` correctly scoped to
Spike/Story/Bug (excluded from Kickoff, matching the "spawn a Spike instead" pattern),
`Database → Dev` precedence present for both Story and Bug, outputs
(`schema-notes`/`migration-plan`) match front matter.

**DBA (Dana) — closed.**

### DevOps (Duncan) — closed

Stale front-matter note fixed alongside DBA's (see above) — no other findings. `Infra`/
`Deploy`/`PostDeploy` routing, Story/Bug/Spike subtask scoping, and precedence edges all
checked out clean against the schema. D7 (Rollback modeling) and D15 (PostDeploy
ownership axis / two-axis owner model) remain parked for §3/§4 as originally planned —
not pulled forward.

### Developer (Dario) — in progress

Resolved and integrated:
- **Missing `create: Subtask:Dev` found and fixed.** Every other persona's permission
  block lists `create` for its own core subtask type (Cole→CodeReview, Dana→Database,
  Duncan→Infra/Deploy/PostDeploy, Tessa→her test types); Dario's `create` list only had
  the ad-hoc `Subtask:Spike`, missing `Subtask:Dev` itself. Added it. → `personas/developer.md`.

**Developer (Dario) — closed.**

### Tester (Tessa) — in progress

Resolved and integrated:
- **Stale front-matter note fixed (same pattern as Uma/DBA/DevOps):** claimed UAT was
  "not represented in these files" despite the file fully modeling it
  (create/workOn/alwaysHumanGated + `uat-plan`). Rewritten to reflect reality.
- **Outputs/Handoff gap found and fixed (same pattern as Architect's DesignReview):**
  `uat-plan` was declared as an output type and described in "when invoked," but never
  covered in the Outputs section; Handoff never described UAT pass/fail routing even
  though it's decided behavior (`workflows/story.md` — "UAT gate"). Added both.
- **Numbering typo:** "When this persona is invoked" had two items labeled "3." — fixed.
→ `personas/tester.md`.

Everything else checked out clean: `IntegrationTest`/`SystemTest`/`E2ETest`/`Triage`
scoping (Story vs. Bug), `Uat` owner + `ALWAYS_HUMAN_GATED_SUBTASKS` membership, and
precedence edges all match the schema.

**Tester (Tessa) — closed.**

### Code Reviewer (Cole) — closed

No findings — already the cleanest file in the roster (Architect's `DesignReview`
explicitly mirrors it). `CodeReview` scoping, precedence edges, outputs, and Handoff
section all checked out against the schema with nothing to fix.

---

**Section 1 (Personas) — closed.** All 9 personas reviewed: Analyst, PM, UX Designer,
Architect, DBA, DevOps, Code Reviewer, Developer, Tester. Next up per the suggested order
of attack: **Section 2 — Story/Task ticket types** (Kickoff, Story, Bug, Spike).

## 2. Story/Task ticket types (one at a time)

Types: Kickoff, Story, Bug, Spike (brief §5.1/§8.1).

- **2a.** Purpose (its `.md` prompt/doc).
- **2b.** Outputs.
- **2c.** What it unblocks/enables.
- **2d.** What subtask types can it have (fleshed out in §3).
- **2e.** Who can work on it — allowed vs. default.
- **2f.** Custom fields needed.
- **2g.** Status transitions.
- **2h.** Naming convention — prefix/postfix.
- **2i.** Humans may change the ticket in unforeseen ways (relates to §7 cache/conflict
  handling).

*(Added question: does Epic itself carry any process/oversight of its own — an "Epic
kickoff," a review point — or is it purely a container with no lifecycle beyond
priority/description, per brief §5.1?)*

### Kickoff — in progress

- **2a-2d already resolved**, cross-checked against schema during §1: purpose (discovery/
  requirements/UX before implementation), outputs (work-breakdown doc, PRD, UX flows,
  optional architecture notes, subtask WBS, Story/Spike tickets), what it unblocks
  (Story/Spike ticket creation post-gate), subtask types (`Research`/`Requirements`/
  `UxDesign`/optional `ArchitectureDesign`). No changes needed — see `workflows/kickoff.md`.
- **2e-2i are new ground**, not yet designed for any story type — the schema has no
  concept of story-level ownership, custom fields, status enums, or naming conventions
  yet. Working through these now, one at a time.
- **2e resolved:** **PM is the default story-level owner/driver of the Kickoff Story**,
  distinct from each subtask's own persona owner — consistent with PM's Orchestrator
  role; Jira Assignee on the Kickoff Story itself defaults to PM. → `workflows/kickoff.md`.
  *Open follow-up:* does this "PM owns the story-level ticket" pattern generalize to
  Story/Bug/Spike too, or does story-level ownership shift once past Kickoff (e.g. to
  whoever's driving the active subtask)? Revisit when reviewing those story types —
  not assumed here.
- **2f resolved:** the PM+UX review-gate sign-off is tracked via an `Approved:`-prefixed
  Jira comment from each required reviewer, no custom field — symmetric with the `Q:`
  convention. Generalized to a framework-wide convention (applies to any future
  `ReviewGate`, not just Kickoff's). → `workflows/kickoff.md`, `schema/story-schema.ts`,
  cross-cutting conventions section above.
- **2g resolved:** story-level status flow is `Open → In Progress → In Review → Done`.
  → `workflows/kickoff.md`.
- **2h resolved (general rule, not Kickoff-specific):** no enforced title prefix — Jira's
  native issue-type field already carries the type signal. Expected to apply to
  Story/Bug/Spike too; confirm rather than assume when reviewing those. →
  `workflows/kickoff.md`.
- **2i resolved (general rule, not Kickoff-specific):** a human-added subtask type
  outside `STORY_SUBTASK_MAP[Kickoff]` gets **flagged on refresh, not blocked or
  auto-removed** — same "create/adjust and flag" posture as D13. Expected to generalize
  to Story/Bug/Spike. → `workflows/kickoff.md`.

**Kickoff — closed.** All of 2a-2i resolved.

### Story — in progress

- **2a, 2d already resolved** (purpose, subtask types) — cross-checked against schema
  during §1, no changes.
- **2b gap found and fixed:** unlike Kickoff, `story.md` had no `## Output` section.
  Drafted one — a Story's output is the aggregate of whichever subtasks are present
  (code, ADR/schema/infra/UX docs, review notes, test results, UAT sign-off, deploy
  runbook), not a single story-level artifact like Kickoff's PRD/WBS batch. →
  `workflows/story.md`. No open question here — mechanical fix, not a new decision.
- **2c:** what a Story unblocks is already covered generally by Layer 1 story-level
  `StoryDependency` (`DependsOn`/`RelatesTo`) in `workflows/dependencies.md` — not
  Story-type-specific, nothing to add here.
- **2e resolved:** PM stays the story-level owner/driver throughout a Story's lifecycle,
  same as Kickoff — doesn't rotate to whichever subtask-owning persona is currently
  active. → `workflows/story.md`.
- **2f resolved:** UAT sign-off is the human transitioning the subtask to Done directly
  (no comment needed — the transition itself is the human-only signal). Rejection
  routing (Dev vs. Requirements) prefers a `Rejected: Dev`/`Rejected: Requirements`
  marker but **falls back to TAI inferring intent from the comment text** when the
  marker's missing, escalating only if genuinely ambiguous — humans can't be relied on
  to type structured markers reliably every time. New cross-cutting pattern
  (marker-with-inference-fallback). → `workflows/story.md`, cross-cutting conventions
  section above.
- **2g resolved:** `Open → In Progress → Done`, no "In Review" (Story has no single
  whole-story gate the way Kickoff does). In Progress covers the whole subtask chain
  including failure loops; loops don't regress story-level status. → `workflows/story.md`.
- **2h/2i confirmed as general rules, unchanged from Kickoff:** no title prefix; human
  out-of-taxonomy subtask additions get flagged on refresh, not blocked. No Story-specific
  doc changes needed.

**Story — closed.** All of 2a-2i resolved.

### Bug — in progress

- **2a, 2d already resolved** (purpose, subtask types) — cross-checked against schema
  during §1, no changes.
- **2b gap found and fixed:** same missing `## Output` section as Story had — drafted,
  same shape (aggregate of present subtasks), with Triage notes replacing Kickoff's
  Research/PRD/UX trio as the front-door artifact. → `workflows/bug.md`. Mechanical fix,
  not a new decision.
- **2c:** same as Story — covered generally by Layer 1 `StoryDependency`, nothing
  Bug-specific to add.
- **2e resolved:** PM stays the default story-level owner for Bug too, same as
  Kickoff/Story — kept uniform even though most Bugs are filed directly by a human, not
  through PM. → `workflows/bug.md`.
- **D5 resolved (was parked here):** a Bug with native Jira **Priority=1
  (Urgent/Emergency)** — the user's existing real-world convention for flagging a rush
  job, not a new custom field — gets an expedited path: test tiers compress to just
  `IntegrationTest` (others skipped, overridable), `CodeReview`/`Deploy`/`PostDeploy`
  stay mandatory regardless. **Not yet implemented** in `SUBTASK_PRECEDENCE`/the resolver
  functions (still priority-unaware) — tied to TODO #5 (test-tier conditionality
  rework), left as a documented decision pending that implementation work. →
  `workflows/bug.md`, `schema/story-schema.ts`.
- **2f resolved:** `Bug.severity` (impact) and Jira's native `Priority` (urgency) are
  **two different axes**, both set during Triage — they correlate but aren't the same
  field; `Priority=1` specifically triggers the D5 expedited path. → `workflows/bug.md`.
- **2g resolved:** same 3-state flow as Story (`Open → In Progress → Done`), no distinct
  pre-Triage "Reported" state. → `workflows/bug.md`.
- **2h/2i confirmed as general rules, unchanged from Kickoff/Story:** no title prefix;
  human out-of-taxonomy subtask additions get flagged on refresh, not blocked.

**Bug — closed.** All of 2a-2i resolved.

### Spike — in progress

Unlike the other three, `spike.md` was explicitly flagged "Not yet finalized" with three
real open design questions parked here (D8, D9/D10, plus origin points) — resolved all
of them as part of 2a-2i:

- **2a, 2d already resolved** (purpose, subtask types) — cross-checked against schema
  during §1, no changes.
- **2e / D8 resolved:** PM stays default story-level owner, uniform with
  Kickoff/Story/Bug — distinct from the **raiser's scoping authority** (whoever needs
  the answer decides what the Spike investigates). Two different things, not in
  tension. Subtask-level ownership was already unambiguous. → `workflows/spike.md`.
- **2c resolved (Origin points):** a Spike behaves identically regardless of what
  spawned it (Kickoff/Epic/Story-Bug) — same subtask types, same outcome taxonomy, no
  origin-specific review requirement. Origin only affects where output links back to.
  → `workflows/spike.md`.
- **2b resolved (Outcome handling, D10 completed):** the investigating persona
  **proposes** the outcome (new Story / Confluence-only / cancelled-deferred) in their
  conclusion doc; **PM confirms** it — mirrors the propose/create split used for Ada's
  decomposition. D9's broader output-taxonomy question stays open generally; only
  Spike's specific case is resolved. → `workflows/spike.md`.
- **2g resolved:** same 3-state flow as the others (`Open → In Progress → Done`).
- **2h/2i confirmed as general rules, unchanged:** no title prefix; human
  out-of-taxonomy subtask additions get flagged on refresh, not blocked.
- Restructured `spike.md` to match the other three workflow docs' shape (dropped
  "Draft"/"Not yet finalized" framing now that everything's resolved; added proper
  `## Output`/`## Status Transitions`/`## Naming Convention`/`## Human Overrides`
  sections).

**Spike — closed.** All of 2a-2i resolved, plus D8 and D10 fully closed out.

---

**Section 2 (Story/Task ticket types) — closed.** All 4 story types reviewed: Kickoff,
Story, Bug, Spike. Next up per the suggested order of attack: **Section 3 — Subtask
ticket types.**

---

## 3. Subtask ticket types (one at a time)

Types (current, brief §5.2, rev 10): Research, Requirements, UxDesign, Investigate,
Feasibility, ArchitectureDesign, DesignReview, Database, Infra, Dev, CodeReview,
IntegrationTest, SystemTest, E2ETest, UAT, Triage, Deploy, PostDeploy, Spike (ad-hoc).
No **Rollback** type (D7, resolved below — handled by reopening `Deploy`, not a new type).

- **3a.** Purpose.
- **3b.** Outputs.
- **3c.** What it unblocks/enables.
- **3d.** Who can work on it — allowed vs. default (ties to D8/D15/two-axis model).
- **3e.** Custom fields needed.
- **3f.** Status transitions.
- **3g.** Naming convention — prefix/postfix.
- **3h.** Humans may change the ticket in unforeseen ways (relates to §7).

### Cross-cutting resolutions (apply to every subtask type, not re-litigated per type)

Much of 3a-3d was already answered during §1 (persona review) and §2 (story-type review),
cross-checked against the schema at the time — purpose, outputs, and unblock effects are
already documented per type in `personas/*.md` and `workflows/*.md`. What's genuinely new
in §3 is 3e-3h, and three of those four resolve the same way for every subtask type:

- **3e resolved — no time-box/estimate custom field, for any type.** Time-boxed work
  (`Feasibility`, the ad-hoc `Spike` subtask) uses Jira's own native Original Estimate/Time
  Tracking field if a team wants one — consistent with reusing `Priority` rather than
  inventing a field for the Bug D5 expedited path. → `PROJECT_BRIEF.md` §5.2.
- **3g resolved — no title prefix, for any subtask type; each `SubtaskType` maps to its
  own native Jira sub-task issue type**, provisioned by a Jira admin the same way Kickoff/
  Spike already assumed a custom **Story**-level issue type. This is what makes 2h's
  "the issue-type field carries the signal" reasoning apply at the subtask level too. →
  `PROJECT_BRIEF.md` §5.2.
- **3f — default subtask lifecycle is `Open → In Progress → Done`**, mirroring story-level
  (2g). Per-type loop-backs are already documented where they exist (Dev ⇄ Test →
  `workflows/story.md`; ArchitectureDesign ⇄ DesignReview → same; UAT rejection routing →
  same) — nothing new to add generically here, just confirming the default for types with
  no special loop.
- **3h resolved — same "flag on refresh, don't block/revert" posture as 2i/D13.** A human
  transitioning a subtask directly in Jira in a way that skips an unmet precedence rule (or
  reassigning it to an unexpected persona/human) isn't blocked or auto-corrected — TAI
  flags it on the next refresh (comment/journal note) and moves on, consistent with the
  framework's "TAI's plugin layer enforces before *our* calls, but a human working directly
  in Jira can always do what Jira itself permits" stance (brief §3.3/§4).

### Research / Requirements / UxDesign / Investigate — closed

3a-3d already resolved (purpose, outputs, unblocks, fixed owners — Analyst/PM/UX Designer/
Analyst respectively) via §1/§2, no changes needed. 3e-3h resolved by the cross-cutting
items above. Nothing type-specific left open for these four.

### Feasibility / ArchitectureDesign / DesignReview — closed

3a-3d already resolved via §1 (Architect review) and §2 — purpose, outputs
(`feasibility-assessment`/`adr`/`design-review-notes`), unblocks (`DesignReview` gates
`Dev`; `ArchitectureDesign` also gates `Dev` directly when no `DesignReview` present), and
scoping (`Feasibility` is Spike-only per `STORY_SUBTASK_MAP`; `ArchitectureDesign` valid on
Kickoff-optional and Story-optional, not Bug/Spike; `DesignReview` valid on Story only) all
checked out clean against the schema, no changes needed. 3e-3h resolved by the
cross-cutting items above.

Confirmed, not reopened: `DesignReview`'s "should not review own `ArchitectureDesign`"
rule is a **soft default** (persona-doc language, not a schema-enforced distinct-assignee
check) — the scope of the underlying "same persona can't approve own work" rule (brief
§8 item #3) was expected to resolve alongside §5's two-axis owner model, but §5 ended up
settling only the Assignee-vs-`persona`-field question, not this specific self-approval
scope (same human / same persona instance / both). **Correction: still genuinely open**
— brief §8 item #3 remains unresolved, not re-litigated in this pass.

### Database / Infra — closed

3a-3d already resolved via §1 (DBA/DevOps review) — purpose, outputs (`schema-notes`/
`migration-plan`, `infra-notes`), unblocks (both gate `Dev` in parallel with
`ArchitectureDesign`, no sequencing between them), and scoping (valid on Spike/Story/Bug,
excluded from Kickoff per the "spawn a Spike instead" rule) all checked out clean, no
changes needed. 3e-3h resolved by the cross-cutting items above — nothing type-specific.

### Dev / CodeReview — closed

3a-3d already resolved via §1 (Developer/Code Reviewer review, Cole's file had zero
findings) — purpose, outputs, unblocks (`Dev → CodeReview → test tiers`), scoping (both
Story/Bug only, not Kickoff/Spike) all checked out clean. 3f-3h resolved by the
cross-cutting items above.

**3e — brief open item #4 resolved here** (multi-repo `repo` tracking, previously
undecided, squarely a "custom fields needed" question for `Dev`/`CodeReview`/`Deploy`/
`PostDeploy`, since brief §4 already established "a subtask targets exactly one repo"):
- **Native Jira Component field**, not a custom `repo` field — reuses existing Jira
  mechanics rather than provisioning a new one.
- **Populated by deriving the repo from a commit's Jira-key prefix** (§6's existing
  "commits begin with the issue key" convention), **with manual fallback** — a human or
  persona can set/correct it before any commit exists yet, or if derivation can't resolve
  it.
→ `PROJECT_BRIEF.md` §4, §8 (item 4, now resolved).

### IntegrationTest / SystemTest / E2ETest / UAT — closed, D12 resolved

3a-3d already resolved via §1 (Tester review) and §2 — purpose, outputs (`test-plan`,
`uat-plan`), scoping (Story/Bug only), fixed owner (Tester, + human stakeholder co-signing
`UAT`). 3e-3h resolved by the cross-cutting items above.

**D12 resolved (both halves):**
1. **Ordering:** the three automated tiers run **sequentially by default** —
   `IntegrationTest → SystemTest → E2ETest`, cheapest/fastest first — not in parallel off
   `CodeReview` as originally modeled. Each tier keeps a direct `CodeReview` edge for when
   an earlier tier in the sequence is absent on a given instance (same coexistence pattern
   as `DesignReview`/`UAT`), so the chain collapses correctly regardless of which subset of
   tiers is present.
2. **Tier applicability:** whether a given tier applies to a Story/Bug at all stays a
   **per-instance judgment call** by whoever assembles the subtask set (Tester, typically)
   — same present-when-added pattern as `DesignReview`/`UAT`/`Database`/`Infra`. No formal
   rule engine.
→ `schema/story-schema.ts` (`SUBTASK_PRECEDENCE[Story]`/`[Bug]`, new tests in
`story-schema.test.ts`), `workflows/dependencies.md`, `personas/tester.md`. Schema TODO #5
(D5's priority-based tier compression) still needs actual resolver implementation — noted
as still-open, now simpler since tiers are already ordered.

### Triage — closed

3a-3d already resolved via §1 (Tester review) and §2 (Bug workflow) — purpose (confirm
repro/assess severity/root cause), outputs (`triage-notes`), unblocks (`Triage → Dev`),
scoping (Bug-only, the entry point replacing Kickoff's Research/Requirements/UxDesign
trio), fixed owner (Tester). `Bug.severity`/`Bug.reproSteps` custom fields already
established (brief §5.2, `personas/tester.md`). 3e-3h resolved by the cross-cutting items
above — nothing type-specific left.

### Deploy / PostDeploy — closed, D7 resolved; stale D15 note fixed

3a-3d already resolved via §1 (DevOps review) and §2 — purpose, outputs (`deploy-runbook`,
`infra-notes`), unblocks (`Deploy` gated by all present test tiers/`UAT`; `PostDeploy`
gated by `Deploy`), scoping (Story/Bug only), default owner (DevOps, overridable per
instance). 3e-3h resolved by the cross-cutting items above.

**Bug found and fixed while reviewing 3d:** schema TODO #2 and the D15 parking-lot row
both asserted "PostDeploy has no default owner, assigned at creation, same as Spike" —
this directly contradicts `SUBTASK_OWNER[PostDeploy] = Persona.DevOps` and brief §5.2's
own rev-10 resolution note ("a type may name a default owner that is overridable per
instance — Deploy/PostDeploy"). Same stale-doc-drift class as the earlier
Uma/PM/DBA/DevOps front-matter fixes in §1 — corrected in both places; no design change,
PostDeploy keeps its actual current behavior (default DevOps owner, overridable).

**D7 resolved (both halves), also closing the related open question in `bug.md`:**
1. **Major/showstopper PostDeploy failure:** **no new `Rollback` subtask/action type.**
   Reopens the existing `Deploy` subtask to In Progress — same "reopen, don't invent a new
   artifact" pattern as Dev ⇄ Test and ArchitectureDesign ⇄ DesignReview — and DevOps
   executes the rollback plan that's already part of `Deploy`'s own `deploy-runbook`
   output. `PostDeploy` also reopens, since its follow-up needs re-evaluating once the
   rolled-back `Deploy` completes.
2. **Minor PostDeploy failure:** spawns a linked Bug, **DevOps proposes/drafts it, PM
   confirms/creates it** — mirrors the propose/create split already used for Spike
   outcomes (`workflows/spike.md`) and Ada's decomposition, not fully automatic and not
   manual-only.
→ `schema/story-schema.ts` (TODO #2/#3 consolidated and corrected), `workflows/story.md`
(new "PostDeploy Failure Handling" section), `workflows/bug.md`, `personas/devops.md`.

### Ad-hoc Spike subtask — closed

3a-3d already resolved via D8 (§1/§2) — purpose (in-story investigation without a full
Spike story), outputs (conclusion doc, same shape as the Spike story's investigating
subtasks), no fixed unblock effect (set explicitly per instance, same reasoning as it
having no fixed owner), no fixed owner (`SUBTASK_OWNER[Spike] = null`, assignee set
explicitly at creation). 3e-3h resolved by the cross-cutting items above — including 3g:
it stays **one** native Jira sub-task issue type, not split into per-persona variants; the
human Assignee is simply set explicitly at creation regardless of which persona ends up
driving it.

**Update (§5, rev 11): now resolved, not parked.** What persona actually drives an ad-hoc
Spike subtask is the two-axis owner model's `persona` field (§5.6) — set explicitly at
creation, same as it has no default human Assignee either. Same resolution closes
`PostDeploy`'s parallel open item above (schema TODO #2).
→ `schema/story-schema.ts` (both former TODOs moved into the RESOLVED block).

---

### D9 — Output taxonomy generalization, resolved (closed, no formal schema construct)

**Resolved:** the existing prose documentation is sufficient — every subtask/story type's
output is already concretely documented (each persona's `confluenceOutputs` front-matter,
each workflow doc's `## Output` section, Spike's variable-outcome handling). **No formal
`OutputType` enum/schema construct is being added.** Rationale: nothing in the codebase
yet consumes "what kind of output is this" programmatically (no storage plugin, no
reporting layer — still Phase 0/1, brief §9) — adding a construct now would create a
second source of truth alongside each persona's front-matter, the same drift risk just
fixed for D15/PostDeploy above. Revisit if/when the storage plugin (Phase 3+) or a
reporting need actually requires querying output-kind in code rather than reading
prose — at that point, derive the construct from the already-settled per-type
documentation rather than inventing a new taxonomy from scratch.

→ `schema/story-schema.ts` TODO #5, updated to reflect this resolution.

---

**Section 3 (Subtask ticket types) — closed.** All types reviewed: Research,
Requirements, UxDesign, Investigate, Feasibility, ArchitectureDesign, DesignReview,
Database, Infra, Dev, CodeReview, IntegrationTest/SystemTest/E2ETest, UAT, Triage, Deploy,
PostDeploy, and the ad-hoc Spike subtask. D7 (Rollback modeling) and D12 (test tier
sequencing) — both explicitly parked for this section — and D9 (output taxonomy) are all
now fully resolved. Next up per the suggested order of attack: **Section 4 — Workflows**.

## 4. Workflows (one at a time)

- **4a.** Purpose (`.md` doc).
- **4b.** Steps.
- **4c.** Story type(s) involved:
  - **4c1.** Initial default subtask structure.
  - **4c2.** What can be added on the fly / as needed.
  - **4c3.** Dependencies between things.
- **4d.** Expected output per step.
- **4e.** Definition of done.
- **4f.** Who owns/oversees the process (Epic level, default story owner, etc.).
- **4g.** Are more workflows needed?

*(Added question: brief §3.5 names two senses of "workflow" — the scenario level
(complete/quick/bugfix) and the per-story-type process level (`workflows/*.md`). Do we
actually need distinct "quick"/"bugfix" **scenarios** on top of the Bug/Spike story types
that already exist, or did the story-type split already absorb that need?)*

### Added question resolved: no separate scenario-workflow layer

**Resolved:** there is only one sense of "workflow" — the per-Story-type process
(`workflows/*.md`). The scenario layer (`complete`/`quick`/`bugfix`) from brief §3.5 is
**dropped** — it turned out to already be absorbed:
- **"bugfix"** = `StoryType.Bug`, which already skips Kickoff-style discovery entirely.
- **"quick"** = a Story/Bug instance with fewer optional subtasks present — `DesignReview`/
  `UAT`/`UxDesign`/etc. are already **present-when-added** per-instance judgment calls
  (§3), not a separate config mode.
- **"complete"** = the full optional-subtask set being present.

Business-configurable "which roles are enabled, what each does" is still supported, just
as **persona configuration** (brief §3.1), not a distinct scenario layer on top.
→ `PROJECT_BRIEF.md` §3.5 (rewritten), glossary `Workflow` entry, §9 Phase 4+ line (removed
stale "Add workflows (quick, bugfix)" bullet).

### 4a/4c1/4c3/4d/4e/4f — already carried over from §2/§3, confirmed not re-litigated

The bulk of these were already answered while reviewing story types (§2) and subtask
types (§3), cross-checked against the schema both times:
- **4a (purpose)** and **4f (who owns it)** — each workflow doc's opening + "Who owns it"
  section (§2 2a/2e).
- **4c1 (initial default subtask structure)** — each workflow's Subtasks table (§2 2d,
  §3).
- **4c3 (dependencies between things)** — fully owned by `workflows/dependencies.md`
  (Layer 1 story-level, Layer 2 subtask-level precedence); not duplicated per-workflow.
- **4d (expected output per step)** — each workflow's `## Output` section (§2 2b) already
  covers this at the aggregate level; no per-step breakdown needed beyond what the
  Subtask Precedence graph already shows structurally.
- **4e (definition of done)** — each workflow's `## Status Transitions` `Done:` bullet
  (§2 2g) already defines this per story type.

**4b (steps)** is satisfied by the *combination* of each workflow's Subtasks table +
Subtask Precedence + Status Transitions sections — the precedence graph **is** the step
sequence, just expressed structurally (a DAG) rather than as a numbered narrative. No
separate step-by-step prose is needed on top of that; the graph is the source of truth
and a numbered list would just be prose that could drift out of sync with it.

### 4g resolved — brief open Q#1 closed: four story types is final for now

**Resolved:** **Kickoff / Story / Bug / Spike** stays the complete set — no new story
type is being added ahead of a real need. The taxonomy remains open/extensible by design
(brief §5.1/§5.2), so a business can add one later (e.g. a Chore/Maintenance type) if a
concrete gap actually shows up in practice, the same way subtask types can be extended.
Not inventing a hypothetical type now is consistent with the project's stated
"right-sized output, don't manufacture process for its own sake" principle
(`personas/analyst.md`).
→ `PROJECT_BRIEF.md` §8 (open question #1, now resolved).

---

**Section 4 (Workflows) — closed.** The scenario-vs-story-type terminology question is
resolved (no separate scenario layer; brief §3.5 rewritten), 4a/4c1/4c3/4d/4e/4f were
already carried over cleanly from §2/§3, 4b is satisfied by the existing
table+precedence-graph structure with no new prose needed, and 4g/brief Q#1 is resolved
(four story types stays final for now). Next up per the suggested order of attack:
**Section 5 — Humans** (this is also where the two-axis owner model / D15 finally gets
decided, not re-litigated further as a parked item).

## 5. Humans

- **5a.** How do we maintain a list of them?
- **5b.** What personas does each human access — all, or a preferred/scoped list?
- **5c.** Does TAI help the PM assign tickets to humans — how?
- **5d.** Who/how do we involve at human checkpoints/sign-offs?

*(Added question: the Atlassian MCP server authenticates as the actual human and respects
their real Jira/Confluence permissions (brief §3.2) — do we ever need to cache/reason
about what a given human is *permitted* to do, or is that entirely Jira's problem and TAI
just finds out when a call fails?)*

This is also where the **two-axis owner model** (human Assignee vs. persona-routing field)
gets decided — see Parking Lot above.

### 5a/5b resolved — human registry via native Jira Project Roles

**One Jira Project Role per persona** (Architect, Developer, DBA, PM, …). A human's
membership in a Project Role means they're authorized to act as that persona on this
project. A human can hold **multiple** roles — this was the user's own pushback during
D15 below, and it's exactly why a stored `persona` field (not derivation from role
membership) turned out to be necessary. Reuses Jira's native role/membership mechanism
rather than a separate TAI-maintained roster or a Confluence page — same "reuse native
Jira mechanics" pattern as `Component` for repo (§3) and native sub-task issue types for
`SubtaskType` (§3). TAI caches the membership list locally like everything else (§7).
→ `PROJECT_BRIEF.md` §5.6 (new).

### D15 resolved — the two-axis owner model, with an explicit `persona` field

Initial proposal (Parking Lot, above) was to derive "which persona is this" from Project
Role membership at read time, no stored field. **Rejected on user pushback:** since a
human can hold multiple Project Roles, derivation is ambiguous whenever they hold more
than one relevant role — effort/time-tracking rollup by persona (the original rationale
for `SUBTASK_OWNER` existing at all, see `schema/story-schema.ts` header) needs a
deterministic answer, not a "could be either" lookup.

**Resolved:** every Story-level ticket (Kickoff/Story/Bug/Spike) and every Subtask carries
**two distinct fields**:
1. **Native Jira `Assignee`** — the real human doing the work (unchanged, brief §5.5).
2. **A stored `persona` custom field** — which role they're acting in for *this specific
   ticket*. Defaults to `SUBTASK_OWNER[type]` for subtasks, or **PM** for story-level
   tickets (the already-established default-owner pattern) — always overridable, and
   **nullable only for the ad-hoc `Spike` subtask** (no default, set explicitly at
   creation, same as it already has no default human Assignee).

**Stale-doc fallout, fixed while integrating this:** `workflows/kickoff.md`/`story.md`/
`bug.md`/`spike.md` all previously said things like "Jira Assignee defaults to PM" or "PM
owns the story-level Jira Assignee" — this predates the two-axis split and directly
conflates persona with human Assignee (Assignee must be a real human, brief §5.5, not
literally "PM"). Corrected in all four to say the **`persona` field** defaults to PM;
Assignee is a separate field, a human holding the PM Project Role. Same conflation was
also present in `schema/story-schema.ts`'s `SUBTASK_OWNER` comment ("the assignee must be
set explicitly") — fixed there too.
→ `PROJECT_BRIEF.md` §5.6, `schema/story-schema.ts` (`SUBTASK_OWNER` comment,
`REVIEW_GATES` comment), `workflows/kickoff.md`/`story.md`/`bug.md`/`spike.md`.

### 5c resolved — the assignment-helper

When a ticket needs a human `Assignee`, TAI looks up which humans hold the Project Role
matching that ticket's `persona` field, and surfaces the candidates — plus lightweight
signals (open-ticket count per person, whether one already has a branch/related work in
flight) — to whoever is driving the PM/Orchestrator session. The human picks; **TAI then
performs the actual Jira `Assignee`-set call itself**, under the driving human's own
already-authenticated MCP session (brief §3.2) — no separate manual Jira login/assignment
step needed. A human can always reassign directly in Jira too — an ordinary override,
same "flag on refresh, don't block" treatment as any other human-made change.

This also makes "PM sees unassigned tickets on an in-progress story" (an earlier side
note, Parking Lot section above) a concrete, checkable rule for the Orchestrator's
"what's ready" query: *`Assignee` empty on an in-progress story/subtask* — worth keeping
in mind once that query is actually implemented (§8), not designed further here.
→ `PROJECT_BRIEF.md` §5.6.

### 5d resolved — who's involved at human checkpoints/sign-offs

Two distinct mechanisms, depending on the gate type:
- **`Approved:`-marker gates** (`REVIEW_GATES`, e.g. Kickoff's PM+UX gate): the commenting
  human must hold the required persona's Project Role — this is new, and is what lets TAI
  verify a raw Jira comment actually counts as "the PM"/"the UX Designer" signing off,
  closing a real gap (previously there was no way to check this beyond trusting the
  comment's content). → `schema/story-schema.ts` (`REVIEW_GATES` comment),
  `workflows/kickoff.md`, cross-cutting conventions section above.
- **`UAT`'s human-stakeholder sign-off:** deliberately **not** Project-Role-gated — a UAT
  stakeholder (product owner, customer, etc.) isn't necessarily a TAI persona at all.
  Already resolved differently in §2 (`workflows/story.md` — "UAT gate"): the human
  **transitioning the subtask to Done themselves** is the signal, no comment/role check
  involved. No change needed here, just confirming the two mechanisms are intentionally
  different, not an inconsistency.

### Added question resolved — no permission caching, consistent with §3.3

**Resolved:** TAI does **not** pre-validate or cache what a given human is *permitted* to
do in Jira, beyond checking Project Role membership for the two purposes above (gate
sign-off validation, assignment-helper candidate lists). For everything else, TAI
attempts the real Jira call and treats a rejection as the same kind of unplanned
checkpoint already defined for transitions in brief §3.3 — no new mechanism needed, this
was already the established pattern, just confirmed to apply here too.
→ `PROJECT_BRIEF.md` §5.6.

---

**Section 5 (Humans) — closed.** All of 5a-5d resolved, D15 (two-axis owner model) fully
closed after nine sections of being parked, and the added permission-caching question
resolved by extending the existing §3.3 pattern. A real stale-doc bug (Assignee/persona
conflation across four workflow docs + the schema) was found and fixed while integrating
this. Next up per the suggested order of attack: **Section 6 — Confluence**.

## 6. Confluence

- **6a.** Document types we expect.
- **6b.** Purpose of each.
- **6c.** Naming convention — prefix/postfix.
- **6d.** Confluence↔Jira linking:
  - **6d1.** Docs linking to Epics.
  - **6d2.** Docs linking to Stories.
  - **6d3.** Docs linking to Subtasks.
  - **6d4.** Docs needed in multiple places — link higher up, link to multiple tickets, or
    something else? Trade-offs each way.
- **6e.** Granularity — large docs (more to read each time) vs. small docs (more link
  management).
- **6f.** Confluence folder/space structure.
- **6g.** Should the Confluence project identifier match the Jira project key? **(Yes,
  per your note — confirm and record where this is enforced.)**
- **6h.** Config storage:
  - **6h1.** Project-level config, persona extensions, other settings (some of this is
    genuinely future/unforeseen — don't force it now).
  - **6h2.** Human tracking (ties to §5a).
- **6i.** How do humans make changes — do we accept any/all human edits, or is there a
  review layer?

### Stale-doc bug found while gathering §6 context

While cross-checking personas for their `confluenceOutputs` (needed for the 6a/6b
consolidation below), `personas/code-reviewer.md` still described test tiers as parallel
and carried an "Open item" asking whether they should chain instead — but D12 (§3)
already resolved this to sequential (`IntegrationTest → SystemTest → E2ETest`). Every
other file that referenced test-tier ordering was updated when D12 was resolved; this one
was missed. Fixed: "When this persona is invoked" now says sequential, and the stale
"Open item" section is replaced with a "Decided" note. → `personas/code-reviewer.md`.

### 6a/6b resolved — document types, consolidated (no new decision, just a table)

Every persona's `confluenceOutputs` front-matter already enumerates this; nothing new to
decide, just worth having in one place:

| Persona | Output types |
|---|---|
| Analyst (Ada) | `requirements-spec` (bootstrap only), `work-breakdown`, `epic-breakdown`, `refinement-notes` |
| PM (Perry) | `prd`, `jira-issue-creation-log` |
| UX Designer (Uma) | `ux-flow`, `wireframe`, `wireframe-index` |
| Architect (Aria) | `adr`, `feasibility-assessment`, `design-review-notes` |
| DBA (Dana) | `schema-notes`, `migration-plan` |
| DevOps (Duncan) | `deploy-runbook`, `infra-notes` |
| Developer (Dario) | `implementation-notes` |
| Code Reviewer (Cole) | `review-notes` |
| Tester (Tessa) | `test-plan`, `triage-notes`, `uat-plan` |

### 6d resolved — Confluence↔Jira linking (already covered by existing decisions)

- **6d1/6d2/6d3:** brief §4's existing rule already answers all three — pages tie to
  **whichever parent issue the content is actually scoped to** (Story or Epic), **never**
  to a subtask. Concretely: Ada's `epic-breakdown` proposal ties to the **Epic** itself
  (it's Epic-scoped decomposition, not tied to any one Story); Kickoff's PRD/UX-flows/WBS
  tie to the **Kickoff Story** (an Epic's child, but the actual scope of that content);
  subtask-produced docs (ADR from `ArchitectureDesign`, schema-notes from `Database`,
  etc.) tie to their **Story**, not the subtask that produced them — matching each
  persona's existing `update: Story.*` field convention (e.g. `Story.schemaNotes`).
- **6d4:** already resolved generically in `workflows/dependencies.md` — a doc needed by
  more than one ticket gets **linked via `RelatesTo`** to the additional ticket (same bar
  as any other `RelatesTo` link: does it materially help complete the other ticket), not
  duplicated or hoisted to a shared ancestor.
→ `PROJECT_BRIEF.md` (Confluence bullet, §4, rewritten with concrete examples).

### 6c/6e/6f resolved — naming, granularity, folder structure

- **6c (naming):** structured page titles — `<JIRA-KEY> — <Doc Type>: <short
  description>` (e.g. `PROJ-123 — ADR: Async job queue`). This does **not** mirror the
  "no title prefix" decision made for Jira issues (2h/3g) — the reasoning there was
  specifically that Jira's native issue-type icon already distinguishes tickets in every
  view; Confluence has no equivalent per-type icon in its page tree or search results, so
  the key and doc type need to live in the title itself for a human scanning a page list
  to know what's what.
- **6e (granularity):** **one page per persona-output instance** — one ADR, one PRD, one
  test-plan, etc. This isn't a new decision so much as making explicit what was already
  implicit in every persona's `confluenceOutputs` list (one entry = one page). The UX
  Designer's wireframe/wireframe-index split (§1) is confirmed as the **one documented
  exception** (a UX flow can span many distinct screens), not a new general pattern to
  extend to ADRs/PRDs/test-plans.
- **6f (folders):** organized **by doc-type** (an ADRs folder, a PRDs folder, …) within
  the one space per project — not by ticket hierarchy. Chosen over mirroring the Jira
  tree because it makes "browse all ADRs" or "browse all PRDs" a folder-navigation, not a
  cross-ticket search.
→ `PROJECT_BRIEF.md` (Confluence bullet, §4, rewritten).

### 6g resolved — Confluence space key matches Jira project key

Already decided by you in an earlier session note; recorded formally now: the
Confluence **space key** matches the **Jira project key** (e.g. Jira project `PROJ` →
Confluence space `PROJ`). → `PROJECT_BRIEF.md` §4.

### 6h resolved

- **6h1 (project-level config, persona extensions):** already covered — brief §3.1
  already establishes persona extensions live in Confluence at "the project's standard
  persona-extension location." Other project-level settings are left genuinely
  future/unforeseen, per the section's own note — not forced now.
- **6h2 (human tracking):** **resolved by §5, not a Confluence artifact at all** — human↔
  persona mapping is native Jira Project Role membership (§5.6), cached locally like
  everything else. No Confluence roster page needed.

### 6i resolved — editing an already-gated doc reopens the gate

**Resolved:** editing a Confluence page that backs an already-passed `ReviewGate` (e.g.
the PRD, after Kickoff's PM+UX gate signed off) **reopens that gate** — detected via the
same cached `lastUpdated`-vs-source staleness check used everywhere else (brief §3.6/§7),
not a new mechanism. TAI flags it and requires fresh `Approved:` sign-off from all
required reviewers before any further gate-dependent step proceeds. Already-created
tickets from before the edit aren't retroactively undone — this only blocks *further*
steps, consistent with how the framework treats other unplanned-checkpoint cases (brief
§3.3) as "stop and escalate the next step," not "roll back what already happened."
→ `schema/story-schema.ts` (`REVIEW_GATES` comment), `workflows/kickoff.md`.

---

**Section 6 (Confluence) — closed.** 6a/6b/6d/6g/6h2 were already resolved by earlier
decisions and just needed consolidating; 6c/6e/6f/6i were genuinely new and are now
decided (structured page titles, one-page-per-output granularity with wireframes as the
sole exception, folders-by-doc-type, and edits reopening an already-passed gate). A
stale-doc bug in `personas/code-reviewer.md` (still describing parallel test tiers after
D12 resolved them to sequential) was found and fixed. Next up per the suggested order of
attack: **Section 7 — Local cache**.

## 7. Local cache

**7a. Jira/work folder structure:**
- 7a1. File structure.
- 7a2. Status tracking.
- 7a3. Cached-date tracking (file date, or explicit field?).
- 7a4. Link tracking.
- 7a5. Can we find all tickets updated since our last cache date?
- 7a6. Do we cache the whole project? How much space? What about offline needs if not?
- 7a7. Images/diagrams/attachments handling.
- 7a8. Comments.

**7b. Confluence folder structure:**
- 7b1. Naming convention.
- 7b2. Link tracking.
- 7b3. Cached-date / updated-date tracking.
- 7b4. Can we find all docs updated since our last cache run?
- 7b5. Do we cache it all?
- 7b6. Images/diagrams/attachments handling.
- 7b7. Comments.

*(Added question: concurrency — if two humans/sessions are working the same project's
local cache at once (not the Jira/Confluence conflict brief §4 already covers, but the
*local* cache files themselves), do we need any locking/merge story? Also: cache eviction
— does anything ever get pruned, or does `.tai/cache` grow forever?)*

### 7a1-7a4 / 7b1-7b3 — already resolved, confirmed not re-litigated

Brief §7's existing `.tai/cache` layout already answers these: file structure
(`issues/<ISSUE-KEY>.json`, `confluence/<PAGE-ID>.md`), status tracking (native
status is part of the cached issue JSON; TAI's own in-progress state lives in
`work/<SUBTASK-KEY>/status.json`), cached-date tracking (`cachedAt` vs. source
`lastUpdated`, brief §3.6), and link tracking (`links/` — cached Jira↔Confluence index).
Nothing new decided here; this section just needed the genuinely open items below.

### 7a5/7b4 resolved — bulk "what changed" detection

**Resolved:** add a bulk **JQL**/**CQL** "updated since" query (`updated >= "<last-sync>"`
for Jira, the CQL equivalent for Confluence) on top of the existing per-item staleness
check — reuses native search rather than polling every cached item individually, same
"reuse native platform mechanics" pattern used throughout (Project Roles, Component
field, native sub-task issue types). Checkpoint timestamp lives in a new
`cache/<project-key>/last-sync.json`.
→ `PROJECT_BRIEF.md` §7 (layout diagram + new prose paragraph).

### 7a6/7b5 resolved — lazy by default, explicit full-sync command added

Brief §4 already established refresh as lazy (manual, or first-use-in-session) — that
default is **unchanged**. **Newly resolved:** add one explicit full-sync command on top,
for someone about to go offline (flight, no wifi) to eagerly prime the whole project's
cache once, rather than discovering gaps mid-flight. Day-to-day usage doesn't change.
→ `PROJECT_BRIEF.md` §7.

### 7a7/7b6 resolved — attachments cached lazily

**Resolved:** attachments/images are cached the same lazy way as everything else —
fetched and stored under the owning issue's/page's `attachments/` folder on first use,
not proactively for the whole project. Matters specifically for UX/diagram-heavy docs
where the image often *is* the content (wireframes, ADR diagrams).
→ `PROJECT_BRIEF.md` §7 (layout diagram).

### 7a8/7b7 resolved — comments: cached as part of the issue/page payload; marker convention extends to Confluence, not the native resolve checkmark

**7a8/7b7 storage shape:** comments aren't a separate cache file — they're part of the
cached issue JSON / Confluence page payload, same as the rest of that item's content.

**Real research finding, not just a design choice:** you asked whether Confluence's
native inline-comment "resolve" checkmark (screenshot showed the UI affordance) could be
leveraged through the Atlassian MCP server instead of a text-marker convention. Checked
the actual MCP tool surface: `confluence_add_comment`, `confluence_add_inline_comment`,
`confluence_reply_to_comment`, `confluence_get_comments`, `confluence_get_inline_comments`
all exist — but **there is no tool to set/toggle a thread's resolved state**. Whether
`get_inline_comments` even surfaces resolution status as a readable field couldn't be
confirmed either, since the Atlassian MCP connection isn't live yet (Phase 0/1, per
`CLAUDE.md`).

**Resolved (with your added caveats):** the `Q:`/`Approved:`/`Rejected:` text-marker
convention (already established for Jira) **extends to Confluence comments too**
(page-level and inline) — not the native resolve checkmark, for two reasons: (1) no MCP
write-tool exists for it, so TAI couldn't drive it even if desired; (2) **even reading it
wouldn't be reliable** — you pointed out a human may click resolve purely to declutter
their view, not as a substantive signal. Also flagged: **delete is available to a
human** for their own comment (both systems) — this generalizes into a "freshness, not
cached memory" rule: marker-scanning is always a fresh re-scan, never cached; if a
previously-satisfying `Approved:` comment is later deleted, the gate/question reverts to
unsatisfied, the same principle as §6i's "editing an already-approved doc reopens the
gate," just triggered by deletion instead of an edit.

→ **Finally integrated into `PROJECT_BRIEF.md`** as new **§3.9 Comment Conventions** —
this closes out the standing deferral note at the top of this document ("integration into
brief/schema deferred to §7/§8") that's been carried since the very first session.

### Added questions resolved — no locking, no eviction for v1

- **Concurrency:** no locking. The cache is explicitly disposable and always rebuildable
  from source (brief §7's opening line) — concurrent writes to the same cached file just
  mean whichever write lands last reflects the most recently fetched state; nothing
  authoritative lives only in the cache. Two humans on the *same* subtask concurrently is
  an existing claiming/assignment question (§5.5), not a new cache-locking problem.
- **Eviction:** none for v1. Don't build pruning logic ahead of an observed need,
  consistent with the project's stated "don't manufacture process for its own sake"
  principle (`personas/analyst.md`).
→ `PROJECT_BRIEF.md` §7.

---

**Section 7 (Local cache) — closed.** 7a1-7a4/7b1-7b3 were already resolved by the
existing `.tai/cache` layout; 7a5-7a8/7b4-7b7 and both added questions (concurrency,
eviction) are now decided. The Confluence-comment research finding (no MCP resolve-tool,
resolve-checkmark isn't a reliable signal anyway) led to formalizing the `Q:`/`Approved:`/
`Rejected:` conventions in `PROJECT_BRIEF.md` §3.9 — closing a deferral that had been
carried since session one. Next up per the suggested order of attack: **Section 8 — Unit
of work**.

## 8. Unit of work (a Jira task/subtask, start to finish)

- **8a.** Process of picking up a ticket.
- **8b.** Status transitions.
- **8c.** Fetching related data, and how deep:
  - 8c1. The ticket itself (fields, comments).
  - 8c2. Parent ticket (fields, comments).
  - 8c3. Rest of the parentage chain (typically up to Epic).
  - 8c4. Linked Confluence pages — how deep do we follow this? *(Note: D11 already
    settled this for `RelatesTo` ticket-to-ticket traversal — one hop only. Does the same
    one-hop rule apply to Confluence page-to-page links, or is that a different question?)*
  - 8c5. Related tickets (and their Confluence pages) — one hop, per D11.
  - 8c6. Parent's Confluence pages and related tickets.
  - 8c7. Other ancestors' Confluence and relations.
  - 8c8. How do we bound this to "useful" — read as-needed, or some other mechanism?
- **8d.** How does a human kick off the AI persona to do the work?
- **8e.** How do the human and AI persona interact through the process?
- **8f.** If issues/questions come up mid-work, how are they resolved — new tasks, other?

*(Added question: what happens when Jira/Confluence is unreachable mid-session — brief §3.2
names offline work as a goal via the filesystem backend, but what's the actual UX when a
*Jira-backed* project temporarily loses connectivity mid-unit-of-work?)*

### 8a/8b resolved — already covered by earlier sections, confirmed not re-litigated

- **8a (picking up a ticket):** already resolved by brief §5.5 (Assignment & Claiming) +
  §5.6 (the assignment-helper) — a human either already holds the ticket as `Assignee`
  (from the assignment-helper flow) or claims an unassigned "ready" ticket themselves.
  "Ready" is `isSubtaskReady()` from the precedence graph (§3/`schema/story-schema.ts`).
- **8b (status transitions):** already resolved — story-level in §2 (`Open → In Progress
  → Done`, plus Kickoff's `In Review`), subtask-level default in §3's cross-cutting
  resolutions (`Open → In Progress → Done`, with the specific per-type loop-backs already
  documented in `workflows/story.md`/`bug.md`).

### 8c resolved

- **8c1 (the ticket itself — fields, comments):** resolved by §7's cache layout — full
  cached issue JSON includes comments as part of the same payload, not a separate file.
- **8c2 (parent ticket — fields, comments):** already established by brief §3.6's
  briefing definition — the briefing aggregates the subtask **and its parent**.
- **8c3/8c7/8c8 resolved — ancestor depth stops at the immediate parent, Epic excluded
  by default.** The parent's own linked Confluence docs necessarily come along regardless
  (§6d already ties every persona-output doc to the parent, never the subtask — this is
  the *only* way a Dev subtask's briefing gets its Story's ADR/PRD/schema-notes at all).
  But the briefing does **not** also walk up to the Epic — consistent with D11's one-hop
  bounding philosophy. If Epic-level context is genuinely needed for a specific unit of
  work, that's a targeted follow-up read, not a default inclusion. This is also the
  answer to 8c8's meta-question ("how do we bound this to useful") for the ancestor-chain
  dimension specifically: bound by depth (one level), not by content-based judgment calls
  every time.
- **8c4 resolved — the same one-hop rule applies to Confluence page-to-page links, not
  just ticket-to-ticket (D11).** If Doc A is linked to the subtask/parent and Doc A
  itself links to Doc B, the briefing includes Doc A but does not transitively follow
  Doc A's own outgoing links to Doc B. Same bounding logic as D11, for the same reason.
- **8c5 (related tickets — one hop, per D11):** already resolved, no change.
- **8c6 (parent's Confluence pages and related tickets):** **necessary consequence of
  §6d, not really a new decision** — since all persona-output docs tie to the parent
  (never the subtask), a subtask's briefing including "the parent's linked Confluence
  pages" is simply how the subtask gets any of its own relevant context (requirements,
  design decisions, schema notes) at all. Not optional.

→ `PROJECT_BRIEF.md` §3.6 (briefing definition, rewritten with the bounded-depth rules),
`workflows/dependencies.md` (8c4 cross-reference added to the existing one-hop note).

### 8d resolved — concrete kickoff commands

**Resolved:** `/tai_work <KEY>` loads/refreshes a specific unit of work's briefing and
invokes its owning persona directly; `/tai_ready [persona]` answers "what's ready for you
to do" (brief §3.8) when the human doesn't have a specific key in mind. Both are thin
wrappers over the same briefing-then-invoke flow, no separate "starting fresh" vs.
"resuming" code path. → `PROJECT_BRIEF.md` §3.8.

### 8e — confirmed as already covered, no new decision needed

How the human and AI persona interact through the process is already substantially
specified: human-sign-off-default (brief §3.4) sets the checkpoint posture, each
persona's own "Interaction style" section (`personas/*.md`) sets its conversational
tone, and the `Q:`/`Approved:`/`Rejected:` conventions (§3.9) cover the structured parts
of that interaction. Nothing further to design here beyond what's already in those
places — 8e doesn't need its own new mechanism.

### 8f — confirmed as already covered, no new decision needed

**Resolved by combining two already-established mechanisms**, not a new one: a quick
clarifying question mid-work is a `Q:` comment (§3.9, on the subtask if only its owner
needs it, on the parent if multiple roles do, per the "who needs to know" rule, brief
§4). Something that needs actual **investigation**, not just an answer, is an ad-hoc
`Spike` subtask (already established, e.g. `personas/developer.md` — "when the approach
isn't obvious mid-implementation") or an `Investigate` subtask for requirements-shaped
gaps. No third mechanism needed.

### Added question resolved — connectivity loss mid-unit-of-work

**Resolved:** TAI degrades to the local cache for reads (clearly flagged as possibly
stale) and queues writes (comments, transitions, assignments) in the work journal rather
than failing outright, replaying them automatically once connectivity returns. This
reuses the journal's existing role as the append-only "what happened, what's next"
record (brief §3.6) rather than inventing a separate queueing mechanism. Distinct from
the filesystem backend's offline mode (brief §3.2), which is a deliberate backend
choice, not a transient-outage recovery.
→ `PROJECT_BRIEF.md` §3.6.

---

**Section 8 (Unit of work) — closed.** 8a/8b/8c1/8c2/8c5/8c6/8e/8f were already resolved
by earlier sections or are necessary consequences of them; 8c3/8c4/8c7/8c8 (briefing
depth bounds), 8d (kickoff commands), and the connectivity-loss added question are newly
decided. This closes the main planned sections — **Section 9 (Plugin implementation)**
is explicitly out of scope for now (see its own header), so the design-notes review is
complete pending any further ad-hoc topics.

## 9. Plugin implementation (Claude / Gemini)

Explicitly **not now** — noted here so it isn't lost. Comes after the above is settled.

---

## Suggested order of attack

Your ordering (Personas → Story types → Subtask types → Workflows → Humans → Confluence →
Cache → Unit-of-work) already builds naturally from "who" to "what" to "how it flows" to
the surrounding infrastructure. One sequencing note: personas and subtask types reference
each other constantly (a persona's permissions are stated in terms of subtask types, and
subtask types name a default persona) — so expect some back-and-forth between §1 and §3
rather than a clean one-pass-and-done through either.

**Recommendation for where to start:** either **Analyst** (fastest — it's the most mature
file already, good for confirming the discussion format works) or **PM** (more open ground:
Orchestrator duties, D8/D9/D15 all brush up against it). Open to whichever you'd rather
tackle first.

---

## Status: all 8 planned sections closed

Sections 1-8 above are all closed, in the order this note originally recommended. Every
parking-lot item (D5/D7/D8/D9/D10/D12/D15) and the two-axis owner model are resolved;
Section 9 (Plugin implementation) stays explicitly out of scope per its own header. A
final consistency pass (cross-references, stale forward-pointers, a couple of doc-drift
bugs in `personas/code-reviewer.md` and `schema/story-schema.ts`'s TODO list) was done
after Section 8 closed — see the fixes noted inline above rather than duplicating them
here. Per this doc's own stated lifecycle ("get integrated into the brief/schema, then
this doc is trimmed or retired"), the natural next step is deciding whether to retire or
trim this file now that its findings are integrated — not a design question, a
housekeeping one, left for you to call.
