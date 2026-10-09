import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { renderPersonaTurn } from "../persona/turn.js";
import {
    PROJECT_CONTEXT_BUDGET,
    PROJECT_CONTEXT_FILE,
    PROJECT_CONTEXT_TEMPLATE_MARKER,
    projectContextBudgetFromEnv,
    projectContextPath,
    projectContextStatus,
    projectContextTemplate,
    readProjectContext,
    renderProjectContext,
    renderProjectContextStatus,
    writeProjectContextTemplate,
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

describe("the starter template and its status (TAI-516)", () => {
    it("a project is missing, template or present", async () => {
        await withProject(async (root) => {
            const file = path.join(root, PROJECT_CONTEXT_FILE);
            assert.deepEqual(await projectContextStatus(root, {}), { state: "missing", path: file });

            assert.deepEqual(await writeProjectContextTemplate(root, {}), { written: true, path: file });
            assert.equal((await projectContextStatus(root, {})).state, "template");

            await writeFile(file, "# Rules\n\nRun `make test`.\n");
            assert.equal((await projectContextStatus(root, {})).state, "present");
        });
    });

    it("an unfilled template is not printed to personas", async () => {
        await withProject(async (root) => {
            await writeProjectContextTemplate(root, {});
            assert.equal(await readProjectContext(root, {}), null);
        });
    });

    it("the template has the four sections and starts with the marker line", () => {
        const template = projectContextTemplate();
        assert.ok(template.startsWith(`${PROJECT_CONTEXT_TEMPLATE_MARKER}\n`));
        for (const heading of ["## Stack", "## Commands", "## Conventions", "## Never"]) assert.ok(template.includes(heading), heading);
    });

    it("never overwrites a file that is already there", async () => {
        await withProject(async (root) => {
            const file = path.join(root, PROJECT_CONTEXT_FILE);
            await writeFile(file, "Ours.");
            assert.deepEqual(await writeProjectContextTemplate(root, {}), { written: false, path: file });
            assert.equal((await readProjectContext(root, {}))?.content, "Ours.");
        });
    });

    it("writes to the path TAI_PROJECT_CONTEXT_FILE names", async () => {
        await withProject(async (root) => {
            await mkdir(path.join(root, "docs"));
            const result = await writeProjectContextTemplate(root, { TAI_PROJECT_CONTEXT_FILE: "docs/rules.md" });
            assert.deepEqual(result, { written: true, path: path.join(root, "docs/rules.md") });
        });
    });

    it("the status line says what to do next in each state", () => {
        const at = "/repo/project-context.md";
        assert.match(renderProjectContextStatus({ state: "present", path: at }, "tai init"), /^- \[x\] project-context\.md/);
        assert.match(renderProjectContextStatus({ state: "template", path: at }, "tai init"), /still the unfilled template .* delete its first line/);
        assert.match(renderProjectContextStatus({ state: "missing", path: at }, "tai init"), /none yet\. Optional: `tai init project-context`/);
    });
});
