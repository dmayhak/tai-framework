import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    INIT_STEPS,
    readInitState,
    markStepDone,
    isInitComplete,
    checkInitCompletion,
    renderEnvFile,
    mergeEnvContent,
    writeEnvFile,
    writeClaudeMdPointer,
    verifyJiraSetup,
    setupConfluence,
    verifyBitbucketSetup,
    type InitState,
} from "./target-init.js";
import { markdownToStorage } from "../storage/jira/storage-format.js";

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function notFound(): Response {
    return new Response("", { status: 404 });
}

/** Dispatches on exact "METHOD path" strings — every test below lists every call it expects,
 *  so an unhandled request is a loud test failure rather than a silent undefined. */
function stubFetch(routes: Record<string, () => Response>): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
        const route = routes[key];
        if (!route) throw new Error(`Unstubbed request: ${key}`);
        return route();
    }) as unknown as typeof fetch;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-target-init-"));
    try {
        await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("resumable state", () => {
    it("reads an empty state when no file exists yet", async () => {
        await withTempDir(async (dir) => {
            const state = await readInitState(path.join(dir, ".tai"));
            assert.deepEqual(state, { version: 1, steps: {} });
        });
    });

    it("markStepDone records completion and persists across reads", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "jira", "verified");
            const state = await readInitState(taiRoot);
            assert.ok(state.steps["jira"]);
            assert.equal(state.steps["jira"]?.detail, "verified");
        });
    });

    it("isInitComplete is true only once every step is recorded", async () => {
        const state: InitState = { version: 1, steps: {} };
        assert.equal(isInitComplete(state), false);
        const full: InitState = {
            version: 1,
            steps: Object.fromEntries(INIT_STEPS.map((s) => [s, { at: "now", detail: "x" }])) as InitState["steps"],
        };
        assert.equal(isInitComplete(full), true);
    });

    it("checkInitCompletion is silent when no state file exists (grandfather case)", async () => {
        await withTempDir(async (dir) => {
            const warning = await checkInitCompletion(path.join(dir, ".tai"));
            assert.equal(warning, null);
        });
    });

    it("checkInitCompletion warns, naming missing steps, when state exists but is incomplete", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "jira", "verified");
            const warning = await checkInitCompletion(taiRoot);
            assert.ok(warning?.includes("confluence"));
            assert.ok(warning?.includes("bitbucket"));
            assert.ok(warning?.includes("env"));
            assert.ok(warning?.includes("claude-md"));
            assert.ok(!warning?.includes("jira,"));
        });
    });

    it("checkInitCompletion is silent once every step is done", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            for (const step of INIT_STEPS) await markStepDone(taiRoot, step, "done");
            assert.equal(await checkInitCompletion(taiRoot), null);
        });
    });
});

