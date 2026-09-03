# Dependency Mapping

> Must comply with `PROJECT_BRIEF.md`; re-check before finalizing output (brief §8.25).

Two distinct layers, handled differently:

1. **Story-level dependencies** — discovered by a persona (usually the
   Analyst), can't be derived from rules. Must be captured as data at
   creation time.
2. **Subtask-level dependencies** — the precedence *graph* is structural,
   derivable from which subtasks actually exist on a given ticket
   (computed, not hand-authored per-edge). The resulting **Jira links**
   are still created explicitly, same as Layer 1 (see "Decided" below,
   2026-08-17 direction) — computed doesn't mean invisible-to-Jira.

## Layer 1: Story-Level Dependencies

### Relations
Our own semantic model, mapped separately to actual Jira link type names.

| Relation | Meaning |
|---|---|
| `DependsOn` | `from` cannot start until `to` is done (`to` "blocks" `from`, in Jira's terms) |
| `RelatesTo` | Non-blocking, informational association |

A `CausedBy` relation (e.g. Bug caused-by Story) was considered and
deferred — "Causes"/"is caused by" isn't a universal Jira default link
type. Sticking to Jira's defaults for now; revisit if a real need comes
up and the link type is confirmed to exist in the target instance.

Each relation is stored **one-directional**. Jira's inverse naming
("blocks" / "is blocked by") is an API/display concern handled at
creation time — not a reason to store both directions in our own data.

### Jira Link Type Mapping
`DEFAULT_JIRA_LINK_TYPE_NAME` maps our relations to Jira's own default
link types — no custom link types required:

| Our Relation | Jira Link Type |
|---|---|
| `DependsOn` | `Blocks` |
| `RelatesTo` | `Relates` |

### Handling Dependencies Discovered Before Tickets Exist
During a single discovery session, the Analyst may find several related
stories before any of them are created in Jira. `StoryRef` supports a
`localId` for this — a temporary identifier used only during the
discovery/creation batch, resolved to a real Jira key once the ticket
exists.

```
StoryRef = { jiraKey?: string, localId?: string }
StoryDependency = { from: StoryRef, relation, to: StoryRef, note? }
```

`resolveStoryDependencies()` takes a batch of these plus a
`localId → jiraKey` map (built after all tickets in the batch are
created) and returns fully-keyed dependencies ready to send to Jira.
It throws on any unresolved `localId` — a missed mapping should fail
loudly, not silently drop a discovered dependency.

## Layer 2: Subtask-Level Precedence

`SUBTASK_PRECEDENCE` defines the **full possible** precedence graph per
story type — every edge that could exist. A real story instance usually
only has a subset of subtask types present (no `Database`, no
`ArchitectureDesign`, etc.), so `resolveApplicablePrecedence()` filters
the graph down to only the edges where **both ends are actually present**
on that instance. This is what lets stories have more or fewer subtasks
than each other without needing a different rule set per story.

`isSubtaskReady()` checks whether a target subtask's applicable
`before` rules are all satisfied — a subtask with no applicable rules is
a root and is always ready.

### Current default shape (Story/Bug)
```
ArchitectureDesign ─> DesignReview ─┐
UxDesign ────────────────────────────┤
Database ────────────────────────────┼─> Dev ─> IntegrationTest ─> SystemTest ─> E2ETest ─> UAT ─> Deploy ─> PostDeploy
Infra ────────────────────────────────┘
```
`UxDesign` under Story is Story-level detailing/tweaking beyond Kickoff's
higher-level flows (not on Bug) — it gates `Dev` the same way as its sibling
prerequisites.

**rev 52 (TAI-159 ADR): the `Dev ─>` edges into the test tiers/`UAT` shown above are
DELIBERATELY never satisfied through this static graph alone.** `CodeReview` used to sit
between `Dev` and the test tiers; it's retired going forward (still a legal `SubtaskType`
for parsing historical tickets, never created for new work). Deleting its edges outright
would have left the test tiers with zero applicable precedence rules, which
`isSubtaskReady()` treats as "no rules apply — always ready" the moment the subtask is
created, silently bypassing review entirely. The `Dev`-anchored edges exist specifically
to prevent that: `Dev` now stays **In Progress** until its PR actually merges (not until
review passes), so a rule requiring `Dev` to be **Done** never actually fires while the
PR-backed flow is what's really gating anything. **Real readiness for these types comes
exclusively from `ready.ts`'s live-computed lists** (`readyToTest` — an open PR on the
linked `Dev` subtask, no approval check; `readyToMerge` — same candidates, additionally
approved-per-the-configured-count and CI-green), checked against Bitbucket's actual PR
state on every `/tai-ready` call, not from a Jira-status fact. See
`personas/developer.md`'s Handoff section and `workflows/story.md`'s PR-backed section for
the mechanics.

