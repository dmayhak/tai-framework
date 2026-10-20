import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RestClient, apiTokenAuth } from "../storage/jira/rest-client.js";
import {
    listJiraProjects,
    listConfluenceSpaces,
    parseBitbucketRemote,
    detectBitbucketRepo,
    parseGitHubRemote,
    parseGitRemote,
    detectGitRemote,
    projectChoices,
    spaceChoices,
    filterChoices,
    decidePick,
    planCoordinate,
    type Choice,
} from "./discovery.js";

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Every test lists every request it expects, so an unhandled one is a loud failure. */
function clientFor(routes: Record<string, () => Response>): RestClient {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
        const route = routes[key];
        if (!route) throw new Error(`Unstubbed request: ${key}`);
        return route();
    }) as unknown as typeof fetch;
    return new RestClient({ siteUrl: "https://x.atlassian.net", auth: apiTokenAuth("a@b.c", "t"), fetchImpl });
}

/** The ambient git environment must not reach these tests: under a git hook GIT_DIR is set
 *  and `git init` / `git remote add` would act on the hook's repository instead of the temp
 *  dir. Drop every GIT_* variable, then ignore the developer's global/system config. */
function isolatedGitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-discovery-"));
    try {
        await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("listJiraProjects", () => {
    it("reads one page in the shape real Jira returns (values/isLast)", async () => {
        const client = clientFor({
            "GET /rest/api/2/project/search?startAt=0&maxResults=50": () =>
                json({ startAt: 0, maxResults: 50, total: 2, isLast: true, values: [{ key: "EXA", name: "EXA" }, { key: "TAI", name: "TAI" }] }),
        });
        assert.deepEqual((await listJiraProjects(client)).items, [
            { key: "EXA", name: "EXA" },
            { key: "TAI", name: "TAI" },
        ]);
    });

    it("follows pagination until isLast", async () => {
        const client = clientFor({
            "GET /rest/api/2/project/search?startAt=0&maxResults=50": () =>
                json({ isLast: false, values: [{ key: "A", name: "a" }, { key: "B", name: "b" }] }),
            "GET /rest/api/2/project/search?startAt=2&maxResults=50": () =>
                json({ isLast: true, values: [{ key: "C", name: "c" }] }),
        });
        assert.deepEqual((await listJiraProjects(client)).items.map((p) => p.key), ["A", "B", "C"]);
    });

    it("stops on an empty page even if isLast is missing (no infinite loop)", async () => {
        const client = clientFor({
            "GET /rest/api/2/project/search?startAt=0&maxResults=50": () => json({ values: [{ key: "A", name: "a" }] }),
            "GET /rest/api/2/project/search?startAt=1&maxResults=50": () => json({ values: [] }),
        });
        assert.deepEqual((await listJiraProjects(client)).items.map((p) => p.key), ["A"]);
    });
});

describe("listJiraProjects — page size, truncation (TAI-364 review)", () => {
    it("honors an injected page size in the request", async () => {
        const client = clientFor({
            "GET /rest/api/2/project/search?startAt=0&maxResults=2": () =>
                json({ isLast: false, values: [{ key: "A", name: "a" }, { key: "B", name: "b" }] }),
            "GET /rest/api/2/project/search?startAt=2&maxResults=2": () => json({ isLast: true, values: [{ key: "C", name: "c" }] }),
        });
        const listing = await listJiraProjects(client, { pageSize: 2 });
        assert.deepEqual(listing.items.map((p) => p.key), ["A", "B", "C"]);
        assert.equal(listing.truncated, false);
    });

    it("reports truncated (not a silent partial list) when the page cap stops it early", async () => {
        const client = clientFor({
            "GET /rest/api/2/project/search?startAt=0&maxResults=1": () => json({ isLast: false, values: [{ key: "A", name: "a" }] }),
            "GET /rest/api/2/project/search?startAt=1&maxResults=1": () => json({ isLast: false, values: [{ key: "B", name: "b" }] }),
        });
        const listing = await listJiraProjects(client, { pageSize: 1, maxPages: 2 });
        assert.deepEqual(listing.items.map((p) => p.key), ["A", "B"]);
        assert.equal(listing.truncated, true);
    });

    it("a complete listing is not truncated", async () => {
        const client = clientFor({
            "GET /rest/api/2/project/search?startAt=0&maxResults=50": () => json({ isLast: true, values: [{ key: "A", name: "a" }] }),
        });
        assert.equal((await listJiraProjects(client)).truncated, false);
    });
});

describe("listConfluenceSpaces", () => {
    const space = (key: string, alias: string | undefined, type: string, name = key) => ({
        id: `id-${key}`,
        key,
        name,
        type,
        status: "current",
        ...(alias !== undefined ? { currentActiveAlias: alias } : {}),
    });

    it("keeps the real key AND the alias, and sets value to the alias (the working-setup form)", async () => {
        const client = clientFor({
            "GET /wiki/api/v2/spaces?limit=250&status=current": () =>
                json({ results: [space("TA", "TAI", "global", "TAI"), space("EXA", "EXA", "knowledge_base")], _links: { base: "x" } }),
        });
        const spaces = (await listConfluenceSpaces(client)).items;
        assert.deepEqual(
            spaces.map((s) => ({ key: s.key, alias: s.alias, value: s.value })),
            [
                { key: "TA", alias: "TAI", value: "TAI" },
                { key: "EXA", alias: "EXA", value: "EXA" },
            ]
        );
    });

    it("excludes personal spaces and falls back to the key when there is no alias", async () => {
        const client = clientFor({
            "GET /wiki/api/v2/spaces?limit=250&status=current": () =>
                json({ results: [space("~abc123", "~abc123", "personal"), space("SD", undefined, "onboarding")] }),
        });
        const spaces = (await listConfluenceSpaces(client)).items;
        assert.deepEqual(spaces.map((s) => s.key), ["SD"]);
        assert.equal(spaces[0]?.value, "SD");
    });

    it("follows _links.next across pages", async () => {
        const client = clientFor({
            "GET /wiki/api/v2/spaces?limit=250&status=current": () =>
                json({ results: [space("A", "A", "global")], _links: { next: "/wiki/api/v2/spaces?cursor=abc&limit=250&status=current" } }),
            "GET /wiki/api/v2/spaces?cursor=abc&limit=250&status=current": () =>
                json({ results: [space("B", "B", "global")], _links: {} }),
        });
        assert.deepEqual((await listConfluenceSpaces(client)).items.map((s) => s.key), ["A", "B"]);
    });
});

describe("listConfluenceSpaces — page size, absolute next, truncation (TAI-364 review)", () => {
    const sp = (key: string) => ({ id: key, key, name: key, type: "global", status: "current", currentActiveAlias: key });

    it("honors an injected page size", async () => {
        const client = clientFor({ "GET /wiki/api/v2/spaces?limit=2&status=current": () => json({ results: [sp("A")] }) });
        assert.deepEqual((await listConfluenceSpaces(client, { pageSize: 2 })).items.map((s) => s.key), ["A"]);
    });

    it("follows an ABSOLUTE _links.next by using only its path and query", async () => {
        const client = clientFor({
            "GET /wiki/api/v2/spaces?limit=250&status=current": () =>
                json({ results: [sp("A")], _links: { next: "https://x.atlassian.net/wiki/api/v2/spaces?cursor=abc&limit=250&status=current" } }),
            "GET /wiki/api/v2/spaces?cursor=abc&limit=250&status=current": () => json({ results: [sp("B")], _links: {} }),
        });
        assert.deepEqual((await listConfluenceSpaces(client)).items.map((s) => s.key), ["A", "B"]);
    });

    it("reports truncated when the page cap stops it with more pages remaining", async () => {
        const client = clientFor({
            "GET /wiki/api/v2/spaces?limit=250&status=current": () =>
                json({ results: [sp("A")], _links: { next: "/wiki/api/v2/spaces?cursor=1" } }),
            "GET /wiki/api/v2/spaces?cursor=1": () => json({ results: [sp("B")], _links: { next: "/wiki/api/v2/spaces?cursor=2" } }),
        });
        const listing = await listConfluenceSpaces(client, { maxPages: 2 });
        assert.deepEqual(listing.items.map((s) => s.key), ["A", "B"]);
        assert.equal(listing.truncated, true);
    });

    it("reports truncated for a cursor that points back at a page already read (stuck cursor)", async () => {
        const client = clientFor({
            "GET /wiki/api/v2/spaces?limit=250&status=current": () =>
                json({ results: [sp("A")], _links: { next: "/wiki/api/v2/spaces?limit=250&status=current" } }),
        });
        const listing = await listConfluenceSpaces(client);
        assert.deepEqual(listing.items.map((s) => s.key), ["A"]);
        assert.equal(listing.truncated, true);
    });

    it("a complete listing is not truncated", async () => {
        const client = clientFor({ "GET /wiki/api/v2/spaces?limit=250&status=current": () => json({ results: [sp("A")] }) });
        assert.equal((await listConfluenceSpaces(client)).truncated, false);
    });
});

describe("parseBitbucketRemote", () => {
    const cases: [string, string | null][] = [
        ["git@bitbucket.org:dmayhak/tai-framework.git", "dmayhak/tai-framework"],
        ["git@bitbucket.org:dmayhak/tai-framework", "dmayhak/tai-framework"],
        ["https://bitbucket.org/dmayhak/tai-framework.git", "dmayhak/tai-framework"],
        ["https://dmayhak@bitbucket.org/dmayhak/tai-framework.git", "dmayhak/tai-framework"],
        ["https://bitbucket.org/dmayhak/tai-framework/", "dmayhak/tai-framework"],
        ["ssh://git@bitbucket.org/dmayhak/tai-framework.git", "dmayhak/tai-framework"],
        ["ssh://git@bitbucket.org:22/dmayhak/tai-framework.git", "dmayhak/tai-framework"],
        ["git@github.com:dmayhak/tai-framework.git", null],
        ["https://bitbucket.example.com/scm/dm/repo.git", null],
        ["https://notbitbucket.org/a/b.git", null],
        ["", null],
        ["not a url", null],
    ];
    for (const [input, expected] of cases) {
        it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
            assert.equal(parseBitbucketRemote(input), expected);
        });
    }
});

