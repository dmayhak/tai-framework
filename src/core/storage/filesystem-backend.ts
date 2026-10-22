/**
 * TAI Framework — Local Filesystem Storage Backend
 * Implements WorkTracker + DocStore over the `.tai/cache/<project-key>/` layout from
 * brief §7, reused as-is (not a parallel structure) — when the backend IS the
 * filesystem, there's no separate "real Jira" to cache from, so the cache directory
 * just becomes the actual store. For solo developers and offline work (brief §3.2).
 *
 * Node built-ins only — the project has zero runtime dependencies today, and this
 * backend shouldn't be the thing that adds one.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Status, SubtaskType, DependencyRelation, defaultPersonaFor } from "../schema/story-schema.js";
import {
    type StorageBackend,
    type WorkTracker,
    type DocStore,
    type Issue,
    type CreateIssueInput,
    type IssuePatch,
    type IssueFilter,
    type MutationResult,
    type TransitionOptions,
    type CascadeWarning,
    type IssueLink,
    type Comment,
    type HumanRef,
    type AttachmentRef,
    type Page,
    type PageSummary,
    type PageRef,
    type CreatePageInput,
    type PagePatch,
    type IssueKey,
    type PageId,
    type RemoteLink,
    toIssueKey,
    toPageId,
    StorageConnectivityError,
    DEFAULT_SEARCH_LIMIT,
} from "./interface.js";
import { violatesAssignmentGate, entryGateReason, exitGateReason } from "./assignment-gate.js";
import { reviewGateApplies, checkReviewGate, reviewGateReason, checkClarificationGate, clarificationGateReason } from "./review-gate.js";
import { precedenceGateApplies, openPrerequisites, precedenceGateReason, precedenceOverrideComment } from "./precedence-gate.js";
import { isExemptFromDuplicateGate, duplicateSubtaskGateReason } from "./duplicate-subtask-gate.js";
import { reparentViolation } from "./reparent-gate.js";
import { labelViolation } from "./label-gate.js";
import { matchesIssueFilter } from "./issue-filter.js";
import {
    cascadeTriggersOn,
    upwardCascadeTarget,
    cascadeTriggersOnClose,
    shouldCascadeCancelChild,
} from "./cascade-gate.js";
import { loadRoster, type Roster } from "../personas/roster.js";

// ---------- Path helpers ----------

// Jira project keys and Confluence space keys never contain a hyphen — confirmed by the
// real Atlassian key validation pattern (`^[A-Z][A-Z0-9_]+$`). Issue keys and page ids
// generated below always take the form `<PROJECT-OR-SPACE-KEY>-<N>`, so the project/space
// can always be recovered by splitting on the first hyphen — used to resolve a bare
// IssueKey/PageId back to its containing directory.
//
// Note this backend MINTS both keys itself, so they're trivially consistent here. Do not
// generalise that to the Jira backend: brief §4 (rev 18) withdrew the old "space key
// matches project key" rule — the real TAI project is Jira `TAI` / Confluence `TA`, and the
// two are independent config values.
function ownerKeyOf(id: string): string {
    const i = id.indexOf("-");
    if (i < 0) throw new Error(`Malformed key/id, expected "<KEY>-<N>": ${id}`);
    return id.slice(0, i);
}

// Defensive: these become path segments below. Backend-generated keys/ids never
// trip this, but a caller passing a hand-built key shouldn't be able to path-traverse.
function assertSafeSegment(s: string): void {
    if (s.includes("/") || s.includes("\\") || s.includes("..")) {
        throw new Error(`Unsafe path segment: ${s}`);
    }
}

function issuesDir(rootDir: string, projectKey: string): string {
    return path.join(rootDir, projectKey, "issues");
}

function issueAttachmentsDir(rootDir: string, key: IssueKey): string {
    return path.join(issuesDir(rootDir, ownerKeyOf(key)), key, "attachments");
}

function confluenceDir(rootDir: string, spaceKey: string): string {
    return path.join(rootDir, spaceKey, "confluence");
}

function pageAttachmentsDir(rootDir: string, id: PageId): string {
    return path.join(confluenceDir(rootDir, ownerKeyOf(id)), id, "attachments");
}

function linksFile(rootDir: string): string {
    return path.join(rootDir, "links", "index.json");
}

async function readJsonDir<T>(dir: string): Promise<T[]> {
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new StorageConnectivityError(`Failed to read ${dir}: ${(err as Error).message}`);
    }
    const results: T[] = [];
    for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const raw = await readFile(path.join(dir, entry), "utf8");
        results.push(JSON.parse(raw) as T);
    }
    return results;
}

// Merges a tri-state patch value onto an existing optional field: `undefined` = leave
// unchanged, `null` = clear, a value = set (documented on IssuePatch/PagePatch).
function applyTriState<T>(current: T | undefined, patch: T | null | undefined): T | undefined {
    if (patch === undefined) return current;
    if (patch === null) return undefined;
    return patch;
}

// The brief §5.5 assignment gate itself (violatesAssignmentGate/entryGateReason/
// exitGateReason) lives in assignment-gate.ts, shared with jira/work-tracker.ts — TAI-15's
// code review found the two backends' copies of this rule had already drifted textually,
// concrete evidence that hand-duplicating it doesn't stay in sync. One implementation now.

// JSON.stringify drops keys whose value is `undefined`, so a freshly-constructed
// in-memory object (built from a CreateIssueInput/CreatePageInput where an optional
// field was simply absent) would otherwise have real own-properties set to
// `undefined` that vanish the moment it round-trips through disk — two different
// shapes for what should be the same conceptual record. Strip them at construction
// time so what's returned immediately after create matches what a later read
// produces.
function omitUndefined<T extends Record<string, unknown>>(obj: T): T {
    const result = {} as T;
    for (const k of Object.keys(obj) as (keyof T)[]) {
        if (obj[k] !== undefined) result[k] = obj[k];
    }
    return result;
}

// ---------- Links index (issue<->issue, issue<->page) ----------
// One global index rather than the per-project `links/` folder brief §7 sketches for
// the Jira-cache case — every key/id here is already globally unique within this
// backend, so a single file loses nothing while avoiding key-parsing just to decide
// which project's link file to touch. Disposable/rebuildable like everything else in
// the cache (§7's "no cache locking, no eviction" stance already covers this file).

interface LinksIndex {
    issueLinks: { from: string; relation: DependencyRelation; to: string }[];
    issuePageLinks: { issueKey: string; pageId: string }[];
    issueRemoteLinks: { issueKey: string; url: string; title: string }[];
}

async function readLinks(rootDir: string): Promise<LinksIndex> {
    try {
        const raw = await readFile(linksFile(rootDir), "utf8");
        const parsed = JSON.parse(raw) as Partial<LinksIndex>;
        // `issueRemoteLinks` postdates this file's original shape (TAI-108) — an
        // existing links.json from before this change has no such key.
        return { issueLinks: [], issuePageLinks: [], issueRemoteLinks: [], ...parsed };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return { issueLinks: [], issuePageLinks: [], issueRemoteLinks: [] };
        }
        throw new StorageConnectivityError(`Failed to read links index: ${(err as Error).message}`);
    }
}

async function writeLinks(rootDir: string, data: LinksIndex): Promise<void> {
    const dir = path.join(rootDir, "links");
    await mkdir(dir, { recursive: true });
    await writeFile(linksFile(rootDir), JSON.stringify(data, null, 2), "utf8");
}

// ---------- Issue read/write ----------

async function nextIssueKey(dir: string, projectKey: string): Promise<IssueKey> {
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        entries = [];
    }
    const prefix = `${projectKey}-`;
    let max = 0;
    for (const entry of entries) {
        if (entry.startsWith(prefix) && entry.endsWith(".json")) {
            const n = Number(entry.slice(prefix.length, -".json".length));
            if (Number.isFinite(n) && n > max) max = n;
        }
    }
    return toIssueKey(`${prefix}${max + 1}`);
}

async function writeIssueFile(rootDir: string, issue: Issue): Promise<void> {
    const dir = issuesDir(rootDir, issue.projectKey);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${issue.key}.json`), JSON.stringify(issue, null, 2), "utf8");
}

async function readIssueFile(rootDir: string, key: IssueKey): Promise<Issue | null> {
    assertSafeSegment(key);
    const file = path.join(issuesDir(rootDir, ownerKeyOf(key)), `${key}.json`);
    try {
        const raw = await readFile(file, "utf8");
        return JSON.parse(raw) as Issue;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new StorageConnectivityError(`Failed to read issue ${key}: ${(err as Error).message}`);
    }
}

async function mustGetIssue(rootDir: string, key: IssueKey): Promise<Issue> {
    const issue = await readIssueFile(rootDir, key);
    if (!issue) throw new Error(`Issue not found: ${key}`);
    return issue;
}

// ---------- Page read/write ----------
// Stored as markdown with a fenced JSON metadata block rather than real YAML
// front-matter, to stay dependency-free — the body below the fence is plain,
// human-readable markdown either way.

async function nextPageId(dir: string, spaceKey: string): Promise<PageId> {
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch {
        entries = [];
    }
    const prefix = `${spaceKey}-`;
    let max = 0;
    for (const entry of entries) {
        if (entry.startsWith(prefix) && entry.endsWith(".md")) {
            const n = Number(entry.slice(prefix.length, -".md".length));
            if (Number.isFinite(n) && n > max) max = n;
        }
    }
    return toPageId(`${prefix}${max + 1}`);
}

function serializePage(page: Page): string {
    const { content, ...meta } = page;
    return `---json\n${JSON.stringify(meta, null, 2)}\n---\n${content}\n`;
}

function parsePage(raw: string): Page {
    const match = /^---json\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    if (!match) throw new Error("Malformed page file: missing JSON front-matter fence");
    const meta = JSON.parse(match[1]) as Omit<Page, "content">;
    return { ...meta, content: match[2].replace(/\n$/, "") };
}

async function writePageFile(rootDir: string, page: Page): Promise<void> {
    const dir = confluenceDir(rootDir, page.spaceKey);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${page.id}.md`), serializePage(page), "utf8");
}

async function readPageById(rootDir: string, id: PageId): Promise<Page | null> {
    assertSafeSegment(id);
    const file = path.join(confluenceDir(rootDir, ownerKeyOf(id)), `${id}.md`);
    try {
        const raw = await readFile(file, "utf8");
        return parsePage(raw);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new StorageConnectivityError(`Failed to read page ${id}: ${(err as Error).message}`);
    }
}

async function readAllPages(rootDir: string, spaceKey: string): Promise<Page[]> {
    const dir = confluenceDir(rootDir, spaceKey);
    let entries: string[];
    try {
        entries = await readdir(dir);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new StorageConnectivityError(`Failed to read ${dir}: ${(err as Error).message}`);
    }
    const pages: Page[] = [];
    for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        pages.push(parsePage(await readFile(path.join(dir, entry), "utf8")));
    }
    return pages;
}

async function resolvePage(rootDir: string, ref: PageRef): Promise<Page | null> {
    if ("id" in ref) return readPageById(rootDir, ref.id);
    const pages = await readAllPages(rootDir, ref.spaceKey);
    return pages.find((p) => p.title === ref.title) ?? null;
}

async function mustResolvePage(rootDir: string, ref: PageRef): Promise<Page> {
    const page = await resolvePage(rootDir, ref);
    if (!page) throw new Error(`Page not found: ${JSON.stringify(ref)}`);
    return page;
}

// ---------- Attachments (stub-level for v1 — brief §7's lazy-fetch shape, no content
// pipeline behind it yet) ----------

async function listDirAttachments(dir: string): Promise<AttachmentRef[]> {
    let entries: { name: string; isFile(): boolean }[];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new StorageConnectivityError(`Failed to list attachments in ${dir}: ${(err as Error).message}`);
    }
    return entries.filter((e) => e.isFile()).map((e) => ({ id: e.name, filename: e.name }));
}

async function readDirAttachment(dir: string, id: string): Promise<Buffer> {
    assertSafeSegment(id);
    try {
        return await readFile(path.join(dir, id));
    } catch (err) {
        throw new StorageConnectivityError(`Failed to read attachment ${id}: ${(err as Error).message}`);
    }
}

// ---------- Factory ----------

/**
 * `currentUser` scopes every write this backend makes to "the human running this
 * session," mirroring how the real Atlassian MCP server authenticates as the actual
 * user rather than taking an author parameter per call (brief §3.2) — comments and
 * links created through this backend are always attributed to them.
 */
