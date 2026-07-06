# Kickoff Workflow

## Purpose
Discovery, requirements, and UX design for a new initiative, before any
implementation work is scheduled.

## Story Type
`StoryType.Kickoff`

## Subtasks

| Subtask | Owner (default) | Notes |
|---|---|---|
| `Research` | Analyst | Market/competitive research, requirements elicitation |
| `Requirements` | PM | PRD drafting |
| `UxDesign` | UX Designer | Flows, wireframes, mockups |
| `ArchitectureDesign` | Architect | Optional — only when the initiative has enough technical risk to warrant early design input |

## Review Gate
**Required reviewers:** PM + UX Designer

The Kickoff story cannot spawn Story/Spike tickets until PM and UX Designer
sign off that the PRD and UX artifacts are ready to build against.

**Open question:** if `ArchitectureDesign` was used during Kickoff, should
the Architect be added to the required reviewers for that instance, or does
the gate stay fixed at PM + UX regardless?

## Output
- PRD (owned by PM)
- UX flows/mockups (owned by UX Designer)
- Optional early architecture notes (if `ArchitectureDesign` was used)
- One or more Story/Spike tickets, created after the review gate passes

## Open Questions
- Should `Feasibility` / `Database` / `Infra` subtasks be allowed under
  Kickoff for early technical-risk flags, or are they strictly locked to
  Spike/Story?