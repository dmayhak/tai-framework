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
    mergeSettingsPage,
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

describe("mergeSettingsPage", () => {
    const hand =
        "Our notes: change these with care.\n\n| User | Setting | Value |\n| --- | --- | --- |\n| a@b.co | dev-yolo | maybe |\n| a@b.co | future-setting | 1 |\n| a@b.co | review-rounds | 4 |\n\n## Autonomy admins\n\nOnly these may change autonomy.\n\n- a@b.co\n\n## Later notes\n\nKeep me.\n";

    it("changes one value and keeps unrecognised rows and prose", () => {
        const { state } = parseSettingsPage(hand);
        const merged = mergeSettingsPage(hand, withValue(state, "a@b.co", "review-rounds", "6"));
        assert.match(merged, /Our notes: change these with care\./);
        assert.match(merged, /\| a@b\.co \| dev-yolo \| maybe \|/);
        assert.match(merged, /\| a@b\.co \| future-setting \| 1 \|/);
        assert.match(merged, /Keep me\./);
        assert.equal((merged.match(/review-rounds/g) ?? []).length, 1);
        assert.match(merged, /\| a@b\.co \| review-rounds \| 6 \|/);
        assert.equal(parseSettingsPage(merged).state.values.get("a@b.co")?.get("review-rounds"), "6");
    });

    it("adds an admin inside its section, before the next heading, without repeating the others", () => {
        const { state } = parseSettingsPage(hand);
        const merged = mergeSettingsPage(hand, withAdmins(state, ["a@b.co", "c@d.co"]));
        assert.deepEqual(parseSettingsPage(merged).state.admins, ["a@b.co", "c@d.co"]);
        assert.ok(merged.indexOf("c@d.co") < merged.indexOf("## Later notes"));
    });

    it("builds the table and the admins section when the page has neither, and renders afresh with no page", () => {
        const state = withAdmins(withValue(EMPTY_SETTINGS, "a@b.co", "dev-yolo", "true"), ["a@b.co"]);
        const merged = mergeSettingsPage("Just prose.", state);
        assert.match(merged, /Just prose\./);
        const parsed = parseSettingsPage(merged).state;
        assert.equal(parsed.values.get("a@b.co")?.get("dev-yolo"), "true");
        assert.deepEqual(parsed.admins, ["a@b.co"]);
        assert.equal(mergeSettingsPage(null, state), renderSettingsPage(state));
    });

    it("writes into the settings table, not another table, and keeps an extra column on a row", () => {
        const page =
            "| Team | Lead |\n| --- | --- |\n| core | sam |\n\n| User | Setting | Value | Note |\n| --- | --- | --- | --- |\n| a@b.co | review-rounds | 4 | agreed 10/24 |\n";
        const { state } = parseSettingsPage(page);
        let merged = mergeSettingsPage(page, withValue(state, "a@b.co", "review-rounds", "5"));
        assert.match(merged, /\| a@b\.co \| review-rounds \| 5 \| agreed 10\/24 \|/);
        merged = mergeSettingsPage(merged, withValue(parseSettingsPage(merged).state, "c@d.co", "dev-yolo", "true"));
        assert.ok(merged.indexOf("| c@d.co | dev-yolo | true |") > merged.indexOf("| User | Setting | Value | Note |"));
        assert.match(merged, /\| core \| sam \|\n\n\| User/);
        assert.equal(parseSettingsPage(merged).state.values.get("c@d.co")?.get("dev-yolo"), "true");
    });

    it("does not read rows of another table as settings", () => {
        const { state, unknown } = parseSettingsPage("| Team | Lead |\n| --- | --- |\n| a@b.co | dev-yolo | true |\n");
        assert.equal(state.values.size, 0);
        assert.deepEqual(unknown, []);
    });

    it("rewrites every row for a user and setting, so the one that is read back is the one that was saved", () => {
        const page = "| User | Setting | Value |\n| --- | --- | --- |\n| a@b.co | dev-yolo | true |\n| a@b.co | dev-yolo | true |\n";
        const { state } = parseSettingsPage(page);
        const merged = mergeSettingsPage(page, withValue(state, "a@b.co", "dev-yolo", "false"));
        assert.equal(parseSettingsPage(merged).state.values.get("a@b.co")?.get("dev-yolo"), "false");
        assert.equal((merged.match(/dev-yolo/g) ?? []).length, 2);
    });
});
