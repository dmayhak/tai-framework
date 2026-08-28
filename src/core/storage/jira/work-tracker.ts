/**
 * TAI Framework — WorkTracker over the Jira REST API (TAI-21)
 *
 * The Jira half of StorageBackend. The Confluence half (DocStore) is TAI-13; a
 * `createJiraBackend` composing the two lands with it.
 *
 * See the ADR linked from Jira TAI-12 for why this is REST rather than an MCP client,
 * and rest-client.ts for why /rest/api/2 rather than /rest/api/3.
 */

import {
    Status,
    isSubtaskIssueType,
    type Persona,
    type DependencyRelation,
    DependencyRelation as Rel,
} from "../../schema/story-schema.js";
import {
    type WorkTracker,
    type DocStore,
    type Issue,
    type CreateIssueInput,
    type IssuePatch,
    type IssueFilter,
    type MutationResult,
    type CascadeWarning,
    type IssueLink,
    type Comment,
    type HumanRef,
    type AttachmentRef,
    type IssueKey,
    type PageId,
    type RemoteLink,
    toIssueKey,
    toPageId,
    DEFAULT_SEARCH_LIMIT,
} from "../interface.js";
import { RestClient, JiraRejection } from "./rest-client.js";
import { violatesAssignmentGate, entryGateReason, exitGateReason } from "../assignment-gate.js";
import { reviewGateApplies, checkReviewGate, reviewGateReason } from "../review-gate.js";
import { isExemptFromDuplicateGate, duplicateSubtaskGateReason } from "../duplicate-subtask-gate.js";
import {
    cascadeTriggersOn,
    shouldCascadeTransitionParent,
    cascadeTriggersOnClose,
    shouldCascadeCancelChild,
} from "../cascade-gate.js";
import { loadRoster, type Roster } from "../../personas/roster.js";
import {
    type RawIssue,
    type RawComment,
    toIssue,
    toComment,
    toAttachmentRef,
    toJiraIssueType,
    toJiraPersona,
    toJiraLinkType,
    fromJiraLinkType,
    fromJiraStatus,
    toJql,
    issueFields,
    toHumanRef,
    type RawUser,
    type TypeAliasMap,
} from "./mappers.js";

const API = "/rest/api/2";

export interface JiraWorkTrackerConfig {
    /**
     * Field id of the `Persona` custom field (brief §5.6).
     *
     * DISCOVERED, NOT HARDCODED. It is `customfield_10105` on the TAI dev site, but that
     * number is assigned per-Atlassian-site — hardcoding it would work here and silently
     * write to the wrong field (or nothing) on any other instance.
     * Use `discoverPersonaFieldId()` to resolve it by name at startup.
     */
    readonly personaFieldId: string;
    /**
     * The Confluence DocStore backing the same project (brief §5.6: the Persona Roster is
     * an ordinary Confluence page, not a WorkTracker concern) — needed here so `transition()`
     * can enforce `REVIEW_GATES` centrally (brief §3.3), which requires checking an
     * `Approved:` commenter against the roster. Required, not optional: silently skipping
     * the roster check when unconfigured would silently bypass a checkpoint, which brief
     * §3.3 treats as never acceptable.
     */
    readonly docStore: DocStore;
    /** Confluence space key the Persona Roster page lives in (brief §4 rev 18 — independent
     *  of the Jira project key, never derived from it). */
    readonly spaceKey: string;
    /** TAI-116 piece 4 (TAI-178 ADR): the project's "Type Aliases" override, resolved once
     *  at backend-construction time (`jira-backend.ts`), same as `personaFieldId`. */
    readonly aliases: TypeAliasMap;
}

/** Resolve the `Persona` custom field's site-specific id by its name. */
export async function discoverPersonaFieldId(
    client: RestClient,
    fieldName = "Persona"
): Promise<string> {
    const fields = await client.request<{ id: string; name: string; custom: boolean }[]>(
        "GET",
        `${API}/field`
    );
    const match = fields.find((f) => f.custom && f.name === fieldName);
    if (!match) {
        throw new Error(
            `Custom field "${fieldName}" not found on this Jira site. It backs the two-axis owner model (brief §5.6) and must be provisioned before TAI can run.`
        );
    }
    return match.id;
}

