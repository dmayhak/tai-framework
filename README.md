# TAI (Team AI)

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**Run software delivery — Kickoff, Story, Bug, and Spike work — through a fixed roster of
AI personas, each with their own permissions, human checkpoints, and Confluence outputs,
driven against your real Jira, Confluence, and Bitbucket.**

TAI isn't a chatbot wrapper. It's a process: nine named personas (Analyst, PM, Architect,
UX Designer, Developer, DBA, Code Reviewer, Tester, DevOps) each own a slice of the
software-delivery lifecycle, hand off to each other through real Jira tickets, and stop
for a human sign-off at the points that matter (`brief §3.4` — human sign-off is the
default everywhere, not an opt-in safety net). It works against a real Jira/Confluence/
Bitbucket setup, or fully locally with no external services at all.

`PROJECT_BRIEF.md` is the single source of truth for TAI's design, decisions, and open
questions — this file only covers getting it installed, configured, and used. If anything
here and the brief ever disagree, the brief wins.

## Table of contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
  - [Quickstart: try it locally, no external services](#quickstart-try-it-locally-no-external-services)
  - [Real setup: Jira + Confluence + Bitbucket](#real-setup-jira--confluence--bitbucket)
- [Usage](#usage)
- [The personas](#the-personas)
- [Workflow types](#workflow-types)
- [Project structure](#project-structure)
- [Developing TAI itself](#developing-tai-itself)
- [Contributing](#contributing)
- [Further reading](#further-reading)
- [License](#license)

## How it works

- **A unit of work is a Jira issue** — an Epic decomposes into Stories/Bugs/Spikes/Kickoffs,
  each of which decomposes into subtasks (`Research`, `Dev`, `IntegrationTest`, …). Every
  subtask has exactly one owning persona.
- **Personas hand off through Jira, not through chat.** Asking "what's ready?" or working a
  specific ticket always starts from real Jira/Confluence state — cached locally for
  offline work, refreshed on demand — never from conversation memory alone.
- **Checkpoints are real, not cosmetic.** Some subtasks (e.g. `UAT`, `EpicReview`) are
  *inherently* human-gated — an AI persona can drive the work, but only a human can sign
  off, no matter what autocompletion settings say. Everything else defaults to requiring
  human sign-off too, unless a project explicitly configures autocompletion for it.
- **Nothing runs on a timer.** There's no background daemon watching Jira. Every step
  happens because a human (or an AI session acting for them) explicitly asks "what's
  ready?" or "work this ticket" — see [Usage](#usage) below.
- **Two storage backends, one interface.** A `filesystem` backend (the default) needs
  nothing but a local folder — good for trying TAI out or a genuinely solo project. A
  `jira` backend talks to real Jira/Confluence over their REST APIs, authenticated as your
  own account, so an AI persona only ever acts with the permissions you already have.

## Requirements

- **Node.js 24+** (this repo relies on `import.meta.main` and the native `process.loadEnvFile`).
- **[Claude Code](https://claude.com/claude-code) or [Gemini CLI](https://github.com/google-gemini/gemini-cli)** — TAI's commands are slash-command skills for either.
- For the real backend: a **Jira** site (Cloud), a **Confluence** space on the same site,
  and (optionally, for PR-driven work) a **Bitbucket** repo — each with API-token access.
  The filesystem backend needs none of this.

## Installation

TAI installs itself **once per machine**, at a fixed location (`~/.tai-framework`), and
every project on that machine shares the one install:

```bash
git clone git@bitbucket.org:dmayhak/tai-framework.git ~/.tai-framework
cd ~/.tai-framework
npm install
npx tsx src/hosts/cli.ts install-global
```

Clone it directly to `~/.tai-framework` — don't clone elsewhere and move it. `install-global`
writes global skill files for **both** Claude Code and Gemini CLI that point at this exact
clone as TAI's fixed home; it doesn't copy files anywhere.

This is a manual, one-time bootstrap by necessity: the `/tai-init`, `/tai-work`,
`/tai-ready`, `/tai-pr`, `/tai-audit`, and `/tai-groom` slash commands don't exist in your AI CLI until
`install-global` has written them, so there's nothing to run *before* this step. Once it's
done, those commands exist in every future session, in every project, on this machine —
no re-bootstrap needed, and no separate install per project.

## Configuration

### Quickstart: try it locally, no external services

The `filesystem` backend is the default — it needs nothing but a working directory and a
name for yourself. From inside any project you want to try TAI against:

```bash
export TAI_PROJECT_KEY=DEMO
export TAI_HUMAN_ID=you@example.com
export TAI_HUMAN_NAME="Your Name"
export TAI_HUMAN_EMAIL=you@example.com

npx --prefix ~/.tai-framework tsx ~/.tai-framework/src/hosts/cli.ts issue create DEMO story "Try out TAI"
npx --prefix ~/.tai-framework tsx ~/.tai-framework/src/hosts/cli.ts issue search project=DEMO
```

This creates real, locally-persisted issues under `.tai/` in your current directory (gitignore
it) — no Jira account needed. It's the same code path the real backend uses, just backed
by files instead of the Jira REST API, so everything in [Usage](#usage) below works the
same way. This is also the right mode for a genuinely solo project that will never need
Jira at all.

### Real setup: Jira + Confluence + Bitbucket

For a real target project, run `/tai-init` from inside that project's own repo. It checks
`init status`, and if the project isn't fully initialized it hands you one command to run in a
**separate terminal** (an assistant's own shell can't prompt you or open your editor, and a
token pasted into chat would go to the model provider):

```bash
cd <your project>
npx --prefix ~/.tai-framework tsx ~/.tai-framework/src/hosts/cli.ts init run
```

`init run` is one idempotent command for both a brand-new project and an **already-onboarded
project you've cloned into a new folder or onto a new PC** (a fresh clone has no `.env` or
`.tai/`, since both are gitignored). It:

1. asks for your **Atlassian site URL**;
2. writes a `.env` skeleton and opens your `$VISUAL`/`$EDITOR` so you fill in the secrets
   (Jira email + API token; for `git-pr`, a Bitbucket email + token with repo read/write and
   pull-request scopes) — secrets are only ever typed there, never into chat;
3. **discovers** the Jira project, Confluence space and Bitbucket repo live and lets you pick,
   keeping any `.env` value the live lists confirm;
4. **verifies** Jira, Confluence and Bitbucket against the real APIs, stopping at the first
   failure with a concrete to-do list (Bitbucket is skipped as N/A when you don't use
   `git-pr`);
5. writes the `CLAUDE.md` and `GEMINI.md` pointers (Claude Code and Gemini CLI each read their own)
   and reminds you to commit and push them.

Re-running is always safe: every step is re-verified live, and `.tai/init-state.json` is just a
cache it rebuilds — never copy it between clones. For a brand-new project, the one thing it
can't do is Jira admin provisioning (TAI's issue types and a `Persona` field): its to-do list
says what's missing, and the checklist below has the click-paths. Run
`npx --prefix ~/.tai-framework tsx ~/.tai-framework/src/hosts/cli.ts init status` any time to
see progress.

The full manual admin steps (exact Jira/Confluence click-paths, the complete `.env` var
reference, the Bitbucket-token scopes) live in
[`docs/target-project-setup-checklist.md`](docs/target-project-setup-checklist.md) and
[`.env.example`](.env.example) — read those before running `/tai-init` on a brand-new project,
since the Jira/Confluence provisioning steps need you to do things in the UI first.

**Environment variables at a glance** (see `.env.example` for the authoritative, fully
commented list):

| Variable | Used for | Required when |
|---|---|---|
| `TAI_PROJECT_KEY` | Jira project key (or a local project name) | Always |
| `TAI_BACKEND` | `filesystem` (default) or `jira` | Always (defaults to `filesystem`) |
| `TAI_ROOT` | Local cache/data folder | Optional, defaults to `.tai` |
| `TAI_HUMAN_ID`/`TAI_HUMAN_NAME`/`TAI_HUMAN_EMAIL` | Who's acting | `filesystem` backend |
| `TAI_SPACE_KEY` | Confluence space key (never assumed to equal `TAI_PROJECT_KEY`) | `jira` backend |
| `TAI_JIRA_SITE_URL`/`TAI_JIRA_EMAIL`/`TAI_JIRA_API_TOKEN` | Real Jira/Confluence auth | `jira` backend |
| `BITBUCKET_EMAIL`/`BITBUCKET_API_TOKEN` | Real PR create/review/merge | `git-pr`/`/tai-pr` |
| `TAI_GIT_REPOS` or `TAI_GIT_WORKSPACE` | Which repo(s) `/tai-ready` checks for open PRs | `git-pr`/`/tai-pr` |

## Usage

Everything below is a slash command inside Claude Code or Gemini CLI, once TAI is
installed and a project is configured (or you're using the filesystem quickstart above).

| Command | What it does |
|---|---|
| `/tai-init` | Set up (or check the status of) a target project — see [Configuration](#configuration). |
| `/tai-ready [persona]` | "What's ready for me/this persona to work on?" — the entry point when you don't have a specific ticket in mind. |
| `/tai-work <ISSUE-KEY>` | Load a ticket's briefing and invoke the persona that owns it — the entry point when you do. |
| `/tai-pr create\|review\|merge` | Open, review, or merge a real PR for a `Dev` subtask, using TAI's own structured-findings review flow. |
| `/tai-audit` | Report-only sweep of the open backlog for staleness/drift (stale notes, missing links, decision drift, …). |
| `/tai-kickoff [initiative]` | Start a project or a new initiative with Perry (PM): she checks what Epics and Kickoffs already exist, then creates the Epic + Kickoff Story. Needs no ticket, and works on a fresh project or one that already has Epics. |
| `/tai-groom [epic]` | Backlog grooming with Perry (PM): a briefing of the whole board, or one epic — sequence Kickoffs, schedule a first wave, promote unblocked work, assign owners. Needs no ticket; every change is proposed and applied only after you confirm. |

**A typical flow, end to end:**

```
you> /tai-ready
      → empty backlog; it tells you to run /tai-kickoff

you> /tai-kickoff <your idea>
      → Perry creates the Epic + Kickoff Story, then Ada (Analyst) does real
        discovery with you, proposes an Epic/Story breakdown, and you discuss
        and probe it together before anything downstream is created

you> /tai-ready
      → the first real Story is now unblocked and shows up here

you> /tai-work PROJ-12
      → Dario (Developer) picks up the Dev subtask, implements it, opens a PR

you> /tai-pr review
      → applies Cole (Code Reviewer)'s standard: fetches the real diff,
        produces structured findings, shows them to you, and stops — you
        decide whether to post them and whether to approve/request changes

you> /tai-pr merge
      → merges once approved and CI is green, and marks the Dev subtask Done
```

Nothing here is autonomous — see "Nothing runs on a timer" above. Each arrow in that flow
is a real command a human ran (or explicitly asked their AI CLI to run), never a
background process.

## The personas

| Persona | Name | Owns |
|---|---|---|
| Analyst | **Ada** | Requirements elicitation, research, Epic/Story decomposition, refinement |
| PM | **Perry** | PRDs, ticket creation, the Kickoff review gate, orchestration ("what's ready?") |
| Architect | **Aria** | Technical design, ADRs, feasibility |
| UX Designer | **Uma** | Flows, wireframes, mockups |
| Developer | **Dario** | Implementation, opening PRs |
| DBA | **Dana** | Schema design, migrations, query/performance work |
| Code Reviewer | **Cole** | Structured PR review (never edits code — findings only) |
| Tester | **Tessa** | Automated test tiers, driving (not signing off on) UAT |
| DevOps | **Duncan** | Infra, deployment |

Every persona's exact permissions, checkpoints, and behavior are documented in
[`src/personas/*.md`](src/personas/) — those files (plus [`src/workflows/*.md`](src/workflows/))
are what your AI CLI actually reads when you invoke a persona; this table is just an
orientation map.

## Workflow types

Every Story-level ticket is one of four types, each with its own subtask set and
precedence graph (full detail in [`src/workflows/`](src/workflows/)):

| Type | Purpose |
|---|---|
| `Kickoff` | Discovery, requirements, and UX design for a new initiative, before implementation is scheduled. |
| `Story` | The standard implementation unit — design → dev → test → deploy. |
| `Bug` | A reported defect — triage → investigate → fix, skipping Kickoff-style discovery. |
| `Spike` | A time-boxed investigation into one specific question, ending in a recommendation, not shipped code. |

## Project structure

```
PROJECT_BRIEF.md        Source of truth for TAI's design, decisions, and open questions
src/
  personas/*.md          One file per persona — permissions, behavior, when it's invoked
  workflows/*.md          One file per Story type, plus dependencies.md (precedence rules)
  core/                   Storage backends (filesystem + Jira), schema, commands
  hosts/cli.ts            The CLI every skill/command actually shells out to
docs/
  target-project-setup-checklist.md   The real Jira/Confluence/Bitbucket admin walkthrough
.env.example              The full, authoritative environment-variable reference
```

## Developing TAI itself

If you're working on `tai-framework`'s own source (not just using it against a target
project), see `PROJECT_BRIEF.md` and `CLAUDE.md`/`GEMINI.md` for the project's design and
working conventions.

```bash
npm test           # full test suite (node's own test runner)
npm run typecheck  # tsc --noEmit
npm run build      # compiles to dist/
```

## Contributing

Internally, every change to this repo ships through TAI's own real Jira ticket → branch →
PR → structured-findings review → merge pipeline (tracked in [`CHANGELOG.md`](CHANGELOG.md)) — that's this project dogfooding itself, not something external contributors
need access to. From the outside, a normal fork → branch → PR flow works fine:

1. **Read [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md) first.** It's the single source of truth
   for TAI's design, decisions, and open questions — and
   [`CHANGELOG.md`](CHANGELOG.md), its revision history, explains the reasoning behind anything that looks
   surprising (the *why*, not just the *what*).
   A change that contradicts an already-settled decision needs to either follow it or open
   the discussion to revisit it, not quietly work around it.
2. **For anything beyond a small fix, open an issue first** to discuss the approach —
   especially for anything touching [`src/personas/*.md`](src/personas/) or
   [`src/workflows/*.md`](src/workflows/), since those files are the actual behavioral
   contract an AI CLI reads at runtime, not just documentation.
3. **Fork the repo, branch, and make your change.**
4. **Before opening a PR, make sure both of these pass clean:**
   ```bash
   npm test
   npm run typecheck
   ```
5. **Open a PR against `master`** with a clear description of what changed and why,
   referencing the issue it addresses if there is one.

By contributing, you agree your contribution is licensed under this project's
[Apache License 2.0](#license).

## Further reading

- [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md) — the full design: every decision, the reasoning
  behind it, and open questions. Read this before changing how TAI itself behaves.
- [`docs/target-project-setup-checklist.md`](docs/target-project-setup-checklist.md) — the
  complete real-project admin setup walkthrough.
- [`.env.example`](.env.example) — every environment variable, fully commented.
- [`DESIGN_NOTES.md`](DESIGN_NOTES.md) — closed archival record of the original design
  discussion (rev 11 and earlier); kept for historical *why*, superseded by the brief for
  anything current.

## License

Apache License 2.0 — see [`LICENSE`](LICENSE) for the full text. Copyright 2026 Del Mayhak.
