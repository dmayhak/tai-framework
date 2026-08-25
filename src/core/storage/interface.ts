/**
 * TAI Framework — Storage Plugin Interface
 * The swappable abstraction over the system of record (Jira+Confluence, a local
 * filesystem fallback, or a future third-party backend via its own MCP server —
 * brief §3.2). Every persona, workflow, and command is built against this interface,
 * never against a specific backend directly — this is the single most important
 * design artifact in the system (brief §3.2's own words).
 *
 * Two focused interfaces, matching the brief's own product split rather than one
 * giant interface or several fragmented ones: WorkTracker (the Jira-like ticket
 * hierarchy) and DocStore (the Confluence-like doc hierarchy). A StorageBackend
 * bundles one of each, since a single backend (Jira+Confluence, or the filesystem)
 * always implements both halves together.
 */

import type {
    StoryType,
    SubtaskType,
    Persona,
    DependencyRelation,
    Status,
} from "../schema/story-schema.js";

// ---------- Branded IDs ----------

// Cheap insurance against swapping an issue key for a page id (or a raw unbranded
// string) at a call site — strict mode won't catch that otherwise.
type Brand<T, B extends string> = T & { readonly __brand: B };

export type IssueKey = Brand<string, "IssueKey">;
export type PageId = Brand<string, "PageId">;
export type HumanId = Brand<string, "HumanId">;

// Thin cast helpers so call sites and backends aren't full of inline `as` casts.
export const toIssueKey = (s: string): IssueKey => s as IssueKey;
export const toPageId = (s: string): PageId => s as PageId;
export const toHumanId = (s: string): HumanId => s as HumanId;

// ---------- Core shapes ----------

export interface HumanRef {
    readonly id: HumanId;
    readonly displayName: string;
    readonly email?: string;
}
// HumanId is backend-scoped and opaque: a Jira accountId on the Jira backend, an
// email or locally-assigned id on the filesystem backend. Reconciling a HumanRef
// against the Persona Roster (brief §5.6) is domain logic built ON TOP of this
// interface via DocStore — not this interface's job.

export interface Comment {
    readonly id: string;
    readonly author: HumanRef;
    readonly body: string;
    readonly createdAt: string; // ISO 8601
    readonly updatedAt: string; // ISO 8601 — equals createdAt until edited. Matters for
    // brief §3.9's "fresh re-scan, never cached" comment-marker rule: an edited
    // `Approved:`/`Q:`/`Rejected:` comment can change what it means, so callers doing
    // freshness comparisons need to see the edit, not just additions/deletions.
}

export interface AttachmentRef {
    readonly id: string;
    readonly filename: string;
    readonly sizeBytes?: number;
}

export interface Issue {
    readonly key: IssueKey;
    readonly projectKey: string;
    // 'epic': Epic has no formal StoryType/SubtaskType entry in the schema yet — a
    // known gap, tracked as a follow-up, not worth blocking this interface on.
    readonly issueType: StoryType | SubtaskType | "epic";
    readonly summary: string;
    readonly description?: string;
    readonly status: Status;
    readonly assignee: HumanRef | null; // two-axis owner model, axis 1 — the real human (brief §5.6)
    readonly persona: Persona | null; // axis 2 — which role is acting; stored, never derived
    // Required-by-convention depending on issueType (Epic: none; Story/Bug: an Epic;
    // Subtask: a Story/Bug) — not enforced at the type level, documented only.
    readonly parentKey?: IssueKey;
    // Subtask-scoped in TAI's model (brief §4/§5.4 — repo tracking, one component per
    // subtask). A Story/Bug's own value has no defined meaning; don't rely on it there.
    readonly component?: string;
    readonly severity?: string;
    readonly priority?: string;
    readonly labels: readonly string[];
    readonly createdAt: string;
    readonly updatedAt: string;
    // Comments are part of this payload, not a separate fetch (brief §7).
    readonly comments: readonly Comment[];
}

export interface CreateIssueInput {
    readonly projectKey: string;
    readonly issueType: StoryType | SubtaskType | "epic";
    readonly summary: string;
    readonly description?: string;
    readonly assignee?: HumanRef | null;
    readonly persona?: Persona | null;
    readonly parentKey?: IssueKey;
    readonly component?: string;
    readonly severity?: string;
    readonly priority?: string;
    readonly labels?: readonly string[];
}

