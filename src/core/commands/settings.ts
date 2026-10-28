/**
 * TAI Framework — `tai-settings`: show and change the project's settings (TAI-627, ADR page 64782337).
 *
 * Reads and writes the `Settings` page through the DocStore. The guard on autonomy settings lives here,
 * in one place: a change is refused unless a human on the `Autonomy admins` list makes it, and never
 * from an acting persona (`--as`) or an AI session.
 */

import type { DocStore, Page } from "../storage/interface.js";
import { CONFIG_FOLDER_TITLE } from "../storage/doc-folders.js";
import {
    EMPTY_SETTINGS,
    mergeSettingsPage,
    SETTINGS_PAGE_TITLE,
    findSetting,
    parseSettingValue,
    parseSettingsPage,
    viewSettings,
    withAdmins,
    withValue,
    type SettingsState,
} from "../settings/settings.js";

export interface SettingsContext {
    readonly docStore: DocStore;
    readonly spaceKey: string;
    /** The human running the command, from the session's configured email; null when none is configured. */
    readonly email: string | null;
    /** The persona this command says it is acting as (`--as`); a persona is never the human. */
    readonly actingPersona?: string;
    /** True inside an AI session (Claude Code or Gemini CLI set a marker in the environment). */
    readonly aiSession: boolean;
    /** Records on this machine that the human set an autonomy setting (TAI-634); the unattended run asks for it as well as the page. */
    readonly attest?: (email: string, key: string, value: string) => Promise<void>;
}

/** Claude Code and Gemini CLI mark the shells they start. A marker is a guard against an AI session
 *  raising its own autonomy by accident, not a defence against one that sets out to evade it. */
export function inAiSession(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(env["CLAUDECODE"] || env["CLAUDE_CODE_ENTRYPOINT"] || env["GEMINI_CLI"]);
}

interface Loaded {
    readonly state: SettingsState;
    readonly unknown: readonly string[];
    readonly page: Page | null;
}

async function load(ctx: SettingsContext): Promise<Loaded> {
    const page = await ctx.docStore.getPage({ spaceKey: ctx.spaceKey, title: SETTINGS_PAGE_TITLE });
    if (!page) return { state: EMPTY_SETTINGS, unknown: [], page: null };
    return { ...parseSettingsPage(page.content), page };
}

async function save(ctx: SettingsContext, loaded: Loaded, state: SettingsState): Promise<void> {
    const content = mergeSettingsPage(loaded.page?.content ?? null, state);
    if (loaded.page) {
        await ctx.docStore.updatePage({ id: loaded.page.id }, { content });
        return;
    }
    const config = (await ctx.docStore.getPage({ spaceKey: ctx.spaceKey, title: CONFIG_FOLDER_TITLE })) ??
        (await ctx.docStore.createPage({
            spaceKey: ctx.spaceKey,
            title: CONFIG_FOLDER_TITLE,
            content: "Folder for the project's configuration pages (brief §4).",
        }));
    await ctx.docStore.createPage({ spaceKey: ctx.spaceKey, title: SETTINGS_PAGE_TITLE, content, parentId: config.id });
}

function requireEmail(ctx: SettingsContext): string {
    if (!ctx.email) {
        throw new Error("No user is configured for this session (set TAI_JIRA_EMAIL, or TAI_HUMAN_EMAIL on the filesystem backend), so there is no one to keep settings for.");
    }
    return ctx.email.toLowerCase();
}

/**
 * Why `ctx` may not make an autonomy change, or null when it may. `admins` is the page's list. `what` and `how` word the refusal
 * for the change being made: the setting itself, or turning DEV-YOLO on for one run (TAI-693).
 */
function autonomyRefusal(
    ctx: SettingsContext,
    admins: readonly string[],
    what = "an autonomy setting cannot be changed",
    how = "Run `tai-settings` yourself in a plain terminal."
): string | null {
    if (ctx.actingPersona) {
        return `Refused: ${what} while acting as a persona (--as ${ctx.actingPersona}). Run it yourself, as the human.`;
    }
    if (ctx.aiSession) {
        return `Refused: ${what} from an AI session. ${how}`;
    }
    if (!ctx.email) return "Refused: no user is configured for this session, so TAI cannot tell who is asking.";
    if (admins.length === 0) {
        return "Refused: the Autonomy admins list is empty. Add yourself first, in a plain terminal: `tai-settings admins add <your email>`.";
    }
    if (!admins.includes(ctx.email.toLowerCase())) {
        return `Refused: ${ctx.email} is not on the Autonomy admins list (${admins.join(", ")}).`;
    }
    return null;
}

/** The attestation key for one run with DEV-YOLO on, apart from the `dev-yolo` setting's own (TAI-693). An audit record: nothing requires it. */
export const DEV_YOLO_ONCE = "dev-yolo-once";

/**
 * `do-dev-tasks yolo=true` (TAI-693): turning DEV-YOLO on for one run passes the checks the setting does (a person on the Autonomy
 * admins list, in a plain terminal, not acting as a persona), and when `record` is set leaves an attestation that says it was for
 * one run. It reads the settings page and never writes it. Throws the refusal, naming the check that failed.
 */
export async function allowYoloForOneRun(ctx: SettingsContext, record: boolean): Promise<void> {
    const { state } = await load(ctx);
    const refusal = autonomyRefusal(ctx, state.admins, "DEV-YOLO cannot be turned on for a run", "Run `tai-do-dev-tasks yolo=true` yourself in a plain terminal.");
    if (refusal) throw new Error(refusal);
    if (record) await ctx.attest?.(requireEmail(ctx), DEV_YOLO_ONCE, "true");
}

