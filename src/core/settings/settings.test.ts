import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    SETTING_DEFINITIONS,
    findSetting,
    parseSettingValue,
    parseSettingsPage,
    renderSettingsPage,
    viewSettings,
    withAdmins,
    withValue,
    EMPTY_SETTINGS,
} from "./settings.js";

describe("parseSettingValue", () => {
    it("accepts and normalises each type", () => {
        assert.equal(parseSettingValue(findSetting("dev-yolo")!, "ON"), "true");
        assert.equal(parseSettingValue(findSetting("dev-yolo")!, " no "), "false");
        assert.equal(parseSettingValue(findSetting("review-rounds")!, "3"), "3");
        assert.equal(parseSettingValue(findSetting("reviewer")!, "Claude"), "claude");
    });

    it("refuses a value of the wrong type or out of range", () => {
        assert.throws(() => parseSettingValue(findSetting("dev-yolo")!, "maybe"), /true or false/);
        assert.throws(() => parseSettingValue(findSetting("review-rounds")!, "0"), /1 to 10/);
        assert.throws(() => parseSettingValue(findSetting("review-rounds")!, "2.5"), /whole number/);
        assert.throws(() => parseSettingValue(findSetting("reviewer")!, "gpt"), /one of claude/);
    });
});

describe("the Settings page", () => {
    it("round-trips values and admins", () => {
        let state = withValue(EMPTY_SETTINGS, "Del@Mayhak.com", "dev-yolo", "true");
        state = withAdmins(state, ["del@mayhak.com"]);
        const parsed = parseSettingsPage(renderSettingsPage(state));
        assert.deepEqual(parsed.unknown, []);
        assert.equal(parsed.state.values.get("del@mayhak.com")?.get("dev-yolo"), "true");
        assert.deepEqual(parsed.state.admins, ["del@mayhak.com"]);
    });

    it("keeps a hand-edited bad row out and reports it", () => {
        const md = "| User | Setting | Value |\n| --- | --- | --- |\n| a@b.co | dev-yolo | maybe |\n| a@b.co | nonsense | 1 |\n| a@b.co | review-rounds | 4 |";
        const { state, unknown } = parseSettingsPage(md);
        assert.deepEqual(unknown, ["dev-yolo=maybe", "nonsense"]);
        assert.equal(state.values.get("a@b.co")?.get("review-rounds"), "4");
        assert.equal(state.values.get("a@b.co")?.has("dev-yolo"), false);
    });

    it("reads admins written as plain emails or mailto links", () => {
        const { state } = parseSettingsPage("## Autonomy admins\n\n- a@b.co\n- [c@d.co](mailto:c@d.co)\n");
        assert.deepEqual(state.admins, ["a@b.co", "c@d.co"]);
    });
});

describe("viewSettings", () => {
    it("shows the default for a user with no value and marks a changed one", () => {
        const state = withValue(EMPTY_SETTINGS, "a@b.co", "review-rounds", "5");
        const views = viewSettings(state, "A@B.co");
        assert.equal(views.length, SETTING_DEFINITIONS.length);
        assert.equal(views.find((v) => v.def.key === "review-rounds")?.isDefault, false);
        assert.equal(views.find((v) => v.def.key === "dev-yolo")?.isDefault, true);
    });
});
