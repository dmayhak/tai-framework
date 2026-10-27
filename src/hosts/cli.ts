#!/usr/bin/env node
/**
 * TAI Framework — host-agnostic command-layer entry point (TAI-61 ADR decision 4;
 * generalized from a Claude-Code-only location by TAI-68/TAI-67's feasibility finding
 * that nothing here was ever actually Claude-Code-specific)
 *
 * The core design insight this file implements: "invoke the owning persona" (brief §3.8)
 * is NOT a separate LLM API call — the calling host IS the LLM already running the
 * session. This CLI's whole job is to print an assembled prompt (persona instructions +
 * briefing, or the ready-work list) to stdout; each host's own thin wrapper is what turns
 * that stdout into the session's next turn — no new invocation mechanism on top of that,
 * and no host-specific logic in this file itself.
 *
 * **Wrapper location (TAI-90/126, rev — superseded the original per-project convention):**
 * both hosts' wrappers are global skills — `~/.claude/skills/tai-work/SKILL.md` and
 * `~/.gemini/skills/tai-work/SKILL.md` (same for `tai-ready`/`tai-pr`/`tai-init`/`tai-groom`/`tai-kickoff`/`tai-retro`/`tai-change`/`tai-small`/`tai-verify`/`tai-audit`/`tai-settings`/`tai-do-dev-tasks`), installed
 * once via `install-global` (below) rather than generated per-project as
 * `.claude/commands/*.md`/`.gemini/commands/*.toml`. Every command references this file by
 * its fixed install path (`~/.tai-framework/` by default), not a path relative to whatever
 * project the host happens to be running in — see `core/commands/install-global.ts`.
 *
 * Backend construction (which storage backend, from what credentials) is deliberately
 * minimal and env-var driven — nothing in the brief or either ADR (TAI-51/TAI-56/TAI-61)
 * specifies a project-config-resolution mechanism yet, so this is a first-pass convention,
 * not a settled design; revisit if a real multi-project/multi-backend need shows up.
 */

import {
    toHumanId,
    toIssueKey,
    toPageId,
    DEFAULT_SEARCH_LIMIT,
    isFlagged,
    type CreateIssueInput,
    type CreatePageInput,
    type Page,
    type PagePatch,
    type HumanRef,
    type Issue,
    type IssueFilter,
    type IssueKey,
    type CascadeWarning,
    type DocStore,
    type IssueLink,
    type IssuePatch,
    type PageRef,
    type StorageBackend,
    type WorkTracker,
} from "../core/storage/interface.js";
import { DESIGN_WITHOUT_DEV_HEADING } from "../core/storage/design-without-dev.js";
import { resolvePageParent, filePage, looseRootPages } from "../core/storage/doc-folders.js";
import { createFilesystemBackend } from "../core/storage/filesystem-backend.js";
import { createJiraBackend } from "../core/storage/jira/jira-backend.js";
import { apiTokenAuth } from "../core/storage/jira/rest-client.js";
import { prepareWorkTurn, NoOwningPersonaError } from "../core/commands/work.js";
import { briefingBudgetFromEnv, type BriefingChangeNote } from "../core/workspace/briefing.js";
import { cachePage } from "../core/cache/page-cache.js";
import { CachingWorkTracker } from "../core/cache/caching-work-tracker.js";
import { findReadyWork, findReadyPRWork, type ReadyToReviewCandidate, type WaitingToMergeCandidate } from "../core/commands/ready.js";
import {
    EPIC_CHILD_ISSUE_TYPES,
    EPIC_SUMMARY_LIVING_DOC_TYPES,
    computeEpicSummary,
    writeLivingDocSnapshot,
    type EpicSummary,
} from "../core/workspace/living-doc-staleness.js";
import { materializePrecedenceLinks } from "../core/commands/link-precedence.js";
import { renderUnreadableIssuesNote, takeUnreadableIssues } from "../core/storage/unreadable-issues.js";
import { installGlobal, defaultTaiHome, PM_KICKOFF_HINT } from "../core/commands/install-global.js";
import {
    INIT_STEPS,
    readInitState,
    markStepDone,
    isInitComplete,
    checkInitCompletion,
    verifyJiraSetup,
    setupConfluence,
    verifyBitbucketSetup,
    verifyGitHubSetup,
    writeEnvFile,
    writeClaudeMdPointer,
    writeGeminiMdPointer,
    ensureGitignore,
    type InitState,
    type InitStep,
} from "../core/commands/target-init.js";
import { runInit, unpushedChangesReminder } from "../core/commands/init-run.js";
import { createRealServices, createTerminalIO, gitStatusPorcelain } from "../core/commands/init-run-io.js";
import {
    resolvePullRequestId,
    parseReviewArgs,
    parseMergeArgs,
    parseCommentArgs,
    parseFindingsCommentArgs,
    isGreen,
    isMergeConflict,
    findLinkedIssueForPR,
    resolveStoryKeyForPr,
    validateBranchName,
    validatePrTitle,
} from "../core/commands/git-pr.js";
import {
    parseReviewFindings,
    reviewDecisionRefusal,
    hashFindings,
    unrenderedFindingsRefusal,
    unrenderedDecisionRefusal,
    renderReviewFindings,
    renderFindingsPreview,
    partitionInlineFindings,
    renderInlineComment,
} from "../core/git/review-findings.js";
import { listProjectPersonaIds, loadPersonaConfig, resolveActingPersonaId, taiCliCommand, taiInstallRoot } from "../core/persona/config.js";
import { describeTaiInstall, renderInstallWarning } from "../core/git/install-state.js";
import { grantNote } from "../core/persona/permission-gate.js";
import { postIssueComment } from "../core/storage/handoff.js";
import { wallOfTextNote } from "../core/storage/readable-text.js";
import { checkMergeGate, mergeOverrideComment } from "../core/git/merge-gate.js";
import { renderEditedAfterApproval, tryFindEditedAfterApproval } from "../core/commands/edited-after-approval.js";
import { detectExistingCode } from "../core/git/existing-code.js";
import {
    checkCommandFromEnv,
    machineName,
    mergeBlockersWithCheck,
    performLocalCheck,
    readWorkingTree,
    renderLocalCheckOutcome,
    runCheckCommand,
} from "../core/git/local-check.js";
import {
    projectContextBudgetFromEnv,
    projectContextStatus,
    readProjectContext,
    readProjectContextAtRef,
    renderProjectContext,
    renderProjectContextStatus,
    writeProjectContextTemplate,
    type ProjectContextStatus,
} from "../core/workspace/project-context.js";
import { signOffRowNote } from "../core/storage/sign-off-provenance.js";
import { reviewDecisionComment, signOffComment, stampComment, type ActingPersona } from "../core/storage/stamp.js";
import { PersonaPermissionError } from "../core/persona/scoped-work-tracker.js";
import { PersonaScopedGitHost } from "../core/persona/scoped-git-host.js";
import { createGitHostSession, hasGitHostCredentials, resolveGitHostKind, selfReviewAllowed, type GitHostSession } from "../core/git/host-factory.js";
import { detectGitRemote } from "../core/commands/discovery.js";
import { toPullRequestId, toRepoId, type GitHost, type GitMutationResult, type PullRequestComment, type PullRequestRef, type RepoId } from "../core/git/interface.js";
import { loadPrReviewers, isEligibleReviewer, githubReviewers, reviewersNotRequested } from "../core/git/pr-reviewers.js";
import { refreshLocalDefaultBranch, renderLocalFetchNote } from "../core/git/local-fetch.js";
import { gatherDiff, gatherMergedDiff, readFileAtRef, readRenderedFindings, readReviewManifest, recordRenderedFindings, renderReviewPrep, writeReviewFiles } from "../core/git/review-prep.js";
import { renderPersonaTurn } from "../core/persona/turn.js";
import {
    defaultPersonaFor,
    DependencyRelation,
    isSubtaskIssueType,
    subtaskOutsideMapNote,
    Status,
    SubtaskType,
    DEFAULT_PERSONA_DISPLAY_NAME,
    Persona,
    StoryType,
    describePersonaNames,
    resolvePersonaName,
} from "../core/schema/story-schema.js";
import { latestVerification, unverifiedCloseNote } from "../core/storage/verification.js";
import { findVerifyPullRequests, renderVerifyTurn } from "../core/commands/verify.js";
import { rebaseNeededCommentBody, hasUnresolvedRebaseMarker } from "../core/storage/rebase-marker.js";
import { isAssignmentGateReason } from "../core/storage/assignment-gate.js";
import { loadRoster, type Roster } from "../core/personas/roster.js";
import { resolveAssignment, type AssignmentResolution } from "../core/personas/assignment-helper.js";
import { areaWindowDaysFromEnv, createEvidenceCache } from "../core/personas/assignee-evidence.js";
import { suggestAssignees } from "../core/commands/suggest-assignee.js";
import { allowYoloForOneRun, showSettings, setSetting, changeAdmin, inAiSession, readSettingValue } from "../core/commands/settings.js";
import { recordAttestation } from "../core/settings/attestation.js";
import { yoloGate, yoloRun } from "../core/commands/dev-yolo-wiring.js";
import { resolve as resolvePath } from "node:path";
import { buildRunRules, missingRules, readPermissionFiles, readinessWarning, renderRulesJson } from "../core/commands/build-allow-rules.js";
import { findDevTasks, parseDevTasksArgs, resolveYolo, workDevTasks, renderDevTasksReport, findOpenPullRequest, listOpenPullRequests, titleNamesKey } from "../core/commands/do-dev-tasks.js";
import { buildDevPrompt, cliCommand, devRunTimeoutMs, runHeadlessClaude, stopRunsOnInterrupt, wasInterrupted } from "../core/commands/headless-claude.js";
import { assertCleanTree, prepareCleanDefaultBranch } from "../core/commands/dev-tasks-git.js";
import { findGroomingWork, renderGroomingBriefing, staleBacklogDaysFromEnv } from "../core/commands/groom.js";
import { findKickoffContext, renderKickoffBriefing } from "../core/commands/kickoff.js";
import { findChangeContext, parseChangeArgs, renderChangeBriefing } from "../core/commands/change.js";
import { createSmall, renderCreateSmall } from "../core/commands/create-small.js";
import { findRetroSummary, parseRetroArgs, renderRetroBriefing, retroEpicCloseHint } from "../core/commands/retro.js";

interface ResolvedConfig {
    readonly backend: StorageBackend;
    readonly taiRoot: string;
    readonly projectKey: string;
    readonly spaceKey: string;
    /** The human driving THIS session (TAI-249/260 ADR) -- a SYNTHETIC `HumanRef` (same
     *  email-derived id convention as `roster.ts`'s `parseHumanCell`), not a real Jira-
     *  resolved identity. `resolveAssignment`'s matching (`sameHuman`) only needs `id`/
     *  `email`/`displayName` to compare against roster candidates, which are themselves
     *  synthetic -- so no `workTracker.resolveHuman` call is needed here. Deliberately NOT
     *  eagerly resolved (PR #71 review, suggestion severity, fixed this session): that would
     *  cost one extra Jira API call on EVERY CLI invocation, not just `issue create`/
     *  `transition` where this is actually used. `resolveIssueAssignment` still re-resolves
     *  the real identity for whichever candidate ends up picked, same as before.
     *  `null` when no session-identity signal is available (filesystem backend with
     *  `TAI_HUMAN_EMAIL` unset) -- the shortcut simply doesn't apply then, same as today's
     *  "always ask" behavior. */
    readonly currentHuman: HumanRef | null;
    /** TAI-477: the persona this command says it is acting as (`--as <id>`), validated against the
     *  project's personas. Absent when the command did not say -- then the action is unattributed;
     *  nothing guesses. */
    readonly actingPersona?: string;
}

/** TAI-475: who the stamp names -- the `--as` persona with its built-in display name (a user-added
 *  persona, or a team's renamed one, shows its id: no Confluence read is spent on a stamp). */
export function actingPersonaOf(config: Pick<ResolvedConfig, "actingPersona">): ActingPersona | undefined {
    const id = config.actingPersona;
    if (!id) return undefined;
    return { id, displayName: (DEFAULT_PERSONA_DISPLAY_NAME as Record<string, string>)[id] ?? id };
}

/**
 * TAI-477: takes a LEADING `--as <persona>` (or `--as=<persona>`) off the CLI arguments. Only the
 * leading position is read, so the same text inside a later argument (a comment body, a title) is
 * left alone. The id's shape is checked here; whether the project has such a persona is checked
 * once the project config is loaded (`resolveActingPersonaId`).
 */
export function extractActingPersona(args: readonly string[]): { actingPersona: string | undefined; args: string[] } {
    const [first, second, ...rest] = args;
    let id: string | undefined;
    let remaining: string[];
    if (first === "--as") {
        if (second === undefined) throw new Error("--as needs a persona id, e.g. --as developer.");
        id = second;
        remaining = rest;
    } else if (first?.startsWith("--as=")) {
        id = first.slice("--as=".length);
        remaining = args.slice(1);
    } else {
        return { actingPersona: undefined, args: [...args] };
    }
    if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(id)) throw new Error(`"${id}" is not a persona id (--as takes one, e.g. --as developer).`);
    return { actingPersona: id, args: remaining };
}