export async function showSettings(ctx: SettingsContext): Promise<string> {
    const { state, unknown, page } = await load(ctx);
    const email = ctx.email ?? "";
    // TAI-704: plain text for a terminal (no markdown marks): one setting per block, the name column aligned.
    const lines = [`Settings for ${ctx.email ?? "(no user configured)"}`, ""];
    if (!page) lines.push(`No "${SETTINGS_PAGE_TITLE}" page yet: showing the defaults. The first change creates it.`, "");
    if (!ctx.email) lines.push("No user is configured, so these are the defaults.", "");
    const views = viewSettings(state, email);
    const width = Math.max(...views.map((v) => v.def.key.length));
    for (const v of views) {
        lines.push(
            `  ${v.def.key.padEnd(width)}  ${v.value}${v.isDefault ? " (default)" : ` (default ${v.def.default})`}` +
                `${v.def.autonomy ? "  [autonomy: admins only]" : ""}`,
            `  ${" ".repeat(width)}  ${v.def.meaning}`,
            ""
        );
    }
    lines.push(`Autonomy admins: ${state.admins.length ? state.admins.join(", ") : "none yet"}`, "", "Change one: tai-settings set <KEY> <VALUE>");
    if (unknown.length) lines.push("", `Ignored on the page (not a known setting or not a valid value): ${unknown.join(", ")}. They are left as written; edit the page to fix or remove them.`);
    return lines.join("\n");
}

export async function setSetting(ctx: SettingsContext, key: string, rawValue: string): Promise<string> {
    const def = findSetting(key);
    if (!def) throw new Error(`Unknown setting "${key}". Known settings: ${viewSettings(EMPTY_SETTINGS, "").map((v) => v.def.key).join(", ")}.`);
    const value = parseSettingValue(def, rawValue);
    const loaded = await load(ctx);
    if (def.autonomy) {
        const refusal = autonomyRefusal(ctx, loaded.state.admins);
        if (refusal) throw new Error(refusal);
    } else if (ctx.actingPersona) {
        throw new Error(`Refused: settings belong to the human and cannot be changed while acting as a persona (--as ${ctx.actingPersona}).`);
    }
    const email = requireEmail(ctx);
    const before = viewSettings(loaded.state, email).find((v) => v.def.key === def.key)!.value;
    // Recorded only once the page holds the value, and also when it already did, so a person re-running the command can supply a missing record.
    if (before === value) {
        if (def.autonomy) await ctx.attest?.(email, def.key, value);
        return `# No change\n\n${def.key} is already ${value} for ${email}.`;
    }
    await save(ctx, loaded, withValue(loaded.state, email, def.key, value));
    if (def.autonomy) await ctx.attest?.(email, def.key, value);
    return `# Setting changed\n\n${def.key} for ${email}: ${before} -> ${value}.`;
}

export async function changeAdmin(ctx: SettingsContext, action: string, target: string): Promise<string> {
    if (action !== "add" && action !== "remove") throw new Error(`Usage: settings admins add|remove <EMAIL> (got "${action}").`);
    const who = target.trim().toLowerCase();
    if (!/^\S+@\S+$/.test(who)) throw new Error(`"${target}" is not an email address.`);
    const loaded = await load(ctx);
    const { admins } = loaded.state;
    if (ctx.actingPersona) throw new Error(`Refused: the Autonomy admins list cannot be changed while acting as a persona (--as ${ctx.actingPersona}).`);
    if (ctx.aiSession) throw new Error("Refused: the Autonomy admins list cannot be changed from an AI session. Run `tai-settings` yourself in a plain terminal.");
    const email = requireEmail(ctx);
    if (admins.length === 0) {
        // Seeding: with no admin yet, a human may name only themselves.
        if (action !== "add" || who !== email) {
            throw new Error(`Refused: the Autonomy admins list is empty, so the first entry must be yourself: \`tai-settings admins add ${email}\`.`);
        }
    } else if (!admins.includes(email)) {
        throw new Error(`Refused: ${email} is not on the Autonomy admins list (${admins.join(", ")}).`);
    }
    if (action === "add") {
        if (admins.includes(who)) return `# No change\n\n${who} is already an Autonomy admin.`;
        await save(ctx, loaded, withAdmins(loaded.state, [...admins, who]));
        return `# Autonomy admin added\n\n${who} may now change autonomy settings.`;
    }
    if (!admins.includes(who)) return `# No change\n\n${who} is not an Autonomy admin.`;
    if (admins.length === 1) throw new Error("Refused: that would leave the Autonomy admins list empty. Add another admin first.");
    await save(ctx, loaded, withAdmins(loaded.state, admins.filter((a) => a !== who)));
    return `# Autonomy admin removed\n\n${who} may no longer change autonomy settings.`;
}

/** One setting's value for `email` (its default when none is set), read from the Settings page; defaults when there is no page. */
export async function readSettingValue(docStore: DocStore, spaceKey: string, email: string | null, key: string): Promise<string> {
    const page = await docStore.getPage({ spaceKey, title: SETTINGS_PAGE_TITLE });
    const state = page ? parseSettingsPage(page.content).state : EMPTY_SETTINGS;
    const view = viewSettings(state, email ?? "").find((v) => v.def.key === key);
    if (!view) throw new Error(`Unknown setting "${key}".`);
    return view.value;
}