describe("verifyJiraSetup", () => {
    it("reports missing issue types and a missing Persona field", async () => {
        const fetchImpl = stubFetch({
            "GET /rest/api/2/issue/createmeta?projectKeys=PROJ&expand=projects.issuetypes": () =>
                json({ projects: [{ issuetypes: [{ name: "Story" }, { name: "Bug" }] }] }),
            "GET /rest/api/2/field": () => json([{ id: "customfield_1", name: "Story Points", custom: true }]),
        });
        const result = await verifyJiraSetup({
            siteUrl: "https://example.atlassian.net",
            email: "a@b.c",
            apiToken: "tok",
            projectKey: "PROJ",
            fetchImpl,
        });
        assert.equal(result.ok, false);
        assert.equal(result.personaFieldFound, false);
        assert.ok(result.missingIssueTypes.includes("Dev"));
        assert.ok(result.missingIssueTypes.includes("CodeReview"));
        assert.ok(!result.missingIssueTypes.includes("Story"));
    });

    it("reports ok once every required issue type and the Persona field are present", async () => {
        const fetchImpl = stubFetch({
            "GET /rest/api/2/issue/createmeta?projectKeys=PROJ&expand=projects.issuetypes": () =>
                json({
                    projects: [
                        {
                            issuetypes: [
                                "Epic",
                                "Story",
                                "Bug",
                                "Kickoff",
                                "Spike",
                                "Research",
                                "EpicReview",
                                "Requirements",
                                "UxDesign",
                                "Investigate",
                                "Feasibility",
                                "ArchitectureDesign",
                                "DesignReview",
                                "Database",
                                "Infra",
                                "Dev",
                                "CodeReview",
                                "IntegrationTest",
                                "SystemTest",
                                "E2ETest",
                                "UAT",
                                "Triage",
                                "Deploy",
                                "PostDeploy",
                                "SpikeTask",
                            ].map((name) => ({ name })),
                        },
                    ],
                }),
            "GET /rest/api/2/field": () => json([{ id: "customfield_10105", name: "Persona", custom: true }]),
        });
        const result = await verifyJiraSetup({
            siteUrl: "https://example.atlassian.net",
            email: "a@b.c",
            apiToken: "tok",
            projectKey: "PROJ",
            fetchImpl,
        });
        assert.equal(result.ok, true);
        assert.deepEqual(result.missingIssueTypes, []);
        assert.equal(result.personaFieldFound, true);
    });

    it("reports the project itself as not found rather than throwing", async () => {
        const fetchImpl = stubFetch({
            "GET /rest/api/2/issue/createmeta?projectKeys=NOPE&expand=projects.issuetypes": () =>
                json({ projects: [] }),
        });
        const result = await verifyJiraSetup({
            siteUrl: "https://example.atlassian.net",
            email: "a@b.c",
            apiToken: "tok",
            projectKey: "NOPE",
            fetchImpl,
        });
        assert.equal(result.ok, false);
        assert.match(result.detail, /not found/);
    });

    it("treats an aliased native issue-type name as satisfying provisioning (TAI-116 piece 4, TAI-178 ADR)", async () => {
        const fetchImpl = stubFetch({
            "GET /rest/api/2/issue/createmeta?projectKeys=PROJ&expand=projects.issuetypes": () =>
                json({ projects: [{ issuetypes: [{ name: "Story" }, { name: "Sub-task" }] }] }),
            "GET /rest/api/2/field": () => json([{ id: "customfield_10105", name: "Persona", custom: true }]),
            "GET /wiki/api/v2/spaces?keys=TA": () => json({ results: [{ id: "111", key: "TA" }] }),
            "GET /wiki/api/v2/spaces/111/pages?title=Type%20Aliases&limit=250": () =>
                json({ results: [{ id: "999", title: "Type Aliases" }] }),
            "GET /wiki/api/v2/pages/999?body-format=storage": () =>
                json({
                    id: "999",
                    title: "Type Aliases",
                    spaceId: "111",
                    version: { number: 1, createdAt: "now" },
                    body: { storage: { value: markdownToStorage("```yaml\nSub-task: dev\n```\n") } },
                }),
        });
        const result = await verifyJiraSetup({
            siteUrl: "https://example.atlassian.net",
            email: "a@b.c",
            apiToken: "tok",
            projectKey: "PROJ",
            spaceKey: "TA",
            fetchImpl,
        });
        assert.ok(!result.missingIssueTypes.includes("Dev"), "Dev should be satisfied via the Sub-task alias");
    });

    it("without spaceKey, does not attempt to load aliases and behaves exactly as before", async () => {
        const fetchImpl = stubFetch({
            "GET /rest/api/2/issue/createmeta?projectKeys=PROJ&expand=projects.issuetypes": () =>
                json({ projects: [{ issuetypes: [{ name: "Story" }] }] }),
            "GET /rest/api/2/field": () => json([{ id: "customfield_10105", name: "Persona", custom: true }]),
        });
        const result = await verifyJiraSetup({
            siteUrl: "https://example.atlassian.net",
            email: "a@b.c",
            apiToken: "tok",
            projectKey: "PROJ",
            fetchImpl,
        });
        assert.ok(result.missingIssueTypes.includes("Dev"));
    });
});

