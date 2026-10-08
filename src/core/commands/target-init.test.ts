import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import {
    INIT_STEPS,
    readInitState,
    markStepDone,
    clearStep,
    parseEnvContent,
    isInitComplete,
    checkInitCompletion,
    renderEnvFile,
    mergeEnvContent,
    writeEnvFile,
    renderEnvSkeleton,
    writeEnvSkeleton,
    writeEnvValues,
    requiredEnvSecretKeys,
    missingEnvSecrets,
    writeClaudeMdPointer,
    writeGeminiMdPointer,
    portableTaiHome,
    verifyJiraSetup,
    setupConfluence,
    verifyBitbucketSetup,
    gitignoreEntries,
    mergeGitignoreContent,
    ensureGitignore,
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

/** POSIX permission bits don't exist on Windows (fs.chmod there only toggles the read-only
 *  attribute and stat reports 0o666), so the owner-only assertion is a no-op on win32. */
async function assertOwnerOnly(filePath: string): Promise<void> {
    if (process.platform === "win32") return;
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
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
        assert.equal(result.projectFound, true, "the project exists; what is missing is provisioning");
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
        assert.equal(result.projectFound, true);
    });

    const ALL_TYPES = [
        "Epic", "Story", "Bug", "Kickoff", "Spike", "Research", "EpicReview", "Requirements", "UxDesign", "Investigate",
        "Feasibility", "ArchitectureDesign", "DesignReview", "Database", "Infra", "Dev", "CodeReview", "IntegrationTest",
        "SystemTest", "E2ETest", "UAT", "Triage", "Deploy", "PostDeploy", "SpikeTask",
    ];
    const CREATEMETA = "GET /rest/api/2/issue/createmeta?projectKeys=PROJ&expand=projects.issuetypes";
    const baseRoutes = () => ({
        [CREATEMETA]: () => json({ projects: [{ issuetypes: ALL_TYPES.map((name) => ({ name })) }] }),
        "GET /rest/api/2/field": () => json([{ id: "customfield_10105", name: "Persona", custom: true }]),
    });
    const verify = (routes: Record<string, () => Response>) =>
        verifyJiraSetup({ siteUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "tok", projectKey: "PROJ", fetchImpl: stubFetch(routes) });
    const ticket = (key: string, type: string) => ({ key, fields: { issuetype: { name: type } } });

    it("TAI-413: reports existing tickets of an unmapped issue type, with the fix path, and stays ok", async () => {
        const result = await verify({
            ...baseRoutes(),
            "POST /rest/api/2/search/jql": () =>
                json({ issues: [ticket("PROJ-1", "Story"), ticket("PROJ-2", "Task"), ticket("PROJ-3", "Task")], isLast: true }),
        });
        assert.equal(result.ok, true, "a report never fails the step");
        assert.deepEqual(result.unmappedTypes, [{ typeName: "Task", count: 2, exampleKeys: ["PROJ-2", "PROJ-3"] }]);
        assert.match(result.detail, /"Task" — 2 tickets \(e\.g\. PROJ-2, PROJ-3\)/);
        assert.match(result.detail, /Type Aliases Confluence page/);
        assert.match(result.detail, /nothing was changed/i);
    });

    it("TAI-413: a project with only mapped types has no report", async () => {
        const result = await verify({
            ...baseRoutes(),
            "POST /rest/api/2/search/jql": () => json({ issues: [ticket("PROJ-1", "Story"), ticket("PROJ-2", "Dev")], isLast: true }),
        });
        assert.deepEqual(result.unmappedTypes, []);
        assert.doesNotMatch(result.detail, /issue type TAI does not map/);
    });

    it("TAI-413: a scan that cannot run is noted but never fails the init step", async () => {
        const result = await verify(baseRoutes()); // the search route is unstubbed -> the scan throws
        assert.equal(result.ok, true);
        assert.deepEqual(result.unmappedTypes, []);
        assert.match(result.detail, /Could not scan existing tickets for unmapped issue types/);
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
        assert.equal(result.projectFound, false, "lets a caller tell a wrong key from missing provisioning (TAI-367 review)");
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

describe("mergeEnvContent — fill-if-empty mode (TAI-363)", () => {
    it("fills an existing EMPTY line but never replaces a non-empty value", () => {
        const existing = "TAI_JIRA_EMAIL=\nTAI_JIRA_API_TOKEN=real-token\n";
        const generated = "TAI_JIRA_EMAIL=me@x.com\nTAI_JIRA_API_TOKEN=other\n";
        const merged = mergeEnvContent(existing, generated, "fill-if-empty");
        assert.match(merged, /^TAI_JIRA_EMAIL=me@x\.com$/m);
        assert.match(merged, /^TAI_JIRA_API_TOKEN=real-token$/m);
    });

    it("never replaces a non-empty value with an empty one, and keeps an empty line empty", () => {
        const existing = "TAI_JIRA_API_TOKEN=typed\nBITBUCKET_API_TOKEN=\n";
        const generated = "TAI_JIRA_API_TOKEN=\nBITBUCKET_API_TOKEN=\n";
        assert.equal(mergeEnvContent(existing, generated, "fill-if-empty"), existing);
    });

    it("treats a quoted-empty or whitespace-only value as empty", () => {
        const existing = 'TAI_JIRA_EMAIL=""\nTAI_JIRA_API_TOKEN=  \n';
        const merged = mergeEnvContent(existing, "TAI_JIRA_EMAIL=a@b.c\nTAI_JIRA_API_TOKEN=tok\n", "fill-if-empty");
        assert.match(merged, /^TAI_JIRA_EMAIL=a@b\.c$/m);
        assert.match(merged, /^TAI_JIRA_API_TOKEN=tok$/m);
    });

    it("appends missing keys WITH their preceding comment lines, leaving unrelated lines untouched", () => {
        const existing = "# my app\nDATABASE_URL=postgres://x\n";
        const generated = "# header\n\n# Your email.\nTAI_JIRA_EMAIL=\n";
        const merged = mergeEnvContent(existing, generated, "fill-if-empty");
        assert.match(merged, /# my app\nDATABASE_URL=postgres:\/\/x\n/);
        assert.match(merged, /# Your email\.\nTAI_JIRA_EMAIL=\n/);
        assert.ok(!merged.includes("# header"), "a detached header comment must not be attached to a key");
    });

    it("default 'replace' mode is unchanged: a generated line still replaces a non-empty one", () => {
        const merged = mergeEnvContent("TAI_PROJECT_KEY=OLD\n", "TAI_PROJECT_KEY=NEW\n");
        assert.match(merged, /^TAI_PROJECT_KEY=NEW$/m);
    });
});

describe("renderEnvSkeleton (TAI-363)", () => {
    it("fills the site URL and leaves every secret line empty under an explanatory comment", () => {
        const out = renderEnvSkeleton({ siteUrl: "https://x.atlassian.net" });
        assert.match(out, /^TAI_JIRA_SITE_URL=https:\/\/x\.atlassian\.net$/m);
        assert.match(out, /# [^\n]*email[^\n]*\nTAI_JIRA_EMAIL=\n/i);
        assert.match(out, /# [^\n]*API token[^\n]*\nTAI_JIRA_API_TOKEN=\n/i);
        assert.ok(!out.includes("BITBUCKET"), "Bitbucket lines only when asked for");
    });

    it("includes the Bitbucket secret lines, also empty and commented, when requested", () => {
        const out = renderEnvSkeleton({ siteUrl: "https://x.atlassian.net", includeBitbucket: true });
        assert.match(out, /# [^\n]*\nBITBUCKET_EMAIL=\n/);
        assert.match(out, /# [^\n]*\nBITBUCKET_API_TOKEN=\n/);
    });

    it("includes project/space keys only when already known", () => {
        assert.ok(!renderEnvSkeleton({ siteUrl: "https://x.atlassian.net" }).includes("TAI_PROJECT_KEY"));
        const out = renderEnvSkeleton({ siteUrl: "https://x.atlassian.net", projectKey: "P", spaceKey: "S" });
        assert.match(out, /^TAI_PROJECT_KEY=P$/m);
        assert.match(out, /^TAI_SPACE_KEY=S$/m);
    });
});

describe("missingEnvSecrets / requiredEnvSecretKeys (TAI-363)", () => {
    it("lists required secret keys, Bitbucket ones only when included", () => {
        assert.deepEqual(requiredEnvSecretKeys(false), ["TAI_JIRA_EMAIL", "TAI_JIRA_API_TOKEN"]);
        assert.deepEqual(requiredEnvSecretKeys(true), [
            "TAI_JIRA_EMAIL",
            "TAI_JIRA_API_TOKEN",
            "BITBUCKET_EMAIL",
            "BITBUCKET_API_TOKEN",
        ]);
    });

    it("reports empty, absent and whitespace-only secrets, and nothing once filled", () => {
        assert.deepEqual(missingEnvSecrets("TAI_JIRA_EMAIL=\nTAI_JIRA_API_TOKEN=  \n", false), [
            "TAI_JIRA_EMAIL",
            "TAI_JIRA_API_TOKEN",
        ]);
        assert.deepEqual(missingEnvSecrets("TAI_JIRA_EMAIL=a@b.c\n", false), ["TAI_JIRA_API_TOKEN"]);
        assert.deepEqual(missingEnvSecrets("TAI_JIRA_EMAIL=a@b.c\nTAI_JIRA_API_TOKEN=t\n", false), []);
    });

    it("ignores commented-out lines", () => {
        assert.deepEqual(missingEnvSecrets("# TAI_JIRA_EMAIL=a@b.c\nTAI_JIRA_API_TOKEN=t\n", false), ["TAI_JIRA_EMAIL"]);
    });
});

describe("writeEnvSkeleton / writeEnvValues (TAI-363)", () => {
    it("creates .env with the skeleton at mode 0600", async () => {
        await withTempDir(async (dir) => {
            const filePath = await writeEnvSkeleton(dir, { siteUrl: "https://x.atlassian.net" });
            assert.match(await readFile(filePath, "utf-8"), /TAI_JIRA_EMAIL=/);
            await assertOwnerOnly(filePath);
        });
    });

    it("never blanks typed secrets when re-run against an existing .env, and fixes a loose mode", async () => {
        await withTempDir(async (dir) => {
            const envPath = path.join(dir, ".env");
            await writeFile(
                envPath,
                "DATABASE_URL=postgres://x\nTAI_JIRA_EMAIL=me@x.com\nTAI_JIRA_API_TOKEN=secret\n",
                "utf-8"
            );
            await chmod(envPath, 0o644);
            await writeEnvSkeleton(dir, { siteUrl: "https://x.atlassian.net", includeBitbucket: true });
            const content = await readFile(envPath, "utf-8");
            assert.match(content, /^DATABASE_URL=postgres:\/\/x$/m);
            assert.match(content, /^TAI_JIRA_EMAIL=me@x\.com$/m);
            assert.match(content, /^TAI_JIRA_API_TOKEN=secret$/m);
            assert.match(content, /^TAI_JIRA_SITE_URL=https:\/\/x\.atlassian\.net$/m);
            assert.match(content, /^BITBUCKET_API_TOKEN=$/m);
            await assertOwnerOnly(envPath);
        });
    });

    it("writeEnvValues writes only the given keys (replacing them) and leaves secrets untouched", async () => {
        await withTempDir(async (dir) => {
            const envPath = path.join(dir, ".env");
            await writeFile(envPath, "TAI_PROJECT_KEY=OLD\nTAI_JIRA_API_TOKEN=secret\n", "utf-8");
            await writeEnvValues(dir, { TAI_PROJECT_KEY: "NEW", TAI_SPACE_KEY: "SP" });
            const content = await readFile(envPath, "utf-8");
            assert.match(content, /^TAI_PROJECT_KEY=NEW$/m);
            assert.match(content, /^TAI_SPACE_KEY=SP$/m);
            assert.match(content, /^TAI_JIRA_API_TOKEN=secret$/m);
            await assertOwnerOnly(envPath);
        });
    });

    it("writeEnvValues rejects a value that would inject another line, and an invalid key", async () => {
        await withTempDir(async (dir) => {
            await assert.rejects(() => writeEnvValues(dir, { TAI_SPACE_KEY: "S\nTAI_JIRA_API_TOKEN=evil" }), /single line/);
            await assert.rejects(() => writeEnvValues(dir, { "BAD KEY": "x" }), /Invalid/);
        });
    });

    it("writeEnvFile (the existing step writer) now also leaves .env at mode 0600", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "jira", "ok");
            await markStepDone(taiRoot, "confluence", "ok");
            const filePath = await writeEnvFile(dir, taiRoot, {
                projectKey: "P",
                spaceKey: "S",
                siteUrl: "https://x.atlassian.net",
                email: "a@b.c",
                apiToken: "t",
            });
            await assertOwnerOnly(filePath);
        });
    });
});

describe("clearStep (TAI-367)", () => {
    it("removes one recorded step and leaves the others, so the state tracks the last live result", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "jira", "ok");
            await markStepDone(taiRoot, "confluence", "ok");
            const next = await clearStep(taiRoot, "jira");
            assert.equal(next.steps.jira, undefined);
            assert.notEqual(next.steps.confluence, undefined);
            assert.equal((await readInitState(taiRoot)).steps.jira, undefined);
        });
    });

    it("is a no-op for a step that was never recorded", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            assert.deepEqual((await clearStep(taiRoot, "env")).steps, {});
        });
    });
});

