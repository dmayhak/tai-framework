import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLock } from "./lock.js";
import { parseServiceUnitArgs, realTimerDeps } from "./real.js";
import type { ProjectEntry } from "./setup.js";
import { readPause, writeLastRun, writeLimitedUntil, noteFailedPreflight } from "./state.js";
import { installTimer, kickService, nextTickFrom, pauseAll, pauseProjects, resumeAll, renderUnits, resumeProjects, serviceStatus, serviceStatusAll, installedRoot, uninstallTimer, unitWord, type SystemctlResult, type TimerDeps } from "./timer.js";

let root: string;
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tai-timer-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const entry = (over: Partial<ProjectEntry> = {}): ProjectEntry => ({ key: "tai", remote: "git@x:y/z.git", clone: "/data/svc/tai/repo", ...over });
const SVC = "/data/svc";
const OK: SystemctlResult = { code: 0, stdout: "", stderr: "" };

/** A fake machine: files in a map, `systemctl` calls recorded, and every answer settable. */
function fake(over: Partial<TimerDeps> & { listTimers?: string; systemctl?: (args: readonly string[]) => SystemctlResult | Promise<SystemctlResult> } = {}) {
    const files = new Map<string, string>();
    const calls: string[] = [];
    const said: string[] = [];
    const deps: TimerDeps = {
        platform: "linux",
        unitDir: "/home/u/.config/systemd/user",
        readFile: async (p) => files.get(p) ?? null,
        writeFile: async (p, t) => void files.set(p, t),
        removeFile: async (p) => files.delete(p),
        systemctl: async (args) => {
            calls.push(args.join(" "));
            if (over.systemctl) return over.systemctl(args);
            if (args[0] === "list-timers") return { code: 0, stdout: over.listTimers ?? "", stderr: "" };
            if (args[0] === "is-failed") return { code: 1, stdout: "active\n", stderr: "" };
            return OK;
        },
        command: ["/usr/bin/node", "--import", "tsx", "/opt/tai/src/hosts/cli.ts"],
        path: "/usr/bin:/home/u/.local/bin",
        lingerEnabled: async () => true,
        user: "u",
        now: () => new Date("2026-11-22T12:00:00Z"),
        isAlive: () => true,
        aiSession: () => false,
        say: (l) => void said.push(l),
        ...over,
    };
    return { deps, files, calls, said };
}

