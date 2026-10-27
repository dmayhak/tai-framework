import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { toHumanId } from "../storage/interface.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { allowYoloForOneRun, changeAdmin, inAiSession, readSettingValue, setSetting, showSettings, type SettingsContext } from "./settings.js";

async function withStore(run: (make: (over?: Partial<SettingsContext>) => SettingsContext) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-settings-"));
    try {
        const backend = createFilesystemBackend(dir, { id: toHumanId("del"), displayName: "Del" });
        await run((over = {}) => ({ docStore: backend.docStore, spaceKey: "TAIT", email: "del@mayhak.com", aiSession: false, ...over }));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("tai-settings", () => {
    it("shows the defaults when there is no page yet", () =>
        withStore(async (make) => {
            const out = await showSettings(make());
            assert.match(out, /No "Settings" page yet/);
            assert.match(out, /\*\*dev-yolo\*\*: false \(default\)/);
            assert.match(out, /Autonomy admins: none yet/);
        }));

    it("refuses an autonomy change until the user is on the admins list, then allows it and says what changed", () =>
        withStore(async (make) => {
            await assert.rejects(setSetting(make(), "dev-yolo", "true"), /Autonomy admins list is empty/);
            await changeAdmin(make(), "add", "del@mayhak.com");
            const out = await setSetting(make(), "DEV-YOLO", "on");
            assert.match(out, /dev-yolo for del@mayhak.com: false -> true/);
            assert.match(await showSettings(make()), /\*\*dev-yolo\*\*: true \(default false\) \[autonomy\]/);
            assert.match(await setSetting(make(), "dev-yolo", "true"), /already true/);
        }));

    it("refuses a bad value and an unknown key without writing the page", () =>
        withStore(async (make) => {
            await changeAdmin(make(), "add", "del@mayhak.com");
            await assert.rejects(setSetting(make(), "review-rounds", "99"), /1 to 10/);
            await assert.rejects(setSetting(make(), "nope", "1"), /Unknown setting "nope"/);
            assert.match(await showSettings(make()), /review-rounds\*\*: 4 \(default\)/);
        }));

    it("refuses an autonomy change from an acting persona, an AI session, or a human not on the list", () =>
        withStore(async (make) => {
            await changeAdmin(make(), "add", "del@mayhak.com");
            await assert.rejects(setSetting(make({ actingPersona: "developer" }), "dev-yolo", "true"), /acting as a persona/);
            await assert.rejects(setSetting(make({ aiSession: true }), "dev-yolo", "true"), /AI session/);
            await assert.rejects(setSetting(make({ email: "sam@mayhak.com" }), "dev-yolo", "true"), /not on the Autonomy admins list/);
            assert.match(await showSettings(make()), /\*\*dev-yolo\*\*: false \(default\)/);
        }));

    it("seeds the admins list with the caller only, and only a listed admin can edit it", () =>
        withStore(async (make) => {
            await assert.rejects(changeAdmin(make(), "add", "sam@mayhak.com"), /first entry must be yourself/);
            await assert.rejects(changeAdmin(make({ aiSession: true }), "add", "del@mayhak.com"), /AI session/);
            await changeAdmin(make(), "add", "del@mayhak.com");
            await assert.rejects(changeAdmin(make({ email: "sam@mayhak.com" }), "add", "sam@mayhak.com"), /not on the Autonomy admins list/);
            await changeAdmin(make(), "add", "sam@mayhak.com");
            await changeAdmin(make(), "remove", "sam@mayhak.com");
            await assert.rejects(changeAdmin(make(), "remove", "del@mayhak.com"), /leave the Autonomy admins list empty/);
        }));

    it("detects an AI session from the markers Claude Code and Gemini CLI set", () => {
        assert.equal(inAiSession({}), false);
        assert.equal(inAiSession({ CLAUDECODE: "1" }), true);
        assert.equal(inAiSession({ GEMINI_CLI: "1" }), true);
    });
});

describe("readSettingValue", () => {
    it("gives the default with no page, the default for a user with no row, the set value, and refuses an unknown key", () =>
        withStore(async (make) => {
            const ctx = make();
            assert.equal(await readSettingValue(ctx.docStore, "TAIT", "del@mayhak.com", "dev-yolo"), "false");
            await changeAdmin(ctx, "add", "del@mayhak.com");
            await setSetting(ctx, "dev-yolo", "on");
            assert.equal(await readSettingValue(ctx.docStore, "TAIT", "DEL@mayhak.com", "dev-yolo"), "true");
            assert.equal(await readSettingValue(ctx.docStore, "TAIT", "other@mayhak.com", "dev-yolo"), "false", "another user has no row");
            assert.equal(await readSettingValue(ctx.docStore, "TAIT", null, "dev-yolo"), "false", "no user means the default");
            await assert.rejects(readSettingValue(ctx.docStore, "TAIT", "del@mayhak.com", "nonsense"), /Unknown setting/);
        }));
});

describe("DEV-YOLO for one run (TAI-693)", () => {
    it("is allowed for an admin in a plain terminal, leaves an attestation that says it was for one run, and does not write the setting", () =>
        withStore(async (make) => {
            await changeAdmin(make(), "add", "del@mayhak.com");
            const seen: string[] = [];
            await allowYoloForOneRun(make({ attest: async (e, k, v) => void seen.push(`${e} ${k} ${v}`) }), true);
            assert.deepEqual(seen, ["del@mayhak.com dev-yolo-once true"]);
            assert.match(await showSettings(make()), /\*\*dev-yolo\*\*: false \(default\)/);
        }));

    it("a check without record leaves no attestation (a dry run)", () =>
        withStore(async (make) => {
            await changeAdmin(make(), "add", "del@mayhak.com");
            const seen: string[] = [];
            await allowYoloForOneRun(make({ attest: async (e, k, v) => void seen.push(`${e} ${k} ${v}`) }), false);
            assert.deepEqual(seen, []);
        }));

    it("is refused from an acting persona, an AI session, a human not on the list, and an empty list, naming the check and leaving no record", () =>
        withStore(async (make) => {
            const seen: string[] = [];
            const attest = async (e: string, k: string, v: string): Promise<void> => void seen.push(`${e} ${k} ${v}`);
            await assert.rejects(allowYoloForOneRun(make({ attest }), true), /Autonomy admins list is empty/);
            await changeAdmin(make(), "add", "del@mayhak.com");
            await assert.rejects(allowYoloForOneRun(make({ actingPersona: "developer", attest }), true), /DEV-YOLO cannot be turned on for a run while acting as a persona/);
            await assert.rejects(allowYoloForOneRun(make({ aiSession: true, attest }), true), /DEV-YOLO cannot be turned on for a run from an AI session\. Run `tai-do-dev-tasks yolo=true` yourself/);
            await assert.rejects(allowYoloForOneRun(make({ email: "sam@mayhak.com", attest }), true), /not on the Autonomy admins list/);
            assert.deepEqual(seen, []);
            assert.match(await showSettings(make()), /\*\*dev-yolo\*\*: false \(default\)/);
        }));
});