// Tri-state on every nullable field: `undefined` = leave unchanged, `null` = clear,
// a value = set. Backend-managed fields (key, createdAt, updatedAt, comments,
// status — status only changes via transition()) are deliberately excluded.
export interface IssuePatch {
    readonly summary?: string;
    readonly description?: string | null;
    readonly assignee?: HumanRef | null;
    readonly persona?: Persona | null;
    readonly component?: string | null;
    readonly severity?: string | null;
    readonly priority?: string | null;
}

export interface IssueFilter {
    readonly projectKey: string;
    readonly issueTypes?: readonly (StoryType | SubtaskType | "epic")[];
    readonly statuses?: readonly Status[];
    readonly assignee?: HumanId;
    readonly persona?: Persona;
    readonly parentKey?: IssueKey;
    readonly updatedSince?: string; // ISO — powers brief §7's bulk incremental-sync case
    // Bounds result size. Full cursor pagination is deferred (documented, not built —
    // no real project is anywhere near needing it yet); a Jira-backed implementation
    // can page internally up to this bound without violating the interface. When omitted,
    // every backend applies DEFAULT_SEARCH_LIMIT below — never "everything."
    readonly limit?: number;
}

/**
 * The limit search() applies when a caller passes no `limit`. EVERY backend must use this
 * same default — a caller doing a full scan with no limit specified must get the same
 * result size regardless of which backend answers.
 *
 * REGRESSION this fixes (TAI-15 code review): the filesystem backend used to return every
 * matching issue unbounded when `limit` was omitted, while the Jira backend capped at 50 —
 * real Jira has no unbounded fetch to offer (full cursor pagination is the deferred feature
 * noted above), so "unbounded" was never actually achievable on both backends, only one.
 * A caller relying on "no limit means everything" would silently get truncated results the
 * moment the same code ran against Jira.
 */
export const DEFAULT_SEARCH_LIMIT = 50;

export interface IssueLink {
    readonly relation: DependencyRelation;
    readonly key: IssueKey;
}

// A generic remote (non-Jira-issue) link — e.g. the PR a CodeReview subtask reviews
// (brief §5.4: "links the PR to the CodeReview subtask via a Jira remote issue link").
// Deliberately NOT git-hosting-specific in shape (no PullRequestId/RepoId here) — this
// interface stays agnostic to what's on the other end of the URL, same as `linkPage`
// stays agnostic to page content. Unlike `linkPage`/`getLinkedPages` (a single well-known
// concept with its own dedicated pair of methods), this is the general-purpose primitive
// underneath — any URL, not just a Confluence page's.
export interface RemoteLink {
    readonly url: string;
    readonly title: string;
}

// Rejection vs. connectivity failure are DIFFERENT cases the brief treats
// differently (§3.3's escalate-immediately-no-retry vs. §3.6's queue-and-retry on
// reconnect) — collapsing them into one `ok: false` shape would force callers to
// string-match `reason` to tell them apart. Convention: throw
// StorageConnectivityError for network/infra failures; return `ok: false` only for a
// genuine backend-side rejection (validator, permission, missing field, concurrent
// change — brief §3.3's "unplanned checkpoint").
export type MutationResult =
    | { readonly ok: true; readonly issue: Issue }
    | { readonly ok: false; readonly reason: string };

export class StorageConnectivityError extends Error {}

// ---------- WorkTracker ----------

export interface WorkTracker {
    createIssue(input: CreateIssueInput): Promise<Issue>;
    getIssue(key: IssueKey): Promise<Issue | null>;
    updateIssue(key: IssueKey, patch: IssuePatch): Promise<Issue>;

