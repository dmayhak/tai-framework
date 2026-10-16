import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ALWAYS_HUMAN_GATED_SUBTASKS, StoryType, SubtaskType } from "../schema/story-schema.js";
import type { AttachmentRef, Comment, CreatePageInput, DocStore, Page, PagePatch, PageRef, IssueKey } from "../storage/interface.js";
import {
    PERSONA_PROMPT_SOFT_LIMIT_BYTES,
    docLocationsNote,
    emptyPersonaShell,
    workflowDocsFor,
    loadBuiltinPersonaConfigs,
    loadPersonaConfig,
    mergePersonaConfig,
    parseBuiltinPersonaFile,
    parseExtensionPage,
    parsePermissionTarget,
    parsePersonasOverridePage,
    fillCliPlaceholder,
    personaCliCommand,
    resolveActingPersonaId,
    taiCliCommand,
    TAI_CLI_PLACEHOLDER,
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
        assert.deepEqual(config.permissions.cannotApprove, ["own-output"]);
        assert.deepEqual(config.checkpoints, { extra: {} });
        assert.deepEqual(config.confluenceOutputs, ["implementation-notes"]);
        assert.match(config.prompt, /Dario is the team's Developer\./);
    });

    it("throws when there's no front-matter block", () => {
        assert.throws(() => parseBuiltinPersonaFile("# just a heading, no front-matter"));
    });

    it("throws when the front-matter has no id", () => {
        assert.throws(() => parseBuiltinPersonaFile("---\ndisplayName: X\n---\nbody"));
    });

    it("loads an older persona file that still carries the retired humanSignOffDefault and alwaysHumanGated keys, and the keys have no effect (TAI-531)", () => {
        const old = parseBuiltinPersonaFile(
            "---\nid: x\ncheckpoints:\n  humanSignOffDefault: false\n  alwaysHumanGated:\n    - Subtask:UAT\n---\nbody"
        );
        const bare = parseBuiltinPersonaFile("---\nid: x\n---\nbody");
        assert.deepEqual(old.permissions, bare.permissions);
        assert.deepEqual(old.confluenceOutputs, bare.confluenceOutputs);
        assert.deepEqual(mergePersonaConfig(old).permissions.cannotApprove, bare.permissions.cannotApprove);
    });

    it("an override page row that still carries the retired key loads, and cannotApprove is still taken from the base (TAI-531)", () => {
        const page = "### developer\n\n```yaml\ncheckpoints:\n  humanSignOffDefault: false\npermissions:\n  cannotApprove: []\n```";
        const overrides = parsePersonasOverridePage(page);
        const merged = mergePersonaConfig(parseBuiltinPersonaFile(FIXTURE_MD), overrides.get("developer"));
        assert.deepEqual(merged.permissions.cannotApprove, ["own-output"]);
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

    // TAI-487: two files per persona. `personas/<id>.md` is the run-time prompt and states the rules as
    // current fact; `personas/rationale/<id>.md` holds the history and is never loaded.
    it("every persona has a rationale file, and the loader does not read it", async () => {
        const { access } = await import("node:fs/promises");
        const configs = await loadBuiltinPersonaConfigs();
        for (const id of configs.keys()) {
            await access(path.resolve(import.meta.dirname, "../../personas/rationale", `${id}.md`));
        }
        assert.equal(configs.size, 9);
    });

    it("no run-time prompt carries history: revision or ticket references belong in the rationale file", async () => {
        const configs = await loadBuiltinPersonaConfigs();
        for (const [id, config] of configs) {
            const found = [...new Set(config.prompt.match(/\brev \d+|\bTAI-\d+/g) ?? [])];
            assert.deepEqual(found, [], `${id}'s prompt cites ${found.join(", ")}; move the history to personas/rationale/${id}.md`);
        }
    });

    // TAI-520: the brief states what is true now; its history is in CHANGELOG.md.
    it("the brief's body cites no revision: only its Last-updated pointer names one", async () => {
        const { readFile } = await import("node:fs/promises");
        const brief = await readFile(path.resolve(import.meta.dirname, "../../../PROJECT_BRIEF.md"), "utf8");
        const body = brief.slice(brief.indexOf("\n## 1. "));
        assert.ok(body.length > 1000, "could not find the brief's first section");
        const found = [...new Set(body.match(/\brevs? \d+/g) ?? [])];
        assert.deepEqual(found, [], `PROJECT_BRIEF.md cites ${found.join(", ")}; write the rule as current fact and put the history in CHANGELOG.md`);
    });

    it("warns, without failing, when a run-time prompt is over the soft size target", async (t) => {
        const configs = await loadBuiltinPersonaConfigs();
        for (const [id, config] of configs) {
            const bytes = Buffer.byteLength(config.prompt, "utf8");
            if (bytes > PERSONA_PROMPT_SOFT_LIMIT_BYTES) {
                t.diagnostic(`WARNING: ${id}'s run-time prompt is ${(bytes / 1024).toFixed(1)} KB, over the ${PERSONA_PROMPT_SOFT_LIMIT_BYTES / 1024} KB soft target`);
            }
        }
    });

    it("Analyst carries a propose grant distinct from create (Epic/Story propose, not create)", async () => {
        const configs = await loadBuiltinPersonaConfigs();
        const analyst = configs.get("analyst")!;
        assert.ok(analyst.permissions.propose.some((t) => t.kind === "issue" && t.issueType === "epic"));
        // TAI-374/387: Ada now holds `create` for Epic ONLY (Backlog shells during EpicReview). She still
        // never creates a Story, Bug, Spike or Kickoff -- Perry does, in grooming.
        const analystCreatedIssues = analyst.permissions.create.filter((t) => t.kind === "issue");
        assert.deepEqual(analystCreatedIssues.map((t) => (t.kind === "issue" ? t.issueType : null)), ["epic"]);
    });

    it("no persona holds a complete grant for a human-gated subtask: UAT, EpicReview, DesignReview (TAI-458)", async () => {
        const configs = await loadBuiltinPersonaConfigs();
        for (const [id, config] of configs) {
            const granted = config.permissions.complete.flatMap((t) => (t.kind === "subtask" ? [t.subtaskType] : []));
            for (const type of ALWAYS_HUMAN_GATED_SUBTASKS) {
                assert.ok(!granted.includes(type), `${id} must not be able to complete ${type}: a human closes it`);
            }
        }
    });

    it("every persona doc carries the human-gated unblock rule (TAI-395, ADR decision 11)", async () => {
        const configs = await loadBuiltinPersonaConfigs();
        for (const [id, config] of configs) {
            assert.match(config.prompt, /Unblocks human-gated work/, `${id} should carry the unblock rule`);
            assert.match(config.prompt, /DesignReview, EpicReview or UAT/, `${id} should name the human-gated types`);
        }
    });

    it("Perry's doc carries the retrospective behavior: the five signals, the briefing-first rule, the action items, the TAI lessons (TAI-491)", async () => {
        const pm = (await loadBuiltinPersonaConfigs()).get("pm")!;
        assert.match(pm.prompt, /\/tai-retro/);
        assert.match(pm.prompt, /tickets\s+cancelled, Bugs raised, tiers sent back/);
        assert.match(pm.prompt, /stale approvals/i);
        assert.match(pm.prompt, /pasted verbatim from the `# Retro briefing` heading/);
        assert.match(pm.prompt, /Ask the human a few questions/);
        assert.match(pm.prompt, /File each action item as a Backlog ticket/);
        assert.match(pm.prompt, /`tai-lesson`/);
        assert.match(pm.prompt, /never cancel, reopen or reassign a ticket because it appears there/i);
    });

    it("Perry's doc carries the course-correction behavior: the briefing, the batch groups, the authority split, the specialists (TAI-492)", async () => {
        const pm = (await loadBuiltinPersonaConfigs()).get("pm")!;
        assert.match(pm.prompt, /\/tai-change/);
        assert.match(pm.prompt, /pasted verbatim from the `# Change briefing` heading down to, but not including, the\s+`---` line/);
        assert.match(pm.prompt, /titles and page\s+ids only/);
        assert.match(pm.prompt, /Tickets to cancel/);
        assert.match(pm.prompt, /Pages to revise/);
        assert.match(pm.prompt, /`Investigate` subtask for Ada/);
        assert.match(pm.prompt, /`ArchitectureDesign` subtask for Aria/);
        assert.match(pm.prompt, /Perry creates Backlog tickets and links on her own/);
        assert.match(pm.prompt, /applies \*\*only after the human confirms\*\*/);
        assert.match(pm.prompt, /ask what changed before proposing/);
    });

    it("Perry's and Dario's docs describe the light lane, its two-sentence convention and that review still applies (TAI-473)", async () => {
        const configs = await loadBuiltinPersonaConfigs();
        const pm = configs.get("pm")!;
        assert.match(pm.prompt, /issue create-small/);
        assert.match(pm.prompt, /two sentences/);
        assert.match(pm.prompt, /`AC-1` line/);
        assert.match(pm.prompt, /review and the merge gate apply as\s+usual/);
        const dev = configs.get("developer")!;
        assert.match(dev.prompt, /issue create-small/);
        assert.match(dev.prompt, /two sentences/);
        assert.match(dev.prompt, /review and the merge gate/);
    });

    it("Perry's doc carries the grooming behavior: the briefing sections, the authority split, the reconciliation (TAI-395)", async () => {
        const pm = (await loadBuiltinPersonaConfigs()).get("pm")!;
        assert.match(pm.prompt, /\/tai-groom/);
        assert.match(pm.prompt, /Backlog tickets, depends-on links and phase labels/);
        assert.match(pm.prompt, /proposes? .* as a batch/is);
        assert.match(pm.prompt, /only after the human confirms/i);
        assert.match(pm.prompt, /work-breakdown/i);
        assert.match(pm.prompt, /document\s+wins/i);
        assert.match(pm.prompt, /never retypes, cancels or deletes/i);
        // TAI-423: briefing shown in chat first, no question in the same turn
        assert.match(pm.prompt, /Show the briefing first/i);
        assert.match(pm.prompt, /verbatim/i);
        assert.match(pm.prompt, /put no question in the same turn/i);
    });

    it("Perry may create Kickoff and every live subtask type (TAI-394 review, human-decided 2026-10-05)", async () => {
        const pm = (await loadBuiltinPersonaConfigs()).get("pm")!;
        const issues = pm.permissions.create.filter((t) => t.kind === "issue").map((t) => (t.kind === "issue" ? t.issueType : null));
        for (const type of ["epic", StoryType.Kickoff, StoryType.Story, StoryType.Bug, StoryType.Spike] as const) {
            assert.ok(issues.includes(type), `create ${type}`);
        }
        const subtasks = new Set(pm.permissions.create.flatMap((t) => (t.kind === "subtask" ? [t.subtaskType] : [])));
        for (const type of Object.values(SubtaskType)) {
            if (type === SubtaskType.CodeReview) continue; // retired in rev 52: reviewing is a PR action, not a ticket
            assert.ok(subtasks.has(type), `create Subtask:${type}`);
        }
        assert.ok(!subtasks.has(SubtaskType.CodeReview), "the retired CodeReview subtask is not granted");
    });

    it("gitHost grants land on exactly the personas TAI-34's checkpoint chain names, nowhere else", async () => {
        const configs = await loadBuiltinPersonaConfigs();
        assert.deepEqual(
            [...configs.get("developer")!.permissions.gitHost].sort(),
            ["createPullRequest", "mergePullRequest"]
        );
        assert.deepEqual([...configs.get("code-reviewer")!.permissions.gitHost], ["reviewPullRequest"]);
        // TAI-478: DevOps holds none. Whoever owns the Dev subtask merges; Deploy ships what is merged.
        assert.deepEqual([...configs.get("devops")!.permissions.gitHost], []);
        // Tester (2026-08-20): the canonical Dev->CodeReview->Merge/Deploy chain never gave
        // Test-tier subtasks (IntegrationTest/SystemTest/E2ETest, all outside that chain) any
        // way to land their own code — granted createPullRequest only, NOT mergePullRequest
        // (no self-merge for Tester; still goes through CodeReview like everyone else).
        assert.deepEqual([...configs.get("tester")!.permissions.gitHost], ["createPullRequest"]);
        // PM/Architect (TAI-112, mergePullRequest added TAI-293): framework-governance
        // content (persona docs, PROJECT_BRIEF.md itself) is real repo content they're the
        // natural owners of — both grants, same reasoning as Developer's self-merge
        // (merging already-Cole-approved work isn't self-certification).
        assert.deepEqual([...configs.get("pm")!.permissions.gitHost].sort(), ["createPullRequest", "mergePullRequest"]);
        assert.deepEqual(
            [...configs.get("architect")!.permissions.gitHost].sort(),
            ["createPullRequest", "mergePullRequest"]
        );
        for (const id of ["analyst", "dba", "ux-designer"]) {
            assert.deepEqual(configs.get(id)!.permissions.gitHost, [], `${id} should have no gitHost grants`);
        }
    });

    it("Perry can complete what her doc has her close, and not an Epic (TAI-478)", async () => {
        const pm = (await loadBuiltinPersonaConfigs()).get("pm")!;
        const completes = pm.permissions.complete.map((t) => (t.kind === "issue" ? t.issueType : t.subtaskType));
        assert.deepEqual([...completes].sort(), [StoryType.Bug, StoryType.Kickoff, SubtaskType.Requirements, StoryType.Spike, StoryType.Story].sort());
        assert.ok(!completes.includes("epic"), "closing an Epic is the human's decision");
    });

    it("no persona file carries update grants any more (TAI-478)", async () => {
        const { readFile, readdir } = await import("node:fs/promises");
        const dir = path.resolve(import.meta.dirname, "../../personas");
        for (const file of (await readdir(dir)).filter((f) => f.endsWith(".md"))) {
            const frontMatter = (await readFile(path.join(dir, file), "utf8")).split("\n---\n")[0]!;
            assert.doesNotMatch(frontMatter, /^ {2}update:/m, `${file} still has an update grant block`);
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
                approve: [],
                gitHost: [],
                cannotApprove: [], // an override attempting to loosen the hard rule
            },
        });
        // The override's own create grant DID apply...
        assert.deepEqual(merged.permissions.create, [{ kind: "subtask", subtaskType: SubtaskType.Database }]);
        // ...but cannotApprove was NOT loosened — carried from base.
        assert.deepEqual(merged.permissions.cannotApprove, ["own-output"]);
    });

    it("an extension unions grants additively and never removes a base grant", () => {
        const merged = mergePersonaConfig(base, undefined, {
            permissions: {
                propose: [],
                create: [{ kind: "subtask", subtaskType: SubtaskType.Database }],
                workOn: [],
                complete: [],
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
        assert.match(merged.prompt, /Dario is the team's Developer\./);
        assert.match(merged.prompt, /## Team-specific additions/);
        assert.match(merged.prompt, /Team-specific note\./);
    });

    it("an extension cannot loosen cannotApprove (no field to even carry it)", () => {
        const merged = mergePersonaConfig(base, undefined, {
            permissions: { propose: [], create: [], workOn: [], complete: [], approve: [], gitHost: [] },
            prose: "",
        });
        assert.deepEqual(merged.permissions.cannotApprove, ["own-output"]);
    });

    it("a user-added persona (emptyPersonaShell base) still gets the safe hard-rule defaults", () => {
        const shell = emptyPersonaShell("release-manager", "Remy");
        assert.deepEqual(shell.permissions.cannotApprove, ["own-output"]);
        const merged = mergePersonaConfig(shell, {
            id: "release-manager",
            displayName: "Remy",
            permissions: {
                propose: [],
                create: [{ kind: "subtask", subtaskType: SubtaskType.Deploy }],
                workOn: [{ kind: "subtask", subtaskType: SubtaskType.Deploy }],
                complete: [{ kind: "subtask", subtaskType: SubtaskType.Deploy }],
                approve: [],
                gitHost: [],
                cannotApprove: [], // still can't loosen it via the override row
            },
        });
        assert.deepEqual(merged.permissions.cannotApprove, ["own-output"]);
        assert.deepEqual(merged.permissions.create, [{ kind: "subtask", subtaskType: SubtaskType.Deploy }]);
    });
});

describe("TAI CLI placeholder (TAI-465)", () => {
    it("fillCliPlaceholder replaces every occurrence with the given command", () => {
        const text = `Run \`${TAI_CLI_PLACEHOLDER} issue get X\`, then \`${TAI_CLI_PLACEHOLDER} ready\`.`;
        assert.equal(fillCliPlaceholder(text, "tai"), "Run `tai issue get X`, then `tai ready`.");
    });

    it("taiCliCommand names this install's own cli.ts by absolute path, not a path relative to the working directory", () => {
        const command = taiCliCommand();
        const match = /^npx --prefix (\S+) tsx (\S+)$/.exec(command);
        assert.ok(match, command);
        assert.ok(path.isAbsolute(match[1]!), command);
        assert.equal(match[2], path.join(match[1]!, "src/hosts/cli.ts"));
    });

    it("taiCliCommand quotes an install path that contains a space", () => {
        assert.equal(
            taiCliCommand("/opt/my tools/tai"),
            "npx --prefix '/opt/my tools/tai' tsx '/opt/my tools/tai/src/hosts/cli.ts'"
        );
    });

    it("loadPersonaConfig returns a prompt with the placeholder filled in, extension prose included", async () => {
        const docStore = new FakeDocStore();
        docStore.seed("TA", "developer", `Team rule: run \`${TAI_CLI_PLACEHOLDER} ready\` first.`);
        const config = await loadPersonaConfig(docStore, "developer", { spaceKey: "TA" });
        assert.ok(!config.prompt.includes(TAI_CLI_PLACEHOLDER));
        // TAI-477: the filled-in command also names the persona it was rendered for.
        assert.ok(config.prompt.includes(`${taiCliCommand()} --as developer git-pr create`));
        assert.ok(config.prompt.includes(`run \`${taiCliCommand()} --as developer ready\` first`));
    });

    // TAI-488: "see workflows/story.md" only resolves inside the TAI checkout.
    it("workflowDocsFor names the type's own workflow doc and dependencies.md, as absolute paths that exist", async () => {
        const { access } = await import("node:fs/promises");
        for (const type of Object.values(StoryType)) {
            const docs = workflowDocsFor(type);
            assert.deepEqual(docs.map((d) => path.basename(d.path)), [`${type}.md`, "dependencies.md"]);
            for (const doc of docs) {
                assert.ok(path.isAbsolute(doc.path), doc.path);
                await access(doc.path);
            }
        }
    });

    it("workflowDocsFor gives dependencies.md alone when the type is unknown (an Epic)", () => {
        assert.deepEqual(workflowDocsFor(null, "/opt/tai").map((d) => d.path), ["/opt/tai/src/workflows/dependencies.md"]);
    });

    it("every loaded persona prompt ends by saying where the docs it cites are", async () => {
        const config = await loadPersonaConfig(new FakeDocStore(), "tester", { spaceKey: "TA" });
        assert.ok(config.prompt.endsWith(docLocationsNote()));
        assert.match(docLocationsNote("/opt/tai"), /`workflows\/<name>\.md` and `personas\/<id>\.md` are under `\/opt\/tai\/src`/);
    });

    it("no persona or workflow doc carries a CLI command relative to the TAI checkout", async () => {
        const { readFile, readdir } = await import("node:fs/promises");
        const root = path.resolve(import.meta.dirname, "../..");
        for (const dir of ["personas", "workflows"]) {
            for (const entry of await readdir(path.join(root, dir))) {
                if (!entry.endsWith(".md")) continue;
                const text = await readFile(path.join(root, dir, entry), "utf8");
                assert.ok(!/npx\s+tsx\s+src\/hosts\/cli\.ts/.test(text), `${dir}/${entry} still has a relative CLI command`);
            }
        }
    });

    it("every built-in persona that names a CLI command does so through the placeholder", async () => {
        const builtins = await loadBuiltinPersonaConfigs();
        for (const [id, config] of builtins) {
            assert.ok(!config.prompt.includes("src/hosts/cli.ts"), `${id} names cli.ts directly`);
        }
        assert.ok(builtins.get("pm")!.prompt.includes(`${TAI_CLI_PLACEHOLDER} issue create`));
    });
});

describe("acting persona (TAI-477)", () => {
    it("personaCliCommand is the install's command plus --as <persona id>", () => {
        assert.equal(personaCliCommand("pm", "/opt/tai"), "npx --prefix /opt/tai tsx /opt/tai/src/hosts/cli.ts --as pm");
    });

    it("each persona's prompt carries its OWN id, not another persona's", async () => {
        const docStore = new FakeDocStore();
        for (const id of ["pm", "tester", "ux-designer"]) {
            const config = await loadPersonaConfig(docStore, id, { spaceKey: "TA" });
            const named = [...config.prompt.matchAll(/cli\.ts --as (\S+)/g)].map((m) => m[1]);
            assert.ok(named.length > 0, `${id} has no CLI command`);
            assert.deepEqual([...new Set(named)], [id]);
        }
    });

    it("no persona doc writes a CLI invocation with arguments outside the placeholder", async () => {
        const { readFile, readdir } = await import("node:fs/promises");
        const dir = path.resolve(import.meta.dirname, "../../personas");
        for (const entry of await readdir(dir)) {
            if (!entry.endsWith(".md")) continue;
            const body = (await readFile(path.join(dir, entry), "utf8")).split("---").slice(2).join("---");
            const bare = [...body.matchAll(/`((?:issue|page|git-pr|link-precedence|doc) [a-z-]+[^`]*)`/g)]
                .map((m) => m[1]!)
                .filter((command) => /[<=]/.test(command));
            assert.deepEqual(bare, [], `${entry}: write these as {{TAI_CLI}} <command> so they carry the acting persona`);
        }
    });

    it("resolveActingPersonaId accepts a built-in id without reading Confluence", async () => {
        const docStore = new FakeDocStore();
        docStore.getPage = async () => {
            throw new Error("must not be called for a built-in persona");
        };
        assert.equal(await resolveActingPersonaId(docStore, "developer", { spaceKey: "TA" }), "developer");
    });

    it("resolveActingPersonaId accepts a user-added persona listed on the Personas page", async () => {
        const docStore = new FakeDocStore();
        docStore.seed("TA", "Personas", "### release-manager\n\n```yaml\ndisplayName: Rae\n```\n");
        assert.equal(await resolveActingPersonaId(docStore, "release-manager", { spaceKey: "TA" }), "release-manager");
    });

    it("resolveActingPersonaId rejects an unknown id, naming the ones it knows", async () => {
        await assert.rejects(
            resolveActingPersonaId(new FakeDocStore(), "develper", { spaceKey: "TA" }),
            /Unknown persona "develper".*developer/s
        );
    });
});
