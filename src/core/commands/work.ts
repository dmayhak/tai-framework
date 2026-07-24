/**
 * TAI Framework — `/tai_work <KEY>` command core (TAI-61 ADR)
 *
 * Host-agnostic composition of already-built pieces — no I/O primitive invented here, no
 * fresh-vs-resume branch (brief §3.8: both are "the same briefing-then-invoke flow"):
 *
 *   0. `replayPending` — flushes any writes a PRIOR offline session queued for this same
 *      subtask (brief §3.6/TAI-56 ADR decision 3) before anything else reads its state.
 *      Runs first: a queued-but-unreplayed transition could change what "the issue" even
 *      is. Found missing entirely (PR #9 code review) — without this, a queued write
 *      stayed stranded in journal.md forever, never actually reaching the backend.
 *   1. Load the issue and read its OWN `persona` field (brief §5.6 — stored, never derived;
 *      already resolved per-instance, so no `SUBTASK_OWNER` lookup is needed here).
 *   2. `canWorkOn` gate (brief §3.1) — throws `PersonaPermissionError` if denied, same shape
 *      `PersonaScopedWorkTracker` already uses elsewhere.
 *   3. Construct the tracker chain in the order the TAI-56 ADR already fixed:
 *      permission-checking outermost, wrapping the connectivity-queue decorator.
 *   4. `generateBriefing` — this call alone satisfies brief §3.6's refresh-point rule.
 *   5. Return the persona's own prompt text plus the briefing, unformatted — prompt
 *      assembly is the host adapter's job (TAI-61 ADR decision 4), not this module's.
 */

import type { Issue, IssueKey, StorageBackend } from "../storage/interface.js";
import { canWorkOn } from "../persona/permission-gate.js";
import { loadPersonaConfig, type LoadPersonaConfigOptions } from "../persona/config.js";
import { PersonaScopedWorkTracker, PersonaPermissionError } from "../persona/scoped-work-tracker.js";
import { ConnectivityQueuedWorkTracker, replayPending, type ReplayOutcome } from "../workspace/connectivity-queue.js";
import { generateBriefing } from "../workspace/briefing.js";

export interface PrepareWorkTurnDeps {
    readonly backend: StorageBackend;
    readonly taiRoot: string;
    readonly projectKey: string;
    /** Confluence space the persona config's override/extension pages live in (brief §3.1). */
    readonly spaceKey: string;
    readonly personasDir?: string;
}

export interface WorkTurn {
    readonly issue: Issue;
    readonly personaId: string;
    readonly personaDisplayName: string;
    /** The persona's own `.md` body — unformatted, for the host adapter to assemble. */
    readonly personaPrompt: string;
    readonly briefingMarkdown: string;
    /** Result of replaying this subtask's queued offline writes, if any (step 0). Surfaced,
     *  not swallowed — an `escalated` entry is an unplanned checkpoint (brief §3.3) the host
     *  adapter should show the human, same as any other rejection. */
    readonly replayOutcome: ReplayOutcome;
}

export class NoOwningPersonaError extends Error {
    constructor(key: IssueKey) {
        super(
            `${key} has no "persona" field set — who should work this is ambiguous (brief §5.6). ` +
                `Set it explicitly before running /tai_work.`
        );
        this.name = "NoOwningPersonaError";
    }
}

/**
 * Prepares one persona turn for `key`: resolves the owning persona, checks it may work on
 * this issue, refreshes/assembles the briefing, and returns everything the host adapter
 * needs to hand off to the LLM. Does not mutate anything — a read-only preparation step,
 * same as brief §3.6's refresh points are read-only.
 */
export async function prepareWorkTurn(deps: PrepareWorkTurnDeps, key: IssueKey): Promise<WorkTurn> {
    const replayOutcome = await replayPending(deps.backend.workTracker, deps.taiRoot, deps.projectKey, key);

    const issue = await deps.backend.workTracker.getIssue(key);
    if (!issue) {
        throw new Error(`${key}: no such issue.`);
    }
    if (!issue.persona) {
        throw new NoOwningPersonaError(key);
    }

    const personaOpts: LoadPersonaConfigOptions = {
        spaceKey: deps.spaceKey,
        ...(deps.personasDir ? { personasDir: deps.personasDir } : {}),
    };
    const config = await loadPersonaConfig(deps.backend.docStore, issue.persona, personaOpts);

    if (!canWorkOn(config, issue)) {
        throw new PersonaPermissionError(config.id, "work on", `issue type "${issue.issueType}" (${key})`);
    }

    // Permission-checking outermost, wrapping the connectivity-queue decorator — the
    // ordering the TAI-56 ADR already fixed (decision 3), applied here rather than reopened.
    const queued = new ConnectivityQueuedWorkTracker(deps.backend.workTracker, deps.taiRoot, deps.projectKey, key);
    const scoped = new PersonaScopedWorkTracker(queued, config);

    const briefingMarkdown = await generateBriefing(scoped, deps.backend.docStore, deps.taiRoot, deps.projectKey, key);

    return {
        issue,
        personaId: config.id,
        personaDisplayName: config.displayName,
        personaPrompt: config.prompt,
        briefingMarkdown,
        replayOutcome,
    };
}
