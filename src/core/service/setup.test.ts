import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findProject, parseProjects, resolveServiceRoot, runServiceSetup, sameRemote, type PathState, type SetupDeps } from "./setup.js";
import { realSetupFs } from "./real.js";

const ROOT = "/svc";
const CONFIG = `${ROOT}/projects.json`;
const ENTRY = { key: "tai", remote: "git@github.com:x/tai.git" };

describe("project list (TAI-771 AC-1, AC-7)", () => {
    it("defaults the clone to <root>/<key>/repo and keeps the optional settings", () => {
        const [p] = parseProjects(JSON.stringify({ projects: [{ ...ENTRY, intervalMinutes: 30, waitHours: 5, cap: 3 }] }), ROOT, CONFIG);
        assert.deepEqual(p, { ...ENTRY, clone: "/svc/tai/repo", intervalMinutes: 30, waitHours: 5, cap: 3 });
    });

    it("takes a given clone path, relative to the root", () => {
        const [a, b] = parseProjects(JSON.stringify({ projects: [{ ...ENTRY, clone: "/elsewhere/tai" }, { key: "b", remote: "r", clone: "b-clone" }] }), ROOT, CONFIG);
        assert.equal(a!.clone, "/elsewhere/tai");
        assert.equal(b!.clone, "/svc/b-clone");
    });

    it("refuses what cannot be read, naming the file", () => {
        for (const text of ["not json", "[]", "{}", JSON.stringify({ projects: [{ key: "a" }] }), JSON.stringify({ projects: [{ ...ENTRY, cap: 0 }] }), JSON.stringify({ projects: [{ ...ENTRY, carp: 2 }] }), JSON.stringify({ projects: [{ ...ENTRY, key: "../x" }] }), JSON.stringify({ projects: [ENTRY, ENTRY] })]) {
            assert.throws(() => parseProjects(text, ROOT, CONFIG), new RegExp(CONFIG.replace(/\./g, "\\.")), text);
        }
    });

    it("refuses a project with no entry and names the config file and the projects it has", () => {
        const entries = parseProjects(JSON.stringify({ projects: [ENTRY] }), ROOT, CONFIG);
        assert.equal(findProject(entries, "tai", CONFIG).key, "tai");
        assert.throws(() => findProject(entries, "other", CONFIG), /other.*\/svc\/projects\.json.*tai/);
    });

    it("finds the root from root=, then TAI_SERVICE_ROOT, then the default under the home directory", () => {
        assert.equal(resolveServiceRoot("/a", { TAI_SERVICE_ROOT: "/b" }, "/home/u"), "/a");
        assert.equal(resolveServiceRoot(undefined, { TAI_SERVICE_ROOT: "/b" }, "/home/u"), "/b");
        assert.equal(resolveServiceRoot(undefined, {}, "/home/u"), "/home/u/.local/share/tai-service");
    });

    it("sees one remote written two ways as the same", () => {
        assert.ok(sameRemote("https://github.com/x/tai.git", "https://github.com/x/tai"));
        assert.ok(sameRemote("https://github.com/x/tai/", "https://github.com/x/tai.git"));
        assert.ok(!sameRemote("https://github.com/x/tai", "https://github.com/x/other"));
    });
});

/** An in-memory file system and git, recording every change so a test can say what was touched. */
function fake(state: Record<string, PathState>, files: Record<string, string>) {
    const changes: string[] = [];
    const deps: SetupDeps = {
        readFile: async (p) => files[p] ?? null,
        inspect: async (p) => state[p] ?? { kind: "absent" },
        clone: async (remote, p) => {
            changes.push(`clone ${remote} ${p}`);
            state[p] = { kind: "clone", remote };
        },
        makeDir: async (p) => {
            if (files[p] !== undefined) return;
            changes.push(`mkdir ${p}`);
            files[p] = "<dir>";
        },
        fileExists: async (p) => files[p] !== undefined,
        copyFile: async (from, to) => {
            changes.push(`copy ${from} ${to}`);
            files[to] = files[from]!;
        },
        stillMissing: async () => "the clone has no .env",
        say: (line) => said.push(line),
    };
    const said: string[] = [];
    return { deps, changes, said, files };
}

const ARGS = { project: "tai", root: ROOT, from: "/me/checkout", attestCommand: (clone: string) => `tai --project ${clone} settings set dev-yolo true` };
const PROJECTS = JSON.stringify({ projects: [ENTRY, { key: "second", remote: "git@github.com:x/second.git" }] });

