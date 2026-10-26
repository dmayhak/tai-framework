/**
 * TAI Framework — the project's `Settings` page (TAI-627, ADR page 64782337 decisions 6 and 7).
 *
 * Settings live on one typed Confluence page per project, read through the DocStore like the
 * `Personas` and `PR Reviewers` pages, so the same code works on both backends. Per-user values are
 * keyed by email. The page also carries the `Autonomy admins` list: the only humans who may change
 * an autonomy setting. This module is the pure part (definitions, parse, render, validate); the
 * command that reads and writes the page is `commands/settings.ts`.
 */

export const SETTINGS_PAGE_TITLE = "Settings";

export type SettingType = "boolean" | "integer" | "enum";

export interface SettingDefinition {
    /** Lower-case key as typed on the command line and written to the page, e.g. `dev-yolo`. */
    readonly key: string;
    readonly type: SettingType;
    readonly default: string;
    readonly meaning: string;
    /** An autonomy setting may be changed only by a human on the `Autonomy admins` list. */
    readonly autonomy: boolean;
    /** Allowed values for an `enum`. */
    readonly choices?: readonly string[];
    /** Inclusive bounds for an `integer`. */
    readonly min?: number;
    readonly max?: number;
}

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
    {
        key: "dev-yolo",
        type: "boolean",
        default: "false",
        autonomy: true,
        meaning: "Let a Dev ticket run unattended from build to merge, verify and close, when it passes every stop check.",
    },
    {
        key: "review-rounds",
        type: "integer",
        default: "4",
        autonomy: true,
        min: 1,
        max: 10,
        meaning: "The most review-and-fix rounds an unattended run makes before it stops for a person.",
    },
    {
        key: "reviewer",
        type: "enum",
        default: "claude",
        autonomy: true,
        choices: ["claude"],
        meaning: "Which model plays the automated reviewer for an unattended run.",
    },
];

export function findSetting(key: string): SettingDefinition | undefined {
    const wanted = key.trim().toLowerCase();
    return SETTING_DEFINITIONS.find((d) => d.key === wanted);
}

/** The normalised form of `raw` for `def`, or an error naming what is allowed. */
export function parseSettingValue(def: SettingDefinition, raw: string): string {
    const value = raw.trim().toLowerCase();
    if (def.type === "boolean") {
        if (["true", "on", "yes"].includes(value)) return "true";
        if (["false", "off", "no"].includes(value)) return "false";
        throw new Error(`"${raw}" is not a valid value for ${def.key}: expected true or false.`);
    }
    if (def.type === "integer") {
        const n = Number(value);
        const min = def.min ?? Number.MIN_SAFE_INTEGER;
        const max = def.max ?? Number.MAX_SAFE_INTEGER;
        if (!/^-?\d+$/.test(value) || n < min || n > max) {
            throw new Error(`"${raw}" is not a valid value for ${def.key}: expected a whole number from ${min} to ${max}.`);
        }
        return String(n);
    }
    if (!def.choices?.includes(value)) {
        throw new Error(`"${raw}" is not a valid value for ${def.key}: expected one of ${(def.choices ?? []).join(", ")}.`);
    }
    return value;
}

export interface SettingsState {
    /** Lower-cased email -> setting key -> value. */
    readonly values: ReadonlyMap<string, ReadonlyMap<string, string>>;
    /** Lower-cased emails of the humans who may change an autonomy setting. */
    readonly admins: readonly string[];
}

export const EMPTY_SETTINGS: SettingsState = { values: new Map(), admins: [] };

const ADMINS_HEADING = /^#{1,6}\s*autonomy admins\s*$/i;

/**
 * The email an `Autonomy admins` bullet names, or null when the bullet is something else (a link to a policy, a note).
 * A bare address, a link whose text is the address, and a named link to a `mailto:` address all count. Reading and
 * saving both use this, so a save rewrites exactly the bullets that reading counted as admins and no others.
 */
function adminEmailOf(line: string): string | null {
    const bullet = /^\s*[-*]\s+(.*?)\s*$/.exec(line)?.[1];
    if (!bullet) return null;
    const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(bullet);
    const candidate = link ? (link[1]!.includes("@") ? link[1]! : link[2]!.replace(/^mailto:/i, "")) : bullet;
    return /^\S+@\S+$/.test(candidate) ? candidate.toLowerCase() : null;
}

/** The settings table is the one whose header starts `User | Setting | Value`; extra columns after those are allowed. */
function isSettingsHeader(cells: readonly string[]): boolean {
    return /^user$/i.test(cells[0] ?? "") && /^setting$/i.test(cells[1] ?? "") && /^value$/i.test(cells[2] ?? "");
}

function tableRow(line: string): string[] | null {
    const t = line.trim();
    if (!t.startsWith("|") || !t.endsWith("|")) return null;
    return t.slice(1, -1).split("|").map((c) => c.trim());
}

/**
 * Parses the page: a `| User | Setting | Value |` table, and bullets under an `Autonomy admins`
 * heading. A row naming a setting this version does not know is kept out of the result and named in
 * `unknown`, so a hand edit with a typo is visible and never silently applied.
 */