/**
 * Wrap a mutation so a genuine Jira rejection becomes `{ok: false, reason}` while a
 * connectivity fault keeps propagating as StorageConnectivityError.
 *
 * This is the single place brief §3.3's "a Jira-rejected transition is an unplanned
 * checkpoint, not an ordinary failure" is enforced — §3.3 is explicit that it lives in the
 * storage plugin's operation, "not repeated in each persona's own instructions."
 */
/**
 * `run` gets a `warnCascade` callback (TAI-275/276 ADR) — `transition()`'s own best-effort
 * parent/child cascade block calls it alongside its existing `console.warn` on a failed
 * cascade attempt, so the failure becomes visible in the returned `MutationResult` too, not
 * just server-side stderr. Every other `asMutation` caller (`assignIssue`, etc.) simply
 * never calls it — TS allows a narrower callback (fewer params) to satisfy a wider
 * function-typed parameter, so their existing `async () => {...}` callbacks are unchanged.
 */
async function asMutation(run: (warnCascade: (w: CascadeWarning) => void) => Promise<Issue>): Promise<MutationResult> {
    const cascadeWarnings: CascadeWarning[] = [];
    try {
        const issue = await run((w) => cascadeWarnings.push(w));
        return cascadeWarnings.length > 0 ? { ok: true, issue, cascadeWarnings } : { ok: true, issue };
    } catch (err) {
        if (err instanceof JiraRejection) return { ok: false, reason: err.reason };
        throw err; // StorageConnectivityError and genuine bugs both belong upstairs.
    }
}