describe("service setup (TAI-771)", () => {
    it("clones the entry's remote to its path, gives the clone its own .tai and copies the permission rules (AC-1, AC-3)", async () => {
        const f = fake({}, { [CONFIG]: PROJECTS, "/me/checkout/.claude/settings.local.json": '{"permissions":{}}' });
        const result = await runServiceSetup(ARGS, f.deps);
        assert.equal(result.changed, true);
        assert.deepEqual(f.changes, ["clone git@github.com:x/tai.git /svc/tai/repo", "mkdir /svc/tai/repo/.tai", "copy /me/checkout/.claude/settings.local.json /svc/tai/repo/.claude/settings.local.json"]);
    });

    it("never copies the person's .env, even from a checkout that has one (AC-3)", async () => {
        const f = fake({}, { [CONFIG]: PROJECTS, "/me/checkout/.env": "TAI_JIRA_API_TOKEN=tok-9f3a1c", "/me/checkout/.claude/settings.local.json": "{}" });
        await runServiceSetup(ARGS, f.deps);
        assert.ok(f.changes.every((c) => !c.includes(".env")), f.changes.join("\n"));
        assert.equal(f.files["/svc/tai/repo/.env"], undefined);
        assert.ok(!f.said.join("\n").includes("tok-9f3a1c"));
    });

    it("refuses a project with no entry before touching anything (AC-1)", async () => {
        const f = fake({}, { [CONFIG]: PROJECTS });
        await assert.rejects(runServiceSetup({ ...ARGS, project: "nope" }, f.deps), /nope.*projects\.json/);
        assert.deepEqual(f.changes, []);
    });

    it("refuses a missing config file, naming it and what an entry holds", async () => {
        const f = fake({}, {});
        await assert.rejects(runServiceSetup(ARGS, f.deps), /\/svc\/projects\.json.*"remote"/s);
        assert.deepEqual(f.changes, []);
    });

    it("a second run on the same clone changes nothing and says so (AC-2)", async () => {
        const f = fake({}, { [CONFIG]: PROJECTS, "/me/checkout/.claude/settings.local.json": "{}" });
        await runServiceSetup(ARGS, f.deps);
        f.changes.length = 0;
        f.said.length = 0;
        const again = await runServiceSetup(ARGS, f.deps);
        assert.equal(again.changed, false);
        assert.deepEqual(f.changes, []);
        assert.match(f.said.join("\n"), /Nothing changed/);
    });

    it("a re-run treats the same remote written another way as the same clone (AC-2)", async () => {
        const f = fake({ "/svc/tai/repo": { kind: "clone", remote: "git@github.com:x/tai" } }, { [CONFIG]: PROJECTS, "/svc/tai/repo/.tai": "<dir>", "/svc/tai/repo/.claude/settings.local.json": "{}", "/me/checkout/.claude/settings.local.json": "{}" });
        assert.equal((await runServiceSetup(ARGS, f.deps)).changed, false);
    });

    it("a re-run keeps a settings file the clone already has instead of overwriting it (AC-2)", async () => {
        const f = fake({ "/svc/tai/repo": { kind: "clone", remote: ENTRY.remote } }, { [CONFIG]: PROJECTS, "/svc/tai/repo/.tai": "<dir>", "/svc/tai/repo/.claude/settings.local.json": "edited", "/me/checkout/.claude/settings.local.json": "new" });
        await runServiceSetup(ARGS, f.deps);
        assert.equal(f.files["/svc/tai/repo/.claude/settings.local.json"], "edited");
    });

    it("refuses a path that exists and is not that clone, and leaves it untouched (AC-2)", async () => {
        for (const found of [{ kind: "other" }, { kind: "clone", remote: "git@github.com:x/different.git" }, { kind: "clone", remote: null }] as const) {
            const f = fake({ "/svc/tai/repo": found }, { [CONFIG]: PROJECTS, "/me/checkout/.claude/settings.local.json": "{}" });
            await assert.rejects(runServiceSetup(ARGS, f.deps), /\/svc\/tai\/repo.*not/s);
            assert.deepEqual(f.changes, []);
        }
    });

    it("clones into an empty directory", async () => {
        const f = fake({ "/svc/tai/repo": { kind: "empty-dir" } }, { [CONFIG]: PROJECTS });
        await runServiceSetup(ARGS, f.deps);
        assert.equal(f.changes[0], "clone git@github.com:x/tai.git /svc/tai/repo");
    });

    it("says so when the person's checkout has no settings file, and goes on", async () => {
        const f = fake({}, { [CONFIG]: PROJECTS });
        await runServiceSetup(ARGS, f.deps);
        assert.match(f.said.join("\n"), /no \.claude\/settings\.local\.json in \/me\/checkout/);
        assert.ok(f.changes.every((c) => !c.startsWith("copy")));
    });

    it("does not copy a file onto itself when from= is the clone", async () => {
        const f = fake({}, { [CONFIG]: PROJECTS });
        await runServiceSetup({ ...ARGS, from: "/svc/tai/repo" }, f.deps);
        assert.ok(f.changes.every((c) => !c.startsWith("copy")));
    });

    it("does not write the attestation; it prints the command for a plain terminal against the clone (AC-4)", async () => {
        const f = fake({}, { [CONFIG]: PROJECTS });
        await runServiceSetup(ARGS, f.deps);
        const out = f.said.join("\n");
        assert.match(out, /plain terminal/);
        assert.match(out, /tai --project \/svc\/tai\/repo settings set dev-yolo true/);
        assert.ok(f.changes.every((c) => !/attest|settings set/.test(c)));
    });

    it("prints what the clone's .env needs, by role, from the preflight's own role table (AC-5)", async () => {
        const f = fake({}, { [CONFIG]: PROJECTS });
        await runServiceSetup(ARGS, f.deps);
        const out = f.said.join("\n");
        for (const [role, variable] of [["jira", "TAI_JIRA_API_TOKEN"], ["git-host", "BITBUCKET_API_TOKEN"], ["git-host", "GITHUB_TOKEN"], ["reviewer", "TAI_REVIEWER_GITHUB_TOKEN"], ["merge", "BITBUCKET_EMAIL"]] as const) {
            assert.match(out, new RegExp(`${role}.*${variable}`), `${role} ${variable}`);
        }
        assert.match(out, /\/svc\/tai\/repo\/\.env/);
    });

    it("ends with what is still missing and the line about working on a branch, not main (AC-6)", async () => {
        const f = fake({}, { [CONFIG]: PROJECTS });
        await runServiceSetup(ARGS, f.deps);
        const lines = f.said;
        assert.match(lines.at(-2)!, /Still missing: the clone has no \.env/);
        assert.match(lines.at(-1)!, /branch, not main.*your own checkout/);
    });

    it("says nothing is missing when the check passes (AC-6)", async () => {
        const f = fake({}, { [CONFIG]: PROJECTS });
        await runServiceSetup(ARGS, { ...f.deps, stillMissing: async () => null });
        assert.match(f.said.at(-2)!, /Nothing is missing.*service run clone=\/svc\/tai\/repo/);
    });

    it("a second project is a config entry only (AC-7)", async () => {
        const f = fake({}, { [CONFIG]: PROJECTS });
        await runServiceSetup({ ...ARGS, project: "second" }, f.deps);
        assert.equal(f.changes[0], "clone git@github.com:x/second.git /svc/second/repo");
    });
});