describe("unit files (TAI-772 AC-1)", () => {
    it("writes the oneshot service with the clone, state, wait and cap from the entry, and the timer from OnUnitInactiveSec", () => {
        const { service, timer } = renderUnits(entry({ intervalMinutes: 45, waitHours: 2, cap: 5 }), ["/usr/bin/node", "/opt/tai/cli.ts"], "/usr/bin", SVC);
        assert.match(service, /Type=oneshot/);
        assert.match(service, /ExecStart=\/usr\/bin\/node \/opt\/tai\/cli\.ts service run clone=\/data\/svc\/tai\/repo state=\/data\/svc\/tai root=\/data\/svc wait=2 cap=5/);
        assert.match(service, /Environment=PATH=\/usr\/bin/);
        assert.match(timer, /OnBootSec=2min/);
        assert.match(timer, /OnActiveSec=1min/);
        assert.match(timer, /OnUnitInactiveSec=45min/);
        assert.match(timer, /Unit=tai-dev@tai\.service/);
        assert.match(timer, /WantedBy=timers\.target/);
    });

    it("defaults to 30 minutes, 5 hours and 3 tickets, and is the same text every time", () => {
        const a = renderUnits(entry(), ["/n"], undefined, SVC);
        assert.match(a.timer, /OnUnitInactiveSec=30min/);
        assert.match(a.service, /wait=5 cap=3/);
        assert.doesNotMatch(a.service, /Environment=/);
        assert.deepEqual(renderUnits(entry(), ["/n"], undefined, SVC), a);
    });

    it("quotes a word with a space and doubles the characters systemd reads", () => {
        assert.equal(unitWord("/a b/c"), '"/a b/c"');
        assert.equal(unitWord("100%"), '"100%%"');
        assert.equal(unitWord("$HOME"), '"$$HOME"');
        assert.equal(unitWord('say "x"'), '"say \\"x\\""');
        assert.equal(unitWord("clone=/plain/path"), "clone=/plain/path");
        assert.equal(unitWord("PATH=/a/$b", false), '"PATH=/a/$b"', "no variables in Environment=: a $ stays as it is");
        assert.equal(unitWord("PATH=/a/100%", false), '"PATH=/a/100%%"', "a % is a specifier there too");
    });

    it("install writes both units, reloads and enables the timer, and a re-run gives the same files without a reload", async () => {
        const { deps, files, calls, said } = fake();
        assert.deepEqual(await installTimer(entry(), deps, SVC), { changed: true });
        assert.ok(said.some((l) => l.includes("running /usr/bin/node --import tsx /opt/tai/src/hosts/cli.ts")), "install names the command the unit runs");
        assert.deepEqual([...files.keys()].sort(), ["/home/u/.config/systemd/user/tai-dev@tai.service", "/home/u/.config/systemd/user/tai-dev@tai.timer"]);
        assert.deepEqual(calls.slice(-3), ["daemon-reload", "enable --now tai-dev@tai.timer", "restart tai-dev@tai.timer"], "a changed unit restarts the timer, never the service, so a new interval is in force");
        const before = new Map(files);
        calls.length = 0;
        assert.deepEqual(await installTimer(entry(), deps, SVC), { changed: false });
        assert.deepEqual(files, before);
        assert.ok(!calls.includes("daemon-reload"), "nothing changed, so nothing to reload");
        assert.ok(!calls.some((c) => c.startsWith("restart")), "nor to restart");
        assert.ok(said.some((l) => /Already installed/.test(l)));
    });

    it("install prints the linger line when linger is off, and not when it is on or cannot be told", async () => {
        const off = fake({ lingerEnabled: async () => false });
        await installTimer(entry(), off.deps, SVC);
        assert.ok(off.said.some((l) => l.includes("loginctl enable-linger u")));
        for (const answer of [true, null]) {
            const f = fake({ lingerEnabled: async () => answer });
            await installTimer(entry(), f.deps, SVC);
            assert.ok(!f.said.some((l) => l.includes("enable-linger")));
        }
    });

    it("refuses on another OS, or without systemctl --user, and changes nothing", async () => {
        const mac = fake({ platform: "darwin" });
        await assert.rejects(installTimer(entry(), mac.deps, SVC), /Linux systemd only \(this is darwin\); nothing was changed/);
        assert.equal(mac.files.size, 0);
        assert.equal(mac.calls.length, 0);
        const none = fake({ systemctl: async () => Promise.reject(Object.assign(new Error("spawn systemctl ENOENT"), { code: "ENOENT" })) });
        await assert.rejects(installTimer(entry(), none.deps, SVC), /`systemctl --user` is not available here; nothing was changed/);
        assert.equal(none.files.size, 0);
        const nobus = fake({ systemctl: async (a) => (a[0] === "is-system-running" ? { code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" } : OK) });
        await assert.rejects(installTimer(entry(), nobus.deps, SVC), /cannot reach a user manager/);
        assert.equal(nobus.files.size, 0);
        const refused = fake({ systemctl: async (a) => (a[0] === "is-system-running" ? { code: 1, stdout: "", stderr: "Verbindung abgelehnt" } : OK) });
        await assert.rejects(installTimer(entry(), refused.deps, SVC), /cannot reach a user manager/, "any stderr, in any wording, is a refusal");
        assert.equal(refused.files.size, 0);
        const warned = fake({ systemctl: async (a) => (a[0] === "is-system-running" ? { code: 0, stdout: "running\n", stderr: "a locale warning" } : OK) });
        await installTimer(entry(), warned.deps, SVC);
        assert.ok(warned.files.size > 0, "a warning beside a working answer is not a refusal");
        const degraded = fake({ systemctl: async (a) => (a[0] === "is-system-running" ? { code: 1, stdout: "degraded\n", stderr: "" } : OK) });
        await installTimer(entry(), degraded.deps, SVC);
        assert.ok(degraded.files.size > 0, "a degraded user manager is still one");
    });

    it("a failing systemctl call is reported with its message", async () => {
        const { deps } = fake({ systemctl: async (a) => (a[0] === "enable" ? { code: 1, stdout: "", stderr: "Unit file is masked" } : OK) });
        await assert.rejects(installTimer(entry(), deps, SVC), /`systemctl --user enable --now tai-dev@tai\.timer` failed \(exit 1\): Unit file is masked/);
    });
});

describe("status and the root the unit was installed with", () => {
    it("reads the pause for all where the unit's run does, and says when the given root differs", async () => {
        const other = join(root, "other");
        const e = entry({ clone: join(root, "tai", "repo") });
        const { deps, said } = fake();
        await installTimer(e, deps, root);
        await pauseAll(root, deps);
        said.length = 0;
        await serviceStatus(e, deps, other);
        const out = said.join("\n");
        assert.match(out, /Root: the installed unit uses .* not .*other/);
        assert.match(out, new RegExp(`PAUSED for every project \\(${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/paused\\.json\\)`));
    });
});

describe("the real file calls (an error other than a missing file is raised, not read as absent)", () => {
    it("readFile and removeFile give null/false only for a missing file", async () => {
        const dir = join(root, "units");
        await mkdir(join(dir, "folder", "inner"), { recursive: true });
        const real = realTimerDeps({ XDG_CONFIG_HOME: root }, () => undefined, () => false, root);
        assert.equal(await real.readFile(join(dir, "missing")), null);
        assert.equal(await real.removeFile(join(dir, "missing")), false);
        await assert.rejects(real.readFile(join(dir, "folder")), /EISDIR/);
        await assert.rejects(real.removeFile(join(dir, "folder")), /./, "a folder with things in it cannot be removed as a file");
    });
});

describe("kick and the root the unit was installed with", () => {
    it("reads the root back out of the unit text, quoted or not, with its escapes undone", () => {
        const e = entry();
        for (const r of ["/svc", "/my svc/100%/a$b/\"q\""]) assert.equal(installedRoot(renderUnits(e, ["/usr/bin/node", "cli.ts"], undefined, r).service), r);
        assert.equal(installedRoot("[Service]\nType=oneshot\n"), null);
    });

    it("looks for the pause for all where the unit's run will, not where kick was pointed", async () => {
        const other = join(root, "other");
        const e = entry({ clone: join(root, "tai", "repo") });
        const { deps, calls } = fake();
        await installTimer(e, deps, root);
        await pauseAll(root, deps);
        calls.length = 0;
        await assert.rejects(kickService(e, deps, other), /Every project is paused/, "kick was given another root, but the unit reads this one");
        await resumeAll(root, deps);
        await pauseAll(other, deps);
        await kickService(e, deps, other);
        assert.ok(calls.some((c) => c.startsWith("start")), "a pause in a root the unit does not read does not stop the start");
    });
});

describe("what an AI session may not do", () => {
    it("is refused install and resume (they start unattended runs or lift the safety pause), and nothing changes; pause, uninstall and status stay open", async () => {
        const { deps, files } = fake({ aiSession: () => true });
        await assert.rejects(installTimer(entry(), deps, SVC), /`tai service install` is refused from an AI session/);
        assert.equal(files.size, 0);
        const person = fake();
        await installTimer(entry({ clone: join(root, "tai", "repo") }), person.deps, root);
        await pauseAll(root, person.deps);
        const ai = { ...person.deps, aiSession: () => true };
        await assert.rejects(resumeAll(root, ai), /`tai service resume` is refused from an AI session/);
        await assert.rejects(resumeProjects([entry({ clone: join(root, "tai", "repo") })], ai), /refused from an AI session/);
        assert.notEqual(await readPause(root), null, "the pause is still in force");
        await pauseProjects([entry({ clone: join(root, "tai", "repo") })], ai);
        await serviceStatus(entry({ clone: join(root, "tai", "repo") }), ai, root);
        await uninstallTimer(entry({ clone: join(root, "tai", "repo") }), ai);
    });
});

describe("status with no projects", () => {
    it("says so and still shows the pause for every project", async () => {
        const { deps, said } = fake();
        await serviceStatusAll([], deps, root, "/svc/projects.json");
        assert.match(said.join("\n"), /No projects are listed in \/svc\/projects\.json.*\n.*Pause: none/);
        said.length = 0;
        await pauseAll(root, deps);
        said.length = 0;
        await serviceStatusAll([], deps, root, "/svc/projects.json");
        assert.match(said.join("\n"), /PAUSED for every project/);
    });
});

describe("status with a problem in the project list", () => {
    it("prints each problem as a line and still shows the projects", async () => {
        const { deps, said } = fake();
        await serviceStatusAll([entry()], deps, root, "/svc/projects.json", ["entry 2: clashes"]);
        const text = said.join("\n");
        assert.match(text, /^PROBLEM in the project list: entry 2: clashes/);
        assert.match(text, /tai/);
    });
});

describe("uninstall (TAI-772 AC-2)", () => {
    it("removes nothing when stopping the timer fails for a reason other than 'not loaded'", async () => {
        const { deps, files } = fake();
        await installTimer(entry(), deps, SVC);
        const before = new Map(files);
        const bad = { ...deps, systemctl: async (a: readonly string[]) => (a[0] === "disable" ? { code: 1, stdout: "", stderr: "Failed to connect to bus: No such file or directory" } : OK) };
        await assert.rejects(uninstallTimer(entry(), bad), /Could not stop tai-dev@tai\.timer: Failed to connect to bus: No such file or directory; nothing was removed/);
        assert.deepEqual(files, before);
        const unloaded = { ...deps, systemctl: async (a: readonly string[]) => (a[0] === "disable" ? { code: 1, stdout: "", stderr: "Die Einheit ist nicht geladen." } : a[0] === "show" ? { code: 0, stdout: "not-found\n", stderr: "" } : OK) };
        assert.deepEqual(await uninstallTimer(entry(), unloaded), { removed: true });
        assert.equal(files.size, 0);
    });

    it("stops, disables and removes both units, then reloads", async () => {
        const { deps, files, calls } = fake();
        await installTimer(entry(), deps, SVC);
        calls.length = 0;
        assert.deepEqual(await uninstallTimer(entry(), deps), { removed: true });
        assert.equal(files.size, 0);
        assert.deepEqual(calls.filter((c) => c !== "--version" && c !== "is-system-running"), ["disable --now tai-dev@tai.timer", "daemon-reload"], "the timer is stopped; the service unit, which may be mid-ticket, is not");
    });

    it("names a run still going and says it was not stopped", async () => {
        const state = join(root, "tai");
        const e = entry({ clone: join(state, "repo") });
        await acquireLock(state, { pid: 4242, now: () => new Date("2026-11-22T11:30:00Z"), isAlive: () => true });
        const { deps, said, calls } = fake();
        await installTimer(e, deps, root);
        await uninstallTimer(e, deps);
        assert.match(said.join("\n"), /A run is still going \(pid 4242.*\) and was not stopped.*`tai service pause tai` ends it after its current ticket/);
        assert.ok(!calls.some((c) => c.startsWith("stop ")));
    });

    it("a second uninstall says there is nothing to remove and changes nothing", async () => {
        const { deps, calls, said } = fake({ systemctl: async (a) => (a[0] === "disable" ? { code: 1, stdout: "", stderr: "not loaded" } : a[0] === "show" ? { code: 0, stdout: "not-found\n", stderr: "" } : OK) });
        assert.deepEqual(await uninstallTimer(entry(), deps), { removed: false });
        assert.ok(!calls.some((c) => c.startsWith("daemon-reload") || c.startsWith("stop")));
        assert.ok(said.some((l) => /Nothing to remove/.test(l)));
    });

    it("with the files gone but the timer still loaded in systemd, stops it instead of reporting success", async () => {
        const { deps, calls, said } = fake();
        assert.deepEqual(await uninstallTimer(entry(), deps), { removed: true });
        assert.ok(calls.includes("disable --now tai-dev@tai.timer") && calls.includes("daemon-reload"));
        assert.ok(said.some((l) => /already gone, but systemd still had tai-dev@tai\.timer loaded/.test(l)));
        const bad = fake({ systemctl: async (a) => (a[0] === "disable" ? { code: 1, stdout: "", stderr: "Failed to connect to bus" } : OK) });
        await assert.rejects(uninstallTimer(entry(), bad.deps), /Could not stop tai-dev@tai\.timer.*nothing was changed/);
    });
});

describe("kick (TAI-772 AC-3)", () => {
    it("starts the same service unit the timer starts", async () => {
        const { deps, calls } = fake();
        await installTimer(entry(), deps, SVC);
        calls.length = 0;
        await kickService(entry(), deps, SVC);
        assert.ok(calls.includes("start --no-block tai-dev@tai.service"));
    });

    it("is refused from an AI session with the reason, and starts nothing", async () => {
        const { deps, calls } = fake({ aiSession: () => true });
        await assert.rejects(kickService(entry(), deps, SVC), /refused from an AI session.*plain terminal/);
        assert.equal(calls.length, 0);
    });

    it("says to install first when the unit is not there", async () => {
        const { deps } = fake();
        await assert.rejects(kickService(entry(), deps, SVC), /tai-dev@tai\.service is not installed: run `tai service install tai` first/);
    });

    it("refuses, without starting anything, when every project is paused", async () => {
        const e = entry({ clone: join(root, "tai", "repo") });
        const { deps, calls } = fake();
        await installTimer(e, deps, root);
        await pauseAll(root, deps);
        calls.length = 0;
        await assert.rejects(kickService(e, deps, root), /Every project is paused .*not started.*`tai service resume` first/);
        assert.ok(!calls.some((c) => c.startsWith("start")));
    });

    it("refuses, without starting anything, when the project is paused", async () => {
        const state = join(root, "tai");
        const e = entry({ clone: join(state, "repo") });
        const { deps, calls } = fake();
        await installTimer(e, deps, root);
        await pauseProjects([e], deps);
        calls.length = 0;
        await assert.rejects(kickService(e, deps, root), /tai is paused .*not started/);
        assert.ok(!calls.some((c) => c.startsWith("start")));
    });
});

describe("pause and resume (TAI-772 AC-4)", () => {
    it("a project's pause is its own file, keeps its first time, and resume undoes it", async () => {
        const a = entry({ key: "a", clone: join(root, "a", "repo") });
        const b = entry({ key: "b", clone: join(root, "b", "repo") });
        const { deps, said } = fake();
        await pauseProjects([a], deps);
        assert.notEqual(await readPause(join(root, "a")), null);
        assert.equal(await readPause(join(root, "b")), null, "only the named project");
        await pauseProjects([a], deps);
        assert.ok(said.includes("a was already paused."));
        await resumeProjects([a], deps);
        assert.equal(await readPause(join(root, "a")), null);
        await resumeProjects([a], deps);
        assert.ok(said.includes("a was not paused."));
        assert.equal(b.key, "b");
    });

    it("a pause for every project is one file in the service root, apart from the projects' own, and survives a project being added", async () => {
        const a = entry({ key: "a", clone: join(root, "a", "repo") });
        const { deps, said } = fake();
        await pauseProjects([a], deps);
        await pauseAll(root, deps);
        assert.notEqual(await readPause(root), null);
        await pauseAll(root, deps);
        assert.ok(said.includes(`Every project was already paused (${join(root, "paused.json")}).`), "the message names the file, so a different root= is visible");
        await resumeAll(root, deps);
        assert.equal(await readPause(root), null, "the pause for all is lifted");
        assert.notEqual(await readPause(join(root, "a")), null, "the project's own pause is still there");
        await resumeAll(root, deps);
        assert.ok(said.some((l) => /No pause for every project was set \(.*paused\.json\)/.test(l)));
    });
});

describe("status (TAI-772 AC-6)", () => {
    it("prints the last run, next tick, lock holder, pause, limited-until time and the preflight note", async () => {
        const state = join(root, "tai");
        const e = entry({ clone: join(state, "repo") });
        await mkdir(state, { recursive: true });
        await writeLastRun(state, { started: "2026-11-22T10:00:00.000Z", ended: "2026-11-22T10:20:00.000Z", tickets: [{ key: "TAI-9", state: "pr-opened", detail: "https://pr/9" }], skipped: [{ key: "TAI-8", reason: "a person's own" }], stopReason: "cap reached" });
        await writeLimitedUntil(state, { until: "2026-11-23T00:00:00.000Z", text: "weekly limit" });
        await noteFailedPreflight(state, "the Jira token has expired", new Date("2026-11-22T06:00:00Z"));
        await acquireLock(state, { pid: 4242, now: () => new Date("2026-11-22T11:30:00Z"), isAlive: () => true });
        const listing = "Sun 2026-11-22 12:30:00 UTC 29min left Sun 2026-11-22 10:20:00 UTC 1h 40min ago tai-dev@tai.timer tai-dev@tai.service\n";
        const { deps, said, files } = fake({ listTimers: listing });
        await installTimer(e, deps, root);
        await pauseProjects([e], deps);
        said.length = 0;
        await serviceStatus(e, deps, root);
        const out = said.join("\n");
        assert.match(out, /Next tick: Sun 2026-11-22 12:30:00 UTC 29min left Sun 2026-11-22 10:20:00 UTC 1h 40min ago$/m);
        assert.match(out, /Running now: pid 4242, started 2026-11-22T11:30:00\.000Z \(30 min ago\)/);
        assert.match(out, /Pause: PAUSED since .*tai service resume tai/);
        assert.match(out, /Limited until: 2026-11-23T00:00:00\.000Z \(weekly limit\)/);
        assert.match(out, /Last run: 2026-11-22T10:00:00\.000Z .* to 2026-11-22T10:20:00\.000Z; cap reached/);
        assert.match(out, /TAI-9: pr-opened \(https:\/\/pr\/9\)/);
        assert.match(out, /TAI-8: left alone \(a person's own\)/);
        assert.match(out, /Preflight: FAILING since .*the Jira token has expired[\s\S]*timer shows green/);
        assert.ok(files.size === 2);
    });

    it("shows a pause for every project apart from the project's own", async () => {
        const e = entry({ clone: join(root, "tai", "repo") });
        const { deps, said } = fake();
        await pauseAll(root, deps);
        said.length = 0;
        await serviceStatus(e, deps, root);
        assert.match(said.join("\n"), /Pause: PAUSED for every project \(.*paused\.json\) since .*`tai service resume` lifts it/);
        assert.doesNotMatch(said.join("\n"), /Pause: none/);
    });

    it("says a damaged pause file counts as a pause", async () => {
        const e = entry({ clone: join(root, "tai", "repo") });
        await mkdir(join(root, "tai"), { recursive: true });
        await (await import("node:fs/promises")).writeFile(join(root, "tai", "paused.json"), "{");
        const { deps, said } = fake();
        await serviceStatus(e, deps, root);
        assert.match(said.join("\n"), /Pause: PAUSED \(its file could not be read, so it counts as a pause\)/);
    });

    it("says what is not there: no timer, no run, no pause, no limit, no failure", async () => {
        const e = entry({ clone: join(root, "tai", "repo") });
        const { deps, said } = fake();
        await serviceStatus(e, deps, root);
        const out = said.join("\n");
        assert.match(out, /Timer: not installed \(`tai service install tai`\)/);
        assert.match(out, /no run holds the lock/);
        assert.match(out, /Pause: none/);
        assert.match(out, /not limited/);
        assert.match(out, /Last run: none recorded/);
        assert.match(out, /Preflight: no failure recorded/);
    });

    it("says so when systemd reports the unit failed (the node or checkout the unit pins has moved)", async () => {
        const state = join(root, "tai");
        const e = entry({ clone: join(state, "repo") });
        const { deps, said } = fake({ systemctl: async (a) => (a[0] === "is-failed" ? { code: 0, stdout: "failed\n", stderr: "" } : OK) });
        await installTimer(e, deps, root);
        said.length = 0;
        await serviceStatus(e, deps, root);
        assert.match(said.join("\n"), /Unit: the last run FAILED in systemd.*One cause is a moved node or checkout.*`tai service install tai`/);
    });

    it("a lock whose run is gone is nobody, and an unreadable systemctl is said, not thrown", async () => {
        const state = join(root, "tai");
        const e = entry({ clone: join(state, "repo") });
        await acquireLock(state, { pid: 4242, now: () => new Date("2026-11-22T11:30:00Z"), isAlive: () => true });
        const { deps, said } = fake({ isAlive: () => false, systemctl: async (a) => (a[0] === "list-timers" ? Promise.reject(new Error("boom")) : OK) });
        await installTimer(e, deps, root);
        said.length = 0;
        await serviceStatus(e, deps, root);
        assert.match(said.join("\n"), /no run holds the lock/);
        assert.match(said.join("\n"), /Next tick: not scheduled/);
    });

    it("reads the next tick out of list-timers, and gives null when the timer is not in it", () => {
        assert.equal(nextTickFrom("n/a n/a n/a n/a tai-dev@tai.timer tai-dev@tai.service\n", "tai-dev@tai.timer"), "n/a n/a n/a n/a");
        assert.equal(nextTickFrom("", "tai-dev@tai.timer"), null);
        assert.equal(nextTickFrom("0 timers listed.\n", "tai-dev@tai.timer"), null);
    });
});

describe("parseServiceUnitArgs", () => {
    it("needs a project for install, uninstall and kick, and lets status, pause and resume go without one", () => {
        for (const a of ["install", "uninstall", "kick"] as const) assert.throws(() => parseServiceUnitArgs(a, []), /needs the project/);
        for (const a of ["status", "pause", "resume"] as const) assert.deepEqual(parseServiceUnitArgs(a, []), { project: undefined, root: undefined });
        assert.deepEqual(parseServiceUnitArgs("install", ["tai", "root=/r"]), { project: "tai", root: "/r" });
    });

    it("refuses a second project, a repeated or empty root, and any other flag", () => {
        assert.throws(() => parseServiceUnitArgs("status", ["a", "b"]), /takes one project/);
        assert.throws(() => parseServiceUnitArgs("status", ["root=/a", "root=/b"]), /only one root=/);
        assert.throws(() => parseServiceUnitArgs("status", ["root="]), /root= takes a directory/);
        assert.throws(() => parseServiceUnitArgs("kick", ["tai", "force=true"]), /takes <project> and root=<dir> \(got: force=true\)/);
    });
});