// Loads `.env` from the current working directory into `process.env`, if present —
// optional (a real shell profile export works just as well; see `.env.example`), so a
// missing file is not an error. Node's own `process.loadEnvFile` (stable since v21.7,
// this repo runs v24+) rather than the `dotenv` package — keeps the repo at the zero
// runtime dependencies both the TAI-12 and TAI-33 ADRs deliberately committed to for
// exactly this class of "small, native-platform-covered" need.
function loadDotEnv(): void {
    try {
        process.loadEnvFile();
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
}

/**
 * The current human's REAL git-host identity (TAI-213/214, found live 2026-08-26) —
 * resolved through the git host itself, not synthesized from the configured email. A
 * `PullRequestRef`'s own reviewer/participant entries carry the git host's real identity
 * fields (Bitbucket: `account_id`/`display_name`, no email at all) — a `{ id: email,
 * displayName: email }` construction can never match those via `sameHuman`, which is
 * exactly what silently broke `readyToReview` (every open PR looked undecided, even ones
 * the current human had already approved). `email` is merged in afterward since it's still
 * needed for roster/eligibility matching against Confluence-sourced `HumanRef`s, which the
 * git host's own identity doesn't carry (Bitbucket users have no email, for privacy).
 */
async function resolveCurrentHuman(gitHost: Pick<GitHost, "getCurrentUser">, email: string | undefined): Promise<HumanRef> {
    const real = await gitHost.getCurrentUser();
    return email ? { ...real, email } : real;
}

/**
 * Who a git-host action was taken as: the account's own name, then the email that matched the PR
 * Reviewers page. On GitHub that email is the session's own (a GitHub token carries none), so the
 * name is what tells two accounts apart (found live, TAI-585).
 */
export function actingHumanLabel(human: Pick<HumanRef, "displayName" | "email">): string {
    if (!human.email) return human.displayName;
    return human.displayName.toLowerCase() === human.email.toLowerCase() ? human.email : `${human.displayName} (${human.email})`;
}

/** TAI-583 ADR: which git host this project uses, from `TAI_GIT_HOST` or else `origin`'s remote. */
async function currentGitHostKind() {
    return resolveGitHostKind(process.env, async () => (await detectGitRemote(process.cwd()))?.kind ?? null);
}

/** The project's git-host backend (TAI-583 ADR). Throws, naming the variable, when a credential is missing. */
async function gitHostSession(config: Pick<ResolvedConfig, "currentHuman"> | null): Promise<GitHostSession> {
    return createGitHostSession(await currentGitHostKind(), process.env, config?.currentHuman?.email);
}

/**
 * A synthetic `HumanRef` for `email`, same id convention `roster.ts`'s `parseHumanCell`
 * uses (lowercased email as the id) -- good enough for `sameHuman` matching against roster
 * candidates without a real backend lookup. See `ResolvedConfig.currentHuman`'s doc comment
 * for why `resolveConfig` uses this instead of `workTracker.resolveHuman`.
 */
function syntheticHuman(email: string): HumanRef {
    return { id: toHumanId(email.toLowerCase()), displayName: email, email };
}

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable ${name}.`);
    }
    return value;
}

/**
 * TAI-304/311 ADR (Confluence page 39518210): wraps `backend.workTracker` in
 * `CachingWorkTracker` here, once, for both backend kinds -- not ad hoc per call site the
 * way `ConnectivityQueuedWorkTracker`/`PersonaScopedWorkTracker` are composed in
 * `work.ts`. Every caller starting from `config.backend.workTracker` (this file's own
 * mutation handlers, `git-pr merge`, `ready.ts`'s sync helpers, `work.ts`'s
 * further-decorated instance, and `replayPending`'s `inner` argument) is caching-aware as
 * a result, cascades included, with no changes needed at any of those call sites.
 */
function withCachingWorkTracker(backend: StorageBackend, taiRoot: string, projectKey: string): StorageBackend {
    return { ...backend, workTracker: new CachingWorkTracker(backend.workTracker, taiRoot, projectKey) };
}

/**
 * The project's own persona ids, for the rules an unattended build needs (TAI-649): a deny that spells out every `--as` name
 * has to know them. A personas page that cannot be read leaves the built-in names only, never a failed command.
 */
async function projectPersonaIdsOrNone(config: ResolvedConfig): Promise<string[]> {
    try {
        return await listProjectPersonaIds(config.backend.docStore, { spaceKey: config.spaceKey });
    } catch {
        return [];
    }
}

async function resolveConfig(): Promise<ResolvedConfig> {
    const taiRoot = process.env["TAI_ROOT"] ?? ".tai";
    const projectKey = requireEnv("TAI_PROJECT_KEY");
    const backendKind = process.env["TAI_BACKEND"] ?? "filesystem";

    if (backendKind === "jira") {
        const spaceKey = requireEnv("TAI_SPACE_KEY");
        const jiraEmail = requireEnv("TAI_JIRA_EMAIL");
        const backend = await createJiraBackend({
            siteUrl: requireEnv("TAI_JIRA_SITE_URL"),
            spaceKey,
            auth: apiTokenAuth(jiraEmail, requireEnv("TAI_JIRA_API_TOKEN")),
        });
        const currentHuman = syntheticHuman(jiraEmail);
        return {
            backend: withCachingWorkTracker(backend, taiRoot, projectKey),
            taiRoot,
            projectKey,
            spaceKey,
            currentHuman,
        };
    }

    if (backendKind === "filesystem") {
        // spaceKey === projectKey by convention — the filesystem backend has no
        // independent Confluence-space concept (brief §4 rev 18; see its own header comment).
        const humanEmail = process.env["TAI_HUMAN_EMAIL"];
        const backend = createFilesystemBackend(taiRoot, {
            id: toHumanId(requireEnv("TAI_HUMAN_ID")),
            displayName: process.env["TAI_HUMAN_NAME"] ?? requireEnv("TAI_HUMAN_ID"),
            ...(humanEmail ? { email: humanEmail } : {}),
        });
        const currentHuman = humanEmail ? syntheticHuman(humanEmail) : null;
        return {
            backend: withCachingWorkTracker(backend, taiRoot, projectKey),
            taiRoot,
            projectKey,
            spaceKey: projectKey,
            currentHuman,
        };
    }

    throw new Error(`Unknown TAI_BACKEND "${backendKind}" — expected "jira" or "filesystem".`);
}

/** The Persona Roster, read once per CLI run (a create needs it for the assignment AND for the ranked list). */
const rosterByConfig = new WeakMap<ResolvedConfig, Promise<Roster>>();
function loadProjectRoster(config: ResolvedConfig): Promise<Roster> {
    let roster = rosterByConfig.get(config);
    if (!roster) {
        roster = loadRoster(config.backend.docStore, { spaceKey: config.spaceKey, projectKey: config.projectKey });
        rosterByConfig.set(config, roster);
    }
    return roster;
}

/**
 * Loads the Persona Roster and resolves an assignment for `persona` via the
 * assignment-helper (TAI-249/260 ADR) — shared by `issue create`'s pre-assign path and
 * `issue transition`'s gate-retry path so the roster-load-plus-resolve logic exists once,
 * not duplicated at each call site.
 *
 * `resolveAssignment` itself is pure and roster-sourced, so any `assignee` it returns
 * carries the Persona Roster's own SYNTHETIC id (email, lowercased — `roster.ts`'s
 * `parseHumanCell`, since the roster has no real Jira accountId at all). Sending that
 * straight to `createIssue`/`assignIssue` fails Jira's assignee validation (confirmed
 * live: "assignee: Please select a valid user") — the exact reason `issue assign` already
 * re-resolves through `workTracker.resolveHuman` instead of using a synthetic HumanRef
 * directly. Same fix applied here: re-resolve whatever candidate was picked to its REAL
 * Jira identity before returning it. A candidate with no email at all (a bare-name roster
 * entry) or no matching real Jira user can't be resolved this way — treated as
 * unresolved, falling through to candidate-surfacing, not a crash.
 */
async function resolveIssueAssignment(
    config: ResolvedConfig,
    persona: Persona,
    options: { readonly atCreate?: boolean } = {}
): Promise<AssignmentResolution> {
    const roster = await loadProjectRoster(config);
    const resolved = resolveAssignment(roster, persona, config.currentHuman, options);
    if (!resolved.assignee) return resolved;

    const real = resolved.assignee.email ? await config.backend.workTracker.resolveHuman(resolved.assignee.email) : null;
    return { assignee: real, candidates: resolved.candidates };
}

/** The subtask types whose owner opens a PR of its own but never merges it: the test tiers (Tester) and `Database`
 *  (DBA). Merging one resolves permission through the sibling `Dev` below. */
const OWN_PR_SUBTASK_TYPES: ReadonlySet<string> = new Set([
    SubtaskType.IntegrationTest,
    SubtaskType.SystemTest,
    SubtaskType.E2ETest,
    SubtaskType.Database,
]);

/**
 * TAI-314/315/316 ADR (Confluence page 40304641): a test-tier subtask's own `persona`
 * field is `tester`, who has no `mergePullRequest` grant (no self-merge for Tester,
 * `tester.md`'s own explicit decision); a `Database` subtask's is `dba`, who has none
 * either (TAI-614) — so MERGING one resolves permission via its
 * sibling `Dev` subtask's persona instead (normally `developer`), falling back to the
 * parent Story's own `persona` field if no sibling `Dev` exists. Every other issue type,
 * and every non-merge action (`create` in particular — Tester's own `createPullRequest`
 * grant is exactly what should apply there), resolves via its own `persona` field
 * unchanged; this is why the caller only sets `forMerge` for the `merge` action.
 */
export async function resolveMergePersona(
    workTracker: Pick<WorkTracker, "search" | "getIssue">,
    projectKey: string,
    issue: Issue
): Promise<Persona | null | undefined> {
    if (!OWN_PR_SUBTASK_TYPES.has(issue.issueType) || !issue.parentKey) return issue.persona;

    const siblings = await workTracker.search({
        projectKey,
        parentKey: issue.parentKey,
        issueTypes: [SubtaskType.Dev],
    });
    if (siblings[0]?.persona) return siblings[0].persona;

    const parent = await workTracker.getIssue(issue.parentKey);
    return parent?.persona ?? issue.persona;
}

/**
 * Resolves a `PersonaScopedGitHost` for `issueKey`'s owning persona (TAI-73) — same
 * identity-resolution shape `prepareWorkTurn` already uses for `WorkTracker` (the issue's
 * own `persona` field, brief §5.6), applied to the git-hosting sibling interface. Requires
 * `BITBUCKET_EMAIL`/`BITBUCKET_API_TOKEN` — only demanded here, not in `resolveConfig`, so
 * `work`/`ready` never need Bitbucket credentials at all.
 *
 * `forMerge` (TAI-314/315/316): set only for the `merge` action — redirects a test-tier
 * subtask's permission resolution to its sibling `Dev`'s persona (see
 * `resolveMergePersona`). `issue` in the returned value is always the ORIGINAL
 * `issueKey`'s own issue, regardless of which persona actually granted permission.
 */
async function resolveGitHost(
    config: ResolvedConfig,
    issueKey: string,
    options: { readonly forMerge?: boolean } = {}
): Promise<{ readonly gitHost: PersonaScopedGitHost; readonly personaId: string; readonly issue: Issue }> {
    const key = toIssueKey(issueKey);
    const issue = await config.backend.workTracker.getIssue(key);
    if (!issue) throw new Error(`${key}: no such issue.`);

    const persona = options.forMerge
        ? await resolveMergePersona(config.backend.workTracker, config.projectKey, issue)
        : issue.persona;
    if (!persona) throw new NoOwningPersonaError(key);

    const personaConfig = await loadPersonaConfig(config.backend.docStore, persona, {
        spaceKey: config.spaceKey,
    });

    const { backend } = await gitHostSession(config);

    return { gitHost: new PersonaScopedGitHost(backend.gitHost, personaConfig), personaId: personaConfig.id, issue };
}

/**
 * Resolves who's allowed to run `git-pr review` (rev 52, TAI-159 ADR — see the AskUserQuestion-
 * confirmed decision this implements): authorization is no longer "does this issue's persona
 * hold reviewPullRequest" (there's no CodeReview subtask left to carry that persona context)
 * — it's "is the current human (BITBUCKET_EMAIL) on the PR Reviewers roster." Throws the same
 * fail-loudly way `resolveGitHost`/`PersonaPermissionError` do elsewhere on a real rejection,
 * rather than silently letting an ineligible human review. Returns a plain, unscoped `GitHost`
 * — no `PersonaScopedGitHost` wrapper, since the roster check above already IS the
 * authorization gate for this action.
 */
async function resolveReviewerGitHost(
    config: ResolvedConfig
): Promise<{ readonly gitHost: GitHost; readonly currentHuman: HumanRef }> {
    const { backend, email } = await gitHostSession(config);
    const currentHuman = await resolveCurrentHuman(backend.gitHost, email);

    const reviewers = await loadPrReviewers(config.backend.docStore, { spaceKey: config.spaceKey, projectKey: config.projectKey });
    if (!isEligibleReviewer(reviewers, currentHuman)) {
        throw new Error(
            `${email ?? currentHuman.displayName} is not on the "PR Reviewers" roster — only listed humans may run git-pr review (rev 52, TAI-159 ADR). ` +
                `Add them to the roster page, or have an already-eligible reviewer perform this review instead.`
        );
    }

    return { gitHost: backend.gitHost, currentHuman };
}

/**
 * Best-effort GitHost + repo list (+ rev 52's readyToReview/readyToMerge inputs) for
 * `/tai-ready`'s PR-awareness path (TAI-107/108) — `undefined` (never a throw) when
 * Bitbucket credentials or `TAI_GIT_REPOS` aren't configured, so `/tai-ready` keeps
 * working with zero GitHost awareness exactly as it always has (same "only demanded
 * where actually needed" posture as `resolveGitHost`).
 *
 * `TAI_GIT_REPOS` (comma-separated `workspace/repo` entries) rather than deriving repos
 * from Jira's Component field: no Component->RepoId mapping exists anywhere in this
 * codebase yet, and this project itself is single-repo — building that mapping is a
 * separate need to solve if/when a real multi-repo project actually hits it (brief's own
 * repeated "don't build ahead of an observed need" stance).
 *
 * `TAI_GIT_WORKSPACE` (TAI-162/TAI-163 ADR): an optional companion env var that discovers
 * every repo in the named Bitbucket workspace via `GitHost.listRepositories`, coexisting
 * ADDITIVELY with `TAI_GIT_REPOS` rather than replacing it — set alone, it scans the whole
 * workspace; set together with `TAI_GIT_REPOS`, the discovered list is narrowed to that
 * explicit subset; `TAI_GIT_REPOS` alone is unchanged from before this ADR (no discovery
 * call at all). Discovered fresh on every call, same "no persisted cache" posture as the
 * rest of this function.
 *
 * rev 52 (TAI-159 ADR): `currentHuman` reuses `BITBUCKET_EMAIL` directly — no new
 * "current user" concept needed (brief §3.2's "acts with exactly the authority of the
 * human driving it"). `requiredApprovals` is an optional TAI-side setting
 * (`TAI_PR_REQUIRED_APPROVALS`), not a live Bitbucket branch-restrictions query — see the
 * ADR for why. `prReviewers` degrades to `undefined` (readyToReview simply stays empty)
 * rather than throwing when the "PR Reviewers" Confluence page doesn't exist yet — unlike
 * the Persona Roster, an absent PR Reviewers page shouldn't break `/tai-ready` entirely.
 */
async function tryResolveReadyGitDeps(
    config: ResolvedConfig
): Promise<
    | {
          readonly gitHost: GitHost;
          readonly repos: readonly RepoId[];
          readonly requiredApprovals?: number;
          readonly checkRequired?: boolean;
          readonly currentHuman?: HumanRef;
          readonly prReviewers?: readonly HumanRef[];
          readonly authorMayReview?: boolean;
      }
    | undefined
> {
    const reposEnv = process.env["TAI_GIT_REPOS"];
    const workspaceEnv = process.env["TAI_GIT_WORKSPACE"];
    if (!reposEnv && !workspaceEnv) return undefined;
    const kind = await currentGitHostKind();
    if (!hasGitHostCredentials(kind, process.env)) return undefined;

    const explicitRepos = reposEnv
        ? reposEnv
              .split(",")
              .map((r) => r.trim())
              .filter((r) => r.length > 0)
              .map(toRepoId)
        : undefined;

    const { backend, email } = createGitHostSession(kind, process.env, config.currentHuman?.email);

    // TAI-163 ADR: TAI_GIT_WORKSPACE discovers every repo in the workspace by default;
    // TAI_GIT_REPOS, if also set, narrows that discovered list down to a subset rather than
    // being replaced by it (a restriction, not an addition).
    let repos: readonly RepoId[];
    if (workspaceEnv) {
        const discovered = (await backend.gitHost.listRepositories(workspaceEnv)).map((r) => r.id);
        repos = explicitRepos ? discovered.filter((id) => explicitRepos.includes(id)) : discovered;
    } else {
        repos = explicitRepos ?? [];
    }
    if (repos.length === 0) return undefined;

    const currentHuman = await resolveCurrentHuman(backend.gitHost, email);

    const requiredApprovalsEnv = process.env["TAI_PR_REQUIRED_APPROVALS"];
    const requiredApprovals = requiredApprovalsEnv ? Number(requiredApprovalsEnv) : undefined;

    let prReviewers: readonly HumanRef[] | undefined;
    try {
        prReviewers = await loadPrReviewers(config.backend.docStore, {
            spaceKey: config.spaceKey,
            projectKey: config.projectKey,
        });
    } catch {
        prReviewers = undefined;
    }

    return {
        gitHost: backend.gitHost,
        repos,
        ...(requiredApprovals !== undefined ? { requiredApprovals } : {}),
        // TAI-534: with a check command configured, ready-to-merge needs a result on the commit too.
        checkRequired: checkCommandFromEnv() !== null,
        currentHuman,
        ...(prReviewers ? { prReviewers } : {}),
        // TAI-585: GitHub refuses an author's own approval unless TAI_PR_SELF_REVIEW records it as a self-review.
        authorMayReview: kind !== "github" || selfReviewAllowed(process.env),
    };
}

function renderPullRequestRef(pr: PullRequestRef, personaId: string, linkedIssueKey?: string): string {
    const lines = [
        `# PR ${pr.id} (as ${personaId})`,
        "",
        `**${pr.title}**`,
        `${pr.sourceBranch} → ${pr.destinationBranch} · ${pr.state}`,
        pr.url,
    ];
    if (linkedIssueKey) {
        lines.push("", `Linked to ${linkedIssueKey}.`);
    }
    return lines.join("\n");
}

/** TAI-462: what `git-pr merge` prints when the merge gate is not met. Nothing was merged. */
export function renderMergeRefused(blockers: readonly string[], personaId: string): string {
    return [
        `# Merge refused (as ${personaId})`,
        "",
        "Nothing was merged. The merge gate is not met:",
        "",
        ...blockers.map((b) => `- ${b}`),
        "",
        "Get what is missing (a fresh approval, the request-changes withdrawn, the tier finished, the UAT signed off) and run the merge again. " +
            "To merge anyway, add `force=true`: it leaves a stamped override comment on the PR. Use it for a very minor " +
            "fix pushed after the approval (a typo or wording, no behavior change); for anything else, only when the human says so.",
    ].join("\n");
}

/** `TAI_PR_REQUIRED_APPROVALS`, when set to something usable (shared by `/tai-ready` and the merge gate). */
function requiredApprovalsFromEnv(): { readonly requiredApprovals?: number } {
    const n = Number(process.env["TAI_PR_REQUIRED_APPROVALS"]);
    return process.env["TAI_PR_REQUIRED_APPROVALS"] && Number.isFinite(n) && n >= 0 ? { requiredApprovals: n } : {};
}

function renderGitMutationResult(
    result: GitMutationResult,
    personaId: string,
    closedIssueKey?: string,
    rebaseCommentPostedOn?: string
): string {
    if (result.ok) {
        const lines = [renderPullRequestRef(result.pullRequest, personaId)];
        // rev 52 (TAI-159 ADR §4; generalized TAI-293): a Dev subtask, OR a governance-
        // content Story/Bug/Spike/Epic ticket, stays In Progress until its PR merges —
        // this is the self-closing trigger, a second write in the same command (same
        // shape `git-pr create`'s PR+link already has). `undefined` (no line at all) when
        // no linked issue was found (best-effort — see `findLinkedIssueForPR`).
        if (closedIssueKey) lines.push("", `${closedIssueKey} transitioned to Done (its PR just merged).`);
        if (result.note) lines.push("", `Note: ${result.note}`);
        return lines.join("\n");
    }
    const lines = [`# Merge denied (as ${personaId})`, "", result.reason];
    // TAI-217/219: a merge-conflict denial specifically — posted a "Rebase needed:" comment
    // on the linked issue (best-effort, same correlation as the success path above), and
    // surfaces `git-pr unapprove` as a SUGGESTION only — never run automatically, a
    // mutation needs the human's own explicit next instruction like every other one here.
    if (rebaseCommentPostedOn) {
        lines.push(
            "",
            `Posted a "Rebase needed:" comment on ${rebaseCommentPostedOn}. If this PR was already ` +
                "approved, that approval predates the conflict — consider `git-pr unapprove` before " +
                "it's re-reviewed and re-approved."
        );
    }
    return lines.join("\n");
}

/** TAI-285 ADR: renders one line per out-of-band change note — mild for "content", a
 *  prominent warning (telling the acting persona to pause and confirm with the human
 *  before proceeding on possibly-invalid assumptions) for "structural" — same
 *  "informational note prepended before the real output" shape as TAI-282's
 *  `renderLocalFetchNote`. `undefined` when there's nothing to mention. Names exactly
 *  which field(s) changed (PR #85 review — TAI-290) rather than listing every possible
 *  cause generically, so the warning is actually actionable. */
export function renderChangeNotes(notes: readonly BriefingChangeNote[]): string | undefined {
    if (notes.length === 0) return undefined;
    return notes
        .map((n) => {
            const fields = n.fields.join(", ");
            return n.severity === "structural"
                ? `⚠️ ${n.key}'s ${fields} changed since it was last read here — ` +
                  `confirm with the human before proceeding on assumptions that may no longer hold.`
                : `(note: ${n.key}'s ${fields} changed since it was last read here — worth a fresh look.)`;
        })
        .join("\n");
}

/** TAI-395: a grooming turn is the same shape as a work turn -- persona heading, her instructions, `---`, the briefing. */
export function renderGroomTurn(persona: { displayName: string; id: string; prompt: string }, briefing: string, projectContext?: string): string {
    return renderPersonaTurn(persona, briefing, projectContext);
}

/** TAI-450: a kickoff turn is the same shape too -- persona heading, her instructions, `---`, the briefing. */
export function renderKickoffTurn(persona: { displayName: string; id: string; prompt: string }, briefing: string, projectContext?: string): string {
    return renderPersonaTurn(persona, briefing, projectContext);
}

/**
 * TAI-478: the note for an `issue create` or a close made as a persona (`--as`) whose doc grants it
 * no `create`/`complete` for that type. Best effort and never a refusal: a persona config that cannot
 * be loaded just means no note. Without `--as` nobody is acting, so there is nothing to compare.
 */
async function actingGrantNote(config: ResolvedConfig, action: "create" | "complete", issueType: Issue["issueType"]): Promise<string | null> {
    if (!config.actingPersona) return null;
    try {
        const persona = await loadPersonaConfig(config.backend.docStore, config.actingPersona, { spaceKey: config.spaceKey });
        return grantNote(persona, action, issueType);
    } catch {
        return null;
    }
}

/**
 * TAI-479: the note for a just-created ticket whose subtask type its parent does not list, or `null`.
 * A note, never a refusal, and best effort: a ticket that is not a subtask, has no parent, or whose
 * parent cannot be read gets none. `parentAlreadyRead` is the parent when the caller has read it
 * (`null` = read and not found); `undefined` means not read yet, and only then is `fetchParent`
 * called, so one create reads its parent at most once.
 */
export async function createdSubtaskMapNote(
    issue: Pick<Issue, "issueType" | "parentKey">,
    parentAlreadyRead: Pick<Issue, "issueType"> | null | undefined,
    fetchParent: (key: IssueKey) => Promise<Pick<Issue, "issueType"> | null>
): Promise<string | null> {
    const parentKey = issue.parentKey;
    if (!parentKey || !isSubtaskIssueType(issue.issueType)) return null;
    const parent = parentAlreadyRead !== undefined ? parentAlreadyRead : await fetchParent(parentKey).catch(() => null);
    return parent ? subtaskOutsideMapNote(issue.issueType, parent.issueType) : null;
}

/** TAI-527: the PR's current head for the findings preview; `null` when the PR is not found. Throws when the host cannot be reached. */
async function previewLiveCommit(config: ResolvedConfig, reviewOf: { readonly repo: string; readonly pr: string }): Promise<string | null> {
    const { gitHost } = await resolveReviewerGitHost(config);
    return (await gitHost.getPullRequest(toRepoId(reviewOf.repo), toPullRequestId(reviewOf.pr)))?.sourceCommit ?? null;
}

/** TAI-527: why findings written for one PR may not be posted on another, or `null` when they match. */
export function reviewOfMismatch(reviewOf: { readonly repo: string; readonly pr: string }, repo: string, prId: string): string | null {
    if (reviewOf.repo.toLowerCase() === repo.toLowerCase() && reviewOf.pr === prId) return null;
    return `These findings say they review ${reviewOf.repo} PR ${reviewOf.pr}, not ${repo} PR ${prId}. Nothing was posted. Post them on the PR they were written for, or review this one.`;
}

/** TAI-522 ADR decision 4: one line when TAI itself is not running from its default branch. */
async function installWarning(): Promise<string | undefined> {
    return renderInstallWarning(await describeTaiInstall(taiInstallRoot()));
}

/** The notes that go ahead of a persona turn's `# Persona:` heading, each as its own paragraph. */
export function withTurnNotes(notes: readonly (string | undefined)[]): string {
    const present = notes.filter((n): n is string => n !== undefined && n !== "");
    return present.length === 0 ? "" : `${present.join("\n\n")}\n\n`;
}

/** TAI-470: the target project's own rules file, rendered for a persona turn; `undefined` when the project has none. */
async function loadProjectContextSection(): Promise<string | undefined> {
    return renderProjectContext(await readProjectContext(process.cwd()), projectContextBudgetFromEnv());
}

/** TAI-488: where the workflow docs for this ticket are, so "see workflows/story.md" can be followed
 *  from a target project. Named, not inlined: the persona reads one when it needs it. */
export function renderWorkflowDocs(docs: Awaited<ReturnType<typeof prepareWorkTurn>>["workflowDocs"]): string {
    return ["## Workflow docs for this ticket", "", "Read on demand:", "", ...docs.map((d) => `- ${d.label}: \`${d.path}\``)].join("\n");
}

function renderWorkTurn(turn: Awaited<ReturnType<typeof prepareWorkTurn>>, projectContext?: string): string {
    const lines = [`# Persona: ${turn.personaDisplayName} (${turn.personaId})`, ""];

    const changeNotesText = renderChangeNotes(turn.changeNotes);
    if (changeNotesText) lines.push(changeNotesText, "");

    const { replayed, stillQueued, escalated } = turn.replayOutcome;
    if (replayed > 0 || stillQueued > 0 || escalated.length > 0) {
        lines.push(`_Offline write replay: ${replayed} replayed, ${stillQueued} still queued._`, "");
        for (const e of escalated) {
            lines.push(`**Escalation:** queued ${e.method} from ${e.timestamp} failed to replay: ${e.reason}`, "");
        }
    }

    lines.push(turn.personaPrompt, "", "---", "", ...(projectContext ? [projectContext, ""] : []), renderWorkflowDocs(turn.workflowDocs), "", turn.briefingMarkdown);
    return lines.join("\n");
}

