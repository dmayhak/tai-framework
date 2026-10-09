# TAI framework: project context

The rules for working in this repo. Read `PROJECT_BRIEF.md` for the design; this file is only what a session needs on every turn.

## Stack

- TypeScript on Node, ES modules, run with `tsx`. No build step is needed to run the CLI.
- Tests use `node:test` and sit next to the code as `*.test.ts`.
- The CLI is `src/hosts/cli.ts`. Persona prompts are `src/personas/*.md`; workflow docs are `src/workflows/*.md`.

## Commands

- Offline test suite: `env -u TAI_TEST_JIRA_SITE_URL -u TAI_TEST_JIRA_EMAIL -u TAI_TEST_JIRA_API_TOKEN npm test`
- Type check: `npm run typecheck`
- Lint: `npm run lint`
- All three pass before a PR is opened.

## Conventions

- One Story branch per ticket, named `TAI-<STORY>-short-slug`. Subtasks commit onto it.
- PR title: `TAI-<STORY> - TAI-<SUBTASK> - what changed`.
- A change to the brief is written as current fact, with its history as an entry in `CHANGELOG.md`.
- A persona prompt carries no revision or ticket references; the reason for a rule goes in `src/personas/rationale/<id>.md`.
- A rule that can be checked mechanically is enforced in code or a test, not only written in a doc.
- Live tests and throwaway tickets go in the `TAIT` scratch project, never in `TAI`.

## Never

- Never commit `.env`, `.tai/` or `.handoff/`, or print a token.
- Never merge a PR without reading all of its comments first.
- Never use `force=true` on a merge or a transition unless the human says so, except for a very minor fix pushed after approval.
- Never edit code as the Code Reviewer; post findings instead.