describe("setupConfluence", () => {
    it("creates Config and Persona Roster on first run, and leaves them alone on a second run", async () => {
        let configCreated = false;
        let rosterCreated = false;
        const fetchImpl = stubFetch({
            "GET /wiki/api/v2/spaces?keys=TA": () => json({ results: [{ id: "111", key: "TA" }] }),
            "GET /wiki/api/v2/spaces/111/pages?title=Config&limit=250": () =>
                json({ results: configCreated ? [{ id: "222", title: "Config" }] : [] }),
            "GET /wiki/api/v2/spaces/111/pages?title=Persona%20Roster&limit=250": () =>
                json({ results: rosterCreated ? [{ id: "333", title: "Persona Roster" }] : [] }),
            "POST /wiki/api/v2/pages": () => {
                throw new Error("unused — see dynamic handler below");
            },
        });
        // POST /pages needs to distinguish Config vs Persona Roster by body, and GET
        // /pages/{id} needs to serve back whichever id was just "created" — easier as a
        // hand-rolled dispatcher than shoehorning into the static stubFetch map above.
        const calls: string[] = [];
        const dynamicFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(String(input));
            const method = init?.method ?? "GET";
            calls.push(`${method} ${url.pathname}${url.search}`);
            if (method === "POST" && url.pathname === "/wiki/api/v2/pages") {
                const body = JSON.parse(String(init?.body)) as { title: string };
                if (body.title === "Config") {
                    configCreated = true;
                    return json({ id: "222", title: "Config", spaceId: "111", version: { number: 1, createdAt: "now" } });
                }
                rosterCreated = true;
                return json({ id: "333", title: "Persona Roster", spaceId: "111", version: { number: 1, createdAt: "now" } });
            }
            if (method === "GET" && url.pathname === "/wiki/api/v2/pages/222") {
                return json({ id: "222", title: "Config", spaceId: "111", version: { number: 1, createdAt: "now" } });
            }
            if (method === "GET" && url.pathname === "/wiki/api/v2/pages/333") {
                return json({ id: "333", title: "Persona Roster", spaceId: "111", version: { number: 1, createdAt: "now" } });
            }
            if (method === "GET" && url.pathname === "/wiki/api/v2/spaces/111") {
                return json({ key: "TA" });
            }
            return fetchImpl(input as string, init);
        }) as unknown as typeof fetch;

        const result = await setupConfluence({
            siteUrl: "https://example.atlassian.net",
            email: "a@b.c",
            apiToken: "tok",
            spaceKey: "TA",
            fetchImpl: dynamicFetch,
        });
        assert.equal(result.ok, true);
        assert.equal(result.configPageId, "222");
        assert.equal(result.personaRosterPageId, "333");

        // Second run: both pages already exist — no more POSTs.
        calls.length = 0;
        await setupConfluence({
            siteUrl: "https://example.atlassian.net",
            email: "a@b.c",
            apiToken: "tok",
            spaceKey: "TA",
            fetchImpl: dynamicFetch,
        });
        assert.ok(!calls.some((c) => c.startsWith("POST")), "second run should not re-create either page");
    });
});

describe("verifyBitbucketSetup", () => {
    it("ok when the repository is reachable", async () => {
        const fetchImpl = stubFetch({
            "GET /2.0/repositories/dmayhak/tai-framework": () =>
                json({
                    full_name: "dmayhak/tai-framework",
                    name: "tai-framework",
                    mainbranch: { name: "master" },
                    links: { html: { href: "https://bitbucket.org/dmayhak/tai-framework" } },
                }),
        });
        const result = await verifyBitbucketSetup({ email: "a@b.c", apiToken: "tok", repo: "dmayhak/tai-framework", fetchImpl });
        assert.equal(result.ok, true);
    });

    it("not ok when the repository can't be found", async () => {
        const fetchImpl = stubFetch({
            "GET /2.0/repositories/dmayhak/missing": notFound,
        });
        const result = await verifyBitbucketSetup({ email: "a@b.c", apiToken: "tok", repo: "dmayhak/missing", fetchImpl });
        assert.equal(result.ok, false);
    });
});

describe("renderEnvFile", () => {
    it("includes only the required fields when Bitbucket isn't configured", () => {
        const out = renderEnvFile({
            projectKey: "PROJ",
            spaceKey: "SPC",
            siteUrl: "https://example.atlassian.net",
            email: "a@b.c",
            apiToken: "tok",
        });
        assert.match(out, /TAI_PROJECT_KEY=PROJ/);
        assert.match(out, /TAI_BACKEND=jira/);
        assert.ok(!out.includes("BITBUCKET_EMAIL"));
    });

    it("includes Bitbucket fields when both are supplied", () => {
        const out = renderEnvFile({
            projectKey: "PROJ",
            spaceKey: "SPC",
            siteUrl: "https://example.atlassian.net",
            email: "a@b.c",
            apiToken: "tok",
            bitbucketEmail: "a@b.c",
            bitbucketApiToken: "bbtok",
            gitRepos: "ws/repo",
        });
        assert.match(out, /BITBUCKET_EMAIL=a@b\.c/);
        assert.match(out, /TAI_GIT_REPOS=ws\/repo/);
    });
});