/**
 * TAI-182: one continuous counter across every ACTIONABLE section below (never
 * "Already in flight" — display-only, brief §7) so a human/persona can reply with a bare
 * number as shorthand for that line's key/action instead of retyping a full issue key or
 * PR URL. `next()` is called in section/list order, so numbering is stable for a given
 * result — not sorted or deduped independently of render order.
 */
function numberedLines(): { next: () => number } {
    let n = 0;
    return { next: () => ++n };
}

/**
 * TAI-244/245: within a section, list subtask-level tickets ("Tasks" — what a human
 * usually picks) before Story-level tickets ("Stories" — kept for PM reference/context,
 * e.g. what a Task's parent is, rather than because they're usually picked directly).
 * Input is assumed already priority-sorted (ready.ts does this); partitioning with a
 * plain filter preserves that order within each bucket, so no re-sort is needed here.
 */
function splitTasksAndStories<T>(
    items: readonly T[],
    issueTypeOf: (item: T) => StoryType | SubtaskType | "epic"
): { tasks: T[]; stories: T[] } {
    const tasks: T[] = [];
    const stories: T[] = [];
    for (const item of items) {
        (isSubtaskIssueType(issueTypeOf(item)) ? tasks : stories).push(item);
    }
    return { tasks, stories };
}

/** "ux-design" -> "UxDesign": the subtask type names people actually say (and Jira shows). */
function subtaskTypeLabel(type: SubtaskType): string {
    return type.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/** TAI-564: the line under "Approved PRs waiting on something". It carries the merge gate's own sentences and offers
 *  no merge command: picking its number only shows the PR and what it waits on. */
const WAITING_INTRO = ["_Show-only: nothing here can be merged yet. Picking one shows what the merge gate still needs._"];
export function waitingLine(n: number, c: WaitingToMergeCandidate): string {
    return `${n}. **${c.issueKey}** — ${c.pullRequest.url} — waiting on: ${c.blockers.join(" ")}`;
}

/** TAI-563: one "PRs ready for your review" line. A PR the human already decided on but that has new commits since says
 *  so, and gives both commits and the diff between them, so it is not mistaken for a first review. */
export function reviewLine(c: ReadyToReviewCandidate): string {
    const pr = c.pullRequest;
    let mark = "";
    if (c.reReview) {
        const { decision, commit, since, unreadable } = c.reReview;
        const did = decision === "approved" ? "approved" : "requested changes";
        if (unreadable) mark = ` — **re-review**: you ${did} earlier, and the PR's history could not be read to tell what changed since (now ${commit})`;
        else if (since) mark = ` — **re-review**: you ${did} at ${since}, now ${commit} (\`git diff ${since}..${commit}\`)`;
        else mark = ` — **re-review**: you ${did} before the latest commit (${commit}); the history does not show which commit that was`;
    }
    return `${pr.url} (${pr.sourceBranch} → ${pr.destinationBranch})${mark} — review it with \`git-pr review-prep ${pr.repo} ${pr.id}\``;
}

/** "A", "A and B", "A, B and C". */
function joinSubtaskTypeLabels(types: readonly SubtaskType[]): string {
    const labels = types.map(subtaskTypeLabel);
    return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export function renderReadyWork(result: Awaited<ReturnType<typeof findReadyWork>>, persona?: string): string {
    const lines: string[] = [`# Ready work${persona ? ` for ${persona}` : ""}`, ""];
    const counter = numberedLines();
    let actionableCount = 0;

    // TAI-266 (TAI-243 ADR): a soft, informational suffix -- never excludes anything from
    // either section below, never blocks `/tai-work` (ADR decision #4). Renders alongside
    // (not instead of) the rebase-conflict flag below -- an item could carry both at once.
    const blockedFlag = (key: IssueKey) => {
        const blockers = result.blockedBy.get(key);
        return blockers && blockers.length > 0 ? ` ⚠️ blocked by ${blockers.join(", ")} (open)` : "";
    };

    // TAI-419 (ADR decision 13c): an unassigned ready ticket shows the single best suggestion with its reason; the
    // full ranked list is `issue suggest <KEY>` (and /tai-groom). Informational only.
    const assigneeSuggestionNote = (key: IssueKey) => {
        const suggestion = result.assigneeSuggestions.get(key);
        return suggestion ? ` — needs an assignee — suggest: ${suggestion}` : "";
    };

    // TAI-196/200: top section — already-started work, split out from genuinely-not-started
    // Ready Work below. A Dev subtask with an open PR is ALWAYS In Progress (rev 52 — it
    // stays open until the PR merges), so this is the only place the TAI-217/219
    // rebase-conflict flag can ever apply — unlike the TAI-266 blocked flag just above,
    // which applies to both this section and Ready Work below (ADR decision #3).
    // TAI-569: a verified Story or Bug with nothing open is waiting only for a human to close it, so it is listed in its own
    // section below, not under In Progress with work that is still being done.
    const stillInProgress = result.inProgress.filter((c) => !result.readyToClose.has(c.issue.key));
    if (stillInProgress.length > 0) {
        lines.push("## In Progress", "");
        const renderInProgressLine = (c: (typeof result.inProgress)[number]) => {
            const rebaseFlag = hasUnresolvedRebaseMarker(c.issue) ? " ⚠️ needs rebase (merge conflicts)" : "";
            const parentNote = c.issue.parentKey ? `, parent: ${c.issue.parentKey}` : "";
            lines.push(
                `${counter.next()}. **${c.issue.key}** [${c.issue.issueType}] ${c.issue.summary} ` +
                    `(persona: ${c.issue.persona ?? "none"}, priority: ${c.issue.priority ?? "none"}${parentNote})${rebaseFlag}${blockedFlag(c.issue.key)}${isFlagged(c.issue) ? ` ${FLAG_MARKER}` : ""}${result.notVerified.has(c.issue.key) ? " ⚠️ not verified" : ""}${signOffRowNote(c.issue)}`
            );
            actionableCount++;
        };
        const { tasks: inProgressTasks, stories: inProgressStories } = splitTasksAndStories(
            stillInProgress,
            (c) => c.issue.issueType
        );
        if (inProgressTasks.length > 0) {
            lines.push("### Tasks", "");
            inProgressTasks.forEach(renderInProgressLine);
            if (inProgressStories.length > 0) lines.push("");
        }
        if (inProgressStories.length > 0) {
            lines.push("### Stories", "");
            inProgressStories.forEach(renderInProgressLine);
        }
        lines.push("");
    }

    // TAI-373: a hint is actionable, so "Nothing is currently ready to start." must not be printed beside one --
    // with nothing else ready the hints section below stands alone (no empty Ready Work heading).
    const hasHints = result.unblockedSubtaskHints.length > 0 || result.designWithoutDev.length > 0;
    if (result.ready.length > 0 || !hasHints) lines.push("## Ready Work", "");
    if (result.ready.length === 0) {
        if (!hasHints) lines.push("Nothing is currently ready to start.");
    } else {
        const renderReadyLine = (issue: (typeof result.ready)[number]) => {
            const parentNote = issue.parentKey ? `, parent: ${issue.parentKey}` : "";
            lines.push(
                `${counter.next()}. **${issue.key}** [${issue.issueType}] ${issue.summary} ` +
                    `(persona: ${issue.persona ?? "none"}, priority: ${issue.priority ?? "none"}${parentNote})${blockedFlag(issue.key)}` +
                    assigneeSuggestionNote(issue.key) +
                    signOffRowNote(issue)
            );
            actionableCount++;
        };
        const { tasks: readyTasks, stories: readyStories } = splitTasksAndStories(result.ready, (issue) => issue.issueType);
        if (readyTasks.length > 0) {
            lines.push("### Tasks", "");
            readyTasks.forEach(renderReadyLine);
            if (readyStories.length > 0) lines.push("");
        }
        if (readyStories.length > 0) {
            lines.push("### Stories", "");
            readyStories.forEach(renderReadyLine);
        }
    }
    // TAI-373: Kickoff Stories whose precedence now allows subtasks that do not exist yet. Nothing is created
    // automatically -- the next /tai-work on the Story re-engages the PM, who judges and creates them.
    if (result.unblockedSubtaskHints.length > 0) {
        lines.push("", "## Subtasks ready to create", "");
        for (const hint of result.unblockedSubtaskHints) {
            const owner = DEFAULT_PERSONA_DISPLAY_NAME[(hint.story.persona as Persona | undefined) ?? Persona.Pm] ?? hint.story.persona;
            lines.push(
                `${counter.next()}. **${hint.story.key}**: ${joinSubtaskTypeLabels(hint.types)} ${hint.types.length === 1 ? "is" : "are"} unblocked ` +
                    `-- run /tai-work ${hint.story.key} (${owner})`
            );
            actionableCount++;
        }
    }
    // TAI-390 (TAI-389 ADR decision 8): flagged To Do items wait here, out of Ready Work. Numbered
    // so a human can reply with one to look at it (and unflag it once the impediment is gone); the
    // reason shown is the latest comment's first line -- the convention is to comment what it waits for.
    if (result.onHold.length > 0) {
        lines.push("", "## On hold (flagged)", "");
        for (const issue of result.onHold) {
            const parentNote = issue.parentKey ? `, parent: ${issue.parentKey}` : "";
            const reason = issue.comments.at(-1)?.body.split("\n").find((l) => l.trim() !== "")?.trim();
            lines.push(
                `${counter.next()}. **${issue.key}** [${issue.issueType}] ${issue.summary} ` +
                    `(persona: ${issue.persona ?? "none"}, priority: ${issue.priority ?? "none"}${parentNote}) ${FLAG_MARKER}` +
                    (reason ? ` — latest comment: ${reason}` : "") +
                    signOffRowNote(issue)
            );
            actionableCount++;
        }
        lines.push("", "_Unflag with `issue update <KEY> flagged=false` once the impediment is gone; it returns to Ready Work._");
    }
    // TAI-548: a Story or Bug whose Dev work is done and which has no Verified:/Not verified: comment gets its own
    // numbered action (like the PR sections below), so picking its number loads Tessa instead of the PM.
    const toVerify = result.inProgress.map((c) => c.issue).filter((issue) => result.notVerified.has(issue.key));
    if (toVerify.length > 0) {
        lines.push("", "## Ready to verify", "");
        for (const issue of toVerify) {
            lines.push(`${counter.next()}. **${issue.key}** [${issue.issueType}] ${issue.summary} — verify it with \`/tai-verify ${issue.key}\``);
            actionableCount++;
        }
    }
    const toClose = result.inProgress.map((c) => c.issue).filter((issue) => result.readyToClose.has(issue.key));
    if (toClose.length > 0) {
        lines.push("", "## Ready to close", "");
        for (const issue of toClose) {
            const verdict = latestVerification(issue.comments)?.body.split("\n", 1)[0]?.trim() ?? "";
            // The markers an In Progress line carries stay: a flagged, blocked or sign-off-noted ticket is not a plain close-it line.
            lines.push(
                `${counter.next()}. **${issue.key}** [${issue.issueType}] ${issue.summary} — ${verdict} — ` +
                    `close it with \`issue transition ${issue.key} Done\`${blockedFlag(issue.key)}${isFlagged(issue) ? ` ${FLAG_MARKER}` : ""}${signOffRowNote(issue)}`
            );
            actionableCount++;
        }
    }
    // TAI-602: design work that finished with no Dev to implement it. Not auto-created: the PM decides where the work
    // goes (an existing Story, a new one, or nowhere), so the line names the Story to open with /tai-work.
    if (result.designWithoutDev.length > 0) {
        lines.push("", `## ${DESIGN_WITHOUT_DEV_HEADING}`, "");
        for (const { design, story } of result.designWithoutDev) {
            lines.push(
                `${counter.next()}. **${story.key}** ${story.summary} — ${design.key} [${design.issueType}] is Done and no Dev exists under it ` +
                    `or its Epic -- run /tai-work ${story.key} (Perry)`
            );
            actionableCount++;
        }
    }
    if (result.readyToReview.length > 0) {
        lines.push("", "## PRs ready for your review", "");
        for (const c of result.readyToReview) {
            lines.push(`${counter.next()}. ${reviewLine(c)}`);
            actionableCount++;
        }
    }
    if (result.readyToTest.length > 0) {
        lines.push("", "## Open PRs ready to test", "");
        for (const c of result.readyToTest) {
            lines.push(`${counter.next()}. **${c.devSubtaskKey}** — ${c.pullRequest.url}`);
            actionableCount++;
        }
    }
    if (result.readyToMerge.length > 0) {
        lines.push("", "## Approved PRs ready to merge", "");
        for (const c of result.readyToMerge) {
            lines.push(
                `${counter.next()}. **${c.issueKey}** — ${c.pullRequest.url} (\`git-pr merge <ISSUE-KEY> <REPO>\` to land it)`
            );
            actionableCount++;
        }
    }
    if (result.waitingToMerge.length > 0) {
        lines.push("", "## Approved PRs waiting on something", "", ...WAITING_INTRO, "");
        for (const c of result.waitingToMerge) {
            lines.push(waitingLine(counter.next(), c));
            actionableCount++;
        }
    }
    // TAI-302/319: informational, not numbered -- the action isn't "pick one," it's "go
    // refresh the doc" once, covering every Epic named below (same non-numbered treatment
    // as the blockedFlag annotation above, not a new pickable-line kind).
    if (result.staleLivingDocs.length > 0) {
        lines.push("", "## Living docs may be stale", "");
        lines.push("Project Home Page — Epic summary has moved since last snapshotted:");
        for (const s of result.staleLivingDocs) {
            lines.push(`  - **${s.epicKey}**: ${s.reason}`);
        }
        lines.push(
            "",
            "Refresh the page's content, then `doc snapshot-living-doc <PROJECT-KEY> project-home` to mark it fresh."
        );
    }
    if (actionableCount > 0) {
        lines.push(
            "",
            "Reply with a number above, or the issue key/PR directly — either works."
        );
    }
    return lines.join("\n");
}

/** Lighter sibling to `renderReadyWork` (TAI-211/212) — just the PR-review-mode
 *  sections (review, merge, waiting), no general ready list, no in-flight section. Same "reply with a number"
 *  numbered-line convention `tai-ready` already uses. */
export function renderPRReadyWork(result: Awaited<ReturnType<typeof findReadyPRWork>>): string {
    const lines: string[] = ["# PRs ready for you", ""];
    const counter = numberedLines();
    let actionableCount = 0;

    if (result.readyToReview.length > 0) {
        lines.push("## PRs ready for your review", "");
        for (const c of result.readyToReview) {
            lines.push(`${counter.next()}. ${reviewLine(c)}`);
            actionableCount++;
        }
    }
    if (result.readyToMerge.length > 0) {
        lines.push("", "## Approved PRs ready to merge", "");
        for (const c of result.readyToMerge) {
            lines.push(
                `${counter.next()}. **${c.issueKey}** — ${c.pullRequest.url} (\`git-pr merge <ISSUE-KEY> <REPO>\` to land it)`
            );
            actionableCount++;
        }
    }
    if (result.waitingToMerge.length > 0) {
        lines.push("", "## Approved PRs waiting on something", "", ...WAITING_INTRO, "");
        for (const c of result.waitingToMerge) {
            lines.push(waitingLine(counter.next(), c));
            actionableCount++;
        }
    }
    if (actionableCount === 0) {
        lines.push("Nothing ready for you right now.");
    } else {
        lines.push("", "Reply with a number above, or the issue key/PR directly — either works.");
    }
    return lines.join("\n");
}

function renderPrecedenceLinkResults({ results, warning }: Awaited<ReturnType<typeof materializePrecedenceLinks>>): string {
    const lines: string[] = ["# Precedence links", ""];
    if (results.length === 0) {
        lines.push("No applicable precedence edges — either this story has fewer than two of the " +
            "subtask types SUBTASK_PRECEDENCE gates against each other, or none are present yet.");
    } else {
        for (const r of results) {
            const verb = r.created ? "created" : "already existed";
            lines.push(`- ${r.afterKey} depends on ${r.beforeKey} (${r.after} after ${r.before}) — ${verb}`);
        }
    }
    if (warning) {
        lines.push("", `**Warning:** ${warning}`);
    }
    return lines.join("\n");
}

// ---------- issue/page subcommands (TAI-126, piece 0) ----------
//
// Thin wrappers around WorkTracker/DocStore methods that already exist, are already
// implemented against direct REST for both backends, and are already covered by the
// conformance suite — cli.ts simply never exposed them as subcommands before this,
// which meant creating/transitioning/commenting/linking tickets and Confluence pages
// required going through a separate MCP server. These wrappers close that gap so no
// MCP server is required for TAI to work end-to-end (brief §3.2's own "direct REST,
// not through mcp-atlassian" decision, extended to cover ticket/page CRUD too).

/** Parses trailing `key=value` arguments (e.g. `parent=TAI-116 persona=developer`) into a
 *  plain object — used by `issue create`/`page create` for their many optional fields,
 *  rather than a long fixed positional list. */
function parseKeyValueArgs(args: readonly string[]): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const raw of args) {
        const eq = raw.indexOf("=");
        if (eq === -1) throw new Error(`Expected key=value, got "${raw}".`);
        fields[raw.slice(0, eq)] = raw.slice(eq + 1);
    }
    return fields;
}

/** TAI-611: a status typed on the command line, matched to TAI's own spelling. Case does not matter and the British
 *  `Cancelled` is `Canceled` (Jira's spelling), which a person types by habit and which cost a retry. A word that is
 *  no status is returned unchanged, so the backend still refuses it with its own message. */
export function normalizeStatusArg(raw: string): string {
    const wanted = raw.trim().toLowerCase().replace(/^cancelled$/, "canceled");
    return Object.values(Status).find((status) => status.toLowerCase() === wanted) ?? raw;
}

/** Builds an `issue update` patch from its `key=value` arguments. Rejects an unknown key rather
 *  than ignoring it (found live: a typo'd `lables=` would otherwise "succeed" doing nothing).
 *  `parent=` re-parents a Story/Bug under an Epic; `labels=` REPLACES the whole list (an empty
 *  value clears it) -- both decided on TAI-372, 2026-10-02. */
export function parseIssueUpdatePatch(fields: Readonly<Record<string, string>>): IssuePatch {
    const known = new Set(["summary", "description", "persona", "priority", "component", "severity", "parent", "labels", "flagged"]);
    const unknown = Object.keys(fields).filter((k) => !known.has(k));
    if (unknown.length > 0) {
        throw new Error(`Unknown issue update field(s): ${unknown.join(", ")}. Valid: ${[...known].join(", ")}.`);
    }
    if (fields["parent"] === "") {
        throw new Error("parent= needs an Epic key; detaching an issue from its Epic is not supported.");
    }
    if (fields["flagged"] !== undefined && fields["flagged"] !== "true" && fields["flagged"] !== "false") {
        throw new Error(`flagged= must be true or false, got "${fields["flagged"]}".`);
    }
    return {
        ...(fields["summary"] !== undefined ? { summary: fields["summary"] } : {}),
        ...(fields["description"] !== undefined ? { description: fields["description"] } : {}),
        ...(fields["persona"] !== undefined ? { persona: parsePersonaArg(fields["persona"]) } : {}),
        ...(fields["flagged"] !== undefined ? { flagged: fields["flagged"] === "true" } : {}),
        ...(fields["priority"] !== undefined ? { priority: fields["priority"] } : {}),
        ...(fields["component"] !== undefined ? { component: fields["component"] } : {}),
        ...(fields["severity"] !== undefined ? { severity: fields["severity"] } : {}),
        ...(fields["parent"] !== undefined ? { parentKey: toIssueKey(fields["parent"]) } : {}),
        ...(fields["labels"] !== undefined
            ? { labels: fields["labels"].split(",").map((l) => l.trim()).filter((l) => l !== "") }
            : {}),
    };
}

/** TAI-383 (TAI-382): everything on a PR, in the order the host returned it, so whoever is about to
 *  merge reads ALL of it -- including a second reviewer's and anything after the last commit --
 *  before deciding. Full bodies on purpose (the point is that they get READ, not skimmed). Ends with
 *  the decision prompt; this is surfacing, never a gate -- whether a comment is actionable is a
 *  judgment call (the human's 2026-10-02 policy: very minor -> fix, test, merge; review-worthy -> ask).
 *  TAI-462: a pushed fix makes the approval stale, so that merge now needs `force=true`. */