**Test tiers run SEQUENTIALLY by default (D12), not in parallel:**
`IntegrationTest → SystemTest → E2ETest`, cheapest/fastest tier first — each
gates the next, rather than all three racing off the same never-fires-statically `Dev`
edge simultaneously. This catches a regression at the cheapest tier before spending time
on a more expensive one that would have failed for the same reason. Each tier also keeps
a direct `Dev` edge for when an earlier tier in the sequence isn't present on this story
instance (same coexistence pattern as `DesignReview`/`UAT` below) — e.g. if
`IntegrationTest` is skipped, `SystemTest` falls back to the same never-fires-statically
`Dev` edge rather than being trivially ready. **Whether a given tier applies to a
Story/Bug at all remains a per-instance judgment call** by whoever adds the subtask set
(Tester, typically) — the same present-when-added pattern already used for
`DesignReview`/`UAT`/`Database`/`Infra`, not a formal rule engine.

**`DesignReview` and `UAT` are optional gates** (present-when-added), and both
are **purely additive** to the static graph — when either is absent the graph
collapses to the prior shape, because the resolver only keeps edges where
**both** ends are present:
- **`DesignReview`** gates `ArchitectureDesign → Dev` — unaffected by `CodeReview`'s
  retirement, since it reviews a design document, not a git PR (there's no git-host-native
  equivalent to defer to the way code review now has). When it's absent, the direct
  `ArchitectureDesign → Dev` edge applies instead (both edges are kept in the graph; the
  filter drops whichever end is missing).
- **`UAT`** sits after the same never-fires-statically `Dev` edge and whichever automated
  tiers are present, and gates `Deploy`. When it's absent, the tiers gate `Deploy`
  directly, as before. `UAT` is **inherently human-gated** (brief §3.3) — it never
  autocompletes, even where autocompletion is otherwise enabled.

### What the `SpikeTask` subtask deliberately has no rule for
The ad-hoc `SpikeTask` subtask (used inside a Story/Bug) has no entry in
`SUBTASK_PRECEDENCE` — same reason it has no fixed owner. Whether it
blocks Dev or is purely informational depends on what's being
investigated, and must be set explicitly per instance rather than
templated.

## Dynamic Subtask Insertion

Stories don't always ship with their full subtask set upfront. Example:
Architecture work on a Story surfaces the need for a Database subtask
partway through. That new Database subtask should:
- run **in parallel** with the still-in-progress Architecture work, and
- still **block Dev**

The static graph already supports this without changes — there's no
edge between `ArchitectureDesign` and `Database`, only independent edges
from each into `Dev`. So a Database subtask inserted mid-flight becomes
a parallel input naturally, not a blocker on Architecture.

What was missing was a way to compute **only the new edges** created by
an insertion, without recomputing or duplicating links for subtasks that
already exist and are already wired up. `getNewPrecedenceEdgesForInsertedSubtask()`
does this: pass the story's currently-present subtask types (before
adding the new one) and the type being inserted, and it returns just the
applicable edges touching the new subtask.

This generalizes beyond the Database example — the same mechanism
applies any time a subtask is discovered mid-flight and wasn't part of
the story's original set (e.g. PostDeploy not being recognized as
necessary until Deploy planning is underway).

## Eager Subtask Creation (who creates, and when)

TAI-83 ADR (Confluence, TA space; TAI-80 Spike). Default convention is still "each
persona creates its own subtask type once invoked" — this section is the named exception,
not a replacement.