describe("parseEnvContent (TAI-367)", () => {
    it("reads KEY=value lines, strips surrounding quotes, ignores comments and blanks", () => {
        assert.deepEqual(parseEnvContent('# c\n\nA=1\nB="two"\nC=\n  # D=4\n'), { A: "1", B: "two", C: "" });
    });

    it("the last occurrence of a key wins", () => {
        assert.deepEqual(parseEnvContent("A=1\nA=2\n"), { A: "2" });
    });

    it("tolerates CRLF line endings", () => {
        assert.deepEqual(parseEnvContent("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
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

    it("never embeds the current home directory in the committed file (TAI-359)", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "env", "ok");
            const taiHome = path.join(homedir(), ".tai-framework");
            const content = await readFile(await writeClaudeMdPointer(dir, taiRoot, taiHome), "utf-8");
            assert.ok(!content.includes(homedir()), "home dir leaked into CLAUDE.md");
            assert.match(content, /~\/\.tai-framework/);
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
            assert.ok(!content.includes("/home/x/.tai-framework`"), "stale pointer should be replaced, not duplicated");
        });
    });
});

describe("pointer files are byte-identical on re-run (TAI-376)", () => {
    for (const [name, write] of [
        ["CLAUDE.md", writeClaudeMdPointer],
        ["GEMINI.md", writeGeminiMdPointer],
    ] as const) {
        it(`${name}: a second write with the same input changes nothing, even with trailing project text`, async () => {
            await withTempDir(async (dir) => {
                const taiRoot = path.join(dir, ".tai");
                await markStepDone(taiRoot, "env", "ok");
                await writeFile(path.join(dir, name), "# Mine\n", "utf-8");
                await write(dir, taiRoot, "/home/x/.tai-framework");
                const first = await readFile(path.join(dir, name), "utf-8");
                await writeFile(path.join(dir, name), `${first}\n## After\n\nMore.\n`, "utf-8");
                const withTail = await readFile(path.join(dir, name), "utf-8");
                await write(dir, taiRoot, "/home/x/.tai-framework");
                assert.equal(await readFile(path.join(dir, name), "utf-8"), withTail);
                await write(dir, taiRoot, "/home/x/.tai-framework");
                assert.equal(await readFile(path.join(dir, name), "utf-8"), withTail);
            });
        });
    }
});