export function renderPullRequestComments(prId: string, comments: readonly PullRequestComment[]): string {
    if (comments.length === 0) {
        return `# Comments on PR ${prId}\n\nNo comments on PR ${prId}. Confirm that is expected for a PR that was reviewed before merging.`;
    }
    // Normalize through Date so a non-UTC offset is converted, not mislabeled "UTC"; an
    // unparseable value is shown as given rather than guessed at.
    const when = (iso: string): string => {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        const utc = d.toISOString();
        return `${utc.slice(0, 10)} ${utc.slice(11, 16)} UTC`;
    };
    const lines = [`# Comments on PR ${prId} (${comments.length})`, ""];
    comments.forEach((c, i) => {
        const where = c.inline ? ` · ${c.inline.path}${c.inline.line !== undefined ? `:${c.inline.line}` : ""}` : "";
        lines.push(`## ${i + 1}. ${c.author.displayName} · ${when(c.createdAt)}${where}`, "", c.body.trim(), "");
    });
    lines.push(
        "---",
        "Before merging, decide for EACH comment above: fix it (only if very minor -- a typo or wording, no behavior change -- " +
            "then run the tests, push, and note it on the PR; that push makes the approval stale, so merge with force=true, " +
            "which records the override on the PR), file a ticket for it, or skip it with a stated reason. " +
            "Anything review-worthy (a behavior change, a logic or parity finding, a design question) is NOT merged automatically: " +
            "ask the human first. Verify a reviewer's factual claims before acting on them."
    );
    return lines.join("\n");
}

/** TAI-390: the marker `issue get`/`search`/`update` and `/tai-ready` show on a flagged issue. */
export const FLAG_MARKER = "🚩 flagged";
const flagSuffix = (issue: Pick<Issue, "flagged">): string => (isFlagged(issue) ? ` · ${FLAG_MARKER}` : "");

function renderIssueRef(issue: Issue): string {
    return [
        `# Issue ${issue.key}`,
        "",
        `**${issue.summary}**`,
        `${issue.issueType} · ${issue.status}${issue.parentKey ? ` · parent: ${issue.parentKey}` : ""}${flagSuffix(issue)}`,
    ].join("\n");
}

/** Shared by `page create`/`page update` -- found duplicated verbatim between the two
 *  during TAI-301's code review; factored out the same way `renderIssueRef` already is. */
function renderPageRef(heading: string, page: Page): string {
    return `# ${heading}\n\n**${page.title}**\nid: ${page.id}\nspace: ${page.spaceKey}`;
}

/** TAI-275/276 ADR: visibility, not auto-retry -- prints alongside `issue transition`'s own
 *  success output so a cascade failure (e.g. an unassigned parent the cascade tried and
 *  failed to move) is visible in the SAME terminal output a human is already looking at,
 *  not just a server-side `console.warn` they may never see. */
export function renderCascadeWarnings(warnings: readonly CascadeWarning[] | undefined): string {
    if (!warnings || warnings.length === 0) return "";
    return "\n\n" + warnings.map((w) => `⚠️ Cascade warning: ${w.key} — ${w.reason}`).join("\n");
}

// TAI-268 (TAI-254 ADR): `search`/`get`/`page get` below are read-only thin wrappers
// around `WorkTracker.search`/`getIssue`/`getLinkedIssues`/`getLinkedPages` and
// `DocStore.getPage` — all pre-existing methods, none new (the ADR's own decision #5
// explicitly rules out adding new WorkTracker/DocStore surface for this). They exist so a
// bulk, whole-backlog read (the `tai-audit` skill's actual need) never has to reach for
// the Atlassian MCP server, matching this file's own header note (TAI-126) that direct
// REST via these wrappers is how TAI avoids that dependency.

/** Pure filter-construction for `issue search` (TAI-268) — separated from the `main()`
 *  branch that calls it so it's unit-testable without a real backend. `fields` is whatever
 *  `parseKeyValueArgs` produced from the trailing CLI args; `defaultProjectKey` is
 *  `config.projectKey`, used whenever no explicit `projectKey=` override was given.
 *  `updatedSince=` takes an ISO 8601 date (2026-10-02) or a date-time with a timezone (2026-10-02T10:00:00Z);
 *  relative forms such as -7d are rejected (TAI-420 review). */
export function parseIssueSearchFilter(fields: Readonly<Record<string, string>>, defaultProjectKey: string): IssueFilter {
    return {
        projectKey: fields["projectKey"] ?? defaultProjectKey,
        ...(fields["status"] !== undefined ? { statuses: fields["status"].split(",").map(normalizeStatusArg) as Status[] } : {}),
        ...(fields["type"] !== undefined ? { issueTypes: fields["type"].split(",") as (StoryType | SubtaskType | "epic")[] } : {}),
        ...(fields["persona"] !== undefined ? { persona: parsePersonaArg(fields["persona"]) } : {}),
        ...(fields["parent"] !== undefined ? { parentKey: toIssueKey(fields["parent"]) } : {}),
        ...(fields["updatedSince"] !== undefined ? { updatedSince: fields["updatedSince"] } : {}),
        ...(fields["limit"] !== undefined ? { limit: Number(fields["limit"]) } : {}),
    };
}

/** Pure `PageRef` parsing for `page get` (TAI-268) — `id=<PAGE-ID>` selects the by-id form,
 *  otherwise `first`/`second` are `<SPACE-KEY>`/`<TITLE>`. `null` means the arguments don't
 *  resolve to a valid `PageRef` at all (missing title with no `id=` given either) — the
 *  caller's job to turn that into a usage error, not this function's. */
export function parsePageGetRef(first: string, second: string | undefined): PageRef | null {
    if (first.startsWith("id=")) return { id: toPageId(first.slice(3)) };
    if (!second) return null;
    return { spaceKey: first, title: second };
}

/**
 * TAI-292 (`workflows/dependencies.md`'s "Initial Status & Priority for a Created
 * Subtask"): `issue create`'s default for a subtask's `priority` when the caller didn't
 * pass `priority=` explicitly. An explicit `priority=` always wins outright (this
 * function isn't even consulted for that case in practice, but stays correct if it is).
 * Only actual subtask issue types inherit this way — a Story/Bug/Spike's own priority is
 * never inferred from a parent Epic, which has no meaningful "priority" of its own to
 * inherit. Pure decision logic only; resolving `parentPriority` (an async fetch) is the
 * caller's job.
 */
export function resolveCreatePriority(
    explicitPriority: string | undefined,
    issueType: StoryType | SubtaskType | "epic",
    parentPriority: string | undefined
): string | undefined {
    if (explicitPriority !== undefined) return explicitPriority;
    if (isSubtaskIssueType(issueType) && parentPriority !== undefined) return parentPriority;
    return undefined;
}

/** `issue link` / `issue unlink` relation argument: only the two relations a person can name. */
function parseLinkRelation(relation: string): DependencyRelation {
    if (relation !== DependencyRelation.DependsOn && relation !== DependencyRelation.RelatesTo) {
        throw new Error(`Unknown relation "${relation}" -- expected "depends-on" or "relates-to".`);
    }
    return relation;
}

/**
 * `issue unlink`: removes the link `issue link <relation> <from> <to>` created. Removing a link that
 * is not there is reported as such and changes nothing, so a repeated unlink is harmless.
 */
export async function unlinkIssues(
    workTracker: Pick<WorkTracker, "removeLink">,
    relation: string,
    fromKey: string,
    toKey: string
): Promise<string> {
    const parsed = parseLinkRelation(relation);
    const removed = await workTracker.removeLink(toIssueKey(fromKey), parsed, toIssueKey(toKey));
    return removed
        ? `# Link removed\n\n${fromKey} ${parsed} ${toKey}.`
        : `# No such link\n\n${fromKey} ${parsed} ${toKey} does not exist; nothing changed.`;
}

/**
 * `skippedCount` (TAI-405) is how many rows the backend fetched but could not read (unmapped Jira type): they
 * count toward the cap, so a full page with one skipped row still shows the "hit the search limit" hint.
 */
/**
 * Validates a `persona=` argument against the real persona ids instead of casting it, so a typo is a
 * clear error naming the valid values and not a silent bad value (found in review of TAI-409).
 */
export function parsePersonaArg(value: string): Persona {
    const persona = resolvePersonaName(value);
    if (!persona) {
        throw new Error(`Unknown persona "${value}". Expected one of: ${describePersonaNames()}.`);
    }
    return persona;
}

/** TAI-615: `ready`'s optional persona filter. An unknown word (`dev` for `developer`) is refused with the list of
 *  valid ids; it used to be cast unchecked and crash deeper in with `Cannot read properties of undefined`. */
export function parseReadyPersonaArg(arg: string | undefined): Persona | undefined {
    return arg === undefined ? undefined : parsePersonaArg(arg);
}

/**
 * A roster that cannot be read (e.g. the Persona Roster page is missing) must never stop a ticket being
 * created: it is made unassigned and the reason is shown (TAI-409 review; "never lose a ticket").
 */
export async function tryResolveCreateAssignee(
    resolve: () => Promise<AssignmentResolution>
): Promise<{ assignee: HumanRef | undefined; note: string | undefined }> {
    try {
        const { assignee } = await resolve();
        return { assignee: assignee ?? undefined, note: undefined };
    } catch (e) {
        return {
            assignee: undefined,
            note: `Created UNASSIGNED: could not resolve an assignee (${(e as Error).message}). Assign it with issue assign.`,
        };
    }
}

/**
 * TAI-421: `issue create assignee=<email>` -- a NAMED person always wins, with no prompt and no roster
 * check (like `issue assign`). Resolved to the real Jira identity the same way `issue assign` does. A name
 * that does not resolve still creates the ticket, unassigned, with a note ("never lose a ticket").
 */
export async function resolveNamedAssignee(
    resolveHuman: (email: string) => Promise<HumanRef | null>,
    named: string
): Promise<{ assignee: HumanRef | undefined; note: string | undefined }> {
    let human: HumanRef | null;
    try {
        human = await resolveHuman(named);
    } catch (e) {
        return { assignee: undefined, note: `Created UNASSIGNED: could not look up "${named}" (${(e as Error).message}). Assign it with issue assign.` };
    }
    if (!human) {
        return { assignee: undefined, note: `Created UNASSIGNED: no Jira user found for "${named}". Assign it with issue assign.` };
    }
    return { assignee: human, note: undefined };
}

/** TAI-409: printed after a create that left the persona empty (only SpikeTask has no default). */
export const PERSONA_LESS_CREATE_WARNING = (key: string): string =>
    `WARNING: ${key} was created with NO persona. It cannot be driven with /tai-work and will not appear in a ` +
    `persona-scoped /tai-ready. Set one now: issue update ${key} persona=<PERSONA>.`;

export function renderIssueSearchResults(issues: readonly Issue[], filter: IssueFilter, skippedCount = 0): string {
    const scope = [
        `project: ${filter.projectKey}`,
        filter.statuses ? `status: ${filter.statuses.join(", ")}` : undefined,
        filter.issueTypes ? `type: ${filter.issueTypes.join(", ")}` : undefined,
        filter.persona ? `persona: ${filter.persona}` : undefined,
        filter.parentKey ? `parent: ${filter.parentKey}` : undefined,
        filter.updatedSince ? `updatedSince: ${filter.updatedSince}` : undefined,
    ]
        .filter((s): s is string => s !== undefined)
        .join(" · ");

    const lines = [`# Issues matching filter (${issues.length} found)`, "", scope, ""];
    if (issues.length === 0) {
        lines.push("No matches.");
        return lines.join("\n");
    }

    for (const issue of issues) {
        lines.push(
            `## ${issue.key} [${issue.issueType}] ${issue.status} — ${issue.summary}${isFlagged(issue) ? ` ${FLAG_MARKER}` : ""}`,
            `Persona: ${issue.persona ?? "none"}${issue.parentKey ? ` | Parent: ${issue.parentKey}` : ""} | ` +
                `Updated: ${issue.updatedAt} | Comments: ${issue.comments.length}`,
            "",
            issue.description ?? "_(no description)_",
            "",
            "---",
            ""
        );
    }

    const effectiveLimit = filter.limit ?? DEFAULT_SEARCH_LIMIT;
    if (issues.length + skippedCount >= effectiveLimit) {
        lines.push(
            `_Hit the search limit (${effectiveLimit}) — more matches may exist. Re-run with a higher ` +
                `limit= to confirm this is everything before treating it as a complete sweep._`
        );
    }
    return lines.join("\n");
}

export function renderLinkedIssues(outgoing: readonly IssueLink[], incoming: readonly IssueLink[]): string {
    if (outgoing.length === 0 && incoming.length === 0) return "None.";
    const lines: string[] = [];
    for (const l of outgoing) lines.push(`- ${l.relation} → ${l.key} (outgoing)`);
    for (const l of incoming) lines.push(`- ${l.relation} ← ${l.key} (incoming)`);
    return lines.join("\n");
}

/** Narrowed to just what it needs (this file's existing `Pick<>` testability pattern —
 *  see `formatAssignmentCandidates` above) rather than the full `ResolvedConfig`, so a unit
 *  test can pass a small fake instead of a real `StorageBackend`. */
export async function renderIssueDetail(
    backend: {
        readonly workTracker: Pick<WorkTracker, "getLinkedIssues" | "getLinkedPages">;
        readonly docStore: Pick<DocStore, "getPage">;
    },
    issue: Issue
): Promise<string> {
    const [outgoing, incoming, pageIds] = await Promise.all([
        backend.workTracker.getLinkedIssues(issue.key, undefined, "outgoing"),
        backend.workTracker.getLinkedIssues(issue.key, undefined, "incoming"),
        backend.workTracker.getLinkedPages(issue.key),
    ]);

    const pageLines = pageIds.length
        ? await Promise.all(
              pageIds.map(async (id) => {
                  const page = await backend.docStore.getPage({ id });
                  return page ? `- ${page.title} (id: ${id}, space: ${page.spaceKey})` : `- **MISSING** — linked page id ${id} no longer exists`;
              })
          )
        : ["None."];

    const commentLines = issue.comments.length
        ? issue.comments.map((c) => `### ${c.author.displayName} — ${c.createdAt}\n\n${c.body}`)
        : ["_(no comments)_"];

    return [
        `# Issue ${issue.key}`,
        "",
        `**${issue.summary}**`,
        `${issue.issueType} · ${issue.status}${issue.parentKey ? ` · parent: ${issue.parentKey}` : ""}${flagSuffix(issue)}`,
        `Persona: ${issue.persona ?? "none"} | Priority: ${issue.priority ?? "none"} | Labels: ${issue.labels.join(", ") || "none"} | Updated: ${issue.updatedAt}`,
        "",
        "## Description",
        "",
        issue.description ?? "_(no description)_",
        "",
        `## Comments (${issue.comments.length})`,
        "",
        commentLines.join("\n\n"),
        "",
        "## Linked issues",
        "",
        renderLinkedIssues(outgoing, incoming),
        "",
        "## Linked pages",
        "",
        pageLines.join("\n"),
    ].join("\n");
}

// ---------- init subcommand (TAI-116 piece 3, TAI-130) ----------

// TAI-349: /tai-init used to just stop here with no pointer to what happens next -- a real
// gap the human found live (2026-09-24). Deliberately does NOT check whether an Epic
// already exists (would need a live Jira query this step never otherwise makes) -- worded
// conditionally instead, so it reads correctly whether this is a fresh project or a
// re-run against an already-active one. Deliberately does NOT say "run /tai-work" --
// found live the same day that /tai-work always requires an existing <ISSUE-KEY> (brief
// §3.8), which doesn't exist yet on a genuinely fresh project. TAI-450 (the TAI-348 decision)
// shipped the real command, `/tai-kickoff`; this hint names it. Shares its actual wording with
// `/tai-ready`'s empty-list fallback (`readySkillBody`) via `PM_KICKOFF_HINT` rather than
// duplicating it, so the two surfaces can't drift apart.
const NEXT_STEP_HINT = `If this is a fresh project with nothing in it yet: ${PM_KICKOFF_HINT}.`;

/** `label` (TAI-377) overrides only the DISPLAYED heading, never the step key -- `claude-md` is also
 *  the recorded `init-state.json` key, so renaming it would orphan existing state files. `init run`
 *  uses it because its pointer step now writes both CLAUDE.md and GEMINI.md. */
export function renderInitStepResult(
    step: InitStep,
    ok: boolean,
    detail: string,
    fullyInitialized = false,
    label?: string
): string {
    const hint = ok && fullyInitialized ? `\n\n${NEXT_STEP_HINT}` : "";
    return `# init ${label ?? step}\n\n${ok ? "Done." : "Not done."} ${detail}${hint}`;
}

/** `projectContext` (TAI-516) adds one line about the project's rules file. It is reported, never
 *  required: `isInitComplete` does not depend on it. */
export function renderInitStatus(state: InitState, projectContext?: ProjectContextStatus): string {
    const lines = ["# /tai-init status", ""];
    for (const step of INIT_STEPS) {
        const s = state.steps[step];
        lines.push(s ? `- [x] ${step} — ${s.detail}` : `- [ ] ${step}`);
    }
    const complete = isInitComplete(state);
    lines.push("", complete ? "**Fully initialized.**" : "**Not yet fully initialized.**");
    if (projectContext) lines.push("", "Not part of setup:", "", renderProjectContextStatus(projectContext, `${taiCliCommand()} init`));
    if (complete) lines.push("", NEXT_STEP_HINT);
    return lines.join("\n");
}