    // Raw backend transition/assignment state — NOT the same as TAI's own
    // precedence-derived "ready/blocked" (that's isSubtaskReady() /
    // resolveApplicablePrecedence() in story-schema.ts, computed over already-fetched
    // Issue data; no storage call needed for it).
    transition(key: IssueKey, target: Status): Promise<MutationResult>;
    getAvailableTransitions(key: IssueKey): Promise<readonly Status[]>;
    // Mirrors transition()'s rejection shape — brief §5.6 explicitly reuses the
    // transition pattern for assignment rejection ("the same kind of unplanned
    // checkpoint already defined for transitions — no new mechanism needed").
    assignIssue(key: IssueKey, human: HumanRef | null): Promise<MutationResult>;

    /**
     * Resolves a real human identity from an email — specifically, a `HumanRef` whose
     * `id` is the backend's REAL account id, not any synthetic/derived one (TAI-165/167
     * ADR). Needed wherever a roster-sourced `HumanRef` (`personas/roster.ts`,
     * `git/pr-reviewers.ts` — both id-less-by-design, matched by email/name only) must be
     * turned into something a raw API call can actually use as an identity (e.g.
     * `GitHost.createPullRequest`'s `reviewers`, which needs a real Bitbucket account_id —
     * verified to be the SAME id Atlassian's unified cross-product identity already gives
     * Jira). Returns `null` on no match rather than throwing — an unresolvable roster
     * entry is a real, non-exceptional case, not a fault.
     */
    resolveHuman(email: string): Promise<HumanRef | null>;

    addComment(key: IssueKey, body: string): Promise<Comment>;
    editComment(key: IssueKey, commentId: string, body: string): Promise<Comment>;
    addLabel(key: IssueKey, label: string): Promise<void>;
    removeLabel(key: IssueKey, label: string): Promise<void>;

    createLink(from: IssueKey, relation: DependencyRelation, to: IssueKey): Promise<void>;
    // direction 'outgoing' (default): links where `key` is the `from` end (what this
    // depends on / relates to). 'incoming': where `key` is the `to` end (what depends
    // on this). Disambiguates DependsOn's direction, which story-schema.ts documents
    // as one-directional but this interface must specify explicitly too.
    getLinkedIssues(
        key: IssueKey,
        relation?: DependencyRelation,
        direction?: "outgoing" | "incoming"
    ): Promise<readonly IssueLink[]>;

    // Issue<->Page association (brief §4: pages tie to the parent issue that needs
    // them as input; §3.6: briefing generation walks these one-hop). Undirected —
    // unlike DependsOn/RelatesTo, link direction has no meaning for a doc reference.
    linkPage(key: IssueKey, page: PageId): Promise<void>;
    getLinkedPages(key: IssueKey): Promise<readonly PageId[]>;

    // Generic remote-URL link (TAI-107/TAI-108) — e.g. `git-pr create` links the PR it
    // opens to the CodeReview subtask that will review it, closing the manual step brief
    // §5.4 previously left to a persona to do by hand. Idempotent by `url`: creating a
    // second link with the same `url` on the same issue updates its `title` in place
    // rather than duplicating the link (same upsert posture as `linkPage`'s dedup-before-
    // push, just keyed on url instead of exact (key, page) equality since a title can
    // legitimately change — e.g. a PR gets renamed — while the URL identifies the same
    // real-world thing).
    createRemoteLink(key: IssueKey, url: string, title: string): Promise<void>;
    getRemoteLinks(key: IssueKey): Promise<readonly RemoteLink[]>;

    listAttachments(key: IssueKey): Promise<readonly AttachmentRef[]>;
    getAttachment(key: IssueKey, attachmentId: string): Promise<Buffer>;

    search(filter: IssueFilter): Promise<readonly Issue[]>;
}

// ---------- DocStore ----------

// Lookup by opaque id, or by (space, title) — callers often know a page's title and
// space but not its id ahead of time (e.g. finding the Persona Roster, brief §5.6).
export type PageRef = { readonly id: PageId } | { readonly spaceKey: string; readonly title: string };

