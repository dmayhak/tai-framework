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
ArchitectureDesign ─┐
Database ───────────┼──> Dev ──> CodeReview ──┬──> IntegrationTest ──┐
Infra ───────────────┘                        ├──> SystemTest ───────┼──> Deploy ──> PostDeploy
                                               └──> E2ETest ──────────┘
```
Test tiers run in **parallel** off CodeReview, not chained to each other,
and all three (when present) must complete before Deploy.

### What the `Spike` subtask deliberately has no rule for
The ad-hoc `Spike` subtask (used inside a Story/Bug) has no entry in
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

## Open Questions
- Should `RelatesTo` edges even auto-create Jira links, or just get
  recorded in the PRD/Confluence text? Blocking edges are rare and
  high-value to surface; "relates to" edges could be numerous and
  create link clutter if every soft association becomes a Jira link.
- Does the parallel-test-tier assumption (Integration/System/E2E all
  gated by CodeReview, not chained) match actual intended workflow, or
  should some test tiers gate others (e.g. E2E only after System passes)?
- Should Jira Automation be used to hard-block transitions, or is
  TAI's own orchestrator sufficient as the single source of truth for
  "what's actually workable right now"?
- When a subtask is inserted mid-flight and its new precedence edges
  target something that's already In Progress or Done (e.g. Dev already
  started before Database was recognized as needed), should the system
  just create the link and flag it, or actively warn that a dependency
  arrived later than it should have?