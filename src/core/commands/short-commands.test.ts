import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// TAI-699: the short commands (bin/tai, bin/tai-link) run against a copy of the install whose CLI is a stub that prints what it got.
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin");

interface World {
    readonly home: string;
    readonly links: string;
    readonly project: string;
    readonly run: (name: string, args: string[], over?: { cwd?: string; env?: Record<string, string> }) => { status: number | null; out: string; err: string };
}

async function world(run: (w: World) => Promise<void>): Promise<void> {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "tai-short-")));
    try {
        const home = path.join(root, "home");
        await mkdir(path.join(home, "bin"), { recursive: true });
        await mkdir(path.join(home, "node_modules", ".bin"), { recursive: true });
        await mkdir(path.join(home, "src", "hosts"), { recursive: true });
        for (const f of ["tai", "tai-link"]) {
            await copyFile(path.join(BIN, f), path.join(home, "bin", f));
            await chmod(path.join(home, "bin", f), 0o755);
        }
        await writeFile(path.join(home, "src", "hosts", "cli.ts"), "");
        const stub = path.join(home, "node_modules", ".bin", "tsx");
        await writeFile(stub, '#!/bin/sh\nshift\nprintf "CWD:%s\\n" "$(pwd)"\nfor a in "$@"; do printf "ARG:%s\\n" "$a"; done\n[ "$1" = "fail" ] && exit 7\nexit 0\n');
        await chmod(stub, 0o755);
        const links = path.join(root, "links");
        await mkdir(links);
        for (const n of ["tai", "tai-settings", "tai-do-dev-tasks"]) await symlink(path.join(home, "bin", "tai"), path.join(links, n));
        const project = path.join(root, "project");
        await mkdir(project);
        await writeFile(path.join(project, ".env"), "");
        const base = { PATH: process.env["PATH"] ?? "" };
        await run({
            home,
            links,
            project,
            run: (name, args, over = {}) => {
                const r = spawnSync(path.join(name === "tai-link" ? path.join(home, "bin") : links, name), args, { cwd: over.cwd ?? root, env: { ...base, HOME: root, ...over.env }, encoding: "utf8" });
                return { status: r.status, out: r.stdout, err: r.stderr };
            },
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

const argsOf = (out: string): string[] => out.split("\n").filter((l) => l.startsWith("ARG:")).map((l) => l.slice(4));
const cwdOf = (out: string): string => out.split("\n").find((l) => l.startsWith("CWD:"))!.slice(4);

describe("short commands (TAI-699)", () => {
    it("tai passes every argument through unchanged, spaces and quotes included, and keeps the exit code", () =>
        world(async (w) => {
            const r = w.run("tai", ["issue", "comment", "TAI-1", 'Handoff: "quoted" and  two  spaces', "*"]);
            assert.equal(r.status, 0);
            assert.deepEqual(argsOf(r.out), ["issue", "comment", "TAI-1", 'Handoff: "quoted" and  two  spaces', "*"]);
            assert.equal(w.run("tai", ["fail"]).status, 7);
        }));

    it("tai-settings and tai-do-dev-tasks run the command of that name with the arguments after it", () =>
        world(async (w) => {
            assert.deepEqual(argsOf(w.run("tai-settings", ["set", "dev-yolo", "true"]).out), ["settings", "set", "dev-yolo", "true"]);
            assert.deepEqual(argsOf(w.run("tai-do-dev-tasks", ["yolo=true", "dryrun=true"]).out), ["do-dev-tasks", "yolo=true", "dryrun=true"]);
        }));

    it("runs from the current directory when no project is given, so its .env is the one read", () =>
        world(async (w) => {
            assert.equal(cwdOf(w.run("tai", ["x"], { cwd: w.project }).out), w.project);
        }));

    it("runs from the project given by --project, --project= or TAI_PROJECT, and the flag beats the variable", () =>
        world(async (w) => {
            assert.equal(cwdOf(w.run("tai", ["--project", w.project, "x"]).out), w.project);
            assert.equal(cwdOf(w.run("tai", [`--project=${w.project}`, "x"]).out), w.project);
            assert.equal(cwdOf(w.run("tai", ["x"], { env: { TAI_PROJECT: w.project } }).out), w.project);
            const other = path.join(path.dirname(w.project), "other");
            await mkdir(path.join(other, ".tai"), { recursive: true });
            assert.equal(cwdOf(w.run("tai", ["--project", other, "x"], { env: { TAI_PROJECT: w.project } }).out), other);
            assert.deepEqual(argsOf(w.run("tai", ["--project", w.project, "issue", "get", "TAI-1"]).out), ["issue", "get", "TAI-1"], "the flag is not passed on");
        }));

    it("refuses a path that is missing, is not a directory, or is not a TAI project, and runs nothing", () =>
        world(async (w) => {
            const empty = path.join(path.dirname(w.project), "empty");
            await mkdir(empty);
            const refused = (args: string[], env?: Record<string, string>) => {
                const r = w.run("tai", args, env ? { env } : {});
                assert.equal(r.status, 2);
                assert.equal(r.out, "", "the CLI was not started");
                return r.err;
            };
            assert.match(refused(["--project", path.join(empty, "nope"), "x"]), /is not a directory/);
            assert.match(refused(["--project", empty, "x"]), /is not a TAI project directory/);
            assert.match(refused(["x"], { TAI_PROJECT: empty }), /is not a TAI project directory/);
            assert.match(refused(["--project"]), /--project needs a path/);
        }));

    it("tai-link links the three commands, is safe to repeat, and will not replace a file that is not its own", () =>
        world(async (w) => {
            const dir = path.join(path.dirname(w.project), "onpath");
            await mkdir(dir);
            const first = w.run("tai-link", [dir]);
            assert.equal(first.status, 0);
            assert.match(first.out, /linked .*\/tai\n/);
            assert.deepEqual(argsOf(spawnSync(path.join(dir, "tai-settings"), ["show"], { encoding: "utf8" }).stdout), ["settings", "show"]);
            assert.match(w.run("tai-link", [dir]).out, /already linked/);
            await rm(path.join(dir, "tai-settings"));
            await writeFile(path.join(dir, "tai-settings"), "mine");
            const clash = w.run("tai-link", [dir]);
            assert.equal(clash.status, 1);
            assert.match(clash.err, /not a link to this install; not touching it/);
            assert.match(w.run("tai-link", [path.join(dir, "nope")]).err, /is not a directory/);
        }));

    it("tai-link --remove takes off its own links only", () =>
        world(async (w) => {
            const dir = path.join(path.dirname(w.project), "onpath");
            await mkdir(dir);
            w.run("tai-link", [dir]);
            await rm(path.join(dir, "tai-do-dev-tasks"));
            await writeFile(path.join(dir, "tai-do-dev-tasks"), "mine");
            const r = w.run("tai-link", ["--remove", dir]);
            assert.equal(r.status, 0);
            assert.match(r.out, /removed .*\/tai\n/);
            assert.match(r.out, /left .*tai-do-dev-tasks: it is not a link to this install/);
            assert.deepEqual(spawnSync("ls", [dir], { encoding: "utf8" }).stdout.trim().split("\n"), ["tai-do-dev-tasks"]);
        }));
});