describe("parseGitHubRemote and parseGitRemote (TAI-583)", () => {
    const cases: [string, string | null][] = [
        ["git@github.com:dmayhak/tai-framework.git", "dmayhak/tai-framework"],
        ["https://github.com/dmayhak/tai-framework", "dmayhak/tai-framework"],
        ["https://user@github.com/dmayhak/tai-framework.git", "dmayhak/tai-framework"],
        ["ssh://git@github.com/dmayhak/tai-framework.git", "dmayhak/tai-framework"],
        ["git@bitbucket.org:dmayhak/tai-framework.git", null],
        ["https://github.example.com/a/b.git", null],
        ["https://notgithub.com/a/b.git", null],
    ];
    for (const [input, expected] of cases) {
        it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
            assert.equal(parseGitHubRemote(input), expected);
        });
    }

    it("names the host of a remote", () => {
        assert.deepEqual(parseGitRemote("git@github.com:a/b.git"), { kind: "github", repo: "a/b" });
        assert.deepEqual(parseGitRemote("git@bitbucket.org:a/b.git"), { kind: "bitbucket", repo: "a/b" });
        assert.equal(parseGitRemote("https://gitlab.com/a/b.git"), null);
    });
});

describe("detectGitRemote", () => {
    it("reads a GitHub origin from a real repo", async () => {
        await withTempDir(async (dir) => {
            execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore", env: isolatedGitEnv() });
            execFileSync("git", ["remote", "add", "origin", "git@github.com:a/b.git"], { cwd: dir, stdio: "ignore", env: isolatedGitEnv() });
            assert.deepEqual(await detectGitRemote(dir, isolatedGitEnv()), { kind: "github", repo: "a/b" });
        });
    });
});

