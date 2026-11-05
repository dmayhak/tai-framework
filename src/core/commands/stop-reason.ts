/**
 * TAI Framework — the reason an unattended build run stopped without a PR (TAI-710).
 *
 * A person reads three short lines: what stopped, why as far as that is known, and what to do next. The end of the agent's own output
 * is kept apart from them, trimmed and with its line breaks, and goes after the lines in the hand-off. It is never joined into them.
 */

/** What a build run left, as `runHeadlessClaude` reports it. */
export interface RunEnd {
    readonly summary: string;
    /** For a run that did not finish: what happened to it ("the run exited with code 1"). */
    readonly what?: string;
    /** The end of the run's output. */
    readonly output?: string;
}

export interface StopReason {
    /** What stopped, one sentence. */
    readonly what: string;
    /** Why, as far as it is known, one sentence. */
    readonly cause: string;
    /** What a person does next, one sentence. */
    readonly next: string;
    /** The end of the agent's own output, trimmed, one line per line; "" when there is none. */
    readonly output: string;
}

const MAX_OUTPUT_LINES = 8;
const MAX_LINE = 240;

/** The last lines of `text`, each cut to a readable length, line breaks kept. */
export function trimmedOutput(text: string): string {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-MAX_OUTPUT_LINES);
    return lines.map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE - 1)}…` : l)).join("\n");
}

// A refusal as the agent tends to write it: the permission system or the settings said no, to a command. The wording is the agent's own and
// not recorded from a real run, so a miss only means the cause is reported as not known (the output is still kept).
const REFUSAL = /\b(?:permission|permissions)\b[^.\n]{0,60}\b(?:denied|refused|not granted|blocked|declined)\b|\b(?:denied|refused|blocked|declined)\b[^.\n]{0,40}\bpermission|\b(?:was|were|got|been)\s+(?:denied|refused|blocked)\b|haven't granted|requires? (?:approval|permission)|not allowed to (?:run|use)|(?:isn't|is not|wasn't|was not) (?:allowed|permitted)/i;
const COMMAND_IN_TICKS = /`([^`\n]{2,120})`/;
const COMMAND_AFTER = /\b(?:command|running|run|ran|use)[:\s]+["“']?((?:git|npm|npx|node|tsx|rm|mv|cp|curl|gh|docker|make|bash|sh)\s[^"”'\n]{1,100})/i;

/** The refused command named in the end of the output, with the line that says so, or null when no line reads as a refusal. */
export function refusedCommand(output: string): { readonly command: string | null; readonly line: string } | null {
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!REFUSAL.test(line)) continue;
        const command = COMMAND_IN_TICKS.exec(line)?.[1]?.trim() ?? COMMAND_AFTER.exec(line)?.[1]?.trim().replace(/[.,;:]+$/, "") ?? null;
        return { command, line };
    }
    return null;
}

/** The output and the "what happened" of a run, from the fields the run reports or, for a result that has only a summary, from the summary. */
function split(run: RunEnd): { what: string | null; output: string } {
    if (run.output !== undefined) return { what: run.what ?? null, output: run.output };
    const at = run.summary.indexOf("Last output:\n");
    if (at >= 0) return { what: run.summary.slice(0, at).replace(/\.\s*$/, "").trim() || null, output: run.summary.slice(at + "Last output:\n".length) };
    return { what: null, output: run.summary };
}

function sentence(text: string): string {
    const t = text.trim();
    return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * The reason for a build run that stopped without a PR. `unfinished` is a run that ended on an exit code, a signal or the time limit;
 * `no-pr` is one that finished cleanly and left no open PR.
 */
export function describeStop(run: RunEnd, kind: "unfinished" | "no-pr"): StopReason {
    const { what: ended, output: raw } = split(run);
    const output = trimmedOutput(raw);
    const refusal = refusedCommand(output);
    const what = kind === "unfinished" ? sentence(`The build run did not finish${ended ? `: ${ended}` : ""}`) : "The build run finished but no open PR for this ticket was found.";
    if (refusal) {
        const cause = refusal.command
            ? `the permission system refused \`${refusal.command}\`, and nobody was there to approve it.`
            : `the permission system refused a command, and nobody was there to approve it ("${refusal.line}").`;
        return {
            what,
            cause,
            next: "allow that command in the project's Claude settings or do that step by hand, then run the ticket again with /tai-work.",
            output,
        };
    }
    return {
        what,
        cause: output === "" ? "not known; the run printed nothing." : "not known; the end of the run's output is below.",
        next: kind === "unfinished" ? "read the reason, fix what it names, and run the ticket again with /tai-work." : "check the branch and open the PR with /tai-work.",
        output,
    };
}

/** The three lines, as the report shows them. */
export function stopLines(stop: Pick<StopReason, "what" | "cause" | "next">): string[] {
    return [stop.what, `Cause: ${stop.cause}`, `Next: ${stop.next}`];
}

/** The part of a hand-off after the lines: the agent's own closing text, set apart. Empty when the run printed nothing. */
export function outputSection(output: string): string {
    return output === "" ? "" : `\n\nThe end of the run's own output:\n${output}`;
}
