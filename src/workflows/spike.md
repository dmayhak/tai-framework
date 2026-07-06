# Spike Workflow (Draft)

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

Note: a `Spike` *subtask* also exists (usable inside a Story, for smaller
ad-hoc investigations that don't warrant a full Spike story). It has no
fixed owner — assignee is set explicitly at creation, since a spike
question could belong to any persona depending on what's being
investigated.

## Status: Not yet finalized

Unlike Kickoff and Story, this workflow still has open design questions
that haven't been resolved:

- **Ownership model** — does a Spike *story* need a single owner field,
  or is it multi-owner by subtask (Architect, DBA, DevOps all
  potentially contributing to the same spike)?
- **Origin points** — a Spike can currently be spawned from Kickoff, an
  Epic, or a Story. Does the review/output requirement differ depending
  on where it originated?
- **Outcome handling** — when a Spike concludes, does it always spawn a
  Story, or can it also conclude with "not feasible, do not proceed"
  as a terminal state?