describe("detectBitbucketRepo", () => {
    const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore", env: isolatedGitEnv() });

    it("reads the raw origin URL from a real repo", async () => {
        await withTempDir(async (dir) => {
            git(dir, "init", "-q");
            git(dir, "remote", "add", "origin", "git@bitbucket.org:a/b.git");
            assert.equal(await detectBitbucketRepo(dir, isolatedGitEnv()), "a/b");
        });
    });

    it("uses the env it is given: a hostile GIT_DIR in process.env cannot redirect it (TAI-364 review)", async () => {
        await withTempDir(async (other) => {
            git(other, "init", "-q");
            git(other, "remote", "add", "origin", "git@bitbucket.org:other/repo.git");
            await withTempDir(async (dir) => {
                git(dir, "init", "-q");
                git(dir, "remote", "add", "origin", "git@bitbucket.org:a/b.git");
                const hostile = { ...isolatedGitEnv(), GIT_DIR: path.join(other, ".git") };
                assert.equal(await detectBitbucketRepo(dir, hostile), "other/repo", "an explicit env is honored as given");
                assert.equal(await detectBitbucketRepo(dir, isolatedGitEnv()), "a/b");
            });
        });
    });

    it("is null for a non-Bitbucket remote, no remote, and a non-repo", async () => {
        await withTempDir(async (dir) => {
            assert.equal(await detectBitbucketRepo(dir, isolatedGitEnv()), null);
            git(dir, "init", "-q");
            assert.equal(await detectBitbucketRepo(dir, isolatedGitEnv()), null);
            git(dir, "remote", "add", "origin", "git@github.com:a/b.git");
            assert.equal(await detectBitbucketRepo(dir, isolatedGitEnv()), null);
        });
    });
});