async function main(): Promise<void> {
    loadDotEnv();
    const { actingPersona, args } = extractActingPersona(process.argv.slice(2));
    const [subcommand, arg, ...rest] = args;

    // TAI-126: install-global runs before resolveConfig() -- it's a bootstrap step for
    // TAI itself (writing global skill files), not a project-scoped operation, so it must
    // not require TAI_PROJECT_KEY/.env to already exist. Every other subcommand below
    // does need real project config, per resolveConfig()'s own required env vars.
    if (subcommand === "install-global") {
        const taiHome = arg ?? defaultTaiHome();
        const result = await installGlobal(taiHome);
        console.log(
            `# Global skills installed\n\ntaiHome: ${result.taiHome}\n\n` +
                result.written.map((p) => `- ${p}`).join("\n")
        );
        return;
    }

    // TAI-130: like install-global, `init` is a bootstrap step for a NEW target project --
    // resolveConfig() below would fail (or, worse, half-succeed against an unprovisioned
    // Jira project) before .env even exists. Each action reads the same TAI_*/BITBUCKET_*
    // env var names .env will eventually hold, exported temporarily by the human running
    // /tai-init, and records its own completion in <taiRoot>/init-state.json for resumability.
    if (subcommand === "init") {
        const [action, ...initArgs] = [arg, ...rest];
        const taiRoot = process.env["TAI_ROOT"] ?? ".tai";

        if (action === "status") {
            console.log(renderInitStatus(await readInitState(taiRoot), await projectContextStatus(process.cwd())));
            return;
        }

        // TAI-516: a starter for the project's own rules file. Not an init step and not .gitignore
        // business: the file is meant to be committed. Never overwrites.
        if (action === "project-context") {
            const result = await writeProjectContextTemplate(process.cwd());
            console.log(
                result.written
                    ? `Wrote a starter template to ${result.path}.\n\nFill in its four sections from what this repo actually does, delete its first line, and commit it through a PR. ` +
                          "Until that line is gone TAI does not print the file to any persona."
                    : `${result.path} already exists; nothing was written.`
            );
            return;
        }

        // TAI-358: eager, idempotent .gitignore hygiene for every mutating init action --
        // see ensureGitignore's own comment for why this isn't a named InitStep. Runs
        // before the action itself so .tai/'s very first write (markStepDone, inside each
        // branch below) is already covered.
        const gitignoreResult = await ensureGitignore(process.cwd(), taiRoot);
        if (gitignoreResult.added.length > 0) {
            console.log(
                `(Added to ${gitignoreResult.path}: ${gitignoreResult.added.join(", ")}.)\n`
            );
        }

        if (action === "jira") {
            // TAI-116 piece 4: TAI_SPACE_KEY may not be set yet on a fresh project's first
            // run (it's the "confluence"/"env" steps' concern) -- optional here, not
            // requireEnv'd, so a missing "Type Aliases" page just means no aliases apply
            // yet rather than blocking this step.
            const spaceKey = process.env["TAI_SPACE_KEY"];
            const result = await verifyJiraSetup({
                siteUrl: requireEnv("TAI_JIRA_SITE_URL"),
                email: requireEnv("TAI_JIRA_EMAIL"),
                apiToken: requireEnv("TAI_JIRA_API_TOKEN"),
                projectKey: requireEnv("TAI_PROJECT_KEY"),
                ...(spaceKey ? { spaceKey } : {}),
            });
            if (result.ok) await markStepDone(taiRoot, "jira", result.detail);
            console.log(renderInitStepResult("jira", result.ok, result.detail));
            return;
        }

        if (action === "confluence") {
            const result = await setupConfluence({
                siteUrl: requireEnv("TAI_JIRA_SITE_URL"),
                email: requireEnv("TAI_JIRA_EMAIL"),
                apiToken: requireEnv("TAI_JIRA_API_TOKEN"),
                spaceKey: requireEnv("TAI_SPACE_KEY"),
            });
            if (result.ok) await markStepDone(taiRoot, "confluence", result.detail);
            console.log(renderInitStepResult("confluence", result.ok, result.detail));
            return;
        }

        if (action === "bitbucket") {
            const repo = initArgs[0];
            if (!repo) throw new Error("Usage: init bitbucket <WORKSPACE/REPO>");
            const result = await verifyBitbucketSetup({
                email: requireEnv("BITBUCKET_EMAIL"),
                apiToken: requireEnv("BITBUCKET_API_TOKEN"),
                repo,
            });
            if (result.ok) await markStepDone(taiRoot, "bitbucket", result.detail);
            console.log(renderInitStepResult("bitbucket", result.ok, result.detail));
            return;
        }

        // TAI-583: the GitHub counterpart, recorded as the same git-host step.
        if (action === "github") {
            const repo = initArgs[0];
            if (!repo) throw new Error("Usage: init github <OWNER/REPO>");
            const result = await verifyGitHubSetup({ token: requireEnv("GITHUB_TOKEN"), repo });
            if (result.ok) await markStepDone(taiRoot, "bitbucket", result.detail);
            console.log(renderInitStepResult("bitbucket", result.ok, result.detail, false, "github"));
            return;
        }

        if (action === "env") {
            const githubToken = process.env["TAI_GIT_HOST"]?.trim().toLowerCase() === "github" ? process.env["GITHUB_TOKEN"] : undefined;
            const bitbucketEmail = process.env["BITBUCKET_EMAIL"];
            const bitbucketApiToken = process.env["BITBUCKET_API_TOKEN"];
            const gitRepos = process.env["TAI_GIT_REPOS"];
            const filePath = await writeEnvFile(process.cwd(), taiRoot, {
                projectKey: requireEnv("TAI_PROJECT_KEY"),
                spaceKey: requireEnv("TAI_SPACE_KEY"),
                siteUrl: requireEnv("TAI_JIRA_SITE_URL"),
                email: requireEnv("TAI_JIRA_EMAIL"),
                apiToken: requireEnv("TAI_JIRA_API_TOKEN"),
                ...(bitbucketEmail ? { bitbucketEmail } : {}),
                ...(bitbucketApiToken ? { bitbucketApiToken } : {}),
                ...(githubToken ? { githubToken } : {}),
                ...(gitRepos ? { gitRepos } : {}),
            });
            await markStepDone(taiRoot, "env", `Wrote ${filePath}.`);
            console.log(renderInitStepResult("env", true, `Wrote ${filePath}.`));
            return;
        }

        if (action === "claude-md") {
            const taiHome = initArgs[0] ?? defaultTaiHome();
            const filePath = await writeClaudeMdPointer(process.cwd(), taiRoot, taiHome);
            const nextState = await markStepDone(taiRoot, "claude-md", `Wrote ${filePath}.`);
            console.log(renderInitStepResult("claude-md", true, `Wrote ${filePath}.`, isInitComplete(nextState)));
            // TAI-367: a plain reminder, never an action -- TAI does not commit or push for you.
            const reminder = unpushedChangesReminder(await gitStatusPorcelain(process.cwd()));
            if (reminder !== null) console.log(`\n${reminder}`);
            return;
        }

        // TAI-367 (ADR for TAI-360): the guided, idempotent flow for a brand-new project OR
        // joining an already-onboarded one -- run it in your own terminal. It prompts for the
        // site URL, writes the .env skeleton, opens your editor for the secret lines, discovers
        // project/space/repo live, then verifies every step against the real APIs.
        if (action === "run") {
            const result = await runInit({
                cwd: process.cwd(),
                taiRoot,
                taiHome: initArgs[0] ?? defaultTaiHome(),
                env: process.env,
                interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
                io: createTerminalIO(),
                renderStepResult: renderInitStepResult,
                services: createRealServices(),
                // TAI-622: the allow rule names the project's own personas too; a failure here is caught by the engine.
                listProjectPersonaIds: async () => {
                    const projectConfig = await resolveConfig();
                    return listProjectPersonaIds(projectConfig.backend.docStore, { spaceKey: projectConfig.spaceKey });
                },
            });
            process.exitCode = result.exitCode;
            return;
        }

        if (action === "gemini-md") {
            // TAI-376: the GEMINI.md twin of `claude-md`. Deliberately records no init step --
            // `isInitComplete` must not start requiring a file that already-onboarded projects lack.
            const taiHome = initArgs[0] ?? defaultTaiHome();
            const filePath = await writeGeminiMdPointer(process.cwd(), taiRoot, taiHome);
            console.log(`Wrote ${filePath}.`);
            const reminder = unpushedChangesReminder(await gitStatusPorcelain(process.cwd()));
            if (reminder !== null) console.log(`\n${reminder}`);
            return;
        }

        throw new Error(
            `Unknown init action "${action}" -- expected "status", "run", "jira", "confluence", "bitbucket", "github", "env", "claude-md", "gemini-md", or "project-context".`
        );
    }

    // TAI-126: any missing required env var here means this project hasn't been
    // initialized for TAI yet (or init didn't finish) -- surface that plainly rather than
    // a bare "Missing required environment variable X", so a persona/human hitting this
    // knows to run /tai-init rather than guessing which env var to hand-add.
    const baseConfig = await resolveConfig().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${message}\n\nThis project doesn't look initialized for TAI yet -- run /tai-init first.`);
    });
    // TAI-477: a named acting persona must be one this project has. Nothing consumes it yet beyond
    // carrying it on the config: the stamp (TAI-475) and grant warnings (TAI-478) will.
    const config: ResolvedConfig = actingPersona
        ? {
              ...baseConfig,
              actingPersona: await resolveActingPersonaId(baseConfig.backend.docStore, actingPersona, { spaceKey: baseConfig.spaceKey }),
          }
        : baseConfig;

    // TAI-130: a state file that EXISTS but is incomplete means a prior /tai-init run was
    // interrupted -- warn (stderr, non-fatal) rather than block, since work may still
    // function fine depending on which step was skipped. No state file at all is NOT
    // flagged (grandfather case -- see target-init.ts's header comment).
    const initWarning = await checkInitCompletion(config.taiRoot);
    if (initWarning) console.error(initWarning);

    if (subcommand === "git-pr") {
        const [action, ...actionArgs] = [arg, ...rest];
        const usage =
            "Usage: git-pr create <ISSUE-KEY> <REPO> <SOURCE_BRANCH> <DEST_BRANCH> <TITLE> [DESCRIPTION]\n" +
            "     | git-pr review-prep <REPO> [PR-ID]   (writes nothing to the PR or tracker: loads the Code Reviewer persona, the PR and its diff -- the review flow's entry point, TAI-425)\n" +
            "     | git-pr review <REPO> [PR-ID] <approve|requestChanges> [COMMENT]\n" +
            "     | git-pr comment <REPO> [PR-ID] <BODY>\n" +
            "     | git-pr comments <REPO> [PR-ID]   (read-only: list ALL comments on a PR -- run before merge)\n" +
            "     | git-pr render-findings <FINDINGS-JSON-OR-@FILE>\n" +
            "     | git-pr comment-findings <REPO> [PR-ID] <FINDINGS-JSON-OR-@FILE>\n" +
            "     | git-pr unapprove <REPO> [PR-ID]\n" +
            "     | git-pr check <REPO> [PR-ID]   (runs TAI_CHECK_COMMAND on the PR's head commit, from a clean checkout of it, and records the result on the commit)\n" +
            "     | git-pr merge <ISSUE-KEY> <REPO> [PR-ID] [mergeCommit|squash|fastForward] [force=true]\n" +
            "  [PR-ID] is optional on review/comment/comments/comment-findings/unapprove/merge — omit it to " +
            "resolve against REPO's sole open PR; if more than one is open, the error lists them so " +
            "you can pass one explicitly.";

        // TAI-209/210 ADR: structured findings, not model-composed prose. render-findings is a
        // pure function (JSON in, markdown out) -- no GitHost call, no roster gate, no <REPO> --
        // this is what the model runs at step 3 so its own stdout becomes the visible findings
        // text, never a narrative it authored itself.
        if (action === "render-findings") {
            const [findingsArg] = actionArgs;
            if (!findingsArg) throw new Error(usage);
            const findings = parseReviewFindings(findingsArg);
            // TAI-527: cross-check the coverage against what review-prep saved for this PR in this clone.
            const manifest = await readReviewManifest(config.taiRoot, findings.reviewOf.repo, findings.reviewOf.pr);
            // TAI-411: the preview carries the numbered next-step options; comment-findings (below) posts
            // renderReviewFindings alone, so the options never reach the PR.
            // The preview shows a moved head too, so the human learns it BEFORE choosing to post or approve.
            // Best effort: when the head cannot be looked up the preview is still rendered, and says it could not check.
            const liveCommit = await previewLiveCommit(config, findings.reviewOf).catch(() => null);
            // TAI-575: record what was rendered, so comment-findings and review can check that this step happened.
            await recordRenderedFindings(config.taiRoot, findings.reviewOf.repo, findings.reviewOf.pr, hashFindings(findings));
            console.log(renderFindingsPreview(findings, manifest, liveCommit));
            return;
        }

        // TAI-425 ADR (page 52559873): the review flow's entry point. Read-only; loads Cole through
        // loadPersonaConfig exactly as work/groom load theirs, so the persona, the PR, the diff and the review
        // steps are all in the output the session reads. Roster-gated FIRST (refuses before printing anything).
        if (action === "review-prep") {
            const [repoArg, prIdArg] = actionArgs;
            if (!repoArg) throw new Error(usage);
            const { gitHost, currentHuman } = await resolveReviewerGitHost(config);
            const repo = toRepoId(repoArg);

            const prId = await resolvePullRequestId(gitHost, repo, prIdArg);
            const pr = await gitHost.getPullRequest(repo, prId);
            if (!pr) throw new Error(`PR ${prId} not found on ${repo}.`);
            if (pr.state !== "open") throw new Error(`PR ${prId} on ${repo} is ${pr.state} -- there is nothing left to review.`);

            const persona = await loadPersonaConfig(config.backend.docStore, "code-reviewer", { spaceKey: config.spaceKey });
            // Best effort: a lookup failure only costs the "Linked ticket" line, never the review.
            const linkedKey = await findLinkedIssueForPR(config.backend.workTracker, config.projectKey, pr.url).catch(() => null);
            const diff = await gatherDiff({
                cwd: process.cwd(),
                repo: repoArg,
                sourceBranch: pr.sourceBranch,
                destinationBranch: pr.destinationBranch,
            });

            // TAI-527 ADR decisions 2 and 4: CI on the commit under review, and the whole diff as a file.
            // Both best effort: a failure costs that section, never the review.
            const ci = await gitHost.getCommitStatuses(repo, pr.sourceCommit).catch(() => null);
            const reviewFiles = await writeReviewFiles(config.taiRoot, repoArg, String(prId), pr.sourceCommit, diff).catch(() => null);

            // TAI-522 ADR decision 2: the same safe fast-forward of the local default branch that `work` and
            // `ready` run. After gatherDiff, whose fetch of the two PR branches must not be skipped by a debounce.
            const fetchNote = renderLocalFetchNote(await refreshLocalDefaultBranch(process.cwd(), config.taiRoot));

            // TAI-522 ADR decision 3: the rules in force on the destination branch, not whatever this clone
            // has checked out. Falls back to the file on disk when the diff could not be gathered (nothing was
            // fetched) or the configured path is outside the repo.
            let projectContext = await loadProjectContextSection();
            if (diff.kind === "ok") {
                const destRef = `origin/${pr.destinationBranch}`;
                const atRef = await readProjectContextAtRef(process.cwd(), destRef, (rel) => readFileAtRef(process.cwd(), destRef, rel));
                if (!atRef.outsideRepo) projectContext = renderProjectContext(atRef.context, projectContextBudgetFromEnv());
            }

            console.log(
                withTurnNotes([await installWarning(), fetchNote]) +
                renderReviewPrep({
                    persona: { displayName: persona.displayName, id: persona.id, prompt: persona.prompt },
                    repo: repoArg,
                    pr,
                    actingHuman: currentHuman,
                    linkedKey,
                    diff,
                    projectContext,
                    ci,
                    reviewFiles,
                })
            );
            return;
        }

        // rev 52 (TAI-159 ADR): review/comment are roster-gated, not persona-gated — no
        // <ISSUE-KEY> at all (there's no CodeReview subtask left to resolve permission
        // through; see resolveReviewerGitHost's own comment). Handled separately from
        // create/merge, which still resolve permission from an <ISSUE-KEY>'s persona field
        // as before.
        if (action === "review") {
            const [repoArg, ...gitArgs] = actionArgs;
            if (!repoArg) throw new Error(usage);
            const { gitHost, currentHuman } = await resolveReviewerGitHost(config);
            const repo = toRepoId(repoArg);

            const { prIdArg, decision, comment } = parseReviewArgs(gitArgs);
            const prId = await resolvePullRequestId(gitHost, repo, prIdArg);
            // TAI-527: an approval counts for the PR's current commit, so it is refused when review-prep
            // last ran here for an older one. A request for changes is always allowed.
            // Looked up only for an approval, so a request for changes never depends on this read succeeding.
            if (decision === "approve") {
                const live = await gitHost.getPullRequest(repo, prId);
                const refusal = live ? reviewDecisionRefusal(decision, await readReviewManifest(config.taiRoot, repoArg, String(prId)), live.sourceCommit) : null;
                if (refusal) throw new Error(refusal);
            }
            // TAI-575: once review-prep has run for this PR here, the findings must have been rendered before a decision.
            const unrenderedDecision = unrenderedDecisionRefusal(
                decision,
                await readReviewManifest(config.taiRoot, repoArg, String(prId)),
                await readRenderedFindings(config.taiRoot, repoArg, String(prId))
            );
            if (unrenderedDecision) throw new Error(unrenderedDecision);
            // TAI-475: a decision made through the CLI always leaves a stamped PR comment saying so.
            await gitHost.reviewPullRequest(repo, prId, decision, reviewDecisionComment(decision, comment, actingPersonaOf(config)));
            console.log(`# Review posted (as ${actingHumanLabel(currentHuman)})\n\n${decision} on PR ${prId}.`);
            return;
        }

        // TAI-383 (TAI-382): read-only, so neither persona- nor roster-gated -- anyone about to merge
        // (or just curious) can read a PR's comments. Same optional-[PR-ID] resolution as the rest.
        // TAI-534 ADR: run the project's check command on the PR's head commit and record the result on that
        // commit. Not roster- or persona-gated: the author runs it, and a reviewer at the PR's head may too.
        if (action === "check") {
            const [repoArg, prIdArg] = actionArgs;
            if (!repoArg) throw new Error(usage);
            const command = checkCommandFromEnv();
            if (!command) {
                throw new Error("No check command is configured. Set TAI_CHECK_COMMAND in this project's .env to the command that verifies a commit (for example its typecheck, lint and tests).");
            }
            const { backend } = await gitHostSession(config);
            const repo = toRepoId(repoArg);
            const prId = await resolvePullRequestId(backend.gitHost, repo, prIdArg);
            const pr = await backend.gitHost.getPullRequest(repo, prId);
            if (!pr) throw new Error(`PR ${prId} not found on ${repo}.`);
            if (pr.state !== "open") throw new Error(`PR ${prId} on ${repo} is ${pr.state} -- there is nothing to check.`);

            const cwd = process.cwd();
            const outcome = await performLocalCheck({
                gitHost: backend.gitHost,
                repo,
                pullRequest: pr,
                command,
                readTree: () => readWorkingTree(cwd, config.taiRoot),
                run: (cmd) => runCheckCommand(cmd, cwd),
                machine: machineName(),
            });
            console.log(renderLocalCheckOutcome(outcome, String(prId)));
            // Anything but a recorded pass is a failure of the command as a whole.
            if (!(outcome.kind === "recorded" && outcome.run.passed)) process.exitCode = 1;
            return;
        }

        if (action === "comments") {
            const [repoArg, prIdArg] = actionArgs;
            if (!repoArg) throw new Error(usage);
            const { backend } = await gitHostSession(config);
            const repo = toRepoId(repoArg);
            const prId = await resolvePullRequestId(backend.gitHost, repo, prIdArg);
            console.log(renderPullRequestComments(String(prId), await backend.gitHost.listPullRequestComments(repo, prId)));
            return;
        }

        // TAI-187: posting review findings as a real PR comment — same roster gate as
        // `review` (the human posting findings is the same one about to decide approve/
        // requestChanges next), same optional-[PR-ID] resolution.
        if (action === "comment") {
            const [repoArg, ...gitArgs] = actionArgs;
            if (!repoArg) throw new Error(usage);
            const { gitHost, currentHuman } = await resolveReviewerGitHost(config);
            const repo = toRepoId(repoArg);

            const { prIdArg, body } = parseCommentArgs(gitArgs);
            const prId = await resolvePullRequestId(gitHost, repo, prIdArg);
            const comment = await gitHost.addPullRequestComment(repo, prId, stampComment(body, actingPersonaOf(config)));
            console.log(`# Comment posted on PR ${prId} (as ${actingHumanLabel(currentHuman)})\n\n${comment.body}`);
            return;
        }

        // TAI-209/210 ADR: the step-4 action, run only once the human has said to post.
        // TAI-207: `critical`-severity findings with a `line` also post as real inline PR
        // comments (via GitHost.addInlineComment) FIRST, then the summary comment posts via
        // the same general-comment path as `comment` above. TAI-678: the summary lists every
        // finding in full, the inline ones included, so a person reading it sees the most
        // serious findings in one place and a failed inline post loses nothing.
        // Inline posting is best-effort per finding (mirrors reviewd's own
        // catch-log-and-continue posture in _post_review_impl): a single bad anchor (e.g. a
        // finding's `line` isn't actually part of the diff -- a real, expected rejection by the
        // host, not a connectivity fault) shouldn't block the summary comment, which is
        // the one artifact every reviewer actually depends on seeing.
        if (action === "comment-findings") {
            const [repoArg, ...gitArgs] = actionArgs;
            if (!repoArg) throw new Error(usage);
            const { gitHost, currentHuman } = await resolveReviewerGitHost(config);
            const repo = toRepoId(repoArg);

            const { prIdArg, findingsArg } = parseFindingsCommentArgs(gitArgs);
            const findings = parseReviewFindings(findingsArg);
            const prId = await resolvePullRequestId(gitHost, repo, prIdArg);
            // TAI-527: a review is of one PR. Refuse to post findings written for another.
            const wrongPr = reviewOfMismatch(findings.reviewOf, repoArg, String(prId));
            if (wrongPr) throw new Error(wrongPr);
            // TAI-575: what is posted must be what render-findings rendered for this PR. Refused before anything is posted.
            const unrendered = unrenderedFindingsRefusal(findings, await readRenderedFindings(config.taiRoot, findings.reviewOf.repo, findings.reviewOf.pr));
            if (unrendered) throw new Error(unrendered);
            const manifest = await readReviewManifest(config.taiRoot, findings.reviewOf.repo, findings.reviewOf.pr);
            // The PR's head now: the only thing that can show a push made after the review was prepared.
            const liveCommit = (await gitHost.getPullRequest(repo, prId))?.sourceCommit;

            const { inline: eligible } = partitionInlineFindings(findings.findings);
            const inlineFailures: string[] = [];
            for (const f of eligible) {
                try {
                    await gitHost.addInlineComment(repo, prId, {
                        path: f.file,
                        line: f.line!,
                        body: stampComment(renderInlineComment(f), actingPersonaOf(config)),
                    });
                } catch (err) {
                    // A failed inline post (e.g. `line` isn't actually part of the diff) never blocks the
                    // summary, which lists the finding in full anyway; it is reported to the person here.
                    inlineFailures.push(`${f.file}:${f.line} (${f.title}) — ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            const comment = await gitHost.addPullRequestComment(
                repo,
                prId,
                stampComment(renderReviewFindings(findings, manifest, liveCommit), actingPersonaOf(config))
            );
            const failureNote = inlineFailures.length > 0
                ? `\n\n(${inlineFailures.length} inline comment${inlineFailures.length === 1 ? "" : "s"} failed to post -- still listed in the summary above.)\n${inlineFailures.map((f) => `  - ${f}`).join("\n")}`
                : "";
            console.log(`# Comment posted on PR ${prId} (as ${actingHumanLabel(currentHuman)})\n\n${comment.body}${failureNote}`);
            return;
        }

        // TAI-217/219: withdraws a stale approval — e.g. after a merge conflict is found,
        // where Bitbucket's free tier has no "reset approvals on change" (Premium-only) to
        // do this automatically. Same roster gate as review/comment; suggested (never run
        // automatically) by the merge action's own conflict-denial message below.
        if (action === "unapprove") {
            const [repoArg, prIdArg] = actionArgs;
            if (!repoArg) throw new Error(usage);
            const { gitHost, currentHuman } = await resolveReviewerGitHost(config);
            const repo = toRepoId(repoArg);

            const prId = await resolvePullRequestId(gitHost, repo, prIdArg);
            await gitHost.unapprovePullRequest(repo, prId);
            console.log(`# Approval withdrawn (as ${actingHumanLabel(currentHuman)})\n\nPR ${prId} is no longer approved by ${actingHumanLabel(currentHuman)}.`);
            return;
        }

        const [issueKey, repoArg, ...gitArgs] = actionArgs;
        if (!action || !issueKey || !repoArg) throw new Error(usage);
        const { gitHost, personaId, issue } = await resolveGitHost(config, issueKey, { forMerge: action === "merge" });
        const repo = toRepoId(repoArg);

        if (action === "create") {
            const [sourceBranch, destinationBranch, title, description] = gitArgs;
            if (!sourceBranch || !destinationBranch || !title) {
                throw new Error(
                    "Usage: git-pr create <ISSUE-KEY> <REPO> <SOURCE_BRANCH> <DEST_BRANCH> <TITLE> [DESCRIPTION]"
                );
            }
            // Brief §6: a branch is named after the parent Story/Bug, not the subtask
            // opening the PR — TAI-107 found this session's own branches had deviated.
            // TAI-297: resolveStoryKeyForPr checks the issue's actual type, not merely
            // whether it has a parentKey — see its own doc comment for why that matters.
            const { storyKey, subtaskKey } = resolveStoryKeyForPr(issue);
            validateBranchName(sourceBranch, storyKey);
            // TAI-112: the PR title is tied to the parent Story/Bug first, subtask second —
            // the 10 PRs preceding this ticket used neither convention consistently.
            validatePrTitle(title, storyKey, subtaskKey);

            // rev 52 (TAI-159 ADR §3.3): loads PR Reviewers roster from Confluence and
            // passes them as reviewers so they are auto-assigned on PR creation.
            //
            // TAI-165/167 ADR: the roster's HumanRefs are email-keyed only (matched by
            // email/name for readyToReview's purposes, no real account_id) -- Bitbucket's
            // reviewers field needs a real Atlassian Account ID, so each entry is resolved
            // through WorkTracker.resolveHuman first. The PR's own author (this call's
            // authenticated BITBUCKET_EMAIL) is excluded up front rather than relying on
            // Bitbucket's self-review rejection semantics. Best-effort throughout, same as
            // before: any failure here still lets the PR itself get created.
            let prReviewers: readonly HumanRef[] | undefined;
            let droppedReviewers: readonly string[] = [];
            try {
                const roster = await loadPrReviewers(config.backend.docStore, {
                    spaceKey: config.spaceKey,
                    projectKey: config.projectKey,
                });
                const session = await gitHostSession(config);
                const candidates = roster.filter((r) => !session.email || r.email !== session.email);
                if (session.kind === "github") {
                    // TAI-583 ADR decision 3: GitHub reviewers come from the page's GitHub column.
                    const reviewers = githubReviewers(candidates);
                    prReviewers = reviewers.reviewers;
                    droppedReviewers = reviewers.dropped;
                } else {
                    const resolved = await Promise.all(
                        candidates.map((r) => (r.email ? config.backend.workTracker.resolveHuman(r.email) : Promise.resolve(null)))
                    );
                    prReviewers = resolved.filter((h): h is HumanRef => h !== null);
                    droppedReviewers = candidates
                        .filter((_, i) => resolved[i] === null)
                        .map((r) => r.email ?? r.displayName);
                }
            } catch {
                prReviewers = undefined;
            }

            const pr = await gitHost.createPullRequest({
                repo,
                title,
                sourceBranch,
                destinationBranch,
                ...(description ? { description } : {}),
                ...(prReviewers ? { reviewers: prReviewers } : {}),
            });

            // rev 52 (TAI-159 ADR §4): links directly to the issue the PR was created
            // against — no CodeReview-sibling search needed anymore (that indirection
            // existed only because the PR conceptually belonged to a separate CodeReview
            // subtask; CodeReview is retired going forward). Unconditional, not
            // best-effort — `issue.key` is always a real key.
            await config.backend.workTracker.createRemoteLink(issue.key, pr.url, pr.title);

            console.log(renderPullRequestRef(pr, personaId, issue.key));
            // PR 215 review: a reviewer request that failed after the PR was created (GitHub asks for them
            // in a second call) leaves the PR without them; say who.
            const notRequested = reviewersNotRequested(prReviewers ?? [], pr.reviewers, pr.author);
            if (notRequested.length > 0) {
                console.log(`\nNote: ${notRequested.map((r) => r.displayName).join(", ")} could not be requested as reviewer on the PR; add them on the git host.`);
            }
            if (droppedReviewers.length > 0) {
                console.log(
                    `\nNote: ${droppedReviewers.join(", ")} on the PR Reviewers roster could not be resolved to a real account on the git host (on GitHub: no login in the page's GitHub column) and was not added as a reviewer.`
                );
            }
            return;
        }

        if (action === "merge") {
            // TAI-462: `force=true` anywhere among the trailing args is the merge-gate override.
            const force = gitArgs.includes("force=true");
            const { prIdArg, strategy } = parseMergeArgs(gitArgs.filter((a) => a !== "force=true"));
            const prId = await resolvePullRequestId(gitHost, repo, prIdArg);

            // Brief §5.4: merge is "gated on GitHost.getCommitStatuses being green first" —
            // confirmed live (TAI-107) this was never actually checked anywhere; both this
            // session's real merges (PR #16, #17) went through with zero CI check.
            const pr = await gitHost.getPullRequest(repo, prId);
            if (!pr) throw new Error(`PR ${prId} not found on ${repo}.`);
            const statuses = await gitHost.getCommitStatuses(repo, pr.sourceCommit);
            if (!isGreen(statuses)) {
                // TAI-230/250: isGreen only fails here when at least one status EXISTS and
                // isn't successful — zero statuses is green now (Pipelines is manual-only),
                // so `statuses` is never empty in this branch.
                const result: GitMutationResult = {
                    ok: false,
                    reason: `CI status not green for ${pr.sourceCommit} — ${statuses
                        .map((s) => `${s.key}: ${s.state}`)
                        .join(", ")}.`,
                };
                console.log(renderGitMutationResult(result, personaId));
                return;
            }

            // TAI-462: the merge gate -- fresh approvals, no standing request-changes, every test
            // tier on the ticket Done, UAT Done unless labeled uat-after-merge (TAI-507). The ticket is whichever one this PR is linked to; the
            // <ISSUE-KEY> given is only the fallback (it is sometimes borrowed for permission).
            const linkedKey = await findLinkedIssueForPR(config.backend.workTracker, config.projectKey, pr.url);
            const prTicket = linkedKey ?? issue.key;
            const verdict = await checkMergeGate(
                { gitHost, workTracker: config.backend.workTracker, ...requiredApprovalsFromEnv() },
                pr,
                prTicket
            );
            // TAI-534: with a check command configured, a commit with no result at all is a blocker too
            // (a result that exists and is not successful was refused above, and force cannot pass that).
            const { blockers, proceed } = mergeBlockersWithCheck({ gateBlockers: verdict.blockers, checkCommand: checkCommandFromEnv(), statuses, commit: pr.sourceCommit, force });
            if (!proceed) {
                console.log(renderMergeRefused(blockers, personaId));
                return;
            }

            // TAI-585: the merge only goes through on the commit the gate was checked against.
            const result = await gitHost.mergePullRequest(repo, prId, strategy, { expectedHead: pr.sourceCommit });
            if (result.ok && blockers.length > 0) {
                // Past the gate on purpose: say so on the PR, stamped, after the merge went through.
                await gitHost.addPullRequestComment(repo, prId, stampComment(mergeOverrideComment(blockers), actingPersonaOf(config)));
            }

            // rev 52 (TAI-159 ADR §4; generalized TAI-293): self-closing Done trigger — a
            // second write in this same command, same shape `git-pr create`'s PR+link
            // already has. The <ISSUE-KEY> this merge was invoked with isn't assumed to BE
            // the linked issue (it's sometimes borrowed purely for permission resolution) —
            // `linkedKey` (found above, before the merge) is whichever In-Progress Dev/Story/Bug/
            // Spike/Epic issue's own remote link actually points at this PR. Best-effort: a merge
            // that can't be correlated to any tracked issue still succeeds, only the side
            // effect is skipped.
            let closedIssueKey: string | undefined;
            let rebaseCommentPostedOn: string | undefined;
            if (result.ok) {
                if (linkedKey) {
                    await config.backend.workTracker.transition(linkedKey, Status.Done);
                    closedIssueKey = linkedKey;
                }
            } else if (isMergeConflict(result.reason)) {
                // TAI-217/219: Bitbucket doesn't invalidate an existing approval when new
                // commits land (no "reset approvals on change" on the free tier) — so a
                // merge conflict is exactly the moment a prior approval may have gone stale.
                // Posting this comment is purely informational (not a decision with
                // consequences), so it runs automatically as part of reporting the failure —
                // unlike `git-pr unapprove`, which stays suggested-only, never automatic.
                if (linkedKey) {
                    await config.backend.workTracker.addComment(linkedKey, stampComment(rebaseNeededCommentBody(pr.url), actingPersonaOf(config)));
                    rebaseCommentPostedOn = linkedKey;
                }
            }

            const overrideNote =
                result.ok && !verdict.ok
                    ? `\n\nMerged past the merge gate with force=true; an override comment on the PR records why it was not met:\n${verdict.blockers.map((b) => `- ${b}`).join("\n")}`
                    : "";
            console.log(renderGitMutationResult(result, personaId, closedIssueKey, rebaseCommentPostedOn) + overrideNote);
            return;
        }

        throw new Error(
            `Unknown git-pr action "${action}" — expected "create", "review-prep", "review", "comment", "render-findings", ` +
                `"comment-findings", "unapprove", "check", or "merge".`
        );
    }

    if (subcommand === "work") {
        if (!arg) throw new Error("Usage: work <ISSUE-KEY>");
        const fetchNote = renderLocalFetchNote(await refreshLocalDefaultBranch(process.cwd(), config.taiRoot));
        const turn = await prepareWorkTurn(
            {
                backend: config.backend,
                taiRoot: config.taiRoot,
                projectKey: config.projectKey,
                spaceKey: config.spaceKey,
                briefingBudget: briefingBudgetFromEnv(),
            },
            toIssueKey(arg)
        );
        console.log(withTurnNotes([await installWarning(), fetchNote]) + renderWorkTurn(turn, await loadProjectContextSection()));
        return;
    }

    // TAI-389/395: `/tai-groom [EPIC-KEY]` -- loads Perry with a computed, read-only grooming briefing of the board
    // (ADR page 48463873). No ticket needed; an optional epic key narrows every section to that epic.
    if (subcommand === "groom") {
        if (arg) {
            const epic = await config.backend.workTracker.getIssue(toIssueKey(arg));
            if (!epic) throw new Error(`${arg}: no such issue.`);
            if (epic.issueType !== "epic") throw new Error(`${arg} is a ${epic.issueType}, not an epic -- /tai-groom takes an epic key (or none, for the whole board).`);
        }
        const pm = await loadPersonaConfig(config.backend.docStore, "pm", { spaceKey: config.spaceKey });
        const evidenceCache = createEvidenceCache();
        const result = await findGroomingWork({
            workTracker: config.backend.workTracker,
            projectKey: config.projectKey,
            ...(arg ? { epicKey: arg } : {}),
            staleBacklogDays: staleBacklogDaysFromEnv(),
            needsAssigneeList: async (issue) =>
                (
                    await suggestAssignees(
                        {
                            workTracker: config.backend.workTracker,
                            roster: await loadProjectRoster(config),
                            areaWindowDays: areaWindowDaysFromEnv(),
                            cache: evidenceCache,
                        },
                        issue,
                        {}
                    )
                ).text,
        });
        // TAI-481: an information section after the eight numbered ones; nothing in it is a proposal.
        const editedSection = renderEditedAfterApproval(
            await tryFindEditedAfterApproval({
                workTracker: config.backend.workTracker,
                docStore: config.backend.docStore,
                projectKey: config.projectKey,
                ...(arg ? { epicKey: toIssueKey(arg) } : {}),
            })
        );
        const groomBriefing = renderGroomingBriefing(result) + (editedSection ? `\n\n${editedSection}` : "");
        console.log(withTurnNotes([await installWarning()]) + renderGroomTurn(pm, groomBriefing, await loadProjectContextSection()));
        return;
    }

    // TAI-627: `settings` shows the project's settings for the current user; `settings set <key> <value>` changes one;
    // `settings admins add|remove <email>` edits the Autonomy admins list. Autonomy changes are guarded in the command.
    if (subcommand === "settings") {
        const ctx = {
            docStore: config.backend.docStore,
            spaceKey: config.spaceKey,
            email: config.currentHuman?.email ?? null,
            ...(config.actingPersona ? { actingPersona: config.actingPersona } : {}),
            aiSession: inAiSession(),
            attest: (email: string, key: string, value: string) => recordAttestation(resolvePath(config.taiRoot), email, key, value),
        };
        if (!arg) console.log(await showSettings(ctx));
        else if (arg === "set") {
            const [key, ...value] = rest;
            if (!key || value.length === 0) throw new Error("Usage: settings set <KEY> <VALUE>");
            console.log(await setSetting(ctx, key, value.join(" ")));
        } else if (arg === "admins") {
            const [action, target] = rest;
            if (!action || !target) throw new Error("Usage: settings admins add|remove <EMAIL>");
            console.log(await changeAdmin(ctx, action, target));
        } else throw new Error(`Unknown settings action "${arg}". Usage: settings | settings set <KEY> <VALUE> | settings admins add|remove <EMAIL>`);
        return;
    }

    // TAI-633: `do-dev-tasks [dryrun=true] [yolo=true|false]` (and `do-dev-tasks rules [yolo=true|false]`) works the current user's In Progress and To Do Dev subtasks one at a time, each in
    // its own headless Claude run. With dev-yolo off it builds, opens the PR and records the check; review and merge stay with people.
    if (subcommand === "do-dev-tasks") {
        // TAI-649: `do-dev-tasks rules` prints the narrow Claude Code rule set a build needs, for the person to add themselves.
        const devYoloOn = async (): Promise<boolean> => (await readSettingValue(config.backend.docStore, config.spaceKey, config.currentHuman?.email ?? null, "dev-yolo")) === "true";
        const { dryRun, yolo: yoloArg } = arg === "rules" ? parseDevTasksArgs(rest, { rules: true }) : parseDevTasksArgs([arg, ...rest]);
        if (arg === "rules") {
            // The setting is read from the settings page; a backend that cannot be reached must not stop the person from getting the rules.
            // `rules yolo=true|false` prints that set whatever the setting is, and reads nothing.
            let readFailed = false;
            const { yolo: yoloRules } = await resolveYolo(yoloArg, () =>
                devYoloOn().catch(() => {
                    readFailed = true;
                    return false;
                })
            );
            console.log(
                (readFailed ? "Could not read the dev-yolo setting, so this is the set for a build without DEV-YOLO. If dev-yolo is on, run this again once the settings page can be read.\n\n" : "") +
                    (yoloRules
                    ? `The Claude Code rules an unattended DEV-YOLO run needs (${yoloArg === undefined ? "dev-yolo is on" : "yolo=true"}): the build, and the review, fix and verify runs. Add them to this project's .claude/settings.local.json yourself; TAI does not write them.\n` +
                      "They leave out git-pr merge and init, and refuse a force push. git-pr review is allowed, since the reviewer run records its own decision with it.\n\n"
                    : `The Claude Code rules an unattended Dev build needs (${yoloArg === false ? "yolo=false" : `dev-yolo ${readFailed ? "could not be read" : "is off"}`}). Add them to this project's .claude/settings.local.json yourself; TAI does not write them.\n` +
                      "They leave out git-pr merge, git-pr review and init, and refuse a force push. With dev-yolo on, `do-dev-tasks rules` prints a larger set.\n\n") +
                    renderRulesJson(buildRunRules(defaultTaiHome(), checkCommandFromEnv(), await projectPersonaIdsOrNone(config), yoloRules))
            );
            return;
        }
        const gitDeps = await tryResolveReadyGitDeps(config);
        const checkConfigured = checkCommandFromEnv() !== null;
        const find = () =>
            findDevTasks({
                workTracker: config.backend.workTracker,
                projectKey: config.projectKey,
                currentHuman: config.currentHuman,
                ...(gitDeps
                    ? {
                          openPullRequests: async () => {
                              const listed = await listOpenPullRequests(gitDeps.gitHost, gitDeps.repos);
                              return (issue) => {
                                  for (const prs of listed.values()) {
                                      const pr = prs.find((p) => titleNamesKey(p.title, issue.key));
                                      if (pr) return pr.url;
                                  }
                                  return null;
                              };
                          },
                      }
                    : {}),
            });
        const found = await find();
        // TAI-693: `yolo=true|false` sets DEV-YOLO for this run only and never writes the setting. Turning it on passes the checks the
        // setting does (an admin, in a plain terminal, not acting as a persona); turning it off needs none.
        const settingsCtx = {
            docStore: config.backend.docStore,
            spaceKey: config.spaceKey,
            email: config.currentHuman?.email ?? null,
            ...(config.actingPersona ? { actingPersona: config.actingPersona } : {}),
            aiSession: inAiSession(),
            attest: (email: string, key: string, value: string) => recordAttestation(resolvePath(config.taiRoot), email, key, value),
        };
        if (yoloArg === true) await allowYoloForOneRun(settingsCtx, false);
        const { yolo, oneRun, thisRunOnly } = await resolveYolo(yoloArg, devYoloOn);
        if (dryRun) {
            console.log(renderDevTasksReport(found, null, { yolo, openPullRequestsChecked: gitDeps !== undefined, ...(thisRunOnly ? { yoloThisRunOnly: true } : {}) }));
            return;
        }
        if (found.tasks.length === 0) {
            console.log(renderDevTasksReport(found, [], { yolo, ...(thisRunOnly ? { yoloThisRunOnly: true } : {}) }));
            return;
        }
        if (!gitDeps) throw new Error("do-dev-tasks needs the git host: set TAI_GIT_REPOS (or TAI_GIT_WORKSPACE) and its credentials, so each PR can be found afterwards.");
        const taiHome = defaultTaiHome();
        const cli = cliCommand(taiHome);
        const timeoutMs = devRunTimeoutMs();
        // TAI-649: say plainly, before any run starts, when the rules do not cover the build (nothing is blocked).
        const readiness = readinessWarning(missingRules(buildRunRules(taiHome, checkCommandFromEnv(), await projectPersonaIdsOrNone(config), yolo), await readPermissionFiles(process.cwd())), checkConfigured, yolo);
        if (readiness) console.log(`${readiness}\n`);
        if (oneRun) await allowYoloForOneRun(settingsCtx, true);
        const developer = { id: "developer", displayName: (DEFAULT_PERSONA_DISPLAY_NAME as Record<string, string>)["developer"] ?? "developer" };
        stopRunsOnInterrupt();
        const yoloWiring = yolo
            ? {
                  gitHost: gitDeps.gitHost,
                  repos: gitDeps.repos,
                  workTracker: config.backend.workTracker,
                  docStore: config.backend.docStore,
                  spaceKey: config.spaceKey,
                  projectKey: config.projectKey,
                  taiDir: resolvePath(config.taiRoot),
                  email: config.currentHuman?.email ?? null,
                  ...(oneRun ? { oneRun: true } : {}),
                  cli,
                  cwd: process.cwd(),
                  timeoutMs,
                  rounds: Number(await readSettingValue(config.backend.docStore, config.spaceKey, config.currentHuman?.email ?? null, "review-rounds")),
                  checkConfigured,
                  reviewer: { token: process.env["TAI_REVIEWER_GITHUB_TOKEN"], email: process.env["TAI_REVIEWER_EMAIL"] },
                  reviewerHost: process.env["TAI_REVIEWER_GITHUB_TOKEN"]
                      ? createGitHostSession(await currentGitHostKind(), { ...process.env, GITHUB_TOKEN: process.env["TAI_REVIEWER_GITHUB_TOKEN"] }, process.env["TAI_REVIEWER_EMAIL"]).backend.gitHost
                      : null,
                  handoff: async (key: string, body: string) => {
                      await postIssueComment(config.backend.workTracker, key as IssueKey, stampComment(body, developer));
                  },
                  finish: {
                      checkCommand: checkCommandFromEnv(),
                      ...requiredApprovalsFromEnv(),
                      stamp: (body: string) => stampComment(body, developer),
                      assertClean: () => assertCleanTree(process.cwd(), config.taiRoot),
                      prepare: () => prepareCleanDefaultBranch(process.cwd(), config.taiRoot),
                  },
              }
            : null;
        const worked = await workDevTasks(find, {
            yolo,
            ...(yoloWiring ? { yoloGate: yoloGate(yoloWiring), yoloRun: yoloRun(yoloWiring) } : {}),
            interrupted: wasInterrupted,
            prepare: () => prepareCleanDefaultBranch(process.cwd(), config.taiRoot),
            build: (task) => runHeadlessClaude(buildDevPrompt(task.issue.key, cli), { cwd: process.cwd(), timeoutMs }),
            inspect: (task) => findOpenPullRequest(gitDeps.gitHost, gitDeps.repos, task.issue.key, { checkConfigured }),
            handoff: async (key, body) => {
                await postIssueComment(config.backend.workTracker, key, stampComment(body, developer));
            },
        }, found);
        console.log(renderDevTasksReport(worked.found, worked.results, { yolo, ...(thisRunOnly ? { yoloThisRunOnly: true } : {}) }));
        return;
    }

    // TAI-468/546: `verify <STORY-KEY>` -- loads Tessa with the Story's numbered acceptance criteria and the diff of
    // every Dev PR on it, open or merged. Read-only: she posts the one stamped Verified:/Not verified: comment herself.
    if (subcommand === "verify") {
        if (!arg) throw new Error("Usage: verify <STORY-KEY>");
        const story = await config.backend.workTracker.getIssue(toIssueKey(arg));
        if (!story) throw new Error(`${arg}: no such issue.`);
        if (story.issueType !== StoryType.Story && story.issueType !== StoryType.Bug) {
            throw new Error(`${arg} is a ${story.issueType} -- verify takes a Story or a Bug.`);
        }
        const tester = await loadPersonaConfig(config.backend.docStore, "tester", { spaceKey: config.spaceKey });
        // Read-only, so no reviewer-roster gate: it only reads pull requests and diffs.
        const gitHost = (await gitHostSession(config)).backend.gitHost;
        const rows = await findVerifyPullRequests({ workTracker: config.backend.workTracker, gitHost, projectKey: config.projectKey }, story.key);
        const withDiffs = [];
        for (const row of rows) {
            if (!row.pr) {
                withDiffs.push({ ...row, diff: null });
            } else if (row.pr.state === "merged") {
                withDiffs.push({ ...row, diff: await gatherMergedDiff({ cwd: process.cwd(), repo: row.repo, destinationBranch: row.pr.destinationBranch, sourceCommit: row.pr.sourceCommit }) });
            } else if (row.pr.state === "open") {
                withDiffs.push({ ...row, diff: await gatherDiff({ cwd: process.cwd(), repo: row.repo, sourceBranch: row.pr.sourceBranch, destinationBranch: row.pr.destinationBranch }) });
            } else {
                withDiffs.push({ ...row, diff: null, note: `the pull request was ${row.pr.state}, so its code is not part of the Story` });
            }
        }
        console.log(
            withTurnNotes([await installWarning()]) +
                renderVerifyTurn({
                    persona: tester,
                    story,
                    pullRequests: withDiffs,
                    projectContext: await loadProjectContextSection(),
                })
        );
        return;
    }

    // TAI-450 (TAI-348 decision): `/tai-kickoff [INITIATIVE...]` -- loads Perry with her Project initiation behavior
    // and a read-only briefing of the Epics and Kickoff Stories that already exist, so she dedups. No ticket needed.
    // The initiative is every remaining word, so an unquoted multi-word description survives.
    if (subcommand === "kickoff") {
        const pm = await loadPersonaConfig(config.backend.docStore, "pm", { spaceKey: config.spaceKey });
        const description = [arg, ...rest].filter((w): w is string => w !== undefined).join(" ");
        const context = await findKickoffContext({
            workTracker: config.backend.workTracker,
            projectKey: config.projectKey,
            ...(description ? { description } : {}),
            existingCode: await detectExistingCode(process.cwd()),
            hasProjectContext: (await readProjectContext(process.cwd())) !== null,
        });
        console.log(withTurnNotes([await installWarning()]) + renderKickoffTurn(pm, renderKickoffBriefing(context), await loadProjectContextSection()));
        return;
    }

    // TAI-559 (TAI-492, TAI-461 decision): `/tai-change [EPIC-KEY] [statement...]` -- loads Perry with a read-only view of the open
    // board and its linked documents, and what the human says changed. No ticket needed. The statement is every remaining
    // word, so an unquoted multi-word statement survives; the skill passes it as ONE single-quoted argument.
    if (subcommand === "change") {
        const pm = await loadPersonaConfig(config.backend.docStore, "pm", { spaceKey: config.spaceKey });
        const changeArgs = parseChangeArgs([arg, ...rest].filter((w): w is string => w !== undefined));
        const context = await findChangeContext({
            workTracker: config.backend.workTracker,
            docStore: config.backend.docStore,
            projectKey: config.projectKey,
            spaceKey: config.spaceKey,
            ...(changeArgs.epicKey ? { epicKey: changeArgs.epicKey } : {}),
            ...(changeArgs.statement ? { statement: changeArgs.statement } : {}),
        });
        console.log(withTurnNotes([await installWarning()]) + renderPersonaTurn(pm, renderChangeBriefing(context), await loadProjectContextSection()));
        return;
    }

    // TAI-491 (TAI-461 decision): `/tai-retro [EPIC-KEY | since=<date>]` -- loads Perry with a read-only summary of what
    // was cancelled, raised as Bugs, sent back, overridden or approved stale in a window. No ticket needed.
    if (subcommand === "retro") {
        const retroArgs = parseRetroArgs([arg, ...rest].filter((w): w is string => w !== undefined));
        const pm = await loadPersonaConfig(config.backend.docStore, "pm", { spaceKey: config.spaceKey });
        const gitDeps = await tryResolveReadyGitDeps(config);
        const report = await findRetroSummary({
            workTracker: config.backend.workTracker,
            projectKey: config.projectKey,
            ...(retroArgs.epicKey ? { epicKey: toIssueKey(retroArgs.epicKey) } : {}),
            ...(retroArgs.since !== undefined ? { since: retroArgs.since } : {}),
            ...(gitDeps ? { git: { gitHost: gitDeps.gitHost, repos: gitDeps.repos } } : {}),
        });
        console.log(withTurnNotes([await installWarning()]) + renderPersonaTurn(pm, renderRetroBriefing(report), await loadProjectContextSection()));
        return;
    }

    if (subcommand === "ready") {
        const persona = parseReadyPersonaArg(arg);
        const fetchNote = renderLocalFetchNote(await refreshLocalDefaultBranch(process.cwd(), config.taiRoot));
        const gitDeps = await tryResolveReadyGitDeps(config);
        const evidenceCache = createEvidenceCache(); // TAI-419: shared across every ticket this run suggests for
        const result = await findReadyWork(
            {
                workTracker: config.backend.workTracker,
                taiRoot: config.taiRoot,
                projectKey: config.projectKey,
                ...(gitDeps ?? {}),
                // TAI-419: the best assignee for each unassigned ready ticket (one line); the full list is `issue suggest`.
                suggestAssignee: async (issue) => {
                    const { ranked } = await suggestAssignees(
                        {
                            workTracker: config.backend.workTracker,
                            roster: await loadProjectRoster(config),
                            areaWindowDays: areaWindowDaysFromEnv(),
                            cache: evidenceCache,
                        },
                        issue,
                        {}
                    );
                    const top = ranked[0];
                    return top ? `${top.candidate.displayName} (${top.reasons[0] ?? "no signal"})` : null;
                },
            },
            persona
        );
        const unreadableNote = renderUnreadableIssuesNote(takeUnreadableIssues());
        // TAI-481: shown, never blocking. Skipped for a persona-scoped list, which is about that persona's own work.
        const editedSection = persona
            ? undefined
            : renderEditedAfterApproval(
                  await tryFindEditedAfterApproval({ workTracker: config.backend.workTracker, docStore: config.backend.docStore, projectKey: config.projectKey })
              );
        console.log(
            (fetchNote ? `${fetchNote}\n\n` : "") +
                renderReadyWork(result, persona) +
                (editedSection ? `\n\n${editedSection}` : "") +
                (unreadableNote ? `\n\n${unreadableNote}` : "")
        );
        return;
    }

    if (subcommand === "pr-ready") {
        const gitDeps = await tryResolveReadyGitDeps(config);
        const result = await findReadyPRWork({
            workTracker: config.backend.workTracker,
            projectKey: config.projectKey,
            ...(gitDeps ?? {}),
        });
        console.log(renderPRReadyWork(result));
        return;
    }

    if (subcommand === "link-precedence") {
        if (!arg) throw new Error("Usage: link-precedence <STORY-KEY>");
        // TAI-118: link-precedence is explicitly meant to be run immediately after
        // front-loading a story's subtask set — exactly the window where Jira Cloud's
        // eventually-consistent search index can still be missing a just-created subtask.
        // Opt into the retry here (unit tests exercising materializePrecedenceLinks
        // directly still default to the original one-shot behavior).
        const result = await materializePrecedenceLinks(config.backend.workTracker, toIssueKey(arg), {
            attempts: 4,
            delayMs: 3000,
        });
        console.log(renderPrecedenceLinkResults(result));
        return;
    }

    if (subcommand === "doc") {
        const [action, ...docArgs] = [arg, ...rest];

        // TAI-302/319: run by whichever persona just finished updating a living doc's actual
        // page content (Analyst for project-home) -- records "this is now the truth as of
        // now," the baseline `tai-ready`'s staleness check diffs future runs against. Never
        // reads or writes the Confluence page itself -- see living-doc-staleness.ts's header.
        if (action === "snapshot-living-doc") {
            const [projectKey, outputType] = docArgs;
            if (!projectKey || !outputType) {
                throw new Error("Usage: doc snapshot-living-doc <PROJECT-KEY> <OUTPUT-TYPE>");
            }
            if (!EPIC_SUMMARY_LIVING_DOC_TYPES.includes(outputType)) {
                throw new Error(
                    `Unknown living-doc output type "${outputType}" -- expected one of: ${EPIC_SUMMARY_LIVING_DOC_TYPES.join(", ")}. ` +
                        `A snapshot for a type not checked here would never be read by \`ready\`'s staleness check.`
                );
            }
            const epics = await config.backend.workTracker.search({
                projectKey,
                issueTypes: ["epic"],
                limit: DEFAULT_SEARCH_LIMIT,
            });
            const summaries: EpicSummary[] = [];
            for (const epic of epics) {
                const children = await config.backend.workTracker.search({
                    projectKey,
                    parentKey: epic.key,
                    issueTypes: EPIC_CHILD_ISSUE_TYPES,
                    limit: DEFAULT_SEARCH_LIMIT,
                });
                summaries.push(computeEpicSummary(epic, children));
            }
            const snapshot = await writeLivingDocSnapshot(config.taiRoot, projectKey, outputType, summaries);
            console.log(
                `# Living doc snapshot recorded\n\n${outputType} (${projectKey}): ${summaries.length} Epic(s) captured at ${snapshot.generatedAt}.`
            );
            return;
        }

        throw new Error(`Unknown doc action "${action}" -- expected "snapshot-living-doc".`);
    }

    if (subcommand === "issue") {
        const [action, ...issueArgs] = [arg, ...rest];

        if (action === "create") {
            const [projectKey, issueType, summary, ...kv] = issueArgs;
            if (!projectKey || !issueType || !summary) {
                throw new Error(
                    "Usage: issue create <PROJECT-KEY> <ISSUE-TYPE> <SUMMARY> " +
                        "[parent=<KEY>] [persona=<PERSONA>] [assignee=<EMAIL>] [description=<TEXT>] [priority=<PRIORITY>] [labels=<a,b,c>] " +
                        "[allowDuplicate=true]\n" +
                        "  assignee=<EMAIL> names who gets the ticket: it always wins, with no prompt and no roster check " +
                        "(TAI-421); an email that resolves to no Jira user creates the ticket UNASSIGNED with a note.\n" +
                        "  With 2+ humans on the persona and nobody named, the ticket is created UNASSIGNED and a ranked " +
                        "'Needs an assignee' list is printed (see also: issue suggest <KEY>) -- offer it to the human, " +
                        "including 'Leave unassigned' (TAI-419).\n" +
                        '  <ISSUE-TYPE> is TAI\'s own internal value (e.g. "bug", "dev", "code-review", ' +
                        '"integration-test") -- see StoryType/SubtaskType in story-schema.ts -- NOT the raw Jira ' +
                        'display name ("Bug", "Dev", "CodeReview").\n' +
                        "  allowDuplicate=true opts out of the one-per-story-instance duplicate-subtask guard " +
                        "(TAI-226/228) -- only for a deliberate redo of a normally-singleton subtask type.\n" +
                        "  persona= defaults to the type's owner (a subtask) or PM (story-level, Epic); only a spike-task " +
                        "has no default -- ASK the human which persona before creating it (TAI-409).\n" +
                        "  A subtask with parent= but no explicit priority= inherits its parent's Priority " +
                        "automatically (TAI-292) -- pass priority= explicitly to override."
                );
            }
            const fields = parseKeyValueArgs(kv);
            // TAI-409: an omitted persona= falls back to the documented default for the type (the
            // owner for a subtask, PM for story-level and Epic), BEFORE assignment, so the
            // assignment-helper sees the real persona. Only SpikeTask has no default.
            const persona: Persona | undefined =
                fields["persona"] !== undefined
                    ? parsePersonaArg(fields["persona"])
                    : (defaultPersonaFor(issueType as StoryType | SubtaskType | "epic") ?? undefined);

            // TAI-249/260 ADR, amended by TAI-416/419: pre-assign at creation via the assignment-helper -- the sole
            // roster candidate only. With 2+ candidates the ticket is created UNASSIGNED and the ranked list is
            // printed below (the session's human pinned first); the old create-time shortcut that silently assigned
            // the session's human is gone (it stays at claim/transition time). It applies whenever `persona` is
            // set and no `assignee=` was given; a human can still reassign afterward via `issue assign`.
            // TAI-421: an explicit assignee= names the person and takes precedence -- the helper
            // is skipped entirely.
            const { assignee: resolvedAssignee, note: assignmentNote } =
                fields["assignee"] !== undefined
                    ? await resolveNamedAssignee((email) => config.backend.workTracker.resolveHuman(email), fields["assignee"])
                    : persona
                      ? await tryResolveCreateAssignee(() => resolveIssueAssignment(config, persona, { atCreate: true }))
                      : { assignee: undefined, note: undefined };

            // TAI-292: only bother fetching the parent when its priority could actually
            // matter (priority= omitted, a parent was given) -- resolveCreatePriority
            // itself also gates on issueType, but there's no reason to fetch at all for a
            // Story/Bug/Spike's own creation (no parent Story to inherit from).
            let parentPriority: string | undefined;
            // Kept for the subtask-map note below (TAI-479), so the parent is read at most once per create.
            let parentRead: Issue | null | undefined;
            if (fields["priority"] === undefined && fields["parent"] !== undefined) {
                parentRead = await config.backend.workTracker.getIssue(toIssueKey(fields["parent"]));
                parentPriority = parentRead?.priority;
            }
            const resolvedPriority = resolveCreatePriority(
                fields["priority"],
                issueType as StoryType | SubtaskType | "epic",
                parentPriority
            );

            const input: CreateIssueInput = {
                projectKey,
                issueType: issueType as StoryType | SubtaskType | "epic",
                summary,
                ...(fields["description"] !== undefined ? { description: fields["description"] } : {}),
                ...(persona !== undefined ? { persona } : {}),
                ...(fields["parent"] !== undefined ? { parentKey: toIssueKey(fields["parent"]) } : {}),
                ...(resolvedPriority !== undefined ? { priority: resolvedPriority } : {}),
                ...(fields["labels"] !== undefined ? { labels: fields["labels"].split(",") } : {}),
                ...(fields["allowDuplicate"] !== undefined ? { allowDuplicate: fields["allowDuplicate"] === "true" } : {}),
                ...(resolvedAssignee !== undefined ? { assignee: resolvedAssignee } : {}),
            };
            const issue = await config.backend.workTracker.createIssue(input);
            console.log(renderIssueRef(issue));
            // TAI-504: a note, never a refusal, when the description is a wall of text.
            const createNote = wallOfTextNote("description", fields["description"], `issue update ${issue.key} description=…`);
            if (createNote) console.log(`\n${createNote}`);
            if (assignmentNote) console.log(`\n${assignmentNote}`);
            // TAI-419: still unassigned under a persona (2+ candidates, nobody named) -> the ranked list, the
            // session's human pinned first. The ticket already exists; "leave unassigned" is a valid outcome.
            if (!issue.assignee && issue.persona) {
                try {
                    const suggestion = await suggestAssignees(
                        { workTracker: config.backend.workTracker, roster: await loadProjectRoster(config), areaWindowDays: areaWindowDaysFromEnv() },
                        issue,
                        { pin: config.currentHuman }
                    );
                    console.log(`\n${suggestion.text}`);
                } catch {
                    // A roster that cannot be read was already explained by the assignment note above.
                }
            }
            if (!issue.persona) console.log(`\n${PERSONA_LESS_CREATE_WARNING(issue.key)}`);
            const outsideGrantNote = await actingGrantNote(config, "create", issue.issueType);
            if (outsideGrantNote) console.log(`\n${outsideGrantNote}`);
            const mapNote = await createdSubtaskMapNote(issue, parentRead, (parentKey) => config.backend.workTracker.getIssue(parentKey));
            if (mapNote) console.log(`\n${mapNote}`);
            return;
        }

        // TAI-560 (light lane, TAI-473): a Story or Bug and its Dev subtask in one call, both in To Do. Review and the
        // merge gate apply unchanged; only the ticket setup shrinks. "Very small" is a convention, not checked.
        if (action === "create-small") {
            const [projectKey, issueType, summary, ...kv] = issueArgs;
            if (!projectKey || !issueType || !summary) {
                throw new Error(
                    "Usage: issue create-small <PROJECT-KEY> <story|bug> <SUMMARY> description=<TEXT> [parent=<EPIC-KEY>] [priority=<PRIORITY>]\n" +
                        "  The light lane for a very small change (one you could describe in two sentences): creates the Story or Bug and its Dev " +
                        "subtask, assigned as a normal create would assign them, both in To Do. Review and the merge gate still apply.\n" +
                        "  description= must contain a line starting AC-1 (a numbered acceptance criterion), so the work can be verified.\n" +
                        "  Any other type, or anything that needs more than a Dev subtask, goes through issue create."
                );
            }
            const fields = parseKeyValueArgs(kv);
            const small = await createSmall(
                {
                    workTracker: config.backend.workTracker,
                    resolveAssignee: (persona) => tryResolveCreateAssignee(() => resolveIssueAssignment(config, persona, { atCreate: true })),
                },
                {
                    projectKey,
                    type: issueType,
                    summary,
                    ...(fields["description"] !== undefined ? { description: fields["description"] } : {}),
                    ...(fields["parent"] !== undefined ? { parentKey: toIssueKey(fields["parent"]) } : {}),
                    ...(fields["priority"] !== undefined ? { priority: fields["priority"] } : {}),
                }
            );
            console.log(renderCreateSmall(small));
            // What a normal `issue create` also prints: the ranked list for a ticket left unassigned under a persona
            // (2+ candidates, nobody named; the ticket exists, "leave unassigned" is valid), and the note for a create
            // outside the acting persona's grant.
            for (const made of [small.parent, small.dev]) {
                if (!made.assignee && made.persona) {
                    try {
                        const suggestion = await suggestAssignees(
                            { workTracker: config.backend.workTracker, roster: await loadProjectRoster(config), areaWindowDays: areaWindowDaysFromEnv() },
                            made,
                            { pin: config.currentHuman }
                        );
                        console.log(`\n${suggestion.text}`);
                    } catch {
                        // A roster that cannot be read was already explained by the assignment note.
                    }
                }
            }
            for (const issueType of new Set([small.parent.issueType, small.dev.issueType])) {
                const outsideGrantNote = await actingGrantNote(config, "create", issueType);
                if (outsideGrantNote) console.log(`\n${outsideGrantNote}`);
            }
            const smallNote = wallOfTextNote("description", fields["description"], `issue update ${small.parent.key} description=…`);
            if (smallNote) console.log(`\n${smallNote}`);
            return;
        }

        if (action === "update") {
            const [issueKey, ...kv] = issueArgs;
            if (!issueKey || kv.length === 0) {
                throw new Error(
                    "Usage: issue update <ISSUE-KEY> [summary=<TEXT>] [description=<TEXT>] " +
                        "[persona=<PERSONA>] [priority=<PRIORITY>] [component=<TEXT>] [severity=<TEXT>] " +
                        "[parent=<EPIC-KEY>] [labels=<a,b,c>] [flagged=true|false]\n" +
                        "  flagged=true sets Jira's Flag (impediment: waiting on something external), flagged=false clears it.\n" +
                        "  parent= re-parents a Story/Bug under an Epic (a subtask is rejected -- use the Jira UI); " +
                        "labels= REPLACES the whole list (labels= with no value clears it).\n" +
                        "  For reassigning to a different human, use \"issue assign\" instead -- it resolves " +
                        "the real Atlassian Account ID that assignee patches require."
                );
            }
            const fields = parseKeyValueArgs(kv);
            const patch = parseIssueUpdatePatch(fields);
            const issue = await config.backend.workTracker.updateIssue(toIssueKey(issueKey), patch);
            console.log(renderIssueRef(issue));
            const updateNote = wallOfTextNote("description", fields["description"], `issue update ${issue.key} description=…`);
            if (updateNote) console.log(`\n${updateNote}`);
            return;
        }

        if (action === "transition") {
            const [issueKey, status, ...kv] = issueArgs;
            if (!issueKey || !status) {
                throw new Error(
                    "Usage: issue transition <ISSUE-KEY> <STATUS> [force=true]\n" +
                        "  force=true starts a subtask even though a precedence prerequisite is still open (TAI-476). It is the " +
                        "human's call: use it only when the human says so. A comment on the ticket records what was bypassed. " +
                        "It does not bypass the assignment gate or a review gate."
                );
            }
            const key = toIssueKey(issueKey);
            const target = normalizeStatusArg(status) as Status;
            const options = parseKeyValueArgs(kv)["force"] === "true" ? { overridePrecedence: true } : undefined;
            let result = await config.backend.workTracker.transition(key, target, options);
            let enrichedCandidates: string | undefined;
            let autoAssignFailure: string | undefined;

            // TAI-249/260 ADR: gate-time wiring. On the assignment gate specifically, try
            // the assignment-helper before giving up -- auto-assign+retry once if the
            // current session's human resolves as the pick, otherwise enrich the rejection
            // with the real candidate list (never a new command, per the ADR's ratified
            // choice) instead of the old generic "let the assignment-helper surface
            // candidates" pointer-to-nothing.
            if (!result.ok && isAssignmentGateReason(result.reason)) {
                const issue = await config.backend.workTracker.getIssue(key);
                if (issue?.persona) {
                    const { assignee } = await resolveIssueAssignment(config, issue.persona);
                    if (assignee) {
                        const assigned = await config.backend.workTracker.assignIssue(key, assignee);
                        if (assigned.ok) {
                            result = await config.backend.workTracker.transition(key, target, options);
                        } else {
                            // Falls through to reporting the ORIGINAL transition rejection
                            // below (no retry attempted), but the human also sees WHY the
                            // auto-assign attempt itself failed instead of that failure
                            // being swallowed silently (PR #71 review, nitpick, fixed this
                            // session).
                            autoAssignFailure = `Auto-assign to ${assignee.displayName} failed: ${assigned.reason}`;
                        }
                    } else {
                        enrichedCandidates = (
                            await suggestAssignees(
                                { workTracker: config.backend.workTracker, roster: await loadProjectRoster(config), areaWindowDays: areaWindowDaysFromEnv() },
                                issue,
                                {}
                            )
                        ).text;
                    }
                }
            }

            // TAI-475: a sign-off made through the CLI (UAT, EpicReview, DesignReview, an Epic -> Done) leaves a
            // stamped comment saying so. Best-effort: the transition has already happened.
            let signOffNote = "";
            const signOff = result.ok ? signOffComment(result.issue, target, actingPersonaOf(config)) : null;
            if (signOff) {
                try {
                    await config.backend.workTracker.addComment(key, signOff);
                    signOffNote = "\n\nSign-off recorded as a comment on the ticket.";
                } catch (err) {
                    signOffNote = `\n\nThe sign-off comment could not be posted: ${err instanceof Error ? err.message : String(err)}`;
                }
            }

            // TAI-478: closing something outside the acting persona's `complete` grant gets a note, not a
            // refusal. Done only: a Cancel is a grooming action the human confirms, not a claim of completion.
            const completeNote = result.ok && target === Status.Done ? await actingGrantNote(config, "complete", result.issue.issueType) : null;

            // TAI-468/546: closing a Story or Bug that has no Verified: / Not verified: comment still goes through;
            // the note says so. Show-only, nothing is blocked.
            const unverifiedNote = result.ok && target === Status.Done ? unverifiedCloseNote(result.issue) : null;

            // TAI-491: an Epic that just moved to Done gets a one-line suggestion. Never blocks or runs anything.
            const retroHint = result.ok ? retroEpicCloseHint(result.issue) : null;

            console.log(
                result.ok
                    ? renderIssueRef(result.issue) + renderCascadeWarnings(result.cascadeWarnings) + signOffNote + (completeNote ? `\n\n${completeNote}` : "") + (unverifiedNote ? `\n\n${unverifiedNote}` : "") + (retroHint ? `\n\n${retroHint}` : "")
                    : `# Transition denied\n\n${issueKey} -> "${target}": ${result.reason}` +
                          (autoAssignFailure ? `\n\n${autoAssignFailure}` : "") +
                          (enrichedCandidates ? `\n\n${enrichedCandidates}` : "")
            );
            return;
        }

        // TAI-419: the ranked "needs an assignee" list for one existing ticket -- read-only, same function as the
        // create output, the transition-gate rejection and /tai-ready's top suggestion.
        if (action === "suggest") {
            const [issueKey] = issueArgs;
            if (!issueKey) throw new Error("Usage: issue suggest <ISSUE-KEY>");
            const issue = await config.backend.workTracker.getIssue(toIssueKey(issueKey));
            if (!issue) throw new Error(`No issue ${issueKey}.`);
            const suggestion = await suggestAssignees(
                { workTracker: config.backend.workTracker, roster: await loadProjectRoster(config), areaWindowDays: areaWindowDaysFromEnv() },
                issue,
                {}
            );
            console.log(suggestion.text);
            return;
        }

        if (action === "assign") {
            const [issueKey, email] = issueArgs;
            if (!issueKey || !email) throw new Error("Usage: issue assign <ISSUE-KEY> <EMAIL>");
            // Resolves the real Atlassian Account ID (TAI-165/167 ADR) rather than
            // constructing a synthetic HumanRef from the email directly -- assignIssue
            // sends `human.id` straight to Jira's assignee endpoint, which needs the real
            // account id, not an email.
            const human = await config.backend.workTracker.resolveHuman(email);
            if (!human) throw new Error(`No Jira user found for "${email}" -- cannot assign.`);
            const result = await config.backend.workTracker.assignIssue(toIssueKey(issueKey), human);
            console.log(
                result.ok
                    ? renderIssueRef(result.issue)
                    : `# Assignment denied\n\n${issueKey} -> ${email}: ${result.reason}`
            );
            return;
        }

        if (action === "comment") {
            const [issueKey, body] = issueArgs;
            if (!issueKey || !body) throw new Error("Usage: issue comment <ISSUE-KEY> <BODY>   (a BODY starting \"Handoff:\" replaces the ticket's hand-off comment)");
            // TAI-475: every comment the CLI posts ends with the provenance stamp.
            // TAI-489: a `Handoff:` body replaces the ticket's latest hand-off comment (one living
            // hand-off per ticket, brief §3.9); everything else is added.
            const posted = await postIssueComment(config.backend.workTracker, toIssueKey(issueKey), stampComment(body, actingPersonaOf(config)));
            const heading = posted.replaced ? `# Hand-off comment updated on ${issueKey}` : `# Comment added to ${issueKey}`;
            const note = posted.editFailure
                ? `\n\n_The existing hand-off comment could not be edited (${posted.editFailure}), so this one was added next to it._`
                : "";
            console.log(`${heading}${note}\n\n${posted.comment.body}`);
            const commentNote = wallOfTextNote("comment", body);
            if (commentNote) console.log(`\n${commentNote}`);
            return;
        }

        if (action === "link") {
            const [relation, fromKey, toKey] = issueArgs;
            if (!relation || !fromKey || !toKey) {
                throw new Error(
                    "Usage: issue link <depends-on|relates-to> <FROM-KEY> <TO-KEY>\n" +
                        '  Means "FROM-KEY <relation> TO-KEY" -- for depends-on, TO-KEY is the BLOCKER ' +
                        "(TO-KEY blocks FROM-KEY). Getting this backwards silently inverts the edge."
                );
            }
            const parsed = parseLinkRelation(relation);
            await config.backend.workTracker.createLink(toIssueKey(fromKey), parsed, toIssueKey(toKey));
            const note = parsed === DependencyRelation.DependsOn ? ` (${toKey} blocks ${fromKey})` : "";
            console.log(`# Link created\n\n${fromKey} ${parsed} ${toKey}${note}.`);
            return;
        }

        if (action === "unlink") {
            const [relation, fromKey, toKey] = issueArgs;
            if (!relation || !fromKey || !toKey) {
                throw new Error(
                    "Usage: issue unlink <depends-on|relates-to> <FROM-KEY> <TO-KEY>\n" +
                        "  Takes the same arguments as issue link: removes the link that command created."
                );
            }
            console.log(await unlinkIssues(config.backend.workTracker, relation, fromKey, toKey));
            return;
        }

        // TAI-268: bulk read primitive `tai-audit` needs (and anything else doing a
        // whole-backlog sweep) -- no free-text/JQL, just the structured fields
        // `IssueFilter` already supports. Defaults to the CURRENT project; every other
        // field is an explicit opt-in filter, omitted entirely means unfiltered on that
        // axis (NOT narrowed to open statuses by default -- a generic primitive, not an
        // audit-specific one; pass status=... explicitly for that).
        if (action === "search") {
            const fields = parseKeyValueArgs(issueArgs);
            const filter = parseIssueSearchFilter(fields, config.projectKey);
            const issues = await config.backend.workTracker.search(filter);
            const unreadable = takeUnreadableIssues();
            const unreadableNote = renderUnreadableIssuesNote(unreadable);
            console.log(
                renderIssueSearchResults(issues, filter, unreadable.length) + (unreadableNote ? `\n\n${unreadableNote}` : "")
            );
            return;
        }

        if (action === "get") {
            const [issueKey] = issueArgs;
            if (!issueKey) throw new Error("Usage: issue get <ISSUE-KEY>");
            const issue = await config.backend.workTracker.getIssue(toIssueKey(issueKey));
            if (!issue) {
                console.log(`# Issue ${issueKey}\n\nNot found.`);
                return;
            }
            console.log(await renderIssueDetail(config.backend, issue));
            return;
        }

        throw new Error(
            `Unknown issue action "${action}" -- expected "create", "create-small", "update", "transition", "assign", "suggest", "comment", ` +
                `"link", "unlink", "search", or "get".`
        );
    }

    if (subcommand === "page") {
        const [action, ...pageArgs] = [arg, ...rest];

        if (action === "create") {
            const [spaceKey, title, content, ...kv] = pageArgs;
            if (!spaceKey || !title || !content) {
                throw new Error(
                    "Usage: page create <SPACE-KEY> <TITLE> <CONTENT> type=<OUTPUT-TYPE> | parent=<PAGE-ID>\n" +
                        "  type= files the page in its doc-type folder (found or created in the space); parent= overrides it. " +
                        "Neither is refused: a page is never left at the space root (brief section 4).\n" +
                        'Passing content from a file: pass "$(cat file)" unescaped and re-read the page afterward. ' +
                        "One unwrapped line per paragraph/bullet; sequential list numbers (brief section 4)."
                );
            }
            const fields = parseKeyValueArgs(kv);
            const parentId = await resolvePageParent(config.backend.docStore, spaceKey, {
                ...(fields["type"] !== undefined ? { type: fields["type"] } : {}),
                ...(fields["parent"] !== undefined ? { parent: fields["parent"] } : {}),
            });
            const input: CreatePageInput = { spaceKey, title, content, ...(parentId ? { parentId } : {}) };
            const page = await config.backend.docStore.createPage(input);
            console.log(renderPageRef("Page created", page));
            return;
        }

        if (action === "link") {
            const [issueKey, pageId] = pageArgs;
            if (!issueKey || !pageId) throw new Error("Usage: page link <ISSUE-KEY> <PAGE-ID>");
            await config.backend.workTracker.linkPage(toIssueKey(issueKey), toPageId(pageId));
            console.log(`# Page linked\n\n${pageId} linked to ${issueKey}.`);
            return;
        }

        // TAI-268: read primitive, same rationale as `issue search`/`issue get` above.
        // `PageRef` is id-or-(spaceKey,title) (interface.ts) -- `id=<PAGE-ID>` selects the
        // former, two positional args the latter.
        if (action === "get") {
            const usage = "Usage: page get <SPACE-KEY> <TITLE> | page get id=<PAGE-ID>";
            const [first, second] = pageArgs;
            if (!first) throw new Error(usage);
            const ref = parsePageGetRef(first, second);
            if (!ref) throw new Error(usage);

            const page = await config.backend.docStore.getPage(ref);
            if (!page) {
                console.log(`# Page not found\n\n${JSON.stringify(ref)}`);
                return;
            }
            console.log(
                [
                    `# ${page.title}`,
                    "",
                    `id: ${page.id} | space: ${page.spaceKey} | updated: ${page.updatedAt}`,
                    "",
                    page.content,
                    "",
                    `## Comments (${page.comments.length})`,
                    "",
                    page.comments.length
                        ? page.comments.map((c) => `### ${c.author.displayName} — ${c.createdAt}\n\n${c.body}`).join("\n\n")
                        : "_(no comments)_",
                ].join("\n")
            );
            return;
        }

        // TAI-598: file an existing loose page into its doc-type folder (the retrofit for pages written before
        // `page create` required a type or a parent).
        if (action === "file") {
            const [pageId, ...kv] = pageArgs;
            const type = parseKeyValueArgs(kv)["type"];
            if (!pageId || !type) throw new Error("Usage: page file <PAGE-ID> type=<OUTPUT-TYPE>");
            const page = await filePage(config.backend.docStore, toPageId(pageId), type);
            await cachePage(config.taiRoot, config.projectKey, page);
            console.log(renderPageRef("Page filed", page));
            return;
        }

        // TAI-598: read primitive for `tai-audit`'s `loose-pages` check -- the pages at a space's root that are
        // not a doc-type folder or Config.
        if (action === "loose") {
            const LOOSE_PAGES_LIMIT = 250;
            const [spaceKey] = pageArgs;
            if (!spaceKey) throw new Error("Usage: page loose <SPACE-KEY>");
            const rootPages = await config.backend.docStore.listRootPages(spaceKey, LOOSE_PAGES_LIMIT);
            const loose = looseRootPages(rootPages);
            console.log(
                [
                    `# Loose pages at the root of ${spaceKey} (${loose.length})`,
                    "",
                    loose.length
                        ? loose.map((p) => `- ${p.id} — ${p.title}`).join("\n")
                        : "_(none: every page is filed)_",
                    ...(rootPages.length >= LOOSE_PAGES_LIMIT
                        ? ["", `Only the first ${LOOSE_PAGES_LIMIT} pages at the root were read, so there may be more.`]
                        : []),
                ].join("\n")
            );
            return;
        }

        // TAI-301: DocStore.updatePage already existed (exercised in conformance.ts) but
        // had no CLI path -- a persona correcting or refreshing already-published content
        // (a decision record, a living doc) had no sanctioned way to do so. Mirrors "issue
        // update"'s <KEY> then key=value-patch shape.
        if (action === "update") {
            const [pageId, ...kv] = pageArgs;
            if (!pageId || kv.length === 0) {
                throw new Error(
                    "Usage: page update <PAGE-ID> [title=<TEXT>] [content=<TEXT>] [parent=<PAGE-ID>]\n" +
                        'Passing content from a file: write "content=$(cat file)" exactly so, UNESCAPED (an escaped ' +
                        "\\$(cat ...) writes the literal text over the page), and re-read the page afterward. " +
                        "One unwrapped line per paragraph/bullet; sequential list numbers (brief section 4)."
                );
            }
            const fields = parseKeyValueArgs(kv);
            const patch: PagePatch = {
                ...(fields["title"] !== undefined ? { title: fields["title"] } : {}),
                ...(fields["content"] !== undefined ? { content: fields["content"] } : {}),
                // TAI-305: move the page under a different parent -- e.g. filing a loose
                // page into its doc-type folder (brief §4 rev 11/14).
                ...(fields["parent"] !== undefined ? { parentId: toPageId(fields["parent"]) } : {}),
            };
            const page = await config.backend.docStore.updatePage({ id: toPageId(pageId) }, patch);
            // TAI-303: write-through the cache on success -- same rationale as the issue-
            // side fixes above ("issue update"'s comment), for `refreshPage`/`cachePage`.
            await cachePage(config.taiRoot, config.projectKey, page);
            console.log(renderPageRef("Page updated", page));
            return;
        }

        throw new Error(`Unknown page action "${action}" -- expected "create", "link", "get", or "update".`);
    }

    throw new Error(
        `Usage: work <ISSUE-KEY> | groom [EPIC-KEY] | kickoff [INITIATIVE] | retro [EPIC-KEY | since=<date>] | change [EPIC-KEY] [statement] | ready [persona] | do-dev-tasks [dryrun=true] [yolo=true|false] | do-dev-tasks rules [yolo=true|false] | settings [set <KEY> <VALUE> | admins add|remove <EMAIL>] | pr-ready | link-precedence <STORY-KEY> | git-pr create|review|merge ... ` +
            `| issue create|transition|comment|link|search|get ... | page create|link|get|update|file|loose ... | doc snapshot-living-doc ... ` +
            `| install-global [TAI-HOME] | init status|run|jira|confluence|bitbucket|github|env|claude-md|gemini-md`
    );
}

// TAI-268: guarded so `cli.test.ts` can import this module's own pure helper functions
// (renderIssueSearchResults, parseIssueSearchFilter, etc.) for unit testing without also
// executing `main()` as a side effect of the import itself -- the exact reason no
// cli.test.ts existed before this. `import.meta.main` (Node 24, this repo's own runtime --
// see loadDotEnv's comment) rather than the classic `import.meta.url === file://+argv[1]`
// idiom -- that comparison breaks the moment this file is reached through a symlink (found
// live: EVERY real invocation goes through `~/.tai-framework` -> the checkout it is
// cloned to, TAI-90's own fixed-install-path convention -- `argv[1]` keeps the symlink
// path while `import.meta.url` resolves through it, so the two never matched and `main()`
// silently never ran at all). `import.meta.main` handles that correctly by construction.
if (import.meta.main) {
    main().catch((err: unknown) => {
        if (err instanceof NoOwningPersonaError || err instanceof PersonaPermissionError) {
            console.error(err.message);
        } else {
            console.error(err instanceof Error ? err.message : String(err));
        }
        process.exitCode = 1;
    });
}