describe("pointer writers: CRLF files and the refusal message (TAI-376 review)", () => {
    for (const [name, write] of [
        ["CLAUDE.md", writeClaudeMdPointer],
        ["GEMINI.md", writeGeminiMdPointer],
    ] as const) {
        it(`${name}: a CRLF-edited file does not grow by a line on each re-run`, async () => {
            await withTempDir(async (dir) => {
                const taiRoot = path.join(dir, ".tai");
                await markStepDone(taiRoot, "env", "ok");
                await write(dir, taiRoot, "/home/x/.tai-framework");
                const lf = await readFile(path.join(dir, name), "utf-8");
                await writeFile(path.join(dir, name), `# Mine\r\n\r\n${lf.replace(/\n/g, "\r\n")}\r\n## After\r\n`, "utf-8");
                await write(dir, taiRoot, "/home/x/.tai-framework");
                const once = await readFile(path.join(dir, name), "utf-8");
                // Exactly the one blank line the file had after the marker, not an extra one.
                assert.equal(once.slice(once.indexOf("TAI-INIT:END -->") + "TAI-INIT:END -->".length), "\n\r\n## After\r\n");
                await write(dir, taiRoot, "/home/x/.tai-framework");
                assert.equal(await readFile(path.join(dir, name), "utf-8"), once);
            });
        });

        it(`${name}: refusing without the env step points a fresh clone at \`init run\``, async () => {
            await withTempDir(async (dir) => {
                await assert.rejects(() => write(dir, path.join(dir, ".tai"), "/home/x/.tai-framework"), /init run/);
            });
        });
    }
});

