/**
 * TAI Framework — the checks before a Dev ticket may run unattended (TAI-634, ADR page 64782337 decisions 4 and 9).
 *
 * `yoloStopReasons` answers one question for one ticket: why must a person do this one? An empty list means the run may
 * start. Every reason is a sentence for the hand-off, so the person knows what to change.
 */

import type { WorkTracker, DocStore } from "../storage/interface.js";
import { Status, SubtaskType } from "../schema/story-schema.js";
import { SETTINGS_PAGE_TITLE, EMPTY_SETTINGS, parseSettingsPage, viewSettings } from "../settings/settings.js";
import { hasAttestation } from "../settings/attestation.js";
import type { DevTask } from "./do-dev-tasks.js";

/** Subtasks that need a person, or a change a person should look at, before an unattended merge. */
const NEEDS_A_PERSON: ReadonlyMap<string, string> = new Map([
    [SubtaskType.Database, "a Database change"],
    [SubtaskType.Uat, "a UAT"],
    [SubtaskType.IntegrationTest, "an IntegrationTest"],
    [SubtaskType.SystemTest, "a SystemTest"],
    [SubtaskType.E2ETest, "an E2ETest"],
]);

export interface YoloCheckDeps {
    readonly workTracker: Pick<WorkTracker, "search">;
    readonly docStore: DocStore;
    readonly spaceKey: string;
    readonly projectKey: string;
    /** Where the machine's autonomy records are kept (`.tai`). */
    readonly taiDir: string;
    /** The human running the command, from the session's configured email. */
    readonly email: string | null;
}

/** Why `task` may not run unattended; empty when it may. */
export async function yoloStopReasons(deps: YoloCheckDeps, task: DevTask): Promise<readonly string[]> {
    const reasons: string[] = [];
    if (!deps.email) {
        return ["no user is configured for this session, so TAI cannot tell whose DEV-YOLO setting applies"];
    }
    const email = deps.email.toLowerCase();
    const page = await deps.docStore.getPage({ spaceKey: deps.spaceKey, title: SETTINGS_PAGE_TITLE });
    const state = page ? parseSettingsPage(page.content).state : EMPTY_SETTINGS;
    const yolo = viewSettings(state, email).find((v) => v.def.key === "dev-yolo")?.value === "true";
    if (!yolo) reasons.push(`DEV-YOLO is off for ${email}`);
    if (!state.admins.includes(email)) {
        reasons.push(`${email} is not on the Autonomy admins list${state.admins.length ? ` (${state.admins.join(", ")})` : " (it is empty)"}`);
    }
    // The page is editable by anyone who can edit the Confluence page, so it is not proof that a person turned autonomy on.
    if (!(await hasAttestation(deps.taiDir, email, "dev-yolo", "true"))) {
        reasons.push("this machine has no record that you turned DEV-YOLO on; run `tai-settings set dev-yolo true` yourself in a plain terminal");
    }
    const siblings = await deps.workTracker.search({ projectKey: deps.projectKey, parentKey: task.parent.key, exhaustive: true, readYourWrites: true });
    for (const sibling of siblings) {
        const what = NEEDS_A_PERSON.get(sibling.issueType);
        if (!what || sibling.status === Status.Canceled) continue;
        reasons.push(`${task.parent.key} has ${what} (${sibling.key}), which needs a person`);
    }
    return reasons;
}