export function parseSettingsPage(markdown: string): { readonly state: SettingsState; readonly unknown: readonly string[] } {
    const values = new Map<string, Map<string, string>>();
    const admins: string[] = [];
    const unknown: string[] = [];
    let inAdmins = false;
    let inTable = false;
    for (const line of markdown.split("\n")) {
        if (/^#{1,6}\s/.test(line)) {
            inAdmins = ADMINS_HEADING.test(line.trim());
            inTable = false;
        }
        if (inAdmins) {
            const found = adminEmailOf(line);
            if (found && !admins.includes(found)) admins.push(found);
            continue;
        }
        const cells = tableRow(line);
        if (!cells) {
            inTable = false;
            continue;
        }
        if (isSettingsHeader(cells)) {
            inTable = true;
            continue;
        }
        if (!inTable || /^[\s:-]+$/.test(cells.join("")) || cells.length < 3) continue;
        const [user, key, value] = cells as [string, string, string];
        const def = findSetting(key);
        if (!def) {
            unknown.push(key);
            continue;
        }
        const email = user.replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1").trim().toLowerCase();
        const own = values.get(email) ?? new Map<string, string>();
        try {
            own.set(def.key, parseSettingValue(def, value));
        } catch {
            unknown.push(`${key}=${value}`);
            continue;
        }
        values.set(email, own);
    }
    return { state: { values, admins }, unknown };
}

export function renderSettingsPage(state: SettingsState): string {
    const rows: string[] = [];
    for (const email of [...state.values.keys()].sort()) {
        for (const def of SETTING_DEFINITIONS) {
            const value = state.values.get(email)?.get(def.key);
            if (value !== undefined) rows.push(`| ${email} | ${def.key} | ${value} |`);
        }
    }
    return [
        "Settings for this project. Edit with the `tai-settings` command; a row that is not valid is not applied, and is left as written for you to fix.",
        "",
        "| User | Setting | Value |",
        "| --- | --- | --- |",
        ...rows,
        "",
        "## Autonomy admins",
        "",
        "Only the humans listed here may change an autonomy setting.",
        "",
        ...state.admins.map((a) => `- ${a}`),
        "",
    ].join("\n");
}

/**
 * The page text after a change: `existing` with only the rows and admin entries TAI understands
 * rewritten from `state`. A row it does not understand, an extra column on a row it does, other
 * tables and any prose the page carries are kept as they are, so a hand edit or a setting from a
 * newer TAI is never erased by a save (PR 17 review).
 */
export function mergeSettingsPage(existing: string | null, state: SettingsState): string {
    if (existing === null) return renderSettingsPage(state);
    const out: string[] = [];
    const written = new Set<string>();
    let inAdmins = false;
    let inTable = false;
    let tableEnd = -1; // index in `out` just after the settings table's last line
    let adminsStart = -1;
    for (const line of existing.split("\n")) {
        if (/^#{1,6}\s/.test(line)) {
            inAdmins = ADMINS_HEADING.test(line.trim());
            inTable = false;
            if (inAdmins) adminsStart = out.length + 1;
        } else if (inAdmins) {
            if (adminEmailOf(line) !== null) continue; // an admin entry: written again from `state` below
        } else {
            const cells = tableRow(line);
            if (!cells) inTable = false;
            else if (isSettingsHeader(cells)) inTable = true;
            else if (inTable && cells.length >= 3 && !/^[\s:-]+$/.test(cells.join(""))) {
                const def = findSetting(cells[1] ?? "");
                const email = (cells[0] ?? "").replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1").trim().toLowerCase();
                let valid = def !== undefined;
                if (def) {
                    try {
                        parseSettingValue(def, cells[2] ?? "");
                    } catch {
                        valid = false; // an invalid value stays on the page for the person to fix
                    }
                }
                const value = def ? state.values.get(email)?.get(def.key) : undefined;
                if (def && valid && value !== undefined) {
                    written.add(`${email}|${def.key}`);
                    out.push(`| ${[cells[0], def.key, value, ...cells.slice(3)].join(" | ")} |`);
                    tableEnd = out.length;
                    continue;
                }
            }
            if (inTable) tableEnd = out.length + 1;
        }
        out.push(line);
    }
    const rows: string[] = [];
    for (const email of [...state.values.keys()].sort()) {
        for (const def of SETTING_DEFINITIONS) {
            const value = state.values.get(email)?.get(def.key);
            if (value !== undefined && !written.has(`${email}|${def.key}`)) rows.push(`| ${email} | ${def.key} | ${value} |`);
        }
    }
    if (rows.length > 0) {
        if (tableEnd === -1) {
            out.unshift("| User | Setting | Value |", "| --- | --- | --- |", ...rows, "");
            if (adminsStart !== -1) adminsStart += rows.length + 3;
        } else {
            out.splice(tableEnd, 0, ...rows);
            if (tableEnd <= adminsStart) adminsStart += rows.length;
        }
    }
    const admins = state.admins.map((a) => `- ${a}`);
    if (adminsStart === -1) out.push("", "## Autonomy admins", "", ...admins);
    else {
        let end = out.length;
        for (let i = adminsStart; i < out.length; i++) {
            if (/^#{1,6}\s/.test(out[i]!)) {
                end = i;
                break;
            }
        }
        while (end > adminsStart && out[end - 1]!.trim() === "") end--;
        out.splice(end, 0, ...admins);
    }
    return out.join("\n");
}

export interface SettingView {
    readonly def: SettingDefinition;
    readonly value: string;
    readonly isDefault: boolean;
}

export function viewSettings(state: SettingsState, email: string): readonly SettingView[] {
    const own = state.values.get(email.toLowerCase());
    return SETTING_DEFINITIONS.map((def) => {
        const value = own?.get(def.key) ?? def.default;
        return { def, value, isDefault: value === def.default };
    });
}

export function withValue(state: SettingsState, email: string, key: string, value: string): SettingsState {
    const values = new Map([...state.values].map(([e, m]) => [e, new Map(m)] as const));
    const own = values.get(email.toLowerCase()) ?? new Map<string, string>();
    own.set(key, value);
    values.set(email.toLowerCase(), own);
    return { values, admins: state.admins };
}

export function withAdmins(state: SettingsState, admins: readonly string[]): SettingsState {
    return { values: state.values, admins };
}
