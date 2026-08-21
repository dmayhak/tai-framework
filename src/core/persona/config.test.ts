import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { StoryType, SubtaskType } from "../schema/story-schema.js";
import type { AttachmentRef, Comment, CreatePageInput, DocStore, Page, PagePatch, PageRef, IssueKey } from "../storage/interface.js";
import {
    emptyPersonaShell,
    loadBuiltinPersonaConfigs,
    loadPersonaConfig,
    mergePersonaConfig,
    parseBuiltinPersonaFile,
    parseExtensionPage,
    parsePermissionTarget,
    parsePersonasOverridePage,
    parseUpdateGrant,
    type PersonaConfig,
} from "./config.js";

/** A minimal in-memory DocStore fake — only getPage is exercised by loadPersonaConfig. */
class FakeDocStore implements DocStore {
    private pages = new Map<string, Page>();

    seed(spaceKey: string, title: string, content: string): void {
        this.pages.set(`${spaceKey}::${title}`, {
            id: `${spaceKey}::${title}` as Page["id"],
            spaceKey,
            title,
            content,
            createdAt: "x",
            updatedAt: "x",
            comments: [],
        });
    }

    async getPage(ref: PageRef): Promise<Page | null> {
        if ("id" in ref) return null;
        return this.pages.get(`${ref.spaceKey}::${ref.title}`) ?? null;
    }

    async createPage(_input: CreatePageInput): Promise<Page> {
        throw new Error("not used in these tests");
    }
    async updatePage(_ref: PageRef, _patch: PagePatch): Promise<Page> {
        throw new Error("not used in these tests");
    }
    async addComment(_ref: PageRef, _body: string): Promise<Comment> {
        throw new Error("not used in these tests");
    }
    async editComment(_ref: PageRef, _commentId: string, _body: string): Promise<Comment> {
        throw new Error("not used in these tests");
    }
    async getChildren(_ref: PageRef): Promise<readonly Page[]> {
        return [];
    }
    async getLinkedIssues(_ref: PageRef): Promise<readonly IssueKey[]> {
        return [];
    }
    async listAttachments(_ref: PageRef): Promise<readonly AttachmentRef[]> {
        return [];
    }
    async getAttachment(_ref: PageRef, _attachmentId: string): Promise<Buffer> {
        throw new Error("not used in these tests");
    }
}

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

    it("accepts confluenceOutputs written as a plain string list, not just {type: ...} objects", () => {
        // Every built-in file uses the object form, but a human editing a Confluence
        // override/extension page might naturally write a plain list (Gemini CLI review, PR #7).
        const config = parseBuiltinPersonaFile(
            "---\nid: x\nconfluenceOutputs:\n  - implementation-notes\n  - type: also-fine\n---\nbody"
        );
        assert.deepEqual(config.confluenceOutputs, ["implementation-notes", "also-fine"]);
    });
});