**Any persona already active on a Story/Bug/Spike may create any subtask type on it, once
they've formed a real in-context judgment (from their own work, not speculation) that it's
needed** — not restricted to that type's default owner. Three properties keep this safe,
and all three are required together:
- **Real judgment, not speculation.** This is not blind pre-population of every possible
  subtask type for every Story "just in case" — that reintroduces exactly the clutter the
  present-when-added pattern (`DesignReview`/`UAT`/`Database`/`Infra`/test tiers, `Current
  default shape` above) exists to avoid. A subtask gets created because someone doing real
  work concluded it's actually needed for this instance — the same trigger that already
  fires `getNewPrecedenceEdgesForInsertedSubtask()` (Dynamic Subtask Insertion, above), just
  without waiting for the type's own owner to be the one to notice.
- **Dedup search first.** Before creating, search `workTracker.search({ projectKey,
  parentKey: <story>, issueTypes: [<type>] })` — `IssueFilter` already supports this
  directly, no new mechanism. A hit means the ticket already exists (a human may have added
  it manually, or another turn already ran this same check) — add a note/comment there
  instead of creating a duplicate. A miss creates it.
- **`persona` still defaults per `SUBTASK_OWNER`, regardless of creator.** Creating a
  ticket doesn't make you its owner — `CreateIssueInput.persona` is a caller-supplied
  field, set to the type's normal default owner exactly as if that owner had created it
  themselves. Creation authority and execution ownership stay separate axes.

**Where a broadened `create` grant is worth adding** (evidence, not an enforced
whitelist — under the model above every persona *can* create any type; this is where it's
actually plausible in practice): Developer often knows, from writing the code itself,
which of the relevant test tiers, a `Database`/`Infra` need (the exact
mid-implementation-discovery case above), or `Deploy`/`PostDeploy` timing apply — see
`personas/developer.md`'s `create` grant. Architect/PM similarly often recognize
`Database`/`Infra`/`ArchitectureDesign` needs during design or requirements work. A
persona that merely *suspects* a need outside what its own work directly surfaces (e.g.
Developer suspecting `UxDesign` is needed) still flags it to the right owner/PM rather than
creating it blind — recognizing a need from your own work is different from guessing at
someone else's domain.

