import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderPersonaTurn } from "../persona/turn.js";
import {
    PROJECT_CONTEXT_BUDGET,
    PROJECT_CONTEXT_FILE,
    projectContextBudgetFromEnv,
    projectContextPath,
    readProjectContext,
    renderProjectContext,
} from "./project-context.js";

async function withProject(fn: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), "tai-project-context-"));
    try {
        await fn(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

describe("project context (TAI-470)", () => {
    it("reads project-context.md from the project root", async () => {
        await withProject(async (root) => {
            await writeFile(path.join(root, PROJECT_CONTEXT_FILE), "\n# Rules\n\nRun `make test`.\n");
            const context = await readProjectContext(root, {});
            assert.deepEqual(context, { path: path.join(root, PROJECT_CONTEXT_FILE), content: "# Rules\n\nRun `make test`." });
        });
    });

    it("is null when the file is missing or empty: a project without one gets no section", async () => {
        await withProject(async (root) => {
            assert.equal(await readProjectContext(root, {}), null);
            await writeFile(path.join(root, PROJECT_CONTEXT_FILE), "  \n");
            assert.equal(await readProjectContext(root, {}), null);
            assert.equal(renderProjectContext(null), undefined);
        });
    });

    it("TAI_PROJECT_CONTEXT_FILE names another file, relative to the project root or absolute", async () => {
        await withProject(async (root) => {
            await mkdir(path.join(root, "docs"));
            await writeFile(path.join(root, "docs/rules.md"), "Elsewhere.");
            assert.equal((await readProjectContext(root, { TAI_PROJECT_CONTEXT_FILE: "docs/rules.md" }))?.content, "Elsewhere.");
            assert.equal(projectContextPath(root, { TAI_PROJECT_CONTEXT_FILE: "/etc/rules.md" }), "/etc/rules.md");
            assert.equal(projectContextPath(root, { TAI_PROJECT_CONTEXT_FILE: "  " }), path.join(root, PROJECT_CONTEXT_FILE));
        });
    });

    it("TAI_PROJECT_CONTEXT_BUDGET sets the cap; anything unusable falls back to the default", () => {
        assert.equal(projectContextBudgetFromEnv({ TAI_PROJECT_CONTEXT_BUDGET: "900" }), 900);
        assert.equal(projectContextBudgetFromEnv({ TAI_PROJECT_CONTEXT_BUDGET: "-1" }), PROJECT_CONTEXT_BUDGET);
        assert.equal(projectContextBudgetFromEnv({ TAI_PROJECT_CONTEXT_BUDGET: "lots" }), PROJECT_CONTEXT_BUDGET);
        assert.equal(projectContextBudgetFromEnv({}), PROJECT_CONTEXT_BUDGET);
    });

    it("renders the file whole under the cap, naming where it came from", () => {
        const section = renderProjectContext({ path: "/repo/project-context.md", content: "Never push to main." })!;
        assert.match(section, /^## Project context\n/);
        assert.match(section, /from `\/repo\/project-context\.md`/);
        assert.ok(section.endsWith("Never push to main."));
        assert.doesNotMatch(section, /NOT SHOWN IN FULL/);
    });

    it("cuts at a line break past the cap and says how much is missing and where to read it", () => {
        const content = ["line one", "line two", "line three is long enough to cross the cap"].join("\n");
        const section = renderProjectContext({ path: "/repo/project-context.md", content }, 20)!;
        assert.ok(section.includes("line one\nline two\n"));
        assert.doesNotMatch(section, /line three/);
        const missing = content.length - "line one\nline two".length;
        assert.ok(section.endsWith(`**NOT SHOWN IN FULL — ${missing} more characters. Read the rest in \`/repo/project-context.md\`.**`));
    });

    it("sits between the persona's instructions and the body of a persona turn", () => {
        const persona = { displayName: "Dario", id: "developer", prompt: "PROMPT" };
        const withContext = renderPersonaTurn(persona, "BODY", "## Project context\n\nRULES");
        assert.ok(withContext.indexOf("PROMPT") < withContext.indexOf("---"));
        assert.ok(withContext.indexOf("---") < withContext.indexOf("RULES"));
        assert.ok(withContext.indexOf("RULES") < withContext.indexOf("BODY"));
        assert.equal(renderPersonaTurn(persona, "BODY", undefined), renderPersonaTurn(persona, "BODY"));
    });
});