describe("writeEnvFile — sequencing", () => {
    it("refuses to run before jira/confluence steps are done", async () => {
        await withTempDir(async (dir) => {
            await assert.rejects(
                () =>
                    writeEnvFile(dir, path.join(dir, ".tai"), {
                        projectKey: "PROJ",
                        spaceKey: "SPC",
                        siteUrl: "https://x",
                        email: "a@b.c",
                        apiToken: "tok",
                    }),
                /jira, confluence/
            );
        });
    });

    it("writes .env once prerequisites are recorded done", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "jira", "ok");
            await markStepDone(taiRoot, "confluence", "ok");
            const filePath = await writeEnvFile(dir, taiRoot, {
                projectKey: "PROJ",
                spaceKey: "SPC",
                siteUrl: "https://x",
                email: "a@b.c",
                apiToken: "tok",
            });
            const content = await readFile(filePath, "utf-8");
            assert.match(content, /TAI_PROJECT_KEY=PROJ/);
        });
    });

    it("preserves a pre-existing .env's own content instead of overwriting it (regression: found live on a real target project)", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "jira", "ok");
            await markStepDone(taiRoot, "confluence", "ok");
            const filePath = path.join(dir, ".env");
            await writeFile(
                filePath,
                "DATABASE_URL=postgres://user:pass@localhost:5432/app\nHTTP_ADDR=:8080\nTAI_GIT_WORKSPACE=dmayhak\n",
                "utf-8"
            );

            await writeEnvFile(dir, taiRoot, {
                projectKey: "PROJ",
                spaceKey: "SPC",
                siteUrl: "https://x",
                email: "a@b.c",
                apiToken: "tok",
            });

            const content = await readFile(filePath, "utf-8");
            assert.match(content, /DATABASE_URL=postgres:\/\/user:pass@localhost:5432\/app/);
            assert.match(content, /HTTP_ADDR=:8080/);
            assert.match(content, /TAI_GIT_WORKSPACE=dmayhak/);
            assert.match(content, /TAI_PROJECT_KEY=PROJ/);
        });
    });

    it("updates an already-TAI-managed key in place on re-run rather than duplicating it", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "jira", "ok");
            await markStepDone(taiRoot, "confluence", "ok");
            const filePath = path.join(dir, ".env");
            await writeFile(filePath, "TAI_PROJECT_KEY=OLD\nDATABASE_URL=postgres://x\n", "utf-8");

            await writeEnvFile(dir, taiRoot, {
                projectKey: "NEW",
                spaceKey: "SPC",
                siteUrl: "https://x",
                email: "a@b.c",
                apiToken: "tok",
            });

            const content = await readFile(filePath, "utf-8");
            assert.match(content, /TAI_PROJECT_KEY=NEW/);
            assert.doesNotMatch(content, /TAI_PROJECT_KEY=OLD/);
            assert.match(content, /DATABASE_URL=postgres:\/\/x/);
            assert.equal(content.match(/TAI_PROJECT_KEY=/g)?.length, 1);
        });
    });
});

describe("mergeEnvContent", () => {
    it("returns the generated content verbatim when there's nothing existing to preserve", () => {
        const generated = "TAI_PROJECT_KEY=PROJ\n";
        assert.equal(mergeEnvContent("", generated), generated);
        assert.equal(mergeEnvContent("   \n", generated), generated);
    });

    it("leaves comments and blank lines in the existing file untouched", () => {
        const existing = "# my app's own config\n\nDATABASE_URL=postgres://x\n";
        const merged = mergeEnvContent(existing, "TAI_PROJECT_KEY=PROJ\n");
        assert.match(merged, /# my app's own config/);
        assert.match(merged, /DATABASE_URL=postgres:\/\/x/);
        assert.match(merged, /TAI_PROJECT_KEY=PROJ/);
    });
});

describe("writeClaudeMdPointer", () => {
    it("refuses to run before the env step is done", async () => {
        await withTempDir(async (dir) => {
            await assert.rejects(() => writeClaudeMdPointer(dir, path.join(dir, ".tai"), "/home/x/.tai-framework"), /env/);
        });
    });

    it("creates CLAUDE.md fresh when none exists", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "env", "ok");
            const filePath = await writeClaudeMdPointer(dir, taiRoot, "/home/x/.tai-framework");
            const content = await readFile(filePath, "utf-8");
            assert.match(content, /Team AI \(TAI\)/);
            assert.match(content, /\/home\/x\/\.tai-framework/);
        });
    });

    it("replaces its own section on re-run without touching the rest of an existing CLAUDE.md", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "env", "ok");
            await writeFile(path.join(dir, "CLAUDE.md"), "# My Project\n\nSome existing notes.\n", "utf-8");
            await writeClaudeMdPointer(dir, taiRoot, "/home/x/.tai-framework");
            const second = await writeClaudeMdPointer(dir, taiRoot, "/home/x/.tai-framework-v2");
            const content = await readFile(second, "utf-8");
            assert.match(content, /My Project/);
            assert.match(content, /Some existing notes\./);
            assert.match(content, /\.tai-framework-v2/);
            assert.ok(!content.includes("/home/x/.tai-framework\`"), "stale pointer should be replaced, not duplicated");
        });
    });
});
