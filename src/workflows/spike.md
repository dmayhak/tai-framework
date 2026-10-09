# Spike Workflow

> Must comply with `PROJECT_BRIEF.md`; re-check before finalizing output (brief §8.25).

## Purpose
Time-boxed technical investigation. Output is a decision/recommendation,
not shippable code.

## Story Type
`StoryType.Spike`

## Subtasks

| Subtask | Owner (default) | Notes |
|---|---|---|
| `Feasibility` | Architect | Quick, spike-like technical go/no-go |
| `Database` | DBA | e.g. "can our schema support this" |
| `Infra` | DevOps | e.g. infra feasibility checks |

Note: a `SpikeTask` *subtask* also exists (usable inside a Story, for smaller
ad-hoc investigations that don't warrant a full Spike story). It has no
fixed owner — assignee is set explicitly at creation, since a spike
question could belong to any persona depending on what's being
investigated. (Renamed from `Spike` to `SpikeTask` to avoid colliding with
this story-level `StoryType.Spike` — Jira issue-type names must be unique
site-wide.)

## Who owns it (story-level)

**PM is the default owner/driver of the Spike story itself**, same as Kickoff/Story/Bug
— kept uniform even though a Spike is *scoped* by whoever raised the question (see
below). Two distinct things, not in tension: **the Spike's `persona` field defaults to
PM** (brief §5.6, the two-axis owner model — the native Jira Assignee is a separate
field, a real human listed under PM in the Persona Roster, rev 12); the **raiser owns
scoping authority** (what question the Spike actually investigates).
Subtask-level ownership is unambiguous already — `Feasibility`/`Database`/`Infra` have
fixed owners (Architect/DBA/DevOps); the ad-hoc `SpikeTask` *subtask* has no fixed owner
and is assigned explicitly at creation (`SUBTASK_OWNER[SpikeTask] = null`, see
`schema/story-schema.ts`). This resolves D8's ownership-model question in full.

## Scope discipline: no default Analyst involvement

A Spike is scoped to the **specific question the raiser needs answered** —
it's not a general research vehicle. The **Analyst is not automatically
involved** in a Spike; Ada only participates if explicitly asked or assigned
a subtask. Whoever raised the question (Architect, DBA, DevOps, PM,
Developer, etc.) owns scoping it, consistent with the default owners in the
table above.

## Origin Points

A Spike can be spawned from Kickoff discovery, directly under an Epic, or from a
Story/Bug. It behaves **identically regardless of origin** — same available subtask
types, same outcome taxonomy (below), no origin-specific review requirement. Origin only
affects where its output links back to (the Kickoff Story, the Epic, or the originating
Story/Bug via `RelatesTo`).

## Output

A Spike does **not** always spawn a Story. It concludes as one of three outcomes:
- A **new Story** (the investigated approach is viable — hands off to PM for creation).
- One or more **Confluence page(s) with no follow-on ticket** (the answer itself was the
  deliverable — nothing further to build yet).
- The initiative being **cancelled/deferred** (a genuine terminal state, not just "not
  feasible" — the question was worth asking and now has a documented answer).

**Who decides, and how it's recorded:** the persona who owned the investigating subtask
(Architect/DBA/DevOps/etc.) **proposes** the outcome in their conclusion doc; **PM
confirms** it — mirroring the propose/create split already used for Ada's decomposition
(`personas/analyst.md`). Recorded as the conclusion note on the Spike's Confluence
output, plus PM transitioning the Spike to **`Done`** (new Story / Confluence-only
outcomes) or **`Canceled`** (cancelled/deferred outcome, brief §5.3 rev 16 — this used to
collapse into `Done` with the outcome only noted in text; a distinct status now makes an
abandoned Spike visible at a glance, e.g. on a board or filter, without reading the
conclusion doc). The broader D9 output-taxonomy question (what *every* ticket type
produces, formally modeled) is still open — this only resolves Spike's specific case.

## Status Transitions (story-level)

`To Do → In Progress → Done`, with **`Canceled`** as an alternate terminal state reachable
from either `To Do` or `In Progress` (brief §5.3 rev 16).

- **To Do:** created, no present subtask has started.
- **In Progress:** at least one of `Feasibility`/`Database`/`Infra` is underway.
- **Done:** the investigation concluded with a **new Story** or **Confluence-only**
  outcome, PM confirmed.
- **Canceled:** the investigation concluded with the **cancelled/deferred** outcome, PM
  confirmed — same "PM confirms the proposed outcome" mechanics as `Done` above, just a
  different terminal status.

## Naming Convention

Same general rule as Kickoff/Story/Bug: no enforced title prefix. Jira's native
issue-type field already carries the `StoryType.Spike` signal.

## Human Overrides

Same general rule as Kickoff/Story/Bug: a subtask type outside `STORY_SUBTASK_MAP[Spike]`
is noted when it is created through the CLI, not blocked or auto-removed (see
`workflows/kickoff.md`, "Human Overrides").