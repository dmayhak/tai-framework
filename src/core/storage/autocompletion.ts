/**
 * TAI Framework — brief §3.4/§8.9's condition-gated autocompletion engine (TAI-43)
 *
 * Standalone evaluation engine — deliberately NOT wired into `WorkTracker.transition()`
 * (see the TAI-41 ADR and this Story's own scoping discussion). Ordinary ("conditional")
 * checkpoint completion already succeeds unconditionally at the storage layer today: a
 * persona invoking `transition()` already acts "with exactly the authority of the human
 * driving it" (brief §3.2) — there is no existing "human sign-off" gate on ordinary
 * subtasks for autocompletion to be an escape hatch FROM. Whether a not-yet-built
 * Orchestrator persona (Epic TAI-6) PAUSES for an actual human before invoking that call,
 * or proceeds automatically, is what autocompletion actually decides — an orchestration
 * question, not a storage-layer permission check. This module gives that future
 * orchestrator the pure decision function; it enforces nothing itself.
 *
 * Checkpoint kind classification (TAI-41 ADR, resolving §8.23):
 * - `hard` — never autocompletes, regardless of any `AutocompletionConfig`.
 *   `ALWAYS_HUMAN_GATED_SUBTASKS` (e.g. `Uat`) and any story-level issue whose `StoryType`
 *   has a `REVIEW_GATES` entry (e.g. `Kickoff`) are hard.
 * - `conditional` — every other subtask/story type. Autocompletion-eligible when a
 *   matching `AutocompletionConfig` is enabled and its conditions all read PASS.
 */

import {
    ALWAYS_HUMAN_GATED_SUBTASKS,
    REVIEW_GATES,
    StoryType,
} from "../schema/story-schema.js";
import type { Issue } from "./interface.js";

export type CheckpointKind = "hard" | "conditional";

const STORY_TYPES: ReadonlySet<string> = new Set(Object.values(StoryType));
const HARD_SUBTASKS: ReadonlySet<string> = new Set(ALWAYS_HUMAN_GATED_SUBTASKS);
const GATED_STORY_TYPES: ReadonlySet<string> = new Set(REVIEW_GATES.map((g) => g.storyType));

/** Classifies any issue's checkpoint kind (TAI-41 ADR, §8.23). */
export function checkpointKind(issue: Issue): CheckpointKind {
    if (STORY_TYPES.has(issue.issueType)) {
        return GATED_STORY_TYPES.has(issue.issueType) ? "hard" : "conditional";
    }
    return HARD_SUBTASKS.has(issue.issueType) ? "hard" : "conditional";
}

// ---------- Autocompletion condition schema (§8.9) ----------

export interface AutocompletionCondition {
    /** Stable slug the completion marker (§8.22) references. */
    readonly id: string;
    /** The natural-language/prompt condition text, brief §3.4's own examples: "Code review
     *  has no major issues and fewer than X minor ones." Evaluated by the deciding persona,
     *  never by this engine — see the module doc comment above. */
    readonly description: string;
}

export type AutocompletionConfig =
    | { readonly enabled: false }
    | { readonly enabled: true; readonly conditions: readonly AutocompletionCondition[] }; // AND-only, v1

// ---------- Completion marker (§8.22) ----------

export interface ParsedCompletionMarker {
    readonly subtaskType: string;
    /** condition id -> PASS (true) / FAIL (false), as reported on the marker. */
    readonly results: ReadonlyMap<string, boolean>;
}

const COMPLETE_HEADER = /^Complete:\s*(.+)$/i;
const CONDITION_LINE = /^([^:]+):\s*(PASS|FAIL)\s*$/i;

/**
 * Parses a `Complete: <SubtaskType>` marker and its `<condition-id>: PASS|FAIL` lines from
 * a single comment body. Returns null if the comment isn't a completion marker at all.
 *
 * Deliberately NO inference-fallback here, unlike `Q:`/`Approved:`/`Rejected:`
 * (comment-markers.ts) — per the TAI-41 ADR: a persona's comment format is under TAI's own
 * prompt control, so a missing/malformed line is simply absent from `results` (and so reads
 * as unmet in `evaluateAutocompletion`), never inferred from prose.
 */
export function parseCompletionMarker(body: string): ParsedCompletionMarker | null {
    const lines = body.split("\n").map((l) => l.trim());
    const header = COMPLETE_HEADER.exec(lines[0] ?? "");
    if (!header) return null;

    const results = new Map<string, boolean>();
    for (const line of lines.slice(1)) {
        const m = CONDITION_LINE.exec(line);
        if (!m) continue; // blank lines / free-text notes after the marker are allowed
        results.set(m[1]!.trim(), m[2]!.toUpperCase() === "PASS");
    }
    return { subtaskType: header[1]!.trim(), results };
}

/**
 * The most recent `Complete:` marker on an issue, or null if none exists. Scans newest-first
 * so a superseded marker never lingers — same fresh-re-scan discipline as review-gate.ts's
 * `Approved:` scanning (brief §3.9), never a cached prior verdict.
 */
export function latestCompletionMarker(issue: Issue): ParsedCompletionMarker | null {
    for (let i = issue.comments.length - 1; i >= 0; i--) {
        const parsed = parseCompletionMarker(issue.comments[i]!.body);
        if (parsed) return parsed;
    }
    return null;
}

// ---------- Evaluation (§8.9 + §8.22 tied together) ----------

export interface AutocompletionResult {
    readonly autocompleted: boolean;
    /** Condition ids that did not read PASS (missing or FAIL). Empty when autocompleted. */
    readonly unmet: readonly string[];
}

/**
 * Evaluates whether `issue` may autocomplete under `config`. Callers should check
 * `checkpointKind(issue) === "conditional"` first — this function doesn't re-derive kind
 * itself, since kind depends on `issueType` alone while this is purely about
 * condition/marker evaluation. Calling it for a `hard` checkpoint isn't meaningful (there's
 * no config that could ever let one autocomplete), so it's the caller's job to not ask.
 */
export function evaluateAutocompletion(issue: Issue, config: AutocompletionConfig): AutocompletionResult {
    if (!config.enabled) return { autocompleted: false, unmet: [] };
    if (config.conditions.length === 0) return { autocompleted: true, unmet: [] };

    const marker = latestCompletionMarker(issue);
    const unmet = config.conditions.filter((c) => marker?.results.get(c.id) !== true).map((c) => c.id);
    return { autocompleted: unmet.length === 0, unmet };
}
