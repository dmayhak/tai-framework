import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StoryType, SubtaskType } from "../../schema/story-schema.js";
import { toPageId, type DocStore, type Page, type PageRef } from "../interface.js";
import { parseTypeAliasesPage, loadTypeAliasMap, TYPE_ALIASES_PAGE_TITLE } from "./type-alias-config.js";

const SPACE_KEY = "TA";

/** Minimal fake, same shape as work-tracker.test.ts's own — only getPage is exercised. */
function fakeDocStore(pages: Page[] = []): DocStore {
    const notImplemented = (): never => {
        throw new Error("not implemented in this test fake");
    };
    return {
        async getPage(ref: PageRef): Promise<Page | null> {
            if ("id" in ref) return pages.find((p) => p.id === ref.id) ?? null;
            return pages.find((p) => p.spaceKey === ref.spaceKey && p.title === ref.title) ?? null;
        },
        createPage: notImplemented,
        updatePage: notImplemented,
        addComment: notImplemented,
        editComment: notImplemented,
        getChildren: notImplemented,
        listRootPages: notImplemented,
        getLinkedIssues: notImplemented,
        listAttachments: notImplemented,
        getAttachment: notImplemented,
    };
}

function page(title: string, content: string): Page {
    return {
        id: toPageId(title),
        spaceKey: SPACE_KEY,
        title,
        content,
        createdAt: "x",
        updatedAt: "x",
        comments: [],
    };
}

describe("parseTypeAliasesPage", () => {
    it("parses a native-name -> IssueType mapping", () => {
        const map = parseTypeAliasesPage("```yaml\nSub-task: dev\nDefect: bug\n```\n");
        assert.equal(map.fromJira.get("Sub-task"), SubtaskType.Dev);
        assert.equal(map.fromJira.get("Defect"), StoryType.Bug);
        assert.equal(map.toJira.get(SubtaskType.Dev), "Sub-task");
        assert.equal(map.toJira.get(StoryType.Bug), "Defect");
    });

    it("returns an empty map when there's no yaml fence", () => {
        const map = parseTypeAliasesPage("Just prose, no fence.");
        assert.equal(map.fromJira.size, 0);
        assert.equal(map.toJira.size, 0);
    });

    it("degrades to an empty map on malformed YAML rather than throwing", () => {
        const map = parseTypeAliasesPage("```yaml\nSub-task: [this is not: valid: yaml\n```\n");
        assert.equal(map.fromJira.size, 0);
    });

    it("drops an entry whose value isn't a known IssueType, keeps the rest", () => {
        const map = parseTypeAliasesPage("```yaml\nSub-task: dev\nGarbage: not-a-real-type\n```\n");
        assert.equal(map.fromJira.get("Sub-task"), SubtaskType.Dev);
        assert.equal(map.fromJira.has("Garbage"), false);
    });

    it("degrades the WHOLE page to empty when the same native name is listed twice (js-yaml rejects duplicate keys as malformed, not last-wins)", () => {
        // Deviation from the ADR's assumption (TAI-178): js-yaml's `load()` throws on a
        // literal duplicate mapping key rather than silently keeping the last one, so this
        // hits the same "malformed YAML" catch as any other parse error -- still the safe
        // direction (an alias narrows, never fabricates), just page-wide for this one case
        // rather than per-entry. Two DIFFERENT native names aliased to the same IssueType
        // (the next test) is unaffected -- that's not a YAML key collision.
        const map = parseTypeAliasesPage("```yaml\nSub-task: dev\nSub-task: bug\n```\n");
        assert.equal(map.fromJira.size, 0);
    });

    it("resolves two native names aliased to the same IssueType to the last one for toJira", () => {
        const map = parseTypeAliasesPage("```yaml\nTask: dev\nSub-task: dev\n```\n");
        assert.equal(map.fromJira.get("Task"), SubtaskType.Dev);
        assert.equal(map.fromJira.get("Sub-task"), SubtaskType.Dev);
        assert.equal(map.toJira.get(SubtaskType.Dev), "Sub-task"); // last declaration wins
    });

    it("tolerates trailing whitespace after the yaml fence's language tag", () => {
        const map = parseTypeAliasesPage("```yaml \nSub-task: dev\n```\n");
        assert.equal(map.fromJira.get("Sub-task"), SubtaskType.Dev);
    });
});

describe("loadTypeAliasMap", () => {
    it("returns an empty map when the page doesn't exist (the common case)", async () => {
        const map = await loadTypeAliasMap(fakeDocStore([]), SPACE_KEY);
        assert.equal(map.fromJira.size, 0);
    });

    it("loads and parses the page when present", async () => {
        const docStore = fakeDocStore([page(TYPE_ALIASES_PAGE_TITLE, "```yaml\nSub-task: dev\n```\n")]);
        const map = await loadTypeAliasMap(docStore, SPACE_KEY);
        assert.equal(map.fromJira.get("Sub-task"), SubtaskType.Dev);
    });

    it("supports a custom page title", async () => {
        const docStore = fakeDocStore([page("Custom Aliases", "```yaml\nSub-task: dev\n```\n")]);
        const map = await loadTypeAliasMap(docStore, SPACE_KEY, "Custom Aliases");
        assert.equal(map.fromJira.get("Sub-task"), SubtaskType.Dev);
    });
});
