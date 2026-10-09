/**
 * TAI Framework — Persona Config loader/merge (TAI-51 ADR, resolving Epic TAI-6)
 *
 * Every `src/personas/*.md` file carries a `permissions`/`checkpoints`/`confluenceOutputs`
 * front-matter block that has, until now, said "not yet enforced in code." This module makes
 * that block executable: a project's *effective* `PersonaConfig` for a given persona id is a
 * 3-layer merge (TAI-51 ADR decision 1):
 *
 *   1. Bundled default  — the built-in `.md` file (or `emptyPersonaShell` for a user-added
 *      persona with no bundled file).
 *   2. Project override — the `Personas` Confluence page (Config folder, sibling to
 *      `Persona Roster`): sparse, lists only deltas (a disabled built-in, or a full row for a
 *      user-added persona).
 *   3. Extension        — an optional per-persona Confluence page, merged ADDITIVELY ONLY
 *      (brief §3.1: "extensions add to, never override").
 *
 * Hard-rule carve-out (ADR decision 1): `permissions.cannotApprove` and
 * `checkpoints.humanSignOffDefault` are NEVER taken from layers 2/3 — always layer 1's value,
 * enforced uniformly by `mergePersonaConfig` regardless of whether layer 1 is a real built-in
 * or an `emptyPersonaShell`. This is what lets a brand-new user-added persona still inherit
 * the same safe hard-rule defaults (own-output self-approval barred, human sign-off required)
 * without a special "is this built-in" branch anywhere in the merge logic.
 *
 * Parsing is hand-rolled (`js-yaml` for the YAML fragments, not a markdown-front-matter
 * library) matching this project's existing style (`persona/roster.ts` hand-parses its own
 * markdown table rather than pulling in a table-parsing library) — but DOES use `js-yaml`
 * itself rather than a hand-rolled YAML subset, since this parser sits on a permission-
 * enforcement path where a quoting/escaping bug would silently mis-grant or mis-deny.
 */

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { load as loadYaml } from "js-yaml";

import { StoryType, SubtaskType } from "../schema/story-schema.js";
import type { DocStore, PageRef } from "../storage/interface.js";

// ---------- Permission target parsing ----------

export type PermissionTarget =
    | { readonly kind: "issue"; readonly issueType: StoryType | "epic" }
    | { readonly kind: "subtask"; readonly subtaskType: SubtaskType };

export interface UpdateGrant {
    /** e.g. "Epic", "Story", "Bug" — loose, matches the open story-type taxonomy (brief §5.1). */
    readonly entityType: string;
    readonly field: string;
}