const projects: Choice[] = projectChoices([
    { key: "EXA", name: "Example Project" },
    { key: "TAI", name: "Team AI" },
    { key: "TAIT", name: "TAI scratch" },
]);
const spaces: Choice[] = spaceChoices([
    { key: "TA", alias: "TAI", name: "TAI", type: "global", value: "TAI" },
    { key: "EXA", alias: "EXA", name: "EXA", type: "knowledge_base", value: "EXA" },
]);

describe("filterChoices", () => {
    it("matches case-insensitively on key, alias or name, key-prefix matches first", () => {
        assert.deepEqual(filterChoices(projects, "tai").map((c) => c.value), ["TAI", "TAIT"]);
        assert.deepEqual(filterChoices(projects, "example").map((c) => c.value), ["EXA"]);
        assert.deepEqual(filterChoices(spaces, "TA").map((c) => c.value), ["TAI"], "the real key TA matches the aliased space");
        assert.deepEqual(filterChoices(projects, "zzz"), []);
    });

    it("returns everything for an empty query", () => {
        assert.equal(filterChoices(projects, "  ").length, 3);
    });
});

describe("decidePick", () => {
    it("empty input takes the default, or re-prompts when there is none", () => {
        assert.deepEqual(decidePick("", projects, projects, "TAI"), { kind: "chosen", value: "TAI" });
        assert.deepEqual(decidePick("  ", projects, projects), { kind: "reprompt" });
    });

    it("a number indexes the list currently shown", () => {
        assert.deepEqual(decidePick("2", projects, projects), { kind: "chosen", value: "TAI" });
        const shown = filterChoices(projects, "tai");
        assert.deepEqual(decidePick("2", projects, shown), { kind: "chosen", value: "TAIT" });
    });

    it("an exact key or alias (any case) is chosen directly, even when it is also a prefix of another", () => {
        assert.deepEqual(decidePick("tai", projects, projects), { kind: "chosen", value: "TAI" });
        assert.deepEqual(decidePick("TA", spaces, spaces), { kind: "chosen", value: "TAI" }, "real key of an aliased space resolves to the alias value");
    });

    it("a partial match narrows the list instead of guessing", () => {
        const d = decidePick("exam", projects, projects);
        assert.equal(d.kind, "narrowed");
        assert.deepEqual(d.kind === "narrowed" ? d.matches.map((c) => c.value) : [], ["EXA"]);
    });

    it("an out-of-range number is treated as text, and an unknown key is offered as a manual entry", () => {
        assert.deepEqual(decidePick("99", projects, projects), { kind: "not-listed", typed: "99" });
        assert.deepEqual(decidePick("NEWPROJ", projects, projects), { kind: "not-listed", typed: "NEWPROJ" });
    });
});

describe("planCoordinate (discovery never overrides a working value)", () => {
    it("keeps an existing value that matches a live choice, verbatim", () => {
        assert.deepEqual(planCoordinate("TAI", projects), { kind: "keep", value: "TAI" });
    });

    it("keeps an existing ALIAS even though the space list's real key differs (TAI vs TA)", () => {
        assert.deepEqual(planCoordinate("TAI", spaces), { kind: "keep", value: "TAI" });
    });

    it("keeps the existing spelling when it matches by the real key instead", () => {
        assert.deepEqual(planCoordinate("TA", spaces), { kind: "keep", value: "TA" });
    });

    it("an absent or blank value means pick", () => {
        assert.deepEqual(planCoordinate(undefined, projects), { kind: "pick" });
        assert.deepEqual(planCoordinate("  ", projects), { kind: "pick" });
    });

    it("an existing value missing from the live list is surfaced for the user, never silently replaced", () => {
        assert.deepEqual(planCoordinate("GONE", projects), { kind: "pick", unverifiedExisting: "GONE" });
    });
});