export interface Page {
    readonly id: PageId;
    readonly spaceKey: string;
    readonly title: string;
    readonly content: string; // markdown — see note below for the Jira/Confluence backend
    readonly parentId?: PageId;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly comments: readonly Comment[];
}
// For the future Jira/Confluence backend (Phase 4+) — diagram rendering, verified
// live against the real Atlassian MCP server and the real TAI Confluence/Jira site:
//
// Confluence has no native Mermaid rendering and neither does plain markdown import
// — writing a ```mermaid fenced block converts it into a generic `macro-diagram`
// shell that nothing renders ("Unknown macro"), and reading an existing diagram back
// through the MCP's markdown-conversion option is separately lossy (the structure
// collapses into mangled plain text, fence markers gone). A rendering app must be
// installed (we used "Mermaid Macros for Confluence" by 9ByNight — free, Forge-based,
// zero data-access permissions). Confirmed working end-to-end, including writing new
// diagrams programmatically via this backend, not just reading ones a human added by
// hand: content must be raw storage/XHTML format (content_format 'storage', never
// 'markdown'), structured as an `<ac:adf-extension>` node wrapping an
// `<ac:adf-node type="extension">`, with:
//   - extension-key: "<app-id>/<env-id>/static/mermaid-diagram-macro" (site/app-install
//     specific — read it off an existing working diagram on the target site rather
//     than hardcoding the value found on the TAI dev site; not confirmed portable
//     across different Atlassian sites even with the identical app installed)
//   - guest-params > source: the Mermaid source, with `<`/`>`/`&` entity-escaped
//     (not CDATA-wrapped, unlike the old macro-diagram shell's plain-text-body)
//   - guest-params > display: "diagram"
//   - an `<ac:adf-fallback>` sibling duplicating the same node (present in every
//     working example observed; unclear if Confluence requires it or just always
//     emits it — kept for parity rather than tested with it omitted)
// Every `<ac:adf-extension>`/`<ac:adf-node>` needs a unique local-id, reused as both
// the outer node's `local-id` attribute and the nested `parameters > local-id`.
//
// Jira has no equivalent hurdle: with a Mermaid-rendering app installed ("Mermaid
// Diagrams for Jira" by 9ByNight, same vendor), a plain code block containing Mermaid
// syntax in an issue's description or a comment — no special macro, no escaping, just
// ordinary Issue.description/Comment.body text — is auto-detected and rendered in a
// dedicated panel next to the issue. Nothing about WorkTracker needs to change for
// this to work; it's a property of the installed app, not this interface.
//
// External-URL images (`![alt](url)`) round-trip cleanly on the Confluence side
// either direction; an uploaded/attached image reference wasn't tested and likely
// goes through a similar macro mechanism — verify before relying on it.

export interface CreatePageInput {
    readonly spaceKey: string;
    readonly title: string;
    readonly content: string;
    readonly parentId?: PageId;
}

export interface PagePatch {
    readonly title?: string;
    readonly content?: string;
}

export interface DocStore {
    createPage(input: CreatePageInput): Promise<Page>;
    getPage(ref: PageRef): Promise<Page | null>;
    updatePage(ref: PageRef, patch: PagePatch): Promise<Page>;
    addComment(ref: PageRef, body: string): Promise<Comment>;
    editComment(ref: PageRef, commentId: string, body: string): Promise<Comment>;
    getChildren(ref: PageRef, limit?: number): Promise<readonly Page[]>;

    // Complementary view of the same link data as WorkTracker.getLinkedPages/
    // linkPage — not a second store.
    getLinkedIssues(ref: PageRef): Promise<readonly IssueKey[]>;

    listAttachments(ref: PageRef): Promise<readonly AttachmentRef[]>;
    getAttachment(ref: PageRef, attachmentId: string): Promise<Buffer>;
}
// Deliberate: the Persona Roster (brief §5.6) and persona extensions (§3.1) are NOT
// a separate interface — they're ordinary pages (e.g.
// getPage({ spaceKey, title: "Persona Roster" })) under the Config folder (§4 rev
// 14). Domain logic for parsing the roster table into a lookup lives above this
// interface, not in it.

// ---------- StorageBackend ----------

export interface StorageBackend {
    // Deliberately NOT a closed union of known backend names — brief §3.2 explicitly
    // allows third-party backends via their own MCP servers, and a closed union
    // would both block that and invite callers to branch on it, which is exactly the
    // kind of leak this interface exists to prevent.
    readonly kind: string;
    readonly workTracker: WorkTracker;
    readonly docStore: DocStore;
}
