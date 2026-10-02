/**
 * Runs the shared conformance suite (TAI-15) against the real Jira/Confluence backend,
 * targeting the TAIT scratch project (TAI-17). Skips cleanly when credentials are absent —
 * `npm test` must stay green offline (TAI-11's acceptance criteria).
 *
 * PROJECT/SPACE KEYS ARE HARDCODED, NEVER READ FROM ENV. This is deliberate: the whole
 * safety point of a scratch project is that a misconfigured environment variable can never
 * accidentally point these tests at the real `TAI` project. Only the site URL and
 * credentials come from the environment.
 */
import { Status } from "../../schema/story-schema.js";
import { toHumanId, type IssueKey, type PageId } from "../interface.js";
import { RestClient, apiTokenAuth } from "./rest-client.js";
import { createJiraBackend } from "./jira-backend.js";
import { defineStorageConformance, type ConformanceHarness } from "../conformance.js";

const SITE_URL = process.env["TAI_TEST_JIRA_SITE_URL"];
const EMAIL = process.env["TAI_TEST_JIRA_EMAIL"];
const API_TOKEN = process.env["TAI_TEST_JIRA_API_TOKEN"];

const PROJECT_KEY = "TAIT"; // hardcoded — see file header

// The Jira "TAIT" project's linked Confluence space's real, immutable system key is "TA1"
// (Confluence auto-provisions a space with its OWN generated key when a Jira software
// project is created — the same phenomenon rev 18 found for TAI/"TA"). We can nonetheless
// use the human-visible "TAIT" here: it's the space's CURRENT ALIAS, and doc-store.ts's
// `spaceId()` resolves against either the system key or the current alias (fixed after this
// was first misdiagnosed as unresolvable — see that function's comment for the full story).
const SPACE_KEY = "TAIT";

const skip =
    SITE_URL && EMAIL && API_TOKEN
        ? false
        : "TAI_TEST_JIRA_SITE_URL / TAI_TEST_JIRA_EMAIL / TAI_TEST_JIRA_API_TOKEN not set — " +
          "set them to run this suite against the TAIT scratch project.";

/**
 * Unlike everything else in the shared suite (arbitrary strings for summaries, labels,
 * etc.), Jira's native `components` field validates against components ALREADY DECLARED on
 * the project — it is not free text. The filesystem backend has no such restriction. Rather
 * than invent a new capability flag for what is really a fixture-provisioning detail (the
 * scratch project simply doesn't have this component declared yet), the harness declares it
 * once, idempotently — the same category of one-time setup as the issue types and Persona
 * field TAI-17 already provisioned.
 */
const TEST_COMPONENT = "tai-framework";

async function ensureComponent(client: RestClient, projectKey: string, name: string): Promise<void> {
    const existing = await client.request<{ name: string }[]>(
        "GET",
        `/rest/api/2/project/${projectKey}/components`
    );
    if (existing.some((c) => c.name === name)) return;
    await client.request("POST", "/rest/api/2/component", { project: projectKey, name });
}

defineStorageConformance(
    `jira (${PROJECT_KEY})`,
    async (): Promise<ConformanceHarness> => {
        // Guarded by `skip` above — SITE_URL/EMAIL/API_TOKEN are all defined by the time this runs.
        const auth = apiTokenAuth(EMAIL!, API_TOKEN!);
        const client = new RestClient({ siteUrl: SITE_URL!, auth });
        const backend = await createJiraBackend({ siteUrl: SITE_URL!, spaceKey: SPACE_KEY, auth });
        await ensureComponent(client, PROJECT_KEY, TEST_COMPONENT);

        // A valid assignee must be a REAL account on this site — Jira validates it. Use
        // whoever the token belongs to.
        const me = await client.request<{ accountId: string; displayName: string }>(
            "GET",
            "/rest/api/2/myself"
        );
        const validAssignee = { id: toHumanId(me.accountId), displayName: me.displayName };
        const invalidAssignee = {
            id: toHumanId("definitely-not-a-real-account-id"),
            displayName: "Nobody",
        };

        return {
            backend,
            projectKey: PROJECT_KEY,
            spaceKey: SPACE_KEY,
            capabilities: {
                // FALSE, confirmed live: TAIT uses Jira's shared default workflow, which
                // allows every transition from every status (getAvailableTransitions on a
                // fresh issue already lists all five). Consistent with brief §3.3: TAI's own
                // plugin layer is the checkpoint enforcer, not native Jira workflow — see
                // this capability's own doc comment in conformance.ts.
                strictWorkflow: false,
                validatesAssignee: true, // Jira rejects a nonexistent accountId — verified live
                answersPageToIssueLinks: false, // Jira owns the remote link; no reverse index exists
                // Verified live: PUT description:null reads back as "", not absent — Jira's
                // own storage has no true "no description" state distinct from "empty".
                clearedDescriptionIsEmptyString: true,
            searchIsEventuallyConsistent: true, // TAI-381: measured live, a JQL search lags a create by ~2-4s
            },
            validAssignee,
            invalidAssignee,
            async disposeIssue(key: IssueKey) {
                // Jira Cloud's Free plan cannot delete issues at all — confirmed live while
                // provisioning this project (TAI-17). Cancel + label instead; Canceled is
                // exempt from the §5.5 assignment gate, so no assignment is needed first.
                await backend.workTracker.addLabel(key, "tai-conformance-fixture").catch(() => {});
                await backend.workTracker.transition(key, Status.Canceled).catch(() => {});
            },
            async disposePage(id: PageId) {
                // Confluence page delete DOES work (verified live) — but DocStore has no
                // delete method (a real interface gap, out of this ticket's scope; see the
                // TAI-15 writeup). Test-only cleanup goes straight to REST.
                await client.request("DELETE", `/wiki/api/v2/pages/${id}`).catch(() => {});
            },
        };
    },
    { skip }
);
