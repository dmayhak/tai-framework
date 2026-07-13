# Dependency Mapping

Two distinct layers, handled differently:

1. **Story-level dependencies** — discovered by a persona (usually the
   Analyst), can't be derived from rules. Must be captured as data at
   creation time.
2. **Subtask-level dependencies** — structural, derivable from which
   subtasks actually exist on a given ticket. Generated, not hand-entered.

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
Database ────────────────────────────┼─> Dev ─> CodeReview ─> IntegrationTest ─> SystemTest ─> E2ETest ─> UAT ─> Deploy ─> PostDeploy
Infra ────────────────────────────────┘
```
`UxDesign` under Story is Story-level detailing/tweaking beyond Kickoff's
higher-level flows (not on Bug) — it gates `Dev` the same way as its sibling
prerequisites.

**Test tiers run SEQUENTIALLY by default (D12), not in parallel:**
`IntegrationTest → SystemTest → E2ETest`, cheapest/fastest tier first — each
gates the next, rather than all three racing off `CodeReview` simultaneously.
This catches a regression at the cheapest tier before spending time on a more
expensive one that would have failed for the same reason. Each tier also keeps
a direct `CodeReview` edge for when an earlier tier in the sequence isn't
present on this story instance (same coexistence pattern as `DesignReview`/
`UAT` below) — e.g. if `IntegrationTest` is skipped, `SystemTest` falls back to
being gated directly by `CodeReview` instead of being permanently blocked.
**Whether a given tier applies to a Story/Bug at all remains a per-instance
judgment call** by whoever adds the subtask set (Tester, typically) — the same
present-when-added pattern already used for `DesignReview`/`UAT`/`Database`/
`Infra`, not a formal rule engine.

**`DesignReview` and `UAT` are optional gates** (present-when-added), and both
are **purely additive** to the static graph — when either is absent the graph
collapses to the prior shape, because the resolver only keeps edges where
**both** ends are present:
- **`DesignReview`** gates `ArchitectureDesign → Dev`, the same way `CodeReview`
  gates `Dev → tests`. When it's absent, the direct `ArchitectureDesign → Dev`
  edge applies instead (both edges are kept in the graph; the filter drops
  whichever end is missing).
- **`UAT`** sits after `CodeReview` and whichever automated tiers are present,
  and gates `Deploy`. When it's absent, the tiers gate `Deploy` directly, as
  before. `UAT` is **inherently human-gated** (brief §3.3) — it never
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
- **When a mid-flight-inserted subtask's new precedence edge targets
  something already In Progress or Done** (e.g. `Dev` already started before
  `Database` was recognized as needed): the system creates/adjusts the link
  **and flags it** — it doesn't silently link with no signal, but it also
  doesn't block or require active human intervention before proceeding.

## Open Questions
- **Resolved (D12):** test tiers are sequential by default
  (`IntegrationTest → SystemTest → E2ETest`), not parallel — see "Current
  default shape" above.
- Should Jira Automation be used to hard-block transitions, or is
  TAI's own orchestrator sufficient as the single source of truth for
  "what's actually workable right now"? *(Brief §3.3/§4 already answers
  this at the framework level: TAI's own plugin layer is the enforcer;
  native Jira validators/Automation are optional defense-in-depth only.)*