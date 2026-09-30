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
        assert.deepEqual(await listJiraProjects(client), [
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
        assert.deepEqual((await listJiraProjects(client)).map((p) => p.key), ["A", "B", "C"]);
    });

    it("stops on an empty page even if isLast is missing (no infinite loop)", async () => {
        const client = clientFor({
            "GET /rest/api/2/project/search?startAt=0&maxResults=50": () => json({ values: [{ key: "A", name: "a" }] }),
            "GET /rest/api/2/project/search?startAt=1&maxResults=50": () => json({ values: [] }),
        });
        assert.deepEqual((await listJiraProjects(client)).map((p) => p.key), ["A"]);
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
        const spaces = await listConfluenceSpaces(client);
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
        const spaces = await listConfluenceSpaces(client);
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
        assert.deepEqual((await listConfluenceSpaces(client)).map((s) => s.key), ["A", "B"]);
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

describe("detectBitbucketRepo", () => {
    const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });

    it("reads the raw origin URL from a real repo", async () => {
        await withTempDir(async (dir) => {
            git(dir, "init", "-q");
            git(dir, "remote", "add", "origin", "git@bitbucket.org:a/b.git");
            assert.equal(await detectBitbucketRepo(dir), "a/b");
        });
    });

    it("is null for a non-Bitbucket remote, no remote, and a non-repo", async () => {
        await withTempDir(async (dir) => {
            assert.equal(await detectBitbucketRepo(dir), null);
            git(dir, "init", "-q");
            assert.equal(await detectBitbucketRepo(dir), null);
            git(dir, "remote", "add", "origin", "git@github.com:a/b.git");
            assert.equal(await detectBitbucketRepo(dir), null);
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
        const d = decidePick("homes", projects, projects);
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
