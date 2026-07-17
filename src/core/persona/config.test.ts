import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StoryType, SubtaskType } from "../schema/story-schema.js";
import {
    emptyPersonaShell,
    loadBuiltinPersonaConfigs,
    mergePersonaConfig,
    parseBuiltinPersonaFile,
    parseExtensionPage,
    parsePermissionTarget,
    parsePersonasOverridePage,
    parseUpdateGrant,
    type PersonaConfig,
} from "./config.js";

describe("parsePermissionTarget", () => {
    it("parses a Subtask: label into a subtask target", () => {
        assert.deepEqual(parsePermissionTarget("Subtask:Dev"), { kind: "subtask", subtaskType: SubtaskType.Dev });
    });

    it("normalises across PascalCase/dash differences (CodeReview, UAT, UxDesign)", () => {
        assert.deepEqual(parsePermissionTarget("Subtask:CodeReview"), {
            kind: "subtask",
            subtaskType: SubtaskType.CodeReview,
        });
        assert.deepEqual(parsePermissionTarget("Subtask:UAT"), { kind: "subtask", subtaskType: SubtaskType.Uat });
        assert.deepEqual(parsePermissionTarget("Subtask:UxDesign"), {
            kind: "subtask",
            subtaskType: SubtaskType.UxDesign,
        });
    });

    it("parses a bare story-level label", () => {
        assert.deepEqual(parsePermissionTarget("Story"), { kind: "issue", issueType: StoryType.Story });
        assert.deepEqual(parsePermissionTarget("Bug"), { kind: "issue", issueType: StoryType.Bug });
    });

    it("parses Epic as the 'epic' literal (no StoryType entry for it)", () => {
        assert.deepEqual(parsePermissionTarget("Epic"), { kind: "issue", issueType: "epic" });
    });

    it("returns null for an unrecognised label rather than throwing", () => {
        assert.equal(parsePermissionTarget("Subtask:NotARealType"), null);
        assert.equal(parsePermissionTarget("NotARealStoryType"), null);
    });
});

describe("parseUpdateGrant", () => {
    it("splits EntityType.field", () => {
        assert.deepEqual(parseUpdateGrant("Story.acceptanceCriteria"), {
            entityType: "Story",
            field: "acceptanceCriteria",
        });
    });

    it("returns null when there's no dot, or nothing on either side", () => {
        assert.equal(parseUpdateGrant("NoDotHere"), null);
        assert.equal(parseUpdateGrant(".field"), null);
        assert.equal(parseUpdateGrant("Entity."), null);
    });
});

const FIXTURE_MD = `---
id: developer
displayName: Dario
enabled: true
permissions:
  create:
    - Subtask:Dev
    - Subtask:SpikeTask
  workOn:
    - Subtask:Dev
  complete:
    - Subtask:Dev
  update:
    - Story.implementationNotes
  cannotApprove:
    - own-output
checkpoints:
  humanSignOffDefault: true
confluenceOutputs:
  - type: implementation-notes
---

# Dario — the Developer Persona

Dario is the team's Developer.
`;