describe("writeGeminiMdPointer (TAI-376)", () => {
    it("refuses to run before the env step is done", async () => {
        await withTempDir(async (dir) => {
            await assert.rejects(() => writeGeminiMdPointer(dir, path.join(dir, ".tai"), "/home/x/.tai-framework"), /env/);
        });
    });

    it("creates GEMINI.md with the same TAI section, and never touches CLAUDE.md", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "env", "ok");
            await writeFile(path.join(dir, "CLAUDE.md"), "# Claude notes\n", "utf-8");
            const filePath = await writeGeminiMdPointer(dir, taiRoot, "/home/x/.tai-framework");
            assert.equal(path.basename(filePath), "GEMINI.md");
            assert.match(await readFile(filePath, "utf-8"), /Team AI \(TAI\)/);
            assert.equal(await readFile(path.join(dir, "CLAUDE.md"), "utf-8"), "# Claude notes\n");
        });
    });

    it("never embeds the current home directory in the committed file", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "env", "ok");
            const content = await readFile(await writeGeminiMdPointer(dir, taiRoot, path.join(homedir(), ".tai-framework")), "utf-8");
            assert.ok(!content.includes(homedir()));
            assert.match(content, /~\/\.tai-framework/);
        });
    });

    it("replaces only its own marked section on re-run, keeping the project's own text", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "env", "ok");
            await writeFile(path.join(dir, "GEMINI.md"), "# My Gemini notes\n\nKeep me.\n", "utf-8");
            await writeGeminiMdPointer(dir, taiRoot, "/home/x/.tai-framework");
            const content = await readFile(await writeGeminiMdPointer(dir, taiRoot, "/home/x/.tai-framework-v2"), "utf-8");
            assert.match(content, /Keep me\./);
            assert.match(content, /\.tai-framework-v2/);
            assert.equal(content.split("TAI-INIT:BEGIN").length - 1, 1, "section replaced, not duplicated");
        });
    });

    it("records no init step (isInitComplete must not depend on it)", async () => {
        await withTempDir(async (dir) => {
            const taiRoot = path.join(dir, ".tai");
            await markStepDone(taiRoot, "env", "ok");
            await writeGeminiMdPointer(dir, taiRoot, "/home/x/.tai-framework");
            assert.deepEqual(Object.keys((await readInitState(taiRoot)).steps), ["env"]);
        });
    });
});

