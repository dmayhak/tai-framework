import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findProject, parseProjects, redactRemote, resolveServiceRoot, runServiceSetup, sameRemote, shellQuote, type PathState, type SetupDeps } from "./setup.js";
import { realSetupFs, setupStillMissing } from "./real.js";

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

    it("expands a leading ~ in a clone path to the home directory", () => {
        const [a, b, c] = parseProjects(JSON.stringify({ projects: [{ ...ENTRY, clone: "~/work/tai" }, { key: "b", remote: "r", clone: "~" }, { key: "c", remote: "r", clone: "~x/c" }] }), ROOT, CONFIG, "/home/u");
        assert.equal(a!.clone, "/home/u/work/tai");
        assert.equal(b!.clone, "/home/u");
        assert.equal(c!.clone, "/svc/~x/c");
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

    it("lower-cases the host but not the path, which a host may keep case-sensitive", () => {
        assert.ok(sameRemote("https://GitHub.com/x/tai", "https://github.com/x/tai"));
        assert.ok(sameRemote("git@GitHub.com:x/tai.git", "git@github.com:x/tai"));
        assert.ok(!sameRemote("https://github.com/x/Tai", "https://github.com/x/tai"));
        assert.ok(!sameRemote("/srv/Repos/tai", "/srv/repos/tai"));
        assert.ok(!sameRemote("Git@github.com:x/tai", "git@github.com:x/tai"));
        assert.ok(!sameRemote("https://Bob@github.com/x/tai", "https://bob@github.com/x/tai"));
        assert.ok(sameRemote("https://bob@GitHub.com/x/tai", "https://bob@github.com/x/tai"));
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

const ARGS = { project: "tai", root: ROOT, from: "/me/checkout" };
const PROJECTS = JSON.stringify({ projects: [ENTRY, { key: "second", remote: "git@github.com:x/second.git" }] });

describe("what setup prints is safe to read and to paste (TAI-775 review)", () => {
    it("quotes a path only when it needs it", () => {
        assert.equal(shellQuote("/svc/tai/repo"), "/svc/tai/repo");
        assert.equal(shellQuote("/my svc/repo"), "'/my svc/repo'");
        assert.equal(shellQuote("/it's/repo"), `'/it'\\''s/repo'`);
    });

    it("leaves credentials written into a remote URL out of what it prints", () => {
        assert.equal(redactRemote("https://user:tok-1@github.com/x/tai.git"), "https://github.com/x/tai.git");
        assert.equal(redactRemote("git@github.com:x/tai.git"), "git@github.com:x/tai.git");
        assert.equal(redactRemote("https://user:p@ss@github.com/x/tai"), "https://github.com/x/tai");
        assert.equal(redactRemote("fatal: https://u:t1@a.com/x then https://u:t2@b.com/y"), "fatal: https://a.com/x then https://b.com/y");
        assert.equal(redactRemote("https://github.com/x/tai@v1"), "https://github.com/x/tai@v1");
    });

    it("prints no credential from the remote, on a fresh clone, a re-run or a refusal", async () => {
        const remote = "https://user:tok-77@github.com/x/tai.git";
        const projects = JSON.stringify({ projects: [{ key: "tai", remote }] });
        const f = fake({}, { [CONFIG]: projects });
        await runServiceSetup(ARGS, f.deps);
        await runServiceSetup(ARGS, f.deps);
        const other = fake({ "/svc/tai/repo": { kind: "clone", remote: "https://u:tok-88@github.com/x/else.git" } }, { [CONFIG]: projects });
        const refusal = await runServiceSetup(ARGS, other.deps).then(() => "", (e: Error) => e.message);
        assert.ok(!`${f.said.join("\n")}${refusal}`.match(/tok-77|tok-88/));
        assert.match(refusal, /github\.com\/x\/else/);
    });

    it("quotes the clone path in the run command it prints, and says what `tai` is", async () => {
        const f = fake({}, { "/my svc/projects.json": PROJECTS });
        await runServiceSetup({ ...ARGS, root: "/my svc" }, { ...f.deps, stillMissing: async () => null });
        const out = f.said.join("\n");
        assert.match(out, /service run clone='\/my svc\/tai\/repo'/);
        assert.match(out, /tai --project '\/my svc\/tai\/repo' settings set dev-yolo true/);
        assert.match(out, /bin\/tai-link/);
    });
});

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
            if (found.kind === "clone" && found.remote !== null) await assert.rejects(runServiceSetup(ARGS, f.deps), new RegExp(`set its "remote" back to ${found.remote.replace(/\W/g, ".")}`));
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

    it("a closing check that cannot answer is said, after the hand-off, and does not end the command in an error", async () => {
        const f = fake({}, { [CONFIG]: PROJECTS });
        const result = await runServiceSetup(ARGS, { ...f.deps, stillMissing: async () => Promise.reject(new Error("Jira did not answer")) });
        assert.equal(result.changed, true);
        assert.match(f.said.at(-2)!, /Still missing: could not check what is still missing \(Jira did not answer\)/);
        assert.match(f.said.at(-1)!, /branch, not main/);
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

describe("setup end to end over real directories and a local repository, and its closing check (offline)", () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "tai-setup-e2e-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("makes the clone, copies the rules and not the .env, and a second run changes nothing", async () => {
        const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
        const origin = join(dir, "origin");
        await mkdir(origin);
        execFileSync("git", ["init", "-q"], { cwd: origin });
        await writeFile(join(origin, "a.txt"), "a");
        execFileSync("git", ["add", "."], { cwd: origin });
        execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: origin, env });
        const mine = join(dir, "my checkout");
        await mkdir(join(mine, ".claude"), { recursive: true });
        await writeFile(join(mine, ".claude", "settings.local.json"), '{"permissions":{}}');
        await writeFile(join(mine, ".env"), "TAI_JIRA_API_TOKEN=tok-5");
        const root = join(dir, "root");
        await mkdir(root);
        await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ key: "demo", remote: origin }] }));

        const said: string[] = [];
        const deps = { ...realSetupFs, say: (l: string) => said.push(l), stillMissing: (c: string) => setupStillMissing(c, {}) };
        assert.equal((await runServiceSetup({ project: "demo", root, from: mine }, deps)).changed, true);
        const clone = join(root, "demo", "repo");
        assert.equal(await readFile(join(clone, ".claude", "settings.local.json"), "utf8"), '{"permissions":{}}');
        assert.ok((await stat(join(clone, ".tai"))).isDirectory());
        await assert.rejects(stat(join(clone, ".env")));
        assert.match(said.join("\n"), /Still missing: the clone has no \.env/);

        said.length = 0;
        assert.equal((await runServiceSetup({ project: "demo", root, from: mine }, deps)).changed, false);
        assert.match(said.join("\n"), /Nothing changed/);
    });

    it("the closing check names the clone, then the .env, as the preflight does, and skips the AI-session check", async () => {
        assert.match((await setupStillMissing(join(dir, "none"), { CLAUDECODE: "1" }))!, /is missing or is not a git repository/);
        await mkdir(join(dir, "c", ".git"), { recursive: true });
        assert.match((await setupStillMissing(join(dir, "c"), { CLAUDECODE: "1" }))!, /no \.env/);
        await writeFile(join(dir, "c", ".env"), "TAI_JIRA_SITE_URL=https://x\n");
        assert.match((await setupStillMissing(join(dir, "c"), {}))!, /jira credential is incomplete/);
    });

    it("runs the Jira-reading check only when the local pieces pass, and reports its first reason", async () => {
        await mkdir(join(dir, "c", ".git"), { recursive: true });
        const all = "TAI_JIRA_SITE_URL=https://x\nTAI_JIRA_EMAIL=a@b.c\nTAI_JIRA_API_TOKEN=t\nBITBUCKET_EMAIL=a@b.c\nBITBUCKET_API_TOKEN=t\nTAI_REVIEWER_GITHUB_TOKEN=r\nTAI_REVIEWER_EMAIL=r@b.c\n";
        await writeFile(join(dir, "c", ".env"), all);
        assert.equal(await setupStillMissing(join(dir, "c"), {}, async () => ({ ok: true, reasons: [] })), null);
        assert.equal(await setupStillMissing(join(dir, "c"), {}, async () => ({ ok: false, reasons: ["the attestation is missing", "x"] })), "the attestation is missing");
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

    it("reads the remote as it is stored, not as the person's insteadOf rewriting turns it", async () => {
        const origin = join(dir, "o");
        await mkdir(origin);
        execFileSync("git", ["init", "-q"], { cwd: origin });
        const clone = join(dir, "c");
        execFileSync("git", ["init", "-q", clone]);
        execFileSync("git", ["remote", "add", "origin", "https://example.com/x/tai"], { cwd: clone });
        execFileSync("git", ["config", "url.ssh://git@example.com/.insteadOf", "https://example.com/"], { cwd: clone });
        assert.deepEqual(await realSetupFs.inspect(clone), { kind: "clone", remote: "https://example.com/x/tai" });
    });

    it("a failed clone says why without printing the credentials in the remote", async () => {
        const remote = "https://user:tok-31@127.0.0.1:1/x/tai.git";
        const failure = await realSetupFs.clone(remote, join(dir, "c")).then(() => null, (e: Error) => e);
        const message = failure!.message;
        assert.ok(!JSON.stringify(failure!.cause, Object.getOwnPropertyNames(failure!.cause)).includes("tok-31"), "the cause holds no credential either");
        assert.match(message, /^git clone of https:\/\/127\.0\.0\.1:1\/x\/tai\.git to .* failed: .+/);
        assert.ok(!message.includes("tok-31"), message);
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