// Every subtask has a parent Story/Bug/Kickoff/Spike (brief §5.1). Real Jira enforces this
// structurally and rejects a parentless subtask outright. This backend previously accepted
// one silently — a portability trap found by the conformance suite (TAI-15): code developed
// and tested here could create parentless subtasks that would only fail once run against Jira.
const SUBTASK_TYPES = new Set<string>(Object.values(SubtaskType));

export function createFilesystemBackend(rootDir: string, currentUser: HumanRef): StorageBackend {
    // Lazy + memoized per project, keyed the same way filesystem-backend.test.ts's own
    // fixtures already do (spaceKey === projectKey — this backend has no independent
    // Confluence-space concept, unlike the real Jira/Confluence split, brief §4 rev 18).
    // Only fetched the first time a review-gated transition is actually attempted; brief
    // §3.6's "refresh at session start / first use" cache-point model, not a per-call fetch.
    const rosterByProject = new Map<string, Promise<Roster>>();
    function getRoster(projectKey: string): Promise<Roster> {
        let roster = rosterByProject.get(projectKey);
        if (!roster) {
            roster = loadRoster(docStore, { spaceKey: projectKey, projectKey, cacheRoot: null });
            rosterByProject.set(projectKey, roster);
        }
        return roster;
    }

    const workTracker: WorkTracker = {
        async createIssue(input: CreateIssueInput): Promise<Issue> {
            if (SUBTASK_TYPES.has(input.issueType) && !input.parentKey) {
                throw new Error(
                    `Cannot create a "${input.issueType}" subtask with no parentKey — every subtask has a parent (brief §5.1). Real Jira rejects this structurally; this backend now matches that rather than silently accepting it.`
                );
            }
            if (
                SUBTASK_TYPES.has(input.issueType) &&
                input.parentKey &&
                !isExemptFromDuplicateGate(input.issueType as SubtaskType) &&
                !input.allowDuplicate
            ) {
                const siblings = await readJsonDir<Issue>(issuesDir(rootDir, input.projectKey));
                const existing = siblings.find(
                    (s) => s.parentKey === input.parentKey && s.issueType === input.issueType
                );
                if (existing) {
                    throw new Error(
                        duplicateSubtaskGateReason(input.parentKey, input.issueType as SubtaskType, existing)
                    );
                }
            }
            const dir = issuesDir(rootDir, input.projectKey);
            await mkdir(dir, { recursive: true });
            const key = await nextIssueKey(dir, input.projectKey);
            const now = new Date().toISOString();
            const issue: Issue = omitUndefined({
                key,
                projectKey: input.projectKey,
                issueType: input.issueType,
                summary: input.summary,
                description: input.description,
                // Brief §5.3 (rev 27): `Backlog` — not `To Do` — is the default landing
                // status for a newly created ticket on every backend, including this one.
                // Found out of sync with the live Jira backend's own default while running
                // TAI-291's conformance suite against it (TAI-299).
                status: Status.Backlog,
                assignee: input.assignee ?? null,
                persona: input.persona ?? defaultPersonaFor(input.issueType),
                parentKey: input.parentKey,
                component: input.component,
                severity: input.severity,
                priority: input.priority,
                labels: input.labels ?? [],
                createdAt: now,
                updatedAt: now,
                comments: [],
            });
            await writeIssueFile(rootDir, issue);
            return issue;
        },

        async getIssue(key: IssueKey): Promise<Issue | null> {
            return readIssueFile(rootDir, key);
        },

        async updateIssue(key: IssueKey, patch: IssuePatch): Promise<Issue> {
            const existing = await mustGetIssue(rootDir, key);
            if (patch.assignee === null && violatesAssignmentGate(existing.status, null)) {
                throw new Error(exitGateReason(key, existing.status));
            }
            if (patch.labels !== undefined) {
                const violation = labelViolation(patch.labels);
                if (violation !== null) throw new Error(violation);
            }
            if (patch.parentKey !== undefined) {
                const violation = reparentViolation(existing, await readIssueFile(rootDir, patch.parentKey));
                if (violation !== null) throw new Error(violation);
            }
            const updated: Issue = omitUndefined({
                ...existing,
                parentKey: patch.parentKey ?? existing.parentKey,
                labels: patch.labels ?? existing.labels,
                // TAI-390: stored only while true; clearing drops the key (same shape as Jira reads).
                flagged: patch.flagged === undefined ? existing.flagged : patch.flagged ? true : undefined,
                summary: patch.summary ?? existing.summary,
                description: applyTriState(existing.description, patch.description),
                assignee: patch.assignee === undefined ? existing.assignee : patch.assignee,
                persona: patch.persona === undefined ? existing.persona : patch.persona,
                component: applyTriState(existing.component, patch.component),
                severity: applyTriState(existing.severity, patch.severity),
                priority: applyTriState(existing.priority, patch.priority),
                updatedAt: new Date().toISOString(),
            });
            await writeIssueFile(rootDir, updated);
            return updated;
        },

        // Permissive by design for v1 re: WORKFLOW shape — every Status is reachable from
        // every Status, rather than simulating a fake Jira workflow-validator just to
        // exercise the ok:false path. Real rejection-on-workflow semantics get exercised by
        // the Jira backend (see the conformance suite's `strictWorkflow` capability flag).
        //
        // The assignment gate below is NOT part of that permissiveness, though — brief §5.5
        // says it is "enforced... in the storage plugin's transition operation," meaning
        // every backend's, not just Jira's. Confirmed by the conformance suite (TAI-15): this
        // backend previously allowed an unassigned issue into In Progress while the Jira
        // backend blocked it, which is exactly the kind of behavioral divergence types alone
        // can't catch.
        async transition(key: IssueKey, target: Status, options?: TransitionOptions): Promise<MutationResult> {
            const existing = await mustGetIssue(rootDir, key);
            if (violatesAssignmentGate(target, existing.assignee)) {
                return { ok: false, reason: entryGateReason(key, target) };
            }
            // TAI-275/276 ADR: collected from both best-effort cascade blocks below,
            // surfaced (never auto-retried) on the final MutationResult -- see interface.ts's
            // CascadeWarning doc comment.
            const cascadeWarnings: CascadeWarning[] = [];
            // TAI-304/311 ADR (Confluence page 39518210): the successful counterpart --
            // every OTHER issue a cascade actually mutated, so a caller (CachingWorkTracker)
            // can write all of them through to the cache, not just this issue's own `updated`.
            const affectedIssues: Issue[] = [];
            // REVIEW_GATES (§3.3/§5.6, TAI-41 ADR's "hard" checkpoint kind) — same gate the
            // Jira backend enforces (work-tracker.ts), kept identical across backends so this
            // doesn't become another TAI-15-style behavioral divergence.
            if (reviewGateApplies(existing, target)) {
                const roster = await getRoster(existing.projectKey);
                const check = checkReviewGate(existing, roster);
                if (!check.ok) {
                    return { ok: false, reason: reviewGateReason(key, check.missing) };
                }
                // TAI-480: approvals do not resolve an open question in a linked page.
                const unresolved = await checkClarificationGate(key, { getLinkedPages: (k) => workTracker.getLinkedPages(k), getPage: (ref) => docStore.getPage(ref) });
                if (unresolved.length > 0) {
                    return { ok: false, reason: clarificationGateReason(key, unresolved) };
                }
            }
            // TAI-476: the subtask precedence gate -- same shared predicates as the Jira backend.
            // Checked before the parent cascade below, so a refused start moves nothing.
            let bypassed: readonly Issue[] = [];
            if (precedenceGateApplies(existing, target) && existing.parentKey) {
                // A parent that cannot be read gives no graph to check against -- no gate, same as a
                // parent that is not a story-level ticket.
                const parent = await workTracker.getIssue(existing.parentKey);
                const siblings = parent
                    ? await workTracker.search({ projectKey: existing.projectKey, parentKey: existing.parentKey, exhaustive: true })
                    : [];
                const open = parent ? openPrerequisites(existing, parent, siblings) : [];
                if (open.length > 0) {
                    if (!options?.overridePrecedence) return { ok: false, reason: precedenceGateReason(key, target, open) };
                    bypassed = open;
                }
            }
            // TAI-220/221/222: parent-status cascade -- move the parent first (best-effort),
            // then this issue's own transition below. Recursing through the public
            // transition() (not a raw status write) is what makes "Subtask -> Story -> Epic"
            // work from this one call: the parent's own transition() cascades to ITS parent
            // the same way. Entirely best-effort -- a thrown error or a rejected
            // MutationResult are both just logged, never allowed to block this issue's own
            // transition (ADR, Confluence page 29753345).
            //
            // TAI-374/387: also fires on `To Do` (a scheduled subtask schedules its Backlog parent),
            // and a Kickoff Story never moves its Epic either way -- all in the shared
            // `upwardCascadeTarget` (cascade-gate.ts), so both backends apply one rule.
            if ((cascadeTriggersOn(target) || target === Status.ToDo) && existing.parentKey) {
                try {
                    const parent = await mustGetIssue(rootDir, existing.parentKey);
                    const cascadeTo = upwardCascadeTarget(existing, parent, target);
                    if (cascadeTo !== null) {
                        const cascadeResult = await workTracker.transition(existing.parentKey, cascadeTo);
                        if (!cascadeResult.ok) {
                            console.warn(
                                `Parent-cascade transition failed for ${existing.parentKey} (best-effort, continuing with ${key} -> "${target}"): ${cascadeResult.reason}`
                            );
                            cascadeWarnings.push({ key: existing.parentKey, reason: cascadeResult.reason });
                        } else {
                            // The parent's OWN transition() may have cascaded further up
                            // (Story -> Epic) and hit its own rejection -- bubble it up
                            // rather than losing it one level short of the top-level caller
                            // (found in review, TAI-276 PR).
                            cascadeWarnings.push(...(cascadeResult.cascadeWarnings ?? []));
                            // Same bubble-up for the successful counterpart -- the parent
                            // itself, plus anything ITS own cascade further up affected.
                            affectedIssues.push(cascadeResult.issue, ...(cascadeResult.affectedIssues ?? []));
                        }
                    }
                } catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    console.warn(
                        `Parent-cascade transition threw for ${existing.parentKey} (best-effort, continuing with ${key} -> "${target}"): ${reason}`
                    );
                    cascadeWarnings.push({ key: existing.parentKey, reason });
                }
            }
            let updated: Issue = { ...existing, status: target, updatedAt: new Date().toISOString() };
            await writeIssueFile(rootDir, updated);
            if (bypassed.length > 0) {
                await workTracker.addComment(key, precedenceOverrideComment(target, bypassed));
                updated = await mustGetIssue(rootDir, key);
            }

            // TAI-267 (TAI-247 ADR): downward/terminal cascade -- the closing counterpart to
            // the upward cascade above. Runs AFTER this issue's own transition has already
            // written, unlike the upward cascade's parent-first ordering -- canceling children
            // on behalf of a close that itself got rejected would be a real bug, not a
            // best-effort tradeoff. 1:N, not 1:1 (a parent can have many children, each with
            // children of their own) -- one search({ parentKey: key }), then recurse into
            // transition() itself for each open child, which walks further down the same way
            // (Epic -> Story -> subtask, no special-cased depth limit). Entirely best-effort
            // from here: a failed search or a failed/thrown child transition is logged and
            // skipped, never allowed to retroactively fail THIS transition, which has already
            // committed (ADR decision #3).
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
                                cascadeWarnings.push({ key: child.key, reason: cascadeResult.reason });
                            } else {
                                // Same bubble-up as the upward cascade above -- the child's
                                // own transition() may have cascaded further down to a
                                // grandchild and hit its own rejection there.
                                cascadeWarnings.push(...(cascadeResult.cascadeWarnings ?? []));
                                // Successful counterpart -- the child itself, plus anything
                                // ITS own cascade further down affected.
                                affectedIssues.push(cascadeResult.issue, ...(cascadeResult.affectedIssues ?? []));
                            }
                        } catch (err) {
                            const reason = err instanceof Error ? err.message : String(err);
                            console.warn(
                                `Child-cascade transition threw for ${child.key} (best-effort, ${key} -> "${target}" already succeeded): ${reason}`
                            );
                            cascadeWarnings.push({ key: child.key, reason });
                        }
                    }
                } catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    console.warn(
                        `Child-cascade search failed for ${key} (best-effort, ${key} -> "${target}" already succeeded): ${reason}`
                    );
                    cascadeWarnings.push({ key, reason: `child-cascade search failed: ${reason}` });
                }
            }

            return {
                ok: true,
                issue: updated,
                ...(cascadeWarnings.length > 0 ? { cascadeWarnings } : {}),
                ...(affectedIssues.length > 0 ? { affectedIssues } : {}),
            };
        },

        async getAvailableTransitions(key: IssueKey): Promise<readonly Status[]> {
            await mustGetIssue(rootDir, key); // validates existence
            return Object.values(Status);
        },

        async assignIssue(key: IssueKey, human: HumanRef | null): Promise<MutationResult> {
            const existing = await mustGetIssue(rootDir, key);
            if (violatesAssignmentGate(existing.status, human)) {
                return { ok: false, reason: exitGateReason(key, existing.status) };
            }
            const updated: Issue = { ...existing, assignee: human, updatedAt: new Date().toISOString() };
            await writeIssueFile(rootDir, updated);
            return { ok: true, issue: updated };
        },

        // TAI-165/167 ADR: no real external identity system here (unlike Jira's
        // user-search) — matches against the one human this backend actually knows about.
        async resolveHuman(email: string): Promise<HumanRef | null> {
            return currentUser.email === email ? currentUser : null;
        },

        async addComment(key: IssueKey, body: string): Promise<Comment> {
            const existing = await mustGetIssue(rootDir, key);
            const now = new Date().toISOString();
            const comment: Comment = { id: randomUUID(), author: currentUser, body, createdAt: now, updatedAt: now };
            const updated: Issue = {
                ...existing,
                comments: [...existing.comments, comment],
                updatedAt: now,
            };
            await writeIssueFile(rootDir, updated);
            return comment;
        },

        async editComment(key: IssueKey, commentId: string, body: string): Promise<Comment> {
            const existing = await mustGetIssue(rootDir, key);
            const target = existing.comments.find((c) => c.id === commentId);
            if (!target) throw new Error(`Comment not found: ${commentId} on ${key}`);
            const edited: Comment = { ...target, body, updatedAt: new Date().toISOString() };
            const updated: Issue = {
                ...existing,
                comments: existing.comments.map((c) => (c.id === commentId ? edited : c)),
                updatedAt: new Date().toISOString(),
            };
            await writeIssueFile(rootDir, updated);
            return edited;
        },

        async addLabel(key: IssueKey, label: string): Promise<void> {
            const existing = await mustGetIssue(rootDir, key);
            if (existing.labels.includes(label)) return;
            await writeIssueFile(rootDir, {
                ...existing,
                labels: [...existing.labels, label],
                updatedAt: new Date().toISOString(),
            });
        },

        async removeLabel(key: IssueKey, label: string): Promise<void> {
            const existing = await mustGetIssue(rootDir, key);
            await writeIssueFile(rootDir, {
                ...existing,
                labels: existing.labels.filter((l) => l !== label),
                updatedAt: new Date().toISOString(),
            });
        },

        async createLink(from: IssueKey, relation: DependencyRelation, to: IssueKey): Promise<void> {
            const data = await readLinks(rootDir);
            data.issueLinks.push({ from, relation, to });
            await writeLinks(rootDir, data);
        },

        async getLinkedIssues(
            key: IssueKey,
            relation?: DependencyRelation,
            direction: "outgoing" | "incoming" = "outgoing"
        ): Promise<readonly IssueLink[]> {
            const data = await readLinks(rootDir);
            const out: IssueLink[] = [];
            for (const l of data.issueLinks) {
                if (relation && l.relation !== relation) continue;

                // RelatesTo is symmetric (schema/story-schema.ts: "non-blocking association,
                // informational only") — unlike DependsOn, direction has no meaning for it.
                // REGRESSION this fixes (TAI-15 code review): this backend used to apply the
                // same directional from/to filter to every relation, so getLinkedIssues for
                // the identical RelatesTo link returned different results depending on which
                // direction was requested, while the Jira backend already treats it
                // symmetrically — return the far end regardless of which slot it's in.
                if (l.relation === DependencyRelation.RelatesTo) {
                    if (l.from === key) out.push({ relation: l.relation, key: toIssueKey(l.to) });
                    else if (l.to === key) out.push({ relation: l.relation, key: toIssueKey(l.from) });
                    continue;
                }

                if (direction === "outgoing" && l.from === key) {
                    out.push({ relation: l.relation, key: toIssueKey(l.to) });
                } else if (direction === "incoming" && l.to === key) {
                    out.push({ relation: l.relation, key: toIssueKey(l.from) });
                }
            }
            return out;
        },

        async linkPage(key: IssueKey, page: PageId): Promise<void> {
            const data = await readLinks(rootDir);
            if (!data.issuePageLinks.some((l) => l.issueKey === key && l.pageId === page)) {
                data.issuePageLinks.push({ issueKey: key, pageId: page });
                await writeLinks(rootDir, data);
            }
        },

        async getLinkedPages(key: IssueKey): Promise<readonly PageId[]> {
            const data = await readLinks(rootDir);
            return data.issuePageLinks.filter((l) => l.issueKey === key).map((l) => toPageId(l.pageId));
        },

        async createRemoteLink(key: IssueKey, url: string, title: string): Promise<void> {
            const data = await readLinks(rootDir);
            const idx = data.issueRemoteLinks.findIndex((l) => l.issueKey === key && l.url === url);
            if (idx >= 0) {
                data.issueRemoteLinks[idx] = { issueKey: key, url, title };
            } else {
                data.issueRemoteLinks.push({ issueKey: key, url, title });
            }
            await writeLinks(rootDir, data);
        },

        async getRemoteLinks(key: IssueKey): Promise<readonly RemoteLink[]> {
            const data = await readLinks(rootDir);
            return data.issueRemoteLinks
                .filter((l) => l.issueKey === key)
                .map((l) => ({ url: l.url, title: l.title }));
        },

        async listAttachments(key: IssueKey): Promise<readonly AttachmentRef[]> {
            return listDirAttachments(issueAttachmentsDir(rootDir, key));
        },

        async getAttachment(key: IssueKey, attachmentId: string): Promise<Buffer> {
            return readDirAttachment(issueAttachmentsDir(rootDir, key), attachmentId);
        },

        async search(filter: IssueFilter): Promise<readonly Issue[]> {
            const issues = await readJsonDir<Issue>(issuesDir(rootDir, filter.projectKey));
            const results = issues.filter((i) => matchesIssueFilter(i, filter));
            return filter.exhaustive ? results : results.slice(0, filter.limit ?? DEFAULT_SEARCH_LIMIT);
        },
    };

    const docStore: DocStore = {
        async createPage(input: CreatePageInput): Promise<Page> {
            const dir = confluenceDir(rootDir, input.spaceKey);
            await mkdir(dir, { recursive: true });
            const id = await nextPageId(dir, input.spaceKey);
            const now = new Date().toISOString();
            const page: Page = omitUndefined({
                id,
                spaceKey: input.spaceKey,
                title: input.title,
                content: input.content,
                parentId: input.parentId,
                createdAt: now,
                updatedAt: now,
                comments: [],
            });
            await writePageFile(rootDir, page);
            return page;
        },

        async getPage(ref: PageRef): Promise<Page | null> {
            return resolvePage(rootDir, ref);
        },

        async updatePage(ref: PageRef, patch: PagePatch): Promise<Page> {
            const existing = await mustResolvePage(rootDir, ref);
            // TAI-305 (PR #89 review): a cross-space move would silently orphan the page --
            // this backend stores pages under a per-space directory, so getChildren(newParent)
            // would never find it there. Reject outright rather than leave that inconsistency.
            if (patch.parentId !== undefined) {
                const newParent = await mustResolvePage(rootDir, { id: patch.parentId });
                if (newParent.spaceKey !== existing.spaceKey) {
                    throw new Error(
                        `Cannot move page ${existing.id} to parent ${newParent.id}: different spaces ` +
                            `(${existing.spaceKey} -> ${newParent.spaceKey}) -- not supported.`
                    );
                }
            }
            const updated: Page = omitUndefined({
                ...existing,
                title: patch.title ?? existing.title,
                content: patch.content ?? existing.content,
                parentId: patch.parentId ?? existing.parentId,
                updatedAt: new Date().toISOString(),
            });
            await writePageFile(rootDir, updated);
            return updated;
        },

        async addComment(ref: PageRef, body: string): Promise<Comment> {
            const existing = await mustResolvePage(rootDir, ref);
            const now = new Date().toISOString();
            const comment: Comment = { id: randomUUID(), author: currentUser, body, createdAt: now, updatedAt: now };
            const updated: Page = {
                ...existing,
                comments: [...existing.comments, comment],
                updatedAt: now,
            };
            await writePageFile(rootDir, updated);
            return comment;
        },

        async editComment(ref: PageRef, commentId: string, body: string): Promise<Comment> {
            const existing = await mustResolvePage(rootDir, ref);
            const target = existing.comments.find((c) => c.id === commentId);
            if (!target) throw new Error(`Comment not found: ${commentId} on page ${existing.id}`);
            const edited: Comment = { ...target, body, updatedAt: new Date().toISOString() };
            const updated: Page = {
                ...existing,
                comments: existing.comments.map((c) => (c.id === commentId ? edited : c)),
                updatedAt: new Date().toISOString(),
            };
            await writePageFile(rootDir, updated);
            return edited;
        },

        async getChildren(ref: PageRef, limit?: number): Promise<readonly Page[]> {
            const parent = await resolvePage(rootDir, ref);
            if (!parent) return [];
            const pages = await readAllPages(rootDir, parent.spaceKey);
            const children = pages.filter((p) => p.parentId === parent.id);
            return limit !== undefined ? children.slice(0, limit) : children;
        },

        async listRootPages(spaceKey: string, limit?: number): Promise<readonly PageSummary[]> {
            const roots = (await readAllPages(rootDir, spaceKey)).filter((p) => p.parentId === undefined);
            const summaries = roots.map(({ id, spaceKey: key, title, createdAt, updatedAt }) => ({
                id,
                spaceKey: key,
                title,
                createdAt,
                updatedAt,
            }));
            return limit !== undefined ? summaries.slice(0, limit) : summaries;
        },

        async getLinkedIssues(ref: PageRef): Promise<readonly IssueKey[]> {
            const page = await resolvePage(rootDir, ref);
            if (!page) return [];
            const data = await readLinks(rootDir);
            return data.issuePageLinks.filter((l) => l.pageId === page.id).map((l) => toIssueKey(l.issueKey));
        },

        async listAttachments(ref: PageRef): Promise<readonly AttachmentRef[]> {
            const page = await resolvePage(rootDir, ref);
            if (!page) return [];
            return listDirAttachments(pageAttachmentsDir(rootDir, page.id));
        },

        async getAttachment(ref: PageRef, attachmentId: string): Promise<Buffer> {
            const page = await mustResolvePage(rootDir, ref);
            return readDirAttachment(pageAttachmentsDir(rootDir, page.id), attachmentId);
        },
    };

    return { kind: "filesystem", workTracker, docStore };
}