export function createJiraWorkTracker(
    client: RestClient,
    config: JiraWorkTrackerConfig
): WorkTracker {
    const { personaFieldId, docStore, spaceKey, aliases } = config;
    const fields = issueFields(personaFieldId);

    // Lazy + memoized: only fetched the first time a review-gated transition is actually
    // attempted (most transitions never touch a REVIEW_GATES-bearing story type), then
    // reused for the rest of this WorkTracker's lifetime — brief §3.6's "refresh at session
    // start / first use" cache-point model, not a per-call fetch. `cacheRoot: null` skips
    // loadRoster's own `.tai/cache` disk write; that's the CLI's concern, not this internal
    // check's.
    let rosterPromise: Promise<Roster> | undefined;
    function getRoster(): Promise<Roster> {
        rosterPromise ??= loadRoster(docStore, { spaceKey, projectKey: spaceKey, cacheRoot: null });
        return rosterPromise;
    }

    async function fetchIssue(key: IssueKey): Promise<Issue> {
        const raw = await client.request<RawIssue>("GET", `${API}/issue/${key}?fields=${fields}`);
        return toIssue(raw, personaFieldId, aliases);
    }

    /**
     * Domain patch/input -> Jira `fields` object. Shared by create and update.
     *
     * Note this can't just take `CreateIssueInput & IssuePatch`: the two disagree on
     * `description` by design — it's `string | undefined` on create but `string | null |
     * undefined` on patch, because only a patch can CLEAR a field (interface.ts's
     * tri-state). The wider (patch) shape is the right common denominator; create simply
     * never passes null.
     */
    type MutableFields = {
        readonly summary?: string;
        readonly description?: string | null;
        readonly assignee?: HumanRef | null;
        readonly persona?: Persona | null;
        readonly component?: string | null;
        readonly priority?: string | null;
    };

    function toJiraFields(
        input: MutableFields,
        create?: Pick<CreateIssueInput, "projectKey" | "issueType" | "parentKey" | "labels">
    ): Record<string, unknown> {
        const f: Record<string, unknown> = {};

        if (create) {
            f["project"] = { key: create.projectKey };
            f["issuetype"] = { name: toJiraIssueType(create.issueType, aliases) };
            if (create.parentKey) f["parent"] = { key: create.parentKey };
            if (create.labels) f["labels"] = create.labels;
        }

        if (input.summary !== undefined) f["summary"] = input.summary;

        // Tri-state (interface.ts): undefined = leave alone, null = clear, value = set.
        if (input.description !== undefined) f["description"] = input.description;
        if (input.assignee !== undefined) {
            f["assignee"] = input.assignee ? { accountId: input.assignee.id } : null;
        }
        if (input.persona !== undefined) {
            f[personaFieldId] = input.persona ? { value: toJiraPersona(input.persona) } : null;
        }
        if (input.component !== undefined) {
            // Subtask-scoped, exactly one repo (brief §4/§5.4) — never a list of many.
            f["components"] = input.component ? [{ name: input.component }] : [];
        }
        if (input.priority !== undefined) {
            f["priority"] = input.priority ? { name: input.priority } : null;
        }
        // `severity` is deliberately dropped: it has no Jira counterpart, and brief §5.2
        // says to reuse native Priority rather than provision a custom field for it.

        return f;
    }

    const workTracker: WorkTracker = {
        async createIssue(input: CreateIssueInput): Promise<Issue> {
            if (
                isSubtaskIssueType(input.issueType) &&
                input.parentKey &&
                !isExemptFromDuplicateGate(input.issueType) &&
                !input.allowDuplicate
            ) {
                const siblings = await workTracker.search({
                    projectKey: input.projectKey,
                    parentKey: input.parentKey,
                    issueTypes: [input.issueType],
                });
                if (siblings[0]) {
                    throw new Error(duplicateSubtaskGateReason(input.parentKey, input.issueType, siblings[0]));
                }
            }
            const created = await client.request<{ key: string }>("POST", `${API}/issue`, {
                fields: toJiraFields(input, input),
            });
            // Deliberate re-fetch. Jira's create response carries only key/id/self — it
            // echoes back neither custom fields nor server-set values (status, timestamps).
            // Returning a hand-assembled Issue here would be a guess; this is the truth.
            return fetchIssue(toIssueKey(created.key));
        },

        async getIssue(key: IssueKey): Promise<Issue | null> {
            const raw = await client.getOrNull<RawIssue>(`${API}/issue/${key}?fields=${fields}`);
            return raw ? toIssue(raw, personaFieldId, aliases) : null;
        },

        async updateIssue(key: IssueKey, patch: IssuePatch): Promise<Issue> {
            if (patch.assignee === null) {
                const current = await fetchIssue(key);
                if (violatesAssignmentGate(current.status, null)) {
                    throw new JiraRejection(exitGateReason(key, current.status), 409);
                }
            }
            await client.request("PUT", `${API}/issue/${key}`, {
                fields: toJiraFields(patch),
            });
            return fetchIssue(key);
        },

        /**
         * Brief §3.3: TAI always ATTEMPTS the real transition — it never decides for itself
         * that Jira would say no. If Jira rejects (a validator, a required field, a
         * permission gap, a concurrent change), that is an unplanned checkpoint: work stops,
         * the reason is journaled verbatim, and it escalates to a human with NO retry.
         * Returning the reason unaltered is what makes that possible.
         */
        async transition(key: IssueKey, target: Status): Promise<MutationResult> {
            return asMutation(async (warnCascade) => {
                // TAI's OWN checkpoints are checked BEFORE calling Jira (§3.3: "We check
                // conditions *before* ever calling the Jira 'transition' API"). These are two
                // of them, not Jira rules.
                //
                // No unassigned work in progress (§5.5, rev 19): a ticket may not leave `To Do`
                // for a non-terminal status without a human Assignee. The whole premise is that
                // a NAMED human oversees the persona doing the work (§1) — an in-flight ticket
                // with nobody accountable is the failure mode this framework exists to prevent,
                // and it's invisible on a board. Terminal states (Done/Canceled) are exempt:
                // once work has stopped, an owner no longer matters.
                //
                // REVIEW_GATES (§3.3/§5.6, TAI-41 ADR's "hard" checkpoint kind): a story-level
                // issue reaching Done for a StoryType with a review gate needs an `Approved:`
                // comment from each required reviewer, roster-verified — checked regardless of
                // the FROM status (review-gate.ts's own comment explains why: a gate keyed to
                // "coming from In Review" would be trivially bypassable).
                //
                // Only fetch the issue when the target is actually gated — avoids an extra
                // round trip on every ordinary transition (Canceled/To Do), and avoids a
                // regression found while fixing the assignment gate: an earlier version fetched
                // unconditionally, which broke on any transition target with no assignee data
                // available yet.
                if (target === Status.InProgress || target === Status.InReview || target === Status.Done) {
                    const current = await fetchIssue(key);
                    if (
                        (target === Status.InProgress || target === Status.InReview) &&
                        violatesAssignmentGate(target, current.assignee)
                    ) {
                        throw new JiraRejection(entryGateReason(key, target), 409);
                    }
                    if (reviewGateApplies(current, target)) {
                        const roster = await getRoster();
                        const check = checkReviewGate(current, roster);
                        if (!check.ok) {
                            throw new JiraRejection(reviewGateReason(key, check.missing), 409);
                        }
                    }
                    // TAI-220/221/222: parent-status cascade -- move the parent first
                    // (best-effort), then this issue's own transition below. Recursing
                    // through the public transition() (not a raw status write) is what makes
                    // "Subtask -> Story -> Epic" work from this one call: the parent's own
                    // transition() cascades to ITS parent the same way. Entirely best-effort
                    // -- a thrown error or a rejected MutationResult are both just logged,
                    // never allowed to block this issue's own transition (ADR, Confluence
                    // page 29753345).
                    if (cascadeTriggersOn(target) && current.parentKey) {
                        try {
                            const parent = await fetchIssue(current.parentKey);
                            if (shouldCascadeTransitionParent(parent.status)) {
                                const cascadeResult = await workTracker.transition(current.parentKey, Status.InProgress);
                                if (!cascadeResult.ok) {
                                    console.warn(
                                        `Parent-cascade transition failed for ${current.parentKey} (best-effort, continuing with ${key} -> "${target}"): ${cascadeResult.reason}`
                                    );
                                    warnCascade({ key: current.parentKey, reason: cascadeResult.reason });
                                } else {
                                    // The parent's OWN transition() may have cascaded further
                                    // up (Story -> Epic) and hit its own rejection -- that
                                    // lands on the PARENT's MutationResult, not this one, so
                                    // it must be bubbled up explicitly or it's silently lost
                                    // one level short of the top-level caller (found in
                                    // review, TAI-276 PR).
                                    for (const w of cascadeResult.cascadeWarnings ?? []) warnCascade(w);
                                }
                            }
                        } catch (err) {
                            const reason = err instanceof Error ? err.message : String(err);
                            console.warn(
                                `Parent-cascade transition threw for ${current.parentKey} (best-effort, continuing with ${key} -> "${target}"): ${reason}`
                            );
                            warnCascade({ key: current.parentKey, reason });
                        }
                    }
                }

                const { transitions } = await client.request<{
                    transitions: { id: string; name: string; to: { name: string } }[];
                }>("GET", `${API}/issue/${key}/transitions`);

                // Match on destination status, not on the transition's own name — the two
                // frequently differ, and it's the destination the caller asked for.
                const match = transitions.find((t) => t.to.name === target);
                if (!match) {
                    const available = transitions.map((t) => t.to.name).join(", ") || "(none)";
                    throw new JiraRejection(
                        `No transition from the current status to "${target}". Available: ${available}.`,
                        409
                    );
                }

                await client.request("POST", `${API}/issue/${key}/transitions`, {
                    transition: { id: match.id },
                });
                const updated = await fetchIssue(key);

                // TAI-267 (TAI-247 ADR): downward/terminal cascade -- the closing counterpart
                // to the upward cascade above. Runs AFTER this issue's own transition has
                // already succeeded, unlike the upward cascade's parent-first ordering --
                // canceling children on behalf of a close that itself got rejected would be a
                // real bug, not a best-effort tradeoff. Deliberately outside the `target ===
                // InProgress|InReview|Done` gate above (line 278): that gate exists to skip an
                // extra fetch for ungated targets, but `Canceled` -- one of the two targets
                // this cascade fires on -- is itself ungated, so this has to live down here,
                // common to every target, not nested inside that block.
                //
                // 1:N, not 1:1 (a parent can have many children, each with children of their
                // own) -- one `search({ parentKey: key })`, then recurse into transition()
                // itself for each open child, which walks further down the same way (Epic ->
                // Story -> subtask, no special-cased depth limit). Entirely best-effort from
                // here: a failed search or a failed/thrown child transition is logged and
                // skipped, never allowed to retroactively fail THIS transition, which has
                // already committed (ADR decision #3).
                if (cascadeTriggersOnClose(target)) {
                    try {
                        const children = await workTracker.search({
                            projectKey: updated.projectKey,
                            parentKey: key,
                            limit: DEFAULT_SEARCH_LIMIT,
                        });
                        for (const child of children) {
                            if (!shouldCascadeCancelChild(child.status)) continue;
                            try {
                                const cascadeResult = await workTracker.transition(child.key, Status.Canceled);
                                if (!cascadeResult.ok) {
                                    console.warn(
                                        `Child-cascade transition failed for ${child.key} (best-effort, ${key} -> "${target}" already succeeded): ${cascadeResult.reason}`
                                    );
                                    warnCascade({ key: child.key, reason: cascadeResult.reason });
                                } else {
                                    // Same bubble-up as the upward cascade above -- the
                                    // child's own transition() may have cascaded further
                                    // down to a grandchild and hit its own rejection there.
                                    for (const w of cascadeResult.cascadeWarnings ?? []) warnCascade(w);
                                }
                            } catch (err) {
                                const reason = err instanceof Error ? err.message : String(err);
                                console.warn(
                                    `Child-cascade transition threw for ${child.key} (best-effort, ${key} -> "${target}" already succeeded): ${reason}`
                                );
                                warnCascade({ key: child.key, reason });
                            }
                        }
                    } catch (err) {
                        const reason = err instanceof Error ? err.message : String(err);
                        console.warn(
                            `Child-cascade search failed for ${key} (best-effort, ${key} -> "${target}" already succeeded): ${reason}`
                        );
                        warnCascade({ key, reason: `child-cascade search failed: ${reason}` });
                    }
                }

                return updated;
            });
        },

        async getAvailableTransitions(key: IssueKey): Promise<readonly Status[]> {
            const { transitions } = await client.request<{
                transitions: { to: { name: string } }[];
            }>("GET", `${API}/issue/${key}/transitions`);
            return transitions.map((t) => fromJiraStatus(t.to.name));
        },

        /**
         * Mirrors transition()'s rejection shape. Brief §5.6 is explicit that an assignment
         * rejection (e.g. a missing "Assign Issues" permission) reuses the same unplanned-
         * checkpoint mechanism as a transition rejection — "no new mechanism needed."
         */
        async assignIssue(key: IssueKey, human: HumanRef | null): Promise<MutationResult> {
            return asMutation(async () => {
                if (human === null) {
                    const current = await fetchIssue(key);
                    if (violatesAssignmentGate(current.status, null)) {
                        throw new JiraRejection(exitGateReason(key, current.status), 409);
                    }
                }
                await client.request("PUT", `${API}/issue/${key}/assignee`, {
                    accountId: human ? human.id : null,
                });
                return fetchIssue(key);
            });
        },

        /**
         * TAI-165/167 ADR: resolves the REAL Atlassian Account ID for `email` via Jira's
         * user-search endpoint — the same id Bitbucket expects for `account_id`
         * (Atlassian's cloud products share one unified account id per login, verified
         * live). `null` on no match, not a throw — an unresolvable roster entry is
         * expected, not exceptional.
         */
        async resolveHuman(email: string): Promise<HumanRef | null> {
            const users = await client.request<RawUser[]>(
                "GET",
                `${API}/user/search?query=${encodeURIComponent(email)}`
            );
            return toHumanRef(users[0] ?? null);
        },

        async addComment(key: IssueKey, body: string): Promise<Comment> {
            const raw = await client.request<RawComment>("POST", `${API}/issue/${key}/comment`, {
                body,
            });
            return toComment(raw);
        },

        async editComment(key: IssueKey, commentId: string, body: string): Promise<Comment> {
            const raw = await client.request<RawComment>(
                "PUT",
                `${API}/issue/${key}/comment/${commentId}`,
                { body }
            );
            return toComment(raw);
        },

        // Jira's `update` verb applies an add/remove delta, so two concurrent label writes
        // don't clobber each other the way a read-modify-write of the whole array would.
        async addLabel(key: IssueKey, label: string): Promise<void> {
            await client.request("PUT", `${API}/issue/${key}`, {
                update: { labels: [{ add: label }] },
            });
        },

        async removeLabel(key: IssueKey, label: string): Promise<void> {
            await client.request("PUT", `${API}/issue/${key}`, {
                update: { labels: [{ remove: label }] },
            });
        },

        /**
         * `createLink(from, DependsOn, to)` means "from depends on to" — i.e. `to` BLOCKS
         * `from`.
         *
         * Jira stores a link as (inwardIssue, outwardIssue) where the OUTWARD description
         * reads from inward to outward: for the "Blocks" type, inwardIssue *blocks*
         * outwardIssue. Verified empirically against the live site rather than taken from
         * the docs (the docs' phrasing reads the other way round, and getting this backwards
         * silently inverts every precedence edge in the project).
         *
         * So: the blocker is `to`, and the blocker goes in the INWARD slot.
         */
        async createLink(from: IssueKey, relation: DependencyRelation, to: IssueKey): Promise<void> {
            await client.request("POST", `${API}/issueLink`, {
                type: { name: toJiraLinkType(relation) },
                inwardIssue: { key: to },
                outwardIssue: { key: from },
            });
        },

        async getLinkedIssues(
            key: IssueKey,
            relation?: DependencyRelation,
            direction: "outgoing" | "incoming" = "outgoing"
        ): Promise<readonly IssueLink[]> {
            const raw = await client.request<RawIssue & {
                fields: {
                    issuelinks?: {
                        type: { name: string };
                        inwardIssue?: { key: string };
                        outwardIssue?: { key: string };
                    }[];
                };
            }>("GET", `${API}/issue/${key}?fields=issuelinks`);

            const out: IssueLink[] = [];
            for (const link of raw.fields.issuelinks ?? []) {
                const rel = fromJiraLinkType(link.type.name);
                if (rel === null) continue; // A human's ad-hoc "Duplicates" link, etc. Not ours.
                if (relation !== undefined && rel !== relation) continue;

                // Reading, from `key`'s point of view: a far end sitting in the INWARD slot
                // is one that blocks us (we depend on it) — that's `outgoing` in interface.ts's
                // terms ("what this depends on"). A far end in the OUTWARD slot depends on us.
                const dependsOnTarget = link.inwardIssue?.key;
                const dependentOnUs = link.outwardIssue?.key;

                // RelatesTo is symmetric ("relates to" in both directions), so direction is
                // meaningless for it — return the far end whichever slot it landed in rather
                // than making callers guess which way Jira happened to store it.
                if (rel === Rel.RelatesTo) {
                    const other = dependsOnTarget ?? dependentOnUs;
                    if (other) out.push({ relation: rel, key: toIssueKey(other) });
                    continue;
                }

                const wanted = direction === "outgoing" ? dependsOnTarget : dependentOnUs;
                if (wanted) out.push({ relation: rel, key: toIssueKey(wanted) });
            }
            return out;
        },

        /**
         * Jira<->Confluence association (brief §4). Jira models this as a *remote* link, not
         * an issue link, so there's no DependencyRelation involved — a doc reference has no
         * direction worth modelling.
         */
        async linkPage(key: IssueKey, page: PageId): Promise<void> {
            // `object.url` must be a genuine URL — Jira's remote-link API validates it and
            // 400s on a bare id (found by running the conformance suite, TAI-15). The classic
            // `viewpage.action?pageId=` permalink resolves site-wide without needing the
            // page's space key, which WorkTracker has no reason to know.
            const url = `${client.siteUrl}/wiki/pages/viewpage.action?pageId=${page}`;
            await client.request("POST", `${API}/issue/${key}/remotelink`, {
                // The `tai-page-` prefix is what `getLinkedPages` actually filters on below —
                // `relationship`/`application` are cosmetic to that method, but load-bearing
                // for Jira's own UI: setting them to the exact shape Confluence's native
                // "Link" action itself produces gets this into Jira's "Confluence content"
                // panel AND Confluence's own "Jira work items" panel on the page — confirmed
                // empirically (2026-08-14) that both are driven purely by these fields on the
                // remote link, no Confluence-page-side macro required at all. Without them,
                // Jira has no way to tell this apart from an arbitrary human-added Web Link.
                globalId: `tai-page-${page}`,
                application: { type: "com.atlassian.confluence", name: "Confluence" },
                relationship: "Wiki Page",
                object: {
                    url,
                    title: `${page}`,
                },
            });
        },

        async getLinkedPages(key: IssueKey): Promise<readonly PageId[]> {
            const links = await client.request<{ globalId?: string }[]>(
                "GET",
                `${API}/issue/${key}/remotelink`
            );
            return links
                .map((l) => l.globalId)
                .filter((g): g is string => !!g && g.startsWith("tai-page-"))
                .map((g) => toPageId(g.slice("tai-page-".length)));
        },

        /**
         * Generic remote-URL link (TAI-107/TAI-108), same Jira remote-link API as
         * `linkPage` above but its own `tai-remote-` `globalId` prefix — kept distinct from
         * `tai-page-` so `getRemoteLinks` never returns a Confluence page link that
         * `getLinkedPages` already owns reading back. `globalId` is derived deterministically
         * from `url` (not a random id) so a second call for the same `url` UPSERTS — Jira's
         * remote-link API creates-or-updates by `globalId` — rather than duplicating the link
         * when a title changes (e.g. a PR gets renamed after the link was first created).
         */
        async createRemoteLink(key: IssueKey, url: string, title: string): Promise<void> {
            await client.request("POST", `${API}/issue/${key}/remotelink`, {
                globalId: `tai-remote-${encodeURIComponent(url)}`,
                object: { url, title },
            });
        },

        async getRemoteLinks(key: IssueKey): Promise<readonly RemoteLink[]> {
            const links = await client.request<
                { globalId?: string; object: { url: string; title: string } }[]
            >("GET", `${API}/issue/${key}/remotelink`);
            return links
                .filter((l) => l.globalId?.startsWith("tai-remote-"))
                .map((l) => ({ url: l.object.url, title: l.object.title }));
        },

        async listAttachments(key: IssueKey): Promise<readonly AttachmentRef[]> {
            const raw = await client.request<RawIssue>("GET", `${API}/issue/${key}?fields=attachment`);
            return (raw.fields.attachment ?? []).map(toAttachmentRef);
        },

        async getAttachment(key: IssueKey, attachmentId: string): Promise<Buffer> {
            // The attachment id is globally unique in Jira, so the issue key isn't needed to
            // address the content — it stays in the signature for interface symmetry with
            // DocStore and to keep call sites self-documenting.
            void key;
            return client.getBinary(`${API}/attachment/content/${attachmentId}`);
        },

        async search(filter: IssueFilter): Promise<readonly Issue[]> {
            // toJql() validates and THROWS on anything unmappable — an empty result must only
            // ever mean "no matches," never "the query was malformed." See mappers.ts.
            const jql = toJql(filter, aliases);

            // `/search` (no suffix) was REMOVED by Atlassian and now returns 410 Gone —
            // caught the first time this ran against the live site. `/search/jql` is its
            // replacement, and it exists under /rest/api/2 as well as /3, so we keep the v2
            // string-body semantics rather than being forced onto v3's ADF (rest-client.ts).
            const res = await client.request<{ issues: RawIssue[] }>("POST", `${API}/search/jql`, {
                jql,
                fields: fields.split(","),
                maxResults: filter.limit ?? DEFAULT_SEARCH_LIMIT,
            });
            // Note: this endpoint paginates with `nextPageToken`/`isLast`. Cursor pagination is
            // deliberately deferred (interface.ts: `limit` bounds the result; no real project is
            // near needing it) — but a single page is all we ask for, so results are bounded,
            // never silently truncated mid-iteration.
            return res.issues.map((r) => toIssue(r, personaFieldId, aliases));
        },
    };
    return workTracker;
}