describe("loadBuiltinPersonaConfigs — tolerates a non-persona .md file in the directory", () => {
    it("skips a file with no valid front-matter rather than crashing the whole load", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-personas-"));
        try {
            await writeFile(path.join(dir, "developer.md"), FIXTURE_MD, "utf8");
            await writeFile(path.join(dir, "README.md"), "# Just some notes, no front-matter\n", "utf8");
            const configs = await loadBuiltinPersonaConfigs(dir);
            assert.deepEqual([...configs.keys()], ["developer"]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("loadPersonaConfig — full 3-layer resolution via DocStore", () => {
    it("fetches a user-added persona's prompt page via promptPageTitle (Gemini CLI review, PR #7 — previously parsed but never loaded)", async () => {
        const docStore = new FakeDocStore();
        docStore.seed(
            "TA",
            "Personas",
            [
                "### release-manager",
                "",
                "```yaml",
                "displayName: Remy",
                'promptPage: "Release Manager Persona"',
                "permissions:",
                "  create:",
                "    - Subtask:Deploy",
                "```",
                "",
            ].join("\n")
        );
        docStore.seed("TA", "Release Manager Persona", "Remy handles release coordination.");

        const config = await loadPersonaConfig(docStore, "release-manager", {
            spaceKey: "TA",
            personasDir: await mkdtemp(path.join(tmpdir(), "tai-personas-empty-")),
        });

        assert.equal(config.displayName, "Remy");
        assert.match(config.prompt, /Remy handles release coordination\./);
        assert.deepEqual(config.permissions.create, [{ kind: "subtask", subtaskType: SubtaskType.Deploy }]);
    });

    it("leaves a built-in's prompt alone even if (unusually) promptPageTitle is set on its override row", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "tai-personas-"));
        await writeFile(path.join(dir, "developer.md"), FIXTURE_MD, "utf8");

        const docStore = new FakeDocStore();
        docStore.seed(
            "TA",
            "Personas",
            ["### developer", "", "```yaml", 'promptPage: "Should Be Ignored"', "```", ""].join("\n")
        );
        docStore.seed("TA", "Should Be Ignored", "This must NOT end up as developer's prompt.");

        const config = await loadPersonaConfig(docStore, "developer", { spaceKey: "TA", personasDir: dir });
        assert.match(config.prompt, /Dario is the team's Developer\./);
        assert.doesNotMatch(config.prompt, /Should NOT end up/);
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

    it("gitHost grants land on exactly the personas TAI-34's checkpoint chain names, nowhere else", async () => {
        const configs = await loadBuiltinPersonaConfigs();
        assert.deepEqual(
            [...configs.get("developer")!.permissions.gitHost].sort(),
            ["createPullRequest", "mergePullRequest"]
        );
        assert.deepEqual([...configs.get("code-reviewer")!.permissions.gitHost], ["reviewPullRequest"]);
        assert.deepEqual([...configs.get("devops")!.permissions.gitHost], ["mergePullRequest"]);
        // Tester (2026-08-20): the canonical Dev->CodeReview->Merge/Deploy chain never gave
        // Test-tier subtasks (IntegrationTest/SystemTest/E2ETest, all outside that chain) any
        // way to land their own code — granted createPullRequest only, NOT mergePullRequest
        // (no self-merge for Tester; still goes through CodeReview like everyone else).
        assert.deepEqual([...configs.get("tester")!.permissions.gitHost], ["createPullRequest"]);
        // PM/Architect (TAI-112): framework-governance content (persona docs, PROJECT_BRIEF.md
        // itself) is real repo content they're the natural owners of — granted createPullRequest
        // only, NOT mergePullRequest (no self-merge for either, same asymmetry as Tester).
        assert.deepEqual([...configs.get("pm")!.permissions.gitHost], ["createPullRequest"]);
        assert.deepEqual([...configs.get("architect")!.permissions.gitHost], ["createPullRequest"]);
        for (const id of ["analyst", "dba", "ux-designer"]) {
            assert.deepEqual(configs.get(id)!.permissions.gitHost, [], `${id} should have no gitHost grants`);
        }
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

    it("does not let a multi-word prose subheading hijack the parser (Gemini CLI review, PR #7)", () => {
        // A "### How to run deployments"-style subheading a human adds inside their own
        // section must not be read as a second persona, and must not prematurely end the real
        // persona's section before its fence.
        const page = `
### developer

\`\`\`yaml
enabled: false
\`\`\`

### How to run deployments

More prose, not a real override — this is NOT identifier-shaped (it has spaces), so the
restricted heading regex never matches it at all.
`;
        const overrides = parsePersonasOverridePage(page);
        assert.equal(overrides.get("developer")?.enabled, false);
        assert.equal(overrides.has("How to run deployments"), false);
    });

    it("tolerates trailing whitespace after the yaml fence's language tag", () => {
        const page = "### tester\n\n```yaml \nenabled: false\n```\n";
        const overrides = parsePersonasOverridePage(page);
        assert.equal(overrides.get("tester")?.enabled, false);
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
                gitHost: [],
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
                gitHost: [],
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
            permissions: { propose: [], create: [], workOn: [], complete: [], update: [], approve: [], gitHost: [] },
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
                gitHost: [],
                cannotApprove: [], // still can't loosen it via the override row
            },
        });
        assert.deepEqual(merged.permissions.cannotApprove, ["own-output"]);
        assert.deepEqual(merged.permissions.create, [{ kind: "subtask", subtaskType: SubtaskType.Deploy }]);
    });
});