describe("the real file system and git behind setup (offline)", () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "tai-setup-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

    it("clones a repository, then sees it as that clone, and tells other paths apart", async () => {
        const origin = join(dir, "origin");
        await mkdir(origin);
        git(origin, "init", "-q");
        await writeFile(join(origin, "a.txt"), "a");
        git(origin, "add", ".");
        git(origin, "commit", "-q", "-m", "first");

        const target = join(dir, "root", "tai", "repo");
        assert.deepEqual(await realSetupFs.inspect(target), { kind: "absent" });
        await realSetupFs.clone(origin, target);
        assert.deepEqual(await realSetupFs.inspect(target), { kind: "clone", remote: origin });

        await mkdir(join(dir, "empty"));
        assert.deepEqual(await realSetupFs.inspect(join(dir, "empty")), { kind: "empty-dir" });
        await writeFile(join(dir, "file"), "x");
        assert.deepEqual(await realSetupFs.inspect(join(dir, "file")), { kind: "other" });
        await mkdir(join(dir, "plain"));
        await writeFile(join(dir, "plain", "x"), "x");
        assert.deepEqual(await realSetupFs.inspect(join(dir, "plain")), { kind: "other" });
        const bare = join(dir, "norigin");
        await mkdir(bare);
        git(bare, "init", "-q");
        assert.deepEqual(await realSetupFs.inspect(bare), { kind: "clone", remote: null });
    });

    it("copies a file into a directory that does not exist yet, and makes a directory once", async () => {
        await writeFile(join(dir, "s.json"), "{}");
        await realSetupFs.copyFile(join(dir, "s.json"), join(dir, "c", ".claude", "settings.local.json"));
        assert.equal(await readFile(join(dir, "c", ".claude", "settings.local.json"), "utf8"), "{}");
        await realSetupFs.makeDir(join(dir, "c", ".tai"));
        await realSetupFs.makeDir(join(dir, "c", ".tai"));
        assert.ok((await stat(join(dir, "c", ".tai"))).isDirectory());
        assert.equal(await realSetupFs.fileExists(join(dir, "c", ".tai")), true);
        assert.equal(await realSetupFs.fileExists(join(dir, "nope")), false);
    });
});
