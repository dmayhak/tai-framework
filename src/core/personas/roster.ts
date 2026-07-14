/**
 * TAI Framework — Persona Roster reader (TAI-14)
 *
 * The Persona Roster (brief §5.6) is TAI's own storage-agnostic mapping of
 * `persona -> [authorized humans]`. It answers two questions downstream:
 *   - review-gate validation: does this `Approved:` commenter actually count as the PM?
 *   - the assignment-helper: who are the candidate humans for this ticket's persona?
 *
 * DELIBERATELY built ON TOP OF DocStore, not inside it. interface.ts is explicit that the
 * roster is an ordinary page (`getPage({spaceKey, title: "Persona Roster"})`), not a new
 * storage method — domain logic lives above the interface. Because it only touches DocStore,
 * it works against ANY backend (Jira/Confluence or filesystem) with no `kind` branching: on
 * the filesystem backend the same page is a local markdown file, and this reader neither
 * knows nor cares.
 *
 * The parse is a pure function (testable with no I/O); the loader adds fetch + cache.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Persona, PERSONA_ROLE_LABEL } from "../schema/story-schema.js";
import type { DocStore, HumanRef, PageRef } from "../storage/interface.js";
import { toHumanId } from "../storage/interface.js";

export const PERSONA_ROSTER_TITLE = "Persona Roster";

// Label -> Persona, from the single canonical source. Case-insensitive and space-normalised
// because this column is HUMAN-EDITED — "ux designer", "UX  Designer", "Code reviewer" must
// all resolve rather than silently dropping an authorized human.
const LABEL_TO_PERSONA: ReadonlyMap<string, Persona> = new Map(
    Object.entries(PERSONA_ROLE_LABEL).map(([persona, label]) => [normLabel(label), persona as Persona])
);

function normLabel(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A parsed roster. Immutable; a human may appear under MULTIPLE personas (normal for a solo
 * dev or a small team), so this is many-to-many in both directions.
 */
export class Roster {
    private constructor(private readonly byPersona: ReadonlyMap<Persona, readonly HumanRef[]>) {}

    static from(byPersona: Map<Persona, HumanRef[]>): Roster {
        return new Roster(byPersona);
    }

    /** Humans authorized to act as `persona`. Empty if the roster lists none. */
    humansFor(persona: Persona): readonly HumanRef[] {
        return this.byPersona.get(persona) ?? [];
    }

    /** Personas a given human is authorized for. Matches on id first, then email, then a
     *  case-insensitive display-name fallback — because a comment author (Jira accountId) and
     *  a roster entry (email/name) rarely share the same key. */
    personasFor(human: Pick<HumanRef, "id"> & Partial<HumanRef>): Persona[] {
        const out: Persona[] = [];
        for (const [persona, humans] of this.byPersona) {
            if (humans.some((h) => sameHuman(h, human))) out.push(persona);
        }
        return out;
    }

    /** Does `human` count as `persona`? The check review gates and assignment rely on. */
    isAuthorized(persona: Persona, human: Pick<HumanRef, "id"> & Partial<HumanRef>): boolean {
        return this.humansFor(persona).some((h) => sameHuman(h, human));
    }

    /** Personas that resolve to EXACTLY ONE human — the pre-assign-at-creation case (§5.5). */
    soleHumanFor(persona: Persona): HumanRef | null {
        const humans = this.humansFor(persona);
        return humans.length === 1 ? humans[0]! : null;
    }

    toJSON(): Record<string, HumanRef[]> {
        const obj: Record<string, HumanRef[]> = {};
        for (const [persona, humans] of this.byPersona) obj[persona] = [...humans];
        return obj;
    }

    static fromJSON(obj: Record<string, HumanRef[]>): Roster {
        const map = new Map<Persona, HumanRef[]>();
        for (const [persona, humans] of Object.entries(obj)) map.set(persona as Persona, humans);
        return new Roster(map);
    }
}

function sameHuman(a: HumanRef, b: Pick<HumanRef, "id"> & Partial<HumanRef>): boolean {
    if (b.id && a.id === b.id) return true;
    if (b.email && a.email && a.email.toLowerCase() === b.email.toLowerCase()) return true;
    if (b.displayName && a.displayName.toLowerCase() === b.displayName.toLowerCase()) return true;
    return false;
}

// ---------- parsing ----------

/**
 * Parse one human cell into HumanRef[]. The roster's authored form is
 * `del ([del@mayhak.com](mailto:del@mayhak.com))`, but humans won't be consistent, so accept:
 *   - a markdown mailto link, with or without a leading display name
 *   - a bare email
 *   - a bare name
 *   - several of the above separated by commas or semicolons
 *
 * HumanId is backend-scoped and opaque (interface.ts). The roster has no Jira accountId, so
 * the stable key we DO have — the email, else the name — becomes the id. Matching a real
 * comment author's accountId back to a roster entry is `sameHuman`'s job (by email/name),
 * not something we can do with an id the roster never contained.
 */
