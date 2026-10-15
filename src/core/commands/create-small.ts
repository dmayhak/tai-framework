/**
 * TAI Framework — `issue create-small` (TAI-473 light lane; human decision, 2026-10-14)
 *
 * One call creates a Story or Bug together with its `Dev` subtask: linked (the subtask's parent), assigned as a
 * normal create would assign them, and both moved to To Do. Only the ticket setup shrinks. Review and the merge gate
 * apply to it exactly as to any other Story; the command adds no label, no exemption and no other subtask. What counts as "very small" is a
 * convention in the docs (a change you could describe in two sentences), not something checked here.
 *
 * The description must carry at least one `AC-1` line, so `/tai-verify` and the groom readiness check still have
 * criteria to check against.
 *
 * Nothing is created until the type and the description have been checked. After that it is three writes
 * (parent, subtask, two moves), so a failure part-way leaves what was made: `CreateSmallPartialError` names it and
 * says how to finish or undo it, rather than leaving a silent half-state.
 */

import { Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import type { HumanRef, Issue, IssueKey, WorkTracker } from "../storage/interface.js";

export interface CreateSmallDeps {
    readonly workTracker: Pick<WorkTracker, "createIssue" | "transition" | "getIssue">;
    /** The assignee a normal create would pick for this persona, or a note saying why it created unassigned. */
    readonly resolveAssignee: (persona: Persona) => Promise<{ readonly assignee?: HumanRef; readonly note?: string }>;
}

export interface CreateSmallInput {
    readonly projectKey: string;
    /** `story` or `bug`, TAI's own issue-type value. */
    readonly type: string;
    readonly summary: string;
    readonly description?: string;
    readonly parentKey?: IssueKey;
    readonly priority?: string;
}

export interface CreateSmallResult {
    readonly parent: Issue;
    readonly dev: Issue;
    /** Anything the human should see: an unassigned note, a cascade the move to To Do caused. */
    readonly notes: readonly string[];
}

/** A failure after something was created. `parentKey` is what exists. */
export class CreateSmallPartialError extends Error {
    constructor(
        message: string,
        readonly parentKey: IssueKey,
        readonly devKey?: IssueKey
    ) {
        super(message);
        this.name = "CreateSmallPartialError";
    }
}

/** A line that itself starts with AC-1 (bullet, quote or bold markers allowed), not one that merely mentions it. */
const AC_1_LINE = /^[\s>*_\-•]*(?:\*\*|__)?AC-1\b/;

const TYPES: Readonly<Record<string, StoryType.Story | StoryType.Bug>> = { story: StoryType.Story, bug: StoryType.Bug };

export async function createSmall(deps: CreateSmallDeps, input: CreateSmallInput): Promise<CreateSmallResult> {
    const { workTracker } = deps;
    const storyType = TYPES[input.type];
    if (!storyType) {
        throw new Error(`issue create-small makes a story or bug with its Dev subtask, not "${input.type}". Use issue create for anything else.`);
    }
    if (!(input.description ?? "").split("\n").some((line) => AC_1_LINE.test(line))) {
        throw new Error(
            "issue create-small needs a description with at least one numbered criterion on a line starting AC-1, " +
                "so the work can be verified (for example: AC-1: the usage text names the epic key). Nothing was created."
        );
    }

    // A parent is moved to To Do with its child, which can cascade up: refuse anything that is not an epic before creating.
    if (input.parentKey) {
        const parentIssue = await workTracker.getIssue(input.parentKey);
        if (!parentIssue) throw new Error(`parent=${input.parentKey}: no such issue. Nothing was created.`);
        if (parentIssue.issueType !== "epic") {
            throw new Error(`parent=${input.parentKey} is a ${parentIssue.issueType}, not an epic. Nothing was created.`);
        }
    }

    const notes: string[] = [];
    const parentAssignee = await deps.resolveAssignee(Persona.Pm);
    if (parentAssignee.note) notes.push(parentAssignee.note);
    const parent = await workTracker.createIssue({
        projectKey: input.projectKey,
        issueType: storyType,
        summary: input.summary,
        description: input.description!,
        persona: Persona.Pm,
        ...(input.parentKey ? { parentKey: input.parentKey } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(parentAssignee.assignee ? { assignee: parentAssignee.assignee } : {}),
    });

    let dev: Issue;
    try {
        const devAssignee = await deps.resolveAssignee(Persona.Developer);
        if (devAssignee.note) notes.push(devAssignee.note);
        dev = await workTracker.createIssue({
            projectKey: input.projectKey,
            issueType: SubtaskType.Dev,
            summary: input.summary,
            description: `Implements ${parent.key}: ${input.summary}.\n\nThe acceptance criteria are on ${parent.key}.`,
            persona: Persona.Developer,
            parentKey: parent.key,
            ...(parent.priority !== undefined ? { priority: parent.priority } : {}),
            ...(devAssignee.assignee ? { assignee: devAssignee.assignee } : {}),
        });
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new CreateSmallPartialError(
            `Created ${parent.key} but could not create its Dev subtask: ${reason}. ` +
                `Create the subtask with: issue create ${input.projectKey} dev "${input.summary}" parent=${parent.key} ` +
                `(or cancel ${parent.key} if you no longer want it). Neither ticket was moved to To Do.`,
            parent.key
        );
    }

    // The subtask first: moving the Story can cascade, and a Story in To Do with its subtask still in Backlog is the half-state to avoid.
    for (const key of [dev.key, parent.key]) {
        const moved = await workTracker.transition(key, Status.ToDo);
        if (!moved.ok) {
            throw new CreateSmallPartialError(
                `Created ${parent.key} and its Dev subtask ${dev.key}, but ${key} could not move to To Do: ${moved.reason}. ` +
                    `Fix that and move them with: issue transition ${key} "To Do".`,
                parent.key,
                dev.key
            );
        }
        for (const w of moved.cascadeWarnings ?? []) notes.push(`${w.key}: ${w.reason}`);
    }

    // As they stand after the moves; what create returned if the tracker cannot read them back.
    return { parent: (await workTracker.getIssue(parent.key)) ?? parent, dev: (await workTracker.getIssue(dev.key)) ?? dev, notes };
}

export function renderCreateSmall(result: CreateSmallResult): string {
    const { parent, dev, notes } = result;
    const lines = [
        `# Created ${parent.key} and ${dev.key} (light lane)`,
        "",
        `- **${parent.key}** [${parent.issueType}] ${parent.summary} (${parent.status})`,
        `- **${dev.key}** [dev] under ${parent.key} (${dev.status})`,
        "",
        `Start the work with \`/tai-work ${dev.key}\`. Review and the merge gate apply as for any other Story.`,
    ];
    if (notes.length > 0) lines.push("", ...notes);
    return lines.join("\n");
}