describe("portableTaiHome", () => {
    it("renders a path under home as ~-relative", () => {
        assert.equal(portableTaiHome("/home/x/.tai-framework", "/home/x"), "~/.tai-framework");
    });

    it("renders home itself as ~", () => {
        assert.equal(portableTaiHome("/home/x", "/home/x"), "~");
    });

    it("keeps a path outside home absolute", () => {
        assert.equal(portableTaiHome("/opt/tai", "/home/x"), "/opt/tai");
        assert.equal(portableTaiHome("/home/xy/tai", "/home/x"), "/home/xy/tai");
    });
});

describe("gitignoreEntries", () => {
    it("anchors the default .tai root", () => {
        assert.deepEqual(gitignoreEntries(".tai"), [
            "/.tai/",
            ".env",
            ".env.local",
            ".env.*",
            "!.env.example",
            "*~",
            "/.handoff/",
        ]);
    });

    it("respects an overridden TAI_ROOT instead of hardcoding .tai", () => {
        assert.deepEqual(gitignoreEntries("state/tai"), [
            "/state/tai/",
            ".env",
            ".env.local",
            ".env.*",
            "!.env.example",
            "*~",
            "/.handoff/",
        ]);
    });
});

describe("mergeGitignoreContent", () => {
    const entries = gitignoreEntries(".tai");

    it("returns the input unchanged when every entry is already present", () => {
        const existing = "/node_modules/\n/.tai/\n.env\n.env.local\n.env.*\n!.env.example\n*~\n/.handoff/\n";
        assert.equal(mergeGitignoreContent(existing, entries), existing);
    });

    it("appends only the missing entries, leaving existing content untouched", () => {
        const existing = "# my app\n/node_modules/\n.env\n";
        const merged = mergeGitignoreContent(existing, entries);
        assert.match(merged, /# my app/);
        assert.match(merged, /\/node_modules\//);
        assert.match(merged, /\/\.tai\//);
        assert.match(merged, /\/\.handoff\//);
        // .env was already present -- shouldn't be duplicated.
        assert.equal(merged.match(/^\.env$/gm)?.length, 1);
    });

    it("creates a fresh block when there's no existing .gitignore", () => {
        const merged = mergeGitignoreContent("", entries);
        for (const entry of entries) assert.match(merged, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`, "m"));
    });

    it("is idempotent -- re-merging its own output changes nothing further", () => {
        const once = mergeGitignoreContent("/node_modules/\n", entries);
        const twice = mergeGitignoreContent(once, entries);
        assert.equal(once, twice);
    });
});

describe("gitignore ordering and behavior (TAI-366)", () => {
    const entries = gitignoreEntries(".tai");
    const lastIndexOfLine = (content: string, line: string): number =>
        content.split("\n").map((l) => l.trim()).lastIndexOf(line);

    it("writes .env.* before its !.env.example negation in a fresh file", () => {
        const merged = mergeGitignoreContent("", entries);
        assert.ok(lastIndexOfLine(merged, "!.env.example") > lastIndexOfLine(merged, ".env.*"));
    });

    it("re-appends !.env.example AFTER a newly appended .env.* when an earlier copy already exists", () => {
        const existing = "/node_modules/\n!.env.example\n";
        const merged = mergeGitignoreContent(existing, entries);
        assert.ok(lastIndexOfLine(merged, "!.env.example") > lastIndexOfLine(merged, ".env.*"));
        assert.ok(merged.startsWith(existing), "existing content stays untouched, only appended to");
    });

    it("re-asserts the negation when both are present but in the wrong order", () => {
        const existing = "!.env.example\n.env.*\n";
        const merged = mergeGitignoreContent(existing, entries);
        assert.ok(lastIndexOfLine(merged, "!.env.example") > lastIndexOfLine(merged, ".env.*"));
    });

    it("leaves an already-correct order alone, and is idempotent after re-asserting", () => {
        const correct = ".env.*\n!.env.example\n";
        assert.ok(mergeGitignoreContent(correct, entries).startsWith(correct));
        const once = mergeGitignoreContent("!.env.example\n", entries);
        assert.equal(mergeGitignoreContent(once, entries), once);
    });

    it("ensureGitignore reports a re-asserted negation as added and fixes a wrong order on disk", async () => {
        await withTempDir(async (dir) => {
            await writeFile(path.join(dir, ".gitignore"), "!.env.example\n.env.*\n", "utf-8");
            const result = await ensureGitignore(dir, ".tai");
            assert.ok(result.added.includes("!.env.example"));
            const content = await readFile(result.path, "utf-8");
            assert.ok(lastIndexOfLine(content, "!.env.example") > lastIndexOfLine(content, ".env.*"));
            assert.deepEqual((await ensureGitignore(dir, ".tai")).added, []);
        });
    });

    const hasGit = (() => {
        try {
            execFileSync("git", ["--version"], { stdio: "ignore" });
            return true;
        } catch {
            return false;
        }
    })();

    it("real git agrees: secrets and swap files ignored, .env.example not ignored", { skip: !hasGit }, async () => {
        await withTempDir(async (dir) => {
            // Hermetic: drop every ambient GIT_* variable (a git hook sets GIT_DIR, which would
            // redirect git away from this temp repo) and ignore the developer's own
            // global/system git config, so only this repo's .gitignore decides.
            const env: NodeJS.ProcessEnv = { ...process.env };
            for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
            Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
            execFileSync("git", ["init", "-q"], { cwd: dir, env });
            // The hard case: the negation already sits ABOVE where .env.* will be appended.
            await writeFile(path.join(dir, ".gitignore"), "!.env.example\n", "utf-8");
            await ensureGitignore(dir, ".tai");
            const ignored = (file: string): boolean => {
                try {
                    execFileSync("git", ["check-ignore", "-q", file], { cwd: dir, env });
                    return true;
                } catch {
                    return false;
                }
            };
            for (const f of [".env", ".env.local", ".env.swp", ".env.prod", ".env~", "notes.txt~", ".tai/init-state.json", ".handoff/x.md"]) {
                assert.ok(ignored(f), `${f} should be ignored`);
            }
            assert.ok(!ignored(".env.example"), ".env.example must stay committable");
            assert.ok(!ignored("src/main.ts"));
        });
    });
});

describe("ensureGitignore", () => {
    it("creates .gitignore with all entries when none exists", async () => {
        await withTempDir(async (dir) => {
            const result = await ensureGitignore(dir, ".tai");
            assert.deepEqual(result.added, gitignoreEntries(".tai"));
            const content = await readFile(result.path, "utf-8");
            for (const entry of gitignoreEntries(".tai")) assert.ok(content.includes(entry));
        });
    });

    it("reports no entries added and leaves the file untouched on a second call", async () => {
        await withTempDir(async (dir) => {
            await ensureGitignore(dir, ".tai");
            const before = await readFile(path.join(dir, ".gitignore"), "utf-8");
            const second = await ensureGitignore(dir, ".tai");
            assert.deepEqual(second.added, []);
            const after = await readFile(path.join(dir, ".gitignore"), "utf-8");
            assert.equal(after, before);
        });
    });

    it("reports only the entries actually missing, not the whole list, when .gitignore is partially set up", async () => {
        await withTempDir(async (dir) => {
            await writeFile(path.join(dir, ".gitignore"), "/.tai/\n.env\n.env.local\n", "utf-8");
            const result = await ensureGitignore(dir, ".tai");
            assert.deepEqual(result.added, [".env.*", "!.env.example", "*~", "/.handoff/"]);
        });
    });

    it("preserves a pre-existing .gitignore's own content", async () => {
        await withTempDir(async (dir) => {
            await writeFile(path.join(dir, ".gitignore"), "/node_modules/\n/dist/\n", "utf-8");
            const result = await ensureGitignore(dir, ".tai");
            const content = await readFile(result.path, "utf-8");
            assert.match(content, /\/node_modules\//);
            assert.match(content, /\/dist\//);
            assert.match(content, /\/\.tai\//);
        });
    });
});