function normalizeLabel(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// "Subtask:CodeReview" -> SubtaskType.CodeReview ("code-review"); "Subtask:UAT" ->
// SubtaskType.Uat ("uat"). Front-matter labels are PascalCase/no-dash, enum values are
// dash-separated lowercase — normalizing both sides (strip non-alphanumerics, lowercase)
// is what lets them match without a second hand-maintained label table.
const SUBTASK_LABEL_TO_TYPE: ReadonlyMap<string, SubtaskType> = new Map(
    Object.values(SubtaskType).map((t) => [normalizeLabel(t), t])
);

const STORY_LABEL_TO_TYPE: ReadonlyMap<string, StoryType | "epic"> = new Map<string, StoryType | "epic">([
    ["epic", "epic"],
    ...Object.values(StoryType).map((t): [string, StoryType] => [normalizeLabel(t), t]),
]);

/**
 * Parses one `permissions.{create,workOn,complete,propose}` list entry. Returns null for an
 * unrecognised label (a typo, or a future type) rather than throwing — same "skip, don't
 * crash" tolerance as `roster.ts`'s label parsing, and the SAFE direction here: a target that
 * fails to parse is simply absent from the grant, which narrows permissions, never widens
 * them.
 */
export function parsePermissionTarget(raw: string): PermissionTarget | null {
    const trimmed = raw.trim();
    const subtaskMatch = /^Subtask:(.+)$/i.exec(trimmed);
    if (subtaskMatch) {
        const subtaskType = SUBTASK_LABEL_TO_TYPE.get(normalizeLabel(subtaskMatch[1]!));
        return subtaskType ? { kind: "subtask", subtaskType } : null;
    }
    const issueType = STORY_LABEL_TO_TYPE.get(normalizeLabel(trimmed));
    return issueType !== undefined ? { kind: "issue", issueType } : null;
}

/** Parses one `permissions.update` entry, e.g. "Story.acceptanceCriteria". */
export function parseUpdateGrant(raw: string): UpdateGrant | null {
    const idx = raw.indexOf(".");
    if (idx <= 0 || idx === raw.length - 1) return null;
    return { entityType: raw.slice(0, idx).trim(), field: raw.slice(idx + 1).trim() };
}

function targetKey(t: PermissionTarget): string {
    return t.kind === "issue" ? `issue:${t.issueType}` : `subtask:${t.subtaskType}`;
}

function unionTargets(a: readonly PermissionTarget[], b: readonly PermissionTarget[]): PermissionTarget[] {
    const seen = new Map<string, PermissionTarget>();
    for (const t of [...a, ...b]) seen.set(targetKey(t), t);
    return [...seen.values()];
}

function unionUpdateGrants(a: readonly UpdateGrant[], b: readonly UpdateGrant[]): UpdateGrant[] {
    const seen = new Map<string, UpdateGrant>();
    for (const g of [...a, ...b]) seen.set(`${g.entityType}.${g.field}`, g);
    return [...seen.values()];
}

// ---------- PersonaConfig ----------

export interface PersonaPermissions {
    readonly propose: readonly PermissionTarget[];
    readonly create: readonly PermissionTarget[];
    readonly workOn: readonly PermissionTarget[];
    readonly complete: readonly PermissionTarget[];
    readonly update: readonly UpdateGrant[];
    /** Opaque named gates, e.g. "KickoffReviewGate" (brief §3.5) — not modeled further here. */
    readonly approve: readonly string[];
    /** `GitHost` actions (TAI-33/34 ADRs) this persona may perform — a separate axis from
     *  the Jira-issue-type-shaped grants above, since a PR isn't a Jira issue. Checked by
     *  `PersonaScopedGitHost` (TAI-73), the git-hosting sibling of `PersonaScopedWorkTracker`. */
    readonly gitHost: readonly GitHostAction[];
    /** Hard rule (brief §3.4/§4). Always "own-output" today; kept open (string[]) matching
     *  this project's other open, evolving taxonomies rather than a closed literal union. */
    readonly cannotApprove: readonly string[];
}

/** Scoped to exactly the `GitHost` operations the TAI-34 ADR's checkpoint chain gates —
 *  same "don't build ahead of a need" restraint as `GitHost` itself (`git/interface.ts`'s
 *  own doc comment): `getRepository`/`listBranches`/etc. are read-only and ungated. */
export const GIT_HOST_ACTIONS = ["createPullRequest", "reviewPullRequest", "mergePullRequest"] as const;
export type GitHostAction = (typeof GIT_HOST_ACTIONS)[number];
const GIT_HOST_ACTION_SET: ReadonlySet<string> = new Set(GIT_HOST_ACTIONS);

export interface PersonaCheckpoints {
    readonly humanSignOffDefault: boolean;
    /** Persona-specific extras (`selfAuthoredReviewSeparation`, `alwaysHumanGated`,
     *  `kickoffGateRequiresJointApproval`, ...) captured losslessly. Nothing in this Story
     *  consumes them individually — the brief's own checkpoint taxonomy is still evolving
     *  (§8.23), so modeling each one now would be building ahead of an observed need. */
    readonly extra: Readonly<Record<string, unknown>>;
}

export interface PersonaConfig {
    /** Not narrowed to the `Persona` enum — a user-added persona (brief §3.1) may have an id
     *  outside it. Code that only knows about the 9 built-in roles keeps using `Persona`. */
    readonly id: string;
    readonly displayName: string;
    readonly enabled: boolean;
    readonly permissions: PersonaPermissions;
    readonly checkpoints: PersonaCheckpoints;
    readonly confluenceOutputs: readonly string[];
    /** The runtime prompt text: built-in body, plus (if an extension applied) an appended
     *  "Team-specific additions" section. */
    readonly prompt: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function buildPermissions(raw: unknown): PersonaPermissions {
    const p = isRecord(raw) ? raw : {};
    return {
        propose: asStringArray(p.propose).map(parsePermissionTarget).filter((t): t is PermissionTarget => t !== null),
        create: asStringArray(p.create).map(parsePermissionTarget).filter((t): t is PermissionTarget => t !== null),
        workOn: asStringArray(p.workOn).map(parsePermissionTarget).filter((t): t is PermissionTarget => t !== null),
        complete: asStringArray(p.complete)
            .map(parsePermissionTarget)
            .filter((t): t is PermissionTarget => t !== null),
        update: asStringArray(p.update).map(parseUpdateGrant).filter((g): g is UpdateGrant => g !== null),
        approve: asStringArray(p.approve),
        // Same "skip, don't crash" tolerance as parsePermissionTarget — an unrecognised
        // action narrows the grant, never widens it.
        gitHost: asStringArray(p.gitHost).filter((a): a is GitHostAction => GIT_HOST_ACTION_SET.has(a)),
        cannotApprove: asStringArray(p.cannotApprove),
    };
}

function buildCheckpoints(raw: unknown): PersonaCheckpoints {
    const c = isRecord(raw) ? raw : {};
    const { humanSignOffDefault, ...extra } = c;
    // Brief §3.4: "Human sign-off is the default" — missing/malformed reads as true, the
    // safe direction, not false.
    return { humanSignOffDefault: humanSignOffDefault !== false, extra };
}

function buildConfluenceOutputs(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    // Every built-in `.md` file uses the `- type: xxx` object form, but a human editing a
    // Confluence override/extension page (layers 2/3) may naturally write a plain string list
    // instead — both are accepted rather than silently dropping the plain form (Gemini CLI
    // review, PR #7).
    return raw
        .map((item) => {
            if (typeof item === "string") return item;
            if (isRecord(item) && typeof item.type === "string") return item.type;
            return null;
        })
        .filter((t): t is string => t !== null);
}

/**
 * The layer-1 default for a persona with no bundled `.md` file (a user-added persona, brief
 * §3.1). Carries the same safe hard-rule defaults every built-in has — barred from
 * self-approval, human sign-off required — so `mergePersonaConfig`'s carve-out needs no
 * separate "is this built-in" branch: it always takes `cannotApprove`/`humanSignOffDefault`
 * from layer 1, and layer 1 is always safe by construction.
 */
export function emptyPersonaShell(id: string, displayName = id): PersonaConfig {
    return {
        id,
        displayName,
        enabled: true,
        permissions: {
            propose: [],
            create: [],
            workOn: [],
            complete: [],
            update: [],
            approve: [],
            gitHost: [],
            cannotApprove: ["own-output"],
        },
        checkpoints: { humanSignOffDefault: true, extra: {} },
        confluenceOutputs: [],
        prompt: "",
    };
}

// ---------- Built-in `.md` parsing ----------

function splitFrontMatter(raw: string): { frontMatter: unknown; body: string } {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    if (!match) {
        throw new Error("Persona file has no recognisable `---` front-matter block.");
    }
    return { frontMatter: loadYaml(match[1]!), body: match[2] ?? "" };
}

/** Parses one built-in persona `.md` file's full text into a `PersonaConfig` (layer 1). */
export function parseBuiltinPersonaFile(raw: string): PersonaConfig {
    const { frontMatter, body } = splitFrontMatter(raw);
    const fm = isRecord(frontMatter) ? frontMatter : {};
    if (typeof fm.id !== "string" || fm.id.length === 0) {
        throw new Error("Persona file front-matter is missing a string `id`.");
    }
    return {
        id: fm.id,
        displayName: typeof fm.displayName === "string" ? fm.displayName : fm.id,
        enabled: fm.enabled !== false,
        permissions: buildPermissions(fm.permissions),
        checkpoints: buildCheckpoints(fm.checkpoints),
        confluenceOutputs: buildConfluenceOutputs(fm.confluenceOutputs),
        prompt: body.trim(),
    };
}

// ---------- Layer 2: the `Personas` override page ----------

export interface PersonaOverride {
    readonly id: string;
    readonly enabled?: boolean;
    readonly displayName?: string;
    /** Present only for a full row (built-in narrowing, or a user-added persona) — a sparse
     *  `enabled: false` row has none of these. */
    readonly permissions?: PersonaPermissions;
    readonly checkpoints?: PersonaCheckpoints;
    readonly confluenceOutputs?: readonly string[];
    /** Title of a Confluence page (same space, Config folder) holding this persona's runtime
     *  prompt — required for a user-added persona; absent for a built-in override row, since
     *  the built-in `.md` file already supplies the prompt. */
    readonly promptPageTitle?: string;
}

// Restricted to identifier-shaped headings (persona ids are always lowercase-hyphenated,
// e.g. "code-reviewer", "release-manager") rather than any level-3 heading — an unrestricted
// `.+?` would also match an ordinary prose subheading a human adds inside their own section
// (e.g. "### Notes"), misreading it as a new persona and cutting the real one's section short
// (Gemini CLI review, PR #7).
const OVERRIDE_HEADING = /^###\s+([a-zA-Z][a-zA-Z0-9-]*)\s*$/;
// Trailing whitespace after the language tag (` ```yaml  `) is common from copy-paste/editor
// auto-formatting in human-edited Confluence content — matched here so it doesn't silently
// fail to find the fence (Gemini CLI review, PR #7).
const YAML_FENCE = /```ya?ml[ \t]*\r?\n([\s\S]*?)\r?\n```/;

/**
 * Parses the `Personas` Confluence page: one `### <persona-id>` heading per override, each
 * followed by a \`\`\`yaml fence with the delta (TAI-51 ADR decision 2). Unrecognised/malformed
 * sections are skipped, not thrown — same tolerance as `roster.ts`.
 */
export function parsePersonasOverridePage(markdown: string): ReadonlyMap<string, PersonaOverride> {
    const lines = markdown.split("\n");
    const overrides = new Map<string, PersonaOverride>();

    for (let i = 0; i < lines.length; i++) {
        const headingMatch = OVERRIDE_HEADING.exec(lines[i]!);
        if (!headingMatch) continue;
        const id = headingMatch[1]!.trim();

        // The section body runs until the next `### ` heading (or EOF); the fence must be
        // somewhere inside it.
        let end = lines.length;
        for (let j = i + 1; j < lines.length; j++) {
            if (OVERRIDE_HEADING.test(lines[j]!)) {
                end = j;
                break;
            }
        }
        const section = lines.slice(i + 1, end).join("\n");
        const fenceMatch = YAML_FENCE.exec(section);
        if (!fenceMatch) continue; // heading with no fence — not a valid override, skip

        // This page is human-edited, live Confluence content — a YAML typo in one section
        // must not take down every OTHER persona's override (or crash the whole 3-layer
        // resolution). Same "skip, don't crash" tolerance as an unrecognised Persona Roster
        // label (roster.ts): malformed input narrows to "no override for this id", never
        // throws.
        let parsed: unknown;
        try {
            parsed = loadYaml(fenceMatch[1]!);
        } catch {
            continue;
        }
        if (!isRecord(parsed)) continue;

        overrides.set(id, {
            id,
            enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : undefined,
            displayName: typeof parsed.displayName === "string" ? parsed.displayName : undefined,
            permissions: "permissions" in parsed ? buildPermissions(parsed.permissions) : undefined,
            checkpoints: "checkpoints" in parsed ? buildCheckpoints(parsed.checkpoints) : undefined,
            confluenceOutputs:
                "confluenceOutputs" in parsed ? buildConfluenceOutputs(parsed.confluenceOutputs) : undefined,
            promptPageTitle: typeof parsed.promptPage === "string" ? parsed.promptPage : undefined,
        });
    }

    return overrides;
}

// ---------- Layer 3: an extension page ----------

export interface PersonaExtension {
    /** Additive-only grants — no `cannotApprove` (hard-rule carve-out: an extension can never
     *  grant it away, so there's nothing for this shape to carry). */
    readonly permissions: Pick<
        PersonaPermissions,
        "propose" | "create" | "workOn" | "complete" | "update" | "approve" | "gitHost"
    >;
    readonly prose: string;
}

/**
 * Parses an extension page: an optional \`\`\`yaml fence (a bare `permissions:`-shaped block,
 * or one wrapped in a top-level `permissions:` key — both accepted) plus surrounding prose,
 * which becomes the appended "Team-specific additions" text (brief §3.1: additive only).
 */
export function parseExtensionPage(markdown: string): PersonaExtension {
    const fenceMatch = YAML_FENCE.exec(markdown);
    if (!fenceMatch) {
        return { permissions: emptyGrants(), prose: markdown.trim() };
    }
    // Same tolerance as `parsePersonasOverridePage`: this is live, human-edited Confluence
    // content. A YAML typo degrades to "no additional grants, whole page as prose" rather
    // than throwing and taking down the merge for a persona that otherwise parses fine.
    let parsed: unknown;
    try {
        parsed = loadYaml(fenceMatch[1]!);
    } catch {
        return { permissions: emptyGrants(), prose: markdown.trim() };
    }
    const prose = (markdown.slice(0, fenceMatch.index) + markdown.slice(fenceMatch.index + fenceMatch[0].length)).trim();
    const permsRaw = isRecord(parsed) && isRecord(parsed.permissions) ? parsed.permissions : parsed;
    const built = buildPermissions(permsRaw);
    return {
        permissions: {
            propose: built.propose,
            create: built.create,
            workOn: built.workOn,
            complete: built.complete,
            update: built.update,
            approve: built.approve,
            gitHost: built.gitHost,
        },
        prose,
    };
}

function emptyGrants(): PersonaExtension["permissions"] {
    return { propose: [], create: [], workOn: [], complete: [], update: [], approve: [], gitHost: [] };
}

// ---------- The 3-layer merge ----------

/**
 * Combines an already-resolved layer 1 (`base` — a parsed built-in file, or
 * `emptyPersonaShell` for a user-added persona), an optional layer 2 override, and an
 * optional layer 3 extension into the effective `PersonaConfig` (TAI-51 ADR decision 1).
 *
 * `cannotApprove`/`humanSignOffDefault` always come from `base`, regardless of what `override`
 * or `extension` carry — the hard-rule carve-out, enforced here rather than trusted to callers.
 */
export function mergePersonaConfig(
    base: PersonaConfig,
    override?: PersonaOverride,
    extension?: PersonaExtension
): PersonaConfig {
    const afterOverride: PersonaConfig = override
        ? {
              id: base.id,
              displayName: override.displayName ?? base.displayName,
              enabled: override.enabled ?? base.enabled,
              permissions: override.permissions
                  ? { ...override.permissions, cannotApprove: base.permissions.cannotApprove }
                  : base.permissions,
              checkpoints: override.checkpoints
                  ? { ...override.checkpoints, humanSignOffDefault: base.checkpoints.humanSignOffDefault }
                  : base.checkpoints,
              confluenceOutputs: override.confluenceOutputs ?? base.confluenceOutputs,
              prompt: base.prompt,
          }
        : base;

    if (!extension) return afterOverride;

    const prompt = extension.prose
        ? `${afterOverride.prompt}\n\n## Team-specific additions\n\n${extension.prose}`.trim()
        : afterOverride.prompt;

    return {
        ...afterOverride,
        permissions: {
            ...afterOverride.permissions,
            propose: unionTargets(afterOverride.permissions.propose, extension.permissions.propose),
            create: unionTargets(afterOverride.permissions.create, extension.permissions.create),
            workOn: unionTargets(afterOverride.permissions.workOn, extension.permissions.workOn),
            complete: unionTargets(afterOverride.permissions.complete, extension.permissions.complete),
            update: unionUpdateGrants(afterOverride.permissions.update, extension.permissions.update),
            approve: [...new Set([...afterOverride.permissions.approve, ...extension.permissions.approve])],
            gitHost: [...new Set([...afterOverride.permissions.gitHost, ...extension.permissions.gitHost])],
            // cannotApprove: untouched, carried via the spread above.
        },
        prompt,
    };
}

// ---------- The TAI CLI placeholder (TAI-465) ----------

/** TAI-487: the soft size target for a persona's run-time prompt (the body of `personas/<id>.md`).
 *  A test warns past it and never fails; the history that would push a prompt over belongs in
 *  `personas/rationale/<id>.md`, which is not loaded. */
export const PERSONA_PROMPT_SOFT_LIMIT_BYTES = 12 * 1024;

/** What a persona doc writes in place of the CLI invocation, e.g. `{{TAI_CLI}} issue get <KEY>`.
 *  A path such as `src/hosts/cli.ts` only exists in the TAI checkout, so a command written that
 *  way fails in every target project; `loadPersonaConfig` fills this in with `taiCliCommand()`. */
export const TAI_CLI_PLACEHOLDER = "{{TAI_CLI}}";

function shellQuote(value: string): string {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The command that runs THIS install's CLI from any working directory. `root` defaults to the
 *  checkout this module was loaded from. */
export function taiCliCommand(root: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")): string {
    return `npx --prefix ${shellQuote(root)} tsx ${shellQuote(path.join(root, "src/hosts/cli.ts"))}`;
}

/** TAI-477: the command a persona's own prompt is rendered with -- it names the persona, so every
 *  command copied from that prompt tells the CLI who is acting. */
export function personaCliCommand(personaId: string, root?: string): string {
    return `${taiCliCommand(root)} --as ${shellQuote(personaId)}`;
}

export function fillCliPlaceholder(text: string, command: string = taiCliCommand()): string {
    return text.replaceAll(TAI_CLI_PLACEHOLDER, command);
}

// ---------- Where the docs a persona cites are (TAI-488) ----------

/** The TAI checkout this module was loaded from. */
export function taiInstallRoot(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

const WORKFLOW_DOC_BY_STORY_TYPE: Record<StoryType, string> = {
    [StoryType.Kickoff]: "kickoff.md",
    [StoryType.Story]: "story.md",
    [StoryType.Bug]: "bug.md",
    [StoryType.Spike]: "spike.md",
};

export interface WorkflowDocRef {
    readonly label: string;
    /** Absolute, so it can be read from a target project's working directory. */
    readonly path: string;
}

/**
 * The workflow docs that apply to a ticket of `storyType` (a subtask passes its parent's type):
 * that type's own doc, then `dependencies.md`, which every type shares. `null` (an Epic, or a
 * ticket whose parent could not be read) gets `dependencies.md` alone.
 */
export function workflowDocsFor(storyType: StoryType | null, root: string = taiInstallRoot()): readonly WorkflowDocRef[] {
    const dir = path.join(root, "src/workflows");
    const own = storyType ? [{ label: `The ${storyType} workflow`, path: path.join(dir, WORKFLOW_DOC_BY_STORY_TYPE[storyType]) }] : [];
    return [...own, { label: "Subtask precedence and creation rules", path: path.join(dir, "dependencies.md") }];
}

/**
 * Persona docs cite other docs by a short relative path (`workflows/story.md`). Those resolve only
 * inside the TAI checkout, so every loaded prompt ends with where they are. Read on demand; nothing
 * is inlined.
 */
export function docLocationsNote(root: string = taiInstallRoot()): string {
    const src = path.join(root, "src");
    return [
        "## Where the docs cited above are",
        "",
        "The paths above are relative to TAI's install, not to this project. Read a doc when you need it:",
        "",
        `- \`workflows/<name>.md\` and \`personas/<id>.md\` are under \`${src}\`.`,
        `- \`schema/…\` and other code paths are under \`${path.join(src, "core")}\`.`,
        `- The brief is \`${path.join(root, "PROJECT_BRIEF.md")}\`.`,
    ].join("\n");
}

// ---------- I/O: loading built-ins from disk ----------

/** Default location of the bundled `.md` files, resolved relative to this module. Callers
 *  (tests, and eventually TAI-8's host integration) may override `dir` — resolving this
 *  correctly for a `dist/` build is a known follow-up, not solved by this Story. */
export function defaultPersonasDir(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../../personas");
}

/** Reads and parses every built-in `.md` file into a `Map<id, PersonaConfig>` (layer 1 only,
 *  no override/extension applied). */
export async function loadBuiltinPersonaConfigs(dir: string = defaultPersonasDir()): Promise<Map<string, PersonaConfig>> {
    const entries = await readdir(dir);
    const configs = new Map<string, PersonaConfig>();
    for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const raw = await readFile(path.join(dir, entry), "utf8");
        // A non-persona `.md` file (a README, a template, an editor backup) sitting in this
        // directory shouldn't take down every OTHER persona's load — same "skip, don't crash"
        // tolerance as the Confluence-content parsers above, just applied to disk contents
        // instead (Gemini CLI review, PR #7).
        try {
            const config = parseBuiltinPersonaFile(raw);
            configs.set(config.id, config);
        } catch (err) {
            console.warn(
                `Skipping "${entry}" in ${dir}: not a valid persona file (${err instanceof Error ? err.message : err})`
            );
        }
    }
    return configs;
}

// ---------- I/O: full 3-layer resolution via DocStore ----------

export const PERSONAS_PAGE_TITLE = "Personas";

export interface LoadPersonaConfigOptions {
    readonly spaceKey: string;
    readonly personasDir?: string;
    readonly overridePageTitle?: string;
}

/** Resolves one persona's effective `PersonaConfig` through all 3 layers, fetching layers 2/3
 *  through `DocStore` (brief §3.6-cacheable at a higher level — this function does one fetch
 *  per call, same as `loadRoster`'s uncached read). */
export async function loadPersonaConfig(
    docStore: DocStore,
    personaId: string,
    opts: LoadPersonaConfigOptions
): Promise<PersonaConfig> {
    const builtins = await loadBuiltinPersonaConfigs(opts.personasDir);
    const overridesPage = await docStore.getPage({
        spaceKey: opts.spaceKey,
        title: opts.overridePageTitle ?? PERSONAS_PAGE_TITLE,
    } satisfies PageRef);
    const overrides = overridesPage ? parsePersonasOverridePage(overridesPage.content) : new Map();
    const override = overrides.get(personaId);

    let base = builtins.get(personaId) ?? emptyPersonaShell(personaId, override?.displayName ?? personaId);
    // A user-added persona (no bundled `.md`) supplies its prompt via `promptPageTitle`
    // instead — meaningless for a built-in override row, since the built-in file already has
    // one (PersonaOverride's own doc comment). Without this fetch, a user-added persona's
    // prompt silently stayed "" forever (Gemini CLI review, PR #7, a real bug this Story
    // shipped: the field was parsed but never consumed).
    if (!builtins.has(personaId) && override?.promptPageTitle) {
        const promptPage = await docStore.getPage({
            spaceKey: opts.spaceKey,
            title: override.promptPageTitle,
        } satisfies PageRef);
        if (promptPage) base = { ...base, prompt: promptPage.content };
    }

    let extension: PersonaExtension | undefined;
    const extensionPage = await docStore.getPage({ spaceKey: opts.spaceKey, title: personaId } satisfies PageRef);
    if (extensionPage) extension = parseExtensionPage(extensionPage.content);

    const merged = mergePersonaConfig(base, override, extension);
    const prompt = fillCliPlaceholder(merged.prompt, personaCliCommand(merged.id));
    return { ...merged, prompt: prompt === "" ? prompt : `${prompt}\n\n${docLocationsNote()}` };
}

// ---------- The acting persona (TAI-477) ----------

/**
 * Checks that `personaId` (the CLI's `--as`) names a persona this project has: a built-in, or a
 * user-added one listed on the `Personas` page. Self-declared, not proof of anything -- it exists
 * so an action can be attributed and checked against that persona's grants, and so a typo fails
 * loudly instead of attributing work to a persona that does not exist.
 *
 * A built-in id is accepted from the bundled files alone, with no Confluence read, so naming a
 * persona costs an ordinary command nothing. Whether that built-in is DISABLED for this project
 * is not checked here: a caller that needs the persona's grants loads its full config anyway.
 */
export async function resolveActingPersonaId(docStore: DocStore, personaId: string, opts: LoadPersonaConfigOptions): Promise<string> {
    const builtins = await loadBuiltinPersonaConfigs(opts.personasDir);
    if (builtins.has(personaId)) return personaId;
    const overridesPage = await docStore.getPage({
        spaceKey: opts.spaceKey,
        title: opts.overridePageTitle ?? PERSONAS_PAGE_TITLE,
    } satisfies PageRef);
    const overrides = overridesPage ? parsePersonasOverridePage(overridesPage.content) : new Map<string, PersonaOverride>();
    if (overrides.has(personaId)) return personaId;
    const known = [...new Set([...builtins.keys(), ...overrides.keys()])].sort().join(", ");
    throw new Error(`Unknown persona "${personaId}" given to --as. Known personas: ${known}.`);
}