export function parseHumanCell(cell: string): HumanRef[] {
    const humans: HumanRef[] = [];
    for (const partRaw of cell.split(/[,;]/)) {
        const part = partRaw.trim();
        if (!part) continue;

        // Pull out an email if there is one (a proper email-shaped token, not "([del..."),
        // then take the display name from whatever text precedes the first markdown/paren
        // punctuation. The mailto: duplicate and the bracket noise are stripped, not parsed.
        const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(part)?.[0];
        if (email) {
            // The display name is the text before the email, with markdown/paren noise and
            // the email itself removed. When nothing meaningful is left (a bare email cell),
            // fall back to the email's local part.
            const before = part.slice(0, part.indexOf(email)).replace(/[[\]()]/g, "").trim();
            const name = before || email.split("@")[0]!;
            humans.push({ id: toHumanId(email.toLowerCase()), displayName: name, email });
            continue;
        }

        // No email — a bare name. Still a valid roster entry (a team may list names only).
        const name = part.replace(/[[\]()]/g, "").trim();
        if (name) humans.push({ id: toHumanId(name.toLowerCase()), displayName: name });
    }
    return humans;
}

/**
 * Parse the roster markdown into a Roster. Finds the first table whose header names a
 * "Persona" column and an authorized-humans column, then reads the rows. Tolerant of the
 * surrounding prose (the live page has three paragraphs above the table and one below).
 */
export function parseRoster(markdown: string): Roster {
    const lines = markdown.split("\n");
    const byPersona = new Map<Persona, HumanRef[]>();

    // Locate a header row like `| Persona | Authorized humans |` followed by a `| --- |` rule.
    let start = -1;
    for (let i = 0; i < lines.length - 1; i++) {
        const cells = tableCells(lines[i]!);
        const isRule = /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]!);
        if (cells && isRule && cells.some((c) => normLabel(c) === "persona")) {
            start = i;
            break;
        }
    }
    if (start === -1) {
        throw new Error(
            'Persona Roster has no recognisable table (expected a "| Persona | Authorized humans |" header). Refusing to return an empty roster, which would silently deny every review gate.'
        );
    }

    const header = tableCells(lines[start]!)!.map(normLabel);
    const personaCol = header.indexOf("persona");

    // Prefer a NAME-based match for the humans column ("authorized humans", "humans",
    // "assignees", ...) rather than assuming it's simply "the other column" — that
    // assumption silently breaks the moment the table gains a third column (found by the
    // conformance suite / code review, TAI-15): personaCol !== 0 would hardcode humansCol to
    // 0 regardless of how many other columns exist, reading the wrong cell with no error.
    let humansCol = header.findIndex((h, idx) => idx !== personaCol && /human|assignee/.test(h));
    if (humansCol === -1) {
        if (header.length === 2) {
            // Exactly two columns and neither matched by name (a team renamed it to
            // something this heuristic doesn't recognise) — "the other column" is still
            // unambiguous here, so this narrow fallback is safe.
            humansCol = personaCol === 0 ? 1 : 0;
        } else {
            throw new Error(
                `Persona Roster table has ${header.length} columns and none look like an authorized-humans column (expected one containing "human" or "assignee"). Refusing to guess which column to read — that could silently deny every review gate.`
            );
        }
    }

    for (let i = start + 2; i < lines.length; i++) {
        const cells = tableCells(lines[i]!);
        if (!cells) break; // table ended
        const label = cells[personaCol];
        const persona = label ? LABEL_TO_PERSONA.get(normLabel(label)) : undefined;
        if (!persona) continue; // unknown label (a typo, or a future role) — skip, don't crash
        const humans = parseHumanCell(cells[humansCol] ?? "");
        const existing = byPersona.get(persona) ?? [];
        byPersona.set(persona, [...existing, ...humans]);
    }

    return Roster.from(byPersona);
}

/** Split a `| a | b |` row into trimmed cells, or null if the line isn't a table row. */
function tableCells(line: string): string[] | null {
    if (!/^\s*\|.*\|\s*$/.test(line)) return null;
    return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

// ---------- loading + caching ----------

export interface LoadRosterOptions {
    /** Confluence space key (Jira backend) — separate from the project key, brief §4 rev 18. */
    readonly spaceKey: string;
    /** Project key — used only for the cache path, never to derive the space key. */
    readonly projectKey: string;
    /** Cache root; defaults to `.tai/cache`. Set to null to skip caching entirely. */
    readonly cacheRoot?: string | null;
    readonly title?: string;
}

function cachePath(cacheRoot: string, projectKey: string): string {
    return path.join(cacheRoot, projectKey, "personas", "roster.json");
}

/**
 * Fetch the roster page through DocStore, parse it, and (unless disabled) write it to
 * `.tai/cache/<project>/personas/roster.json` (brief §7). Works on any backend.
 */
export async function loadRoster(docStore: DocStore, opts: LoadRosterOptions): Promise<Roster> {
    const ref: PageRef = { spaceKey: opts.spaceKey, title: opts.title ?? PERSONA_ROSTER_TITLE };
    const page = await docStore.getPage(ref);
    if (!page) {
        throw new Error(
            `Persona Roster page "${opts.title ?? PERSONA_ROSTER_TITLE}" not found in space "${opts.spaceKey}". It is required — without it TAI cannot verify who may act as any persona (brief §5.6).`
        );
    }
    const roster = parseRoster(page.content);

    if (opts.cacheRoot !== null) {
        const root = opts.cacheRoot ?? path.join(".tai", "cache");
        const file = cachePath(root, opts.projectKey);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(roster.toJSON(), null, 2), "utf8");
    }
    return roster;
}

/** Read a previously-cached roster (brief §3.6 offline / degrade-to-cache). Null if absent. */
export async function loadCachedRoster(cacheRoot: string, projectKey: string): Promise<Roster | null> {
    try {
        const raw = await readFile(cachePath(cacheRoot, projectKey), "utf8");
        return Roster.fromJSON(JSON.parse(raw));
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
    }
}