describe("parseBuiltinPersonaFile", () => {
    it("parses front-matter into a typed PersonaConfig", () => {
        const config = parseBuiltinPersonaFile(FIXTURE_MD);
        assert.equal(config.id, "developer");
        assert.equal(config.displayName, "Dario");
        assert.equal(config.enabled, true);
        assert.deepEqual(config.permissions.create, [
            { kind: "subtask", subtaskType: SubtaskType.Dev },
            { kind: "subtask", subtaskType: SubtaskType.SpikeTask },
        ]);
        assert.deepEqual(config.permissions.update, [{ entityType: "Story", field: "implementationNotes" }]);
        assert.deepEqual(config.permissions.cannotApprove, ["own-output"]);
        assert.equal(config.checkpoints.humanSignOffDefault, true);
        assert.deepEqual(config.confluenceOutputs, ["implementation-notes"]);
        assert.match(config.prompt, /Dario is the team's Developer\./);
    });

    it("throws when there's no front-matter block", () => {
        assert.throws(() => parseBuiltinPersonaFile("# just a heading, no front-matter"));
    });

    it("throws when the front-matter has no id", () => {
        assert.throws(() => parseBuiltinPersonaFile("---\ndisplayName: X\n---\nbody"));
    });

    it("defaults humanSignOffDefault to true (the brief §3.4 default) when absent", () => {
        const config = parseBuiltinPersonaFile("---\nid: x\ncheckpoints: {}\n---\nbody");
        assert.equal(config.checkpoints.humanSignOffDefault, true);
    });
});

describe("loadBuiltinPersonaConfigs (real src/personas/*.md)", () => {
    it("parses every existing built-in file without error", async () => {
        const configs = await loadBuiltinPersonaConfigs();
        const ids = [...configs.keys()].sort();
        assert.deepEqual(ids, [
            "analyst",
            "architect",
            "code-reviewer",
            "dba",
            "developer",
            "devops",
            "pm",
            "tester",
            "ux-designer",
        ]);
        for (const config of configs.values()) {
            assert.ok(config.prompt.length > 0, `${config.id} should have prompt text`);
            assert.equal(config.enabled, true);
        }
    });

    it("Analyst carries a propose grant distinct from create (Epic/Story propose, not create)", async () => {
        const configs = await loadBuiltinPersonaConfigs();
        const analyst = configs.get("analyst")!;
        assert.ok(analyst.permissions.propose.some((t) => t.kind === "issue" && t.issueType === "epic"));
        assert.ok(!analyst.permissions.create.some((t) => t.kind === "issue"));
    });

    it("Tester's UAT is workOn-able but NOT complete-able (human stakeholder must sign off)", async () => {
        const configs = await loadBuiltinPersonaConfigs();
        const tester = configs.get("tester")!;
        const uat = { kind: "subtask" as const, subtaskType: SubtaskType.Uat };
        assert.ok(tester.permissions.workOn.some((t) => t.kind === "subtask" && t.subtaskType === SubtaskType.Uat));
        assert.ok(
            !tester.permissions.complete.some((t) => t.kind === "subtask" && t.subtaskType === SubtaskType.Uat),
            "UAT should be absent from complete"
        );
        void uat;
    });
});

describe("parsePersonasOverridePage", () => {
    it("parses a disable-only row", () => {
        const page = `
Some intro prose.

### tester

\`\`\`yaml
enabled: false
\`\`\`
`;
        const overrides = parsePersonasOverridePage(page);
        assert.deepEqual(overrides.get("tester")?.enabled, false);
        assert.equal(overrides.get("tester")?.permissions, undefined);
    });

    it("parses a full row for a user-added persona", () => {
        const page = `
### release-manager

\`\`\`yaml
displayName: Remy
promptPage: "Release Manager Persona"
permissions:
  create:
    - Subtask:Deploy
  workOn:
    - Subtask:Deploy
  complete:
    - Subtask:Deploy
  update: []
checkpoints:
  humanSignOffDefault: true
confluenceOutputs: []
\`\`\`
`;
        const overrides = parsePersonasOverridePage(page);
        const rm = overrides.get("release-manager");
        assert.equal(rm?.displayName, "Remy");
        assert.equal(rm?.promptPageTitle, "Release Manager Persona");
        assert.deepEqual(rm?.permissions?.create, [{ kind: "subtask", subtaskType: SubtaskType.Deploy }]);
    });

    it("skips a heading with no yaml fence rather than throwing", () => {
        const page = `### broken\nno fence here, just prose\n`;
        const overrides = parsePersonasOverridePage(page);
        assert.equal(overrides.size, 0);
    });

    it("skips a section with malformed YAML rather than throwing, and still parses the rest", () => {
        const page = `
### broken

\`\`\`yaml
enabled: [this is not: valid: yaml
\`\`\`

### tester

\`\`\`yaml
enabled: false
\`\`\`
`;
        const overrides = parsePersonasOverridePage(page);
        assert.equal(overrides.has("broken"), false);
        assert.equal(overrides.get("tester")?.enabled, false);
    });
});

describe("parseExtensionPage", () => {
    it("extracts additive permissions and prose separately", () => {
        const page = `
Some team-specific prose about how Dario should work here.

\`\`\`yaml
permissions:
  create:
    - Subtask:Database
\`\`\`

More prose after the fence.
`;
        const ext = parseExtensionPage(page);
        assert.deepEqual(ext.permissions.create, [{ kind: "subtask", subtaskType: SubtaskType.Database }]);
        assert.match(ext.prose, /team-specific prose/);
        assert.match(ext.prose, /More prose after the fence/);
        assert.doesNotMatch(ext.prose, /```/);
    });

    it("treats a page with no yaml fence as pure prose, no grants", () => {
        const ext = parseExtensionPage("Just some notes, no permissions block.");
        assert.deepEqual(ext.permissions.create, []);
        assert.match(ext.prose, /Just some notes/);
    });

    it("degrades to prose-only on malformed YAML rather than throwing", () => {
        const page = `
Some prose.

\`\`\`yaml
create: [this is not: valid: yaml
\`\`\`
`;
        const ext = parseExtensionPage(page);
        assert.deepEqual(ext.permissions.create, []);
        assert.match(ext.prose, /Some prose/);
    });
});

describe("mergePersonaConfig", () => {
    const base: PersonaConfig = parseBuiltinPersonaFile(FIXTURE_MD);

    it("returns the base unchanged when no override or extension is given", () => {
        assert.deepEqual(mergePersonaConfig(base), base);
    });

    it("applies a disable-only override without touching permissions", () => {
        const merged = mergePersonaConfig(base, { id: "developer", enabled: false });
        assert.equal(merged.enabled, false);
        assert.deepEqual(merged.permissions, base.permissions);
    });

    it("a full override row replaces permissions/checkpoints EXCEPT the hard-rule carve-out", () => {
        const merged = mergePersonaConfig(base, {
            id: "developer",
            permissions: {
                propose: [],
                create: [{ kind: "subtask", subtaskType: SubtaskType.Database }],
                workOn: [],
                complete: [],
                update: [],
                approve: [],
                cannotApprove: [], // an override attempting to loosen the hard rule
            },
            checkpoints: { humanSignOffDefault: false, extra: {} }, // attempting to loosen the other hard rule
        });
        // The override's own create grant DID apply...
        assert.deepEqual(merged.permissions.create, [{ kind: "subtask", subtaskType: SubtaskType.Database }]);
        // ...but cannotApprove and humanSignOffDefault were NOT loosened — carried from base.
        assert.deepEqual(merged.permissions.cannotApprove, ["own-output"]);
        assert.equal(merged.checkpoints.humanSignOffDefault, true);
    });

    it("an extension unions grants additively and never removes a base grant", () => {
        const merged = mergePersonaConfig(base, undefined, {
            permissions: {
                propose: [],
                create: [{ kind: "subtask", subtaskType: SubtaskType.Database }],
                workOn: [],
                complete: [],
                update: [{ entityType: "Story", field: "extraNotes" }],
                approve: [],
            },
            prose: "Team-specific note.",
        });
        // Base grants still present...
        assert.ok(merged.permissions.create.some((t) => t.kind === "subtask" && t.subtaskType === SubtaskType.Dev));
        // ...plus the extension's addition.
        assert.ok(
            merged.permissions.create.some((t) => t.kind === "subtask" && t.subtaskType === SubtaskType.Database)
        );
        assert.ok(merged.permissions.update.some((g) => g.field === "implementationNotes"));
        assert.ok(merged.permissions.update.some((g) => g.field === "extraNotes"));
        assert.match(merged.prompt, /Dario is the team's Developer\./);
        assert.match(merged.prompt, /## Team-specific additions/);
        assert.match(merged.prompt, /Team-specific note\./);
    });

    it("an extension cannot loosen cannotApprove or humanSignOffDefault (no field to even carry them)", () => {
        const merged = mergePersonaConfig(base, undefined, {
            permissions: { propose: [], create: [], workOn: [], complete: [], update: [], approve: [] },
            prose: "",
        });
        assert.deepEqual(merged.permissions.cannotApprove, ["own-output"]);
        assert.equal(merged.checkpoints.humanSignOffDefault, true);
    });

    it("a user-added persona (emptyPersonaShell base) still gets the safe hard-rule defaults", () => {
        const shell = emptyPersonaShell("release-manager", "Remy");
        assert.deepEqual(shell.permissions.cannotApprove, ["own-output"]);
        assert.equal(shell.checkpoints.humanSignOffDefault, true);
        const merged = mergePersonaConfig(shell, {
            id: "release-manager",
            displayName: "Remy",
            permissions: {
                propose: [],
                create: [{ kind: "subtask", subtaskType: SubtaskType.Deploy }],
                workOn: [{ kind: "subtask", subtaskType: SubtaskType.Deploy }],
                complete: [{ kind: "subtask", subtaskType: SubtaskType.Deploy }],
                update: [],
                approve: [],
                cannotApprove: [], // still can't loosen it via the override row
            },
        });
        assert.deepEqual(merged.permissions.cannotApprove, ["own-output"]);
        assert.deepEqual(merged.permissions.create, [{ kind: "subtask", subtaskType: SubtaskType.Deploy }]);
    });
});