**Known gap this doesn't cover (not resolved by TAI-83):** the existing WBS-assembly batch
scan (`personas/pm.md` items 4/5, `workflows/kickoff.md`) only fires at Kickoff-gate-passing
or Epic-decomposition. A Story created directly from a Spike's conclusion
(`workflows/spike.md`'s "hands off to PM for creation" outcome) gets no formal multi-persona
scan — PM makes an informal solo judgment call instead (a full batch scan is disproportionate
for one Story). When that happens, PM should state which optional subtask types were
considered and why none applied, in the Story's creation comment, so the judgment is visible
and reviewable rather than silent.

## Initial Status & Priority for a Created Subtask (TAI-292, 2026-09-03)

Applies uniformly to every subtask-creation path above — PM's WBS-assembly batch (items
4/5 above), the single-Story informal judgment call (the "Known gap" paragraph just
above), and TAI-83's eager/ad-hoc creation alike. Refines brief §5.3's rev 27/29
`Backlog`-is-the-default-landing-status decision (still the actual default — unchanged);
this section is about the narrower question rev 29 explicitly left open: when does a
persona count as "authority to judge readiness" (rev 29's own phrase) and promote past it
at creation time, rather than always leaving that to a later manual step.

- **Status: `To Do`, not `Backlog`, iff the subtask's description is fully actionable as
  written** — someone picking it up later needs no further scoping/triage first. This is
  the one crisp, self-checkable signal, not a fuzzy "how important/complex is this"
  judgment: a WBS-assembled subtask (Perry already wrote a scoped description) and a
  Developer's well-defined ad-hoc `SpikeTask` both qualify; a placeholder flag for
  something not yet concretely scoped ("we might need a DB migration eventually") does
  not, and lands in `Backlog` same as before. No separate "ask a human" branch is needed
  on top of this — landing in `Backlog` already **is** the fallback, per rev 29's existing
  soft-gate design (a human, or a persona with the authority, moves it later); a comment
  explaining why a given subtask landed in `Backlog` rather than `To Do` is good practice
  but not new machinery.
- **A created subtask never starts directly `In Progress`.** Creating and starting work
  stay two separate steps, always — matches every subtask-creation path in this file, and
  keeps `SUBTASK_PRECEDENCE` gating meaningful (a newly-created, still-blocked subtask
  starting `In Progress` would be a contradiction).
- **Priority: always an explicit `priority=<parent's priority>` write on `issue create`,
  unconditionally — no carve-out for a "minor" subtask under a High-priority parent.**
  `tai-ready`'s existing parent-priority-inheritance behavior is display/sort-only (a
  subtask with no `Priority` of its own falls back to its parent's for that purpose) — the
  underlying Jira field itself was never actually being set, which is a real, silent gap:
  found live this session (TAI-292) when TAI-289/290/291 defaulted to Jira's own `Medium`
  under a `High`-priority parent (TAI-285), since none of the `issue create` calls passed
  `priority=` explicitly. TAI's priority field has exactly one consumer today (`tai-ready`'s
  sort/display) — no SLA or queue-depth logic exists that "priority inflation" from
  inheriting the parent's could actually harm, and a High-priority Story's subtasks
  surfacing prominently in `tai-ready` is the intended behavior, not a bug to guard
  against. Independent subtask-level priority is a solution to a problem TAI doesn't have
  yet (this codebase's own repeated "don't build ahead of an observed need" stance) —
  revisit only if a real workload/triage need for it actually surfaces.

## Ad-Hoc Subtask-Level Dependencies (escape hatch)

Most dynamically-inserted subtasks are already covered by the static
template via the mechanism above. `SubtaskDependencyOverride` (with
`SubtaskRef`, mirroring `StoryRef`'s `localId` pattern) exists for the
rarer case where a subtask discovered mid-flight needs a relationship
the template genuinely doesn't define. The `note` field is required on
overrides — if it doesn't fit the standard template, the reasoning
should be recorded, not just the link itself.

## Enforcement: Jira Links vs. TAI's Own Orchestration
Creating a Jira link (`Blocks`, etc.) is informational for humans looking
at the board — Jira does not, by default, prevent someone from
transitioning a "blocked" ticket to In Progress. Two options, not
mutually exclusive:
- TAI's own orchestrator reads the same precedence graph internally to
  decide what to dispatch to which persona next, independent of whether
  Jira visually shows the block.
- Jira Automation rules could be added to hard-enforce transition
  guards, but that's a separate, optional layer on top.

## Decided

- **`RelatesTo` does create a real Jira link** — but not indiscriminately.
  The bar is: link `A` to `B` only when the information in `B` (and what it
  links to — e.g. Confluence pages) **has a material bearing on completing
  `A` more efficiently**. This is a judgment call by whoever discovers it
  (usually the Analyst), not "everything that's topically related." It's
  meant to prevent the everything-links-to-everything clutter the old open
  question worried about, while still making genuinely useful context
  Jira-discoverable, not just buried in PRD/Confluence prose. Confluence-doc
  links (docs to tickets, tickets to docs) use the same relation and the
  same bar.
- **Whoever writes a reference that meets the bar above creates the real link in the
  same turn — a prose mention alone (a ticket key or a Confluence URL typed into a
  description/comment) is not sufficient on its own.** Found live (TAI-132): TAI-116's
  own description referenced another ticket's ADR in prose only, with zero real
  Jira/Confluence links on the ticket until fixed after the fact. This isn't a
  cosmetic gap — brief §3.6's whole briefing-assembly design (subtask + parent +
  *linked* Confluence pages, one-hop bounded) only surfaces context that's actually
  linked; a prose-only reference is invisible to that mechanism, findable only by a
  human/persona manually reading and traversing text. Every persona this applies to
  (all nine — this is general, not scoped to any one persona's own subtask type)
  points back to this bullet rather than restating it.
- **Traversal depth for `RelatesTo` is one hop only.** If `A` relates to `B`,
  working on `A` means reading `B`. It does **not** mean also reading `C`
  just because `B` relates to `C` — that's a separate judgment call to make
  (or not) when working `B` itself, not something `A`'s context inherits
  transitively. This bounds context-gathering; see the design-notes doc for
  the fuller "how much do we read before starting work" discussion (§8).
  **Resolved (§8, rev 11): the same one-hop rule applies to Confluence
  page-to-page links, not just ticket-to-ticket** — a briefing includes
  pages linked directly to the subtask/parent, but doesn't transitively
  follow those pages' own outgoing links (`PROJECT_BRIEF.md` §3.6).
- **Reaffirmed (TAI-84 ADR, TAI-81 Spike): `generateBriefing` does not walk up to the
  Epic.** Brief §3.6's "the Epic is not auto-included... a targeted follow-up read, not a
  default" stands as-is — checked against real data, not just re-asserted: the issue
  hierarchy is uniformly `Epic → {Kickoff|Story|Bug|Spike} → Subtask` (no story type sits
  closer to its Epic than any other), and zero Epics in this project currently carry any
  linked Confluence page — every ADR so far links to its own Spike/Story, never the Epic.
  **The named mechanism for that "targeted follow-up read"**, concretely, not just prose
  intent: call `refreshIssue`/`getLinkedPages` on the parent issue's own `parentKey`
  directly — the same primitives `generateBriefing` itself already uses, invoked manually
  and selectively rather than wired into the default path. This is already de facto
  practice — every ADR in this project (including TAI-84's own) already recites its Epic's
  framing in prose in its Context section, sourced this way. Revisit if a real Epic-level
  doc ever actually gets linked via `linkPage()` — that's the trigger to re-open this with
  real data, not before.
- **When a mid-flight-inserted subtask's new precedence edge targets
  something already In Progress or Done** (e.g. `Dev` already started before
  `Database` was recognized as needed): the system creates/adjusts the link
  **and flags it** — it doesn't silently link with no signal, but it also
  doesn't block or require active human intervention before proceeding.
- **Real Jira links get created for known/reasonably-assumed relationships as
  soon as they're known — not deferred to a later pass** (2026-08-17 direction,
  surfaced while creating TAI-85's TAI-87→TAI-92→TAI-93 chain). Applies at both
  layers:
  - **Layer 2 (subtask precedence):** whoever creates the subtask set — eagerly
    per TAI-83, or up front in PM's WBS-assembly pass — also creates the
    corresponding `Blocks` link (`DEFAULT_JIRA_LINK_TYPE_NAME` mapping, same as
    Layer 1) between sequential siblings actually present on this instance
    (per `resolveApplicablePrecedence()`, not the full theoretical graph) —
    e.g. `ArchitectureDesign` blocks `DesignReview` blocks `Dev`. `SUBTASK_PRECEDENCE`
    stays the source of truth for what TAI's own orchestrator reads
    (Enforcement section above is unchanged); the real link is for board
    visibility to a human, materializing what the engine already computes.
  - **Layer 1 (story-level):** unchanged in mechanism (`StoryDependency`/
    `resolveStoryDependencies()` already do this) — restated here as the same
    "as soon as known" bar, not a separate rule.
  - **Direction matters and is easy to get backwards:** for `Blocks`, the
    **inward** issue blocks the **outward** one (ground truth per §3.2's
    MCP-wrapper hazard note) — `jira_create_issue_link(link_type="Blocks",
    inward_issue_key=<blocker>, outward_issue_key=<blocked>)`. A link created
    with the keys swapped reads backwards in the Jira UI and is worse than no
    link — double-check direction, don't just fire-and-forget the call.
- **A subtask's linked Confluence page also gets linked directly to that subtask's
  immediate parent Story/Bug** — a second, purely human-facing link, on top of
  whatever `generateBriefing`'s own traversal already covers. Found live (TAI-255,
  2026-08-27): TAI-209's ADR was linked to TAI-209 itself, and reached TAI-210's
  (sibling Dev subtask) briefing automatically via the existing
  `ArchitectureDesign`-blocks-`Dev` link and the one-hop linked-ticket-page rule
  above — but TAI-208, the parent Story whose own scope the ADR resolves, had zero
  Confluence links, so a human opening TAI-208 directly in Jira saw nothing pointing
  at the decision. The AI-side briefing mechanism working correctly doesn't make the
  page discoverable to a human browsing the board — that's a different consumer with
  no equivalent traversal, and needs its own real link. Same immediate-parent-only
  bound as everywhere else in this file (no Epic) — whoever links a page to a
  subtask links it to that subtask's parent in the same turn, not as a follow-up
  pass.

## Open Questions
- **Resolved (D12):** test tiers are sequential by default
  (`IntegrationTest → SystemTest → E2ETest`), not parallel — see "Current
  default shape" above.
- Should Jira Automation be used to hard-block transitions, or is
  TAI's own orchestrator sufficient as the single source of truth for
  "what's actually workable right now"? *(Brief §3.3/§4 already answers
  this at the framework level: TAI's own plugin layer is the enforcer;
  native Jira validators/Automation are optional defense-in-depth only.)*