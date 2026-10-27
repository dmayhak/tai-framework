import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Persona, Status, StoryType, SubtaskType } from "../schema/story-schema.js";
import { createFilesystemBackend } from "../storage/filesystem-backend.js";
import { toHumanId, type HumanRef } from "../storage/interface.js";
import { recordAttestation } from "../settings/attestation.js";
import { changeAdmin, setSetting } from "./settings.js";
import type { DevTask } from "./do-dev-tasks.js";
import { yoloStopReasons } from "./yolo-checks.js";

const ME: HumanRef = { id: toHumanId("a@b.co"), displayName: "A", email: "a@b.co" };

async function world(run: (w: {
    deps: Parameters<typeof yoloStopReasons>[0];
    task: DevTask;
    add: (type: SubtaskType, status?: Status) => Promise<string>;
    on: () => Promise<void>;
}) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-yolo-"));
    try {
        const backend = createFilesystemBackend(dir, ME);
        const mk = (over: Record<string, unknown>) => backend.workTracker.createIssue({ projectKey: "TAI", persona: Persona.Developer, summary: "s", ...over } as never);
        const story = await mk({ issueType: StoryType.Story });
        const dev = await mk({ issueType: SubtaskType.Dev, parentKey: story.key, assignee: ME });
        const taiDir = path.join(dir, ".tai");
        const ctx = { docStore: backend.docStore, spaceKey: "TAIT", email: "a@b.co", aiSession: false };
        await run({
            deps: { workTracker: backend.workTracker, docStore: backend.docStore, spaceKey: "TAIT", projectKey: "TAI", taiDir, email: "a@b.co" },
            task: { issue: dev, parent: story },
            add: async (type, status) => {
                const t = await mk({ issueType: type, parentKey: story.key });
                if (status) await backend.workTracker.transition(t.key, status);
                return t.key;
            },
            on: async () => {
                await changeAdmin(ctx, "add", "a@b.co");
                await setSetting({ ...ctx, attest: (e, k, v) => recordAttestation(taiDir, e, k, v) }, "dev-yolo", "true");
            },
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("yoloStopReasons (TAI-634)", () => {
    it("lets a ticket run when DEV-YOLO is on, the person is an admin, the record exists and nothing needs a person", () =>
        world(async ({ deps, task, on }) => {
            await on();
            assert.deepEqual(await yoloStopReasons(deps, task), []);
        }));

    it("says why when DEV-YOLO is off, there is no admin list and no record", () =>
        world(async ({ deps, task }) => {
            const reasons = await yoloStopReasons(deps, task);
            assert.equal(reasons.length, 3);
            assert.match(reasons.join("\n"), /DEV-YOLO is off for a@b.co/);
            assert.match(reasons.join("\n"), /not on the Autonomy admins list \(it is empty\)/);
            assert.match(reasons.join("\n"), /no record that you turned DEV-YOLO on/);
        }));

    it("does not take the page alone as proof: the value and the admin entry are there but this machine has no record", () =>
        world(async ({ deps, task }) => {
            const ctx = { docStore: deps.docStore, spaceKey: "TAIT", email: "a@b.co", aiSession: false };
            await changeAdmin(ctx, "add", "a@b.co");
            await setSetting(ctx, "dev-yolo", "true"); // no attest: as if the page had been edited by hand
            const reasons = await yoloStopReasons(deps, task);
            assert.equal(reasons.length, 1);
            assert.match(reasons[0]!, /no record that you turned DEV-YOLO on/);
        }));

    it("a person re-running the set command supplies a missing record even though the page already holds the value", () =>
        world(async ({ deps, task }) => {
            const ctx = { docStore: deps.docStore, spaceKey: "TAIT", email: "a@b.co", aiSession: false };
            await changeAdmin(ctx, "add", "a@b.co");
            await setSetting(ctx, "dev-yolo", "true");
            const out = await setSetting({ ...ctx, attest: (e, k, v) => recordAttestation(deps.taiDir, e, k, v) }, "dev-yolo", "true");
            assert.match(out, /already true/);
            assert.deepEqual(await yoloStopReasons(deps, task), []);
        }));

    it("stops on a Database change, a UAT and each test tier on the Story, but not a cancelled one or other types", () =>
        world(async ({ deps, task, on, add }) => {
            await on();
            const db = await add(SubtaskType.Database, Status.Done);
            const uat = await add(SubtaskType.Uat);
            const it_ = await add(SubtaskType.IntegrationTest, Status.InProgress);
            await add(SubtaskType.SystemTest, Status.Canceled);
            await add(SubtaskType.Infra);
            const reasons = (await yoloStopReasons(deps, task)).join("\n");
            assert.match(reasons, new RegExp(`a Database change \\(${db}\\)`));
            assert.match(reasons, new RegExp(`a UAT \\(${uat}\\)`));
            assert.match(reasons, new RegExp(`an IntegrationTest \\(${it_}\\)`));
            assert.doesNotMatch(reasons, /SystemTest|Infra/);
        }));

    it("stops with one reason when no user is configured", () =>
        world(async ({ deps, task }) => {
            const reasons = await yoloStopReasons({ ...deps, email: null }, task);
            assert.equal(reasons.length, 1);
            assert.match(reasons[0]!, /no user is configured/);
        }));
    it("a failed page save leaves no record", () =>
        world(async ({ deps }) => {
            const ctx = { docStore: deps.docStore, spaceKey: "TAIT", email: "a@b.co", aiSession: false };
            await changeAdmin(ctx, "add", "a@b.co");
            const failing = { ...deps.docStore, updatePage: async () => { throw new Error("write failed"); }, createPage: async () => { throw new Error("write failed"); } } as typeof deps.docStore;
            await assert.rejects(setSetting({ ...ctx, docStore: failing, attest: (e, k, v) => recordAttestation(deps.taiDir, e, k, v) }, "dev-yolo", "true"), /write failed/);
            assert.match((await yoloStopReasons(deps, { issue: {} as never, parent: { key: "TAI-1" } as never })).join("\n"), /no record that you turned DEV-YOLO on/);
        }));
});

describe("yoloStopReasons for one run (TAI-693)", () => {
    it("lets a ticket run with the setting off when this machine holds the one-run record and the person is an admin", () =>
        world(async ({ deps, task }) => {
            const ctx = { docStore: deps.docStore, spaceKey: "TAIT", email: "a@b.co", aiSession: false };
            await changeAdmin(ctx, "add", "a@b.co");
            await recordAttestation(deps.taiDir, "a@b.co", "dev-yolo-once", "true");
            assert.deepEqual(await yoloStopReasons({ ...deps, oneRun: true }, task), []);
            assert.match((await yoloStopReasons(deps, task)).join("\n"), /DEV-YOLO is off for a@b\.co/);
        }));

    it("stops when the one-run record is missing, and does not take the setting's own record in its place", () =>
        world(async ({ deps, task, on }) => {
            await on();
            await rm(path.join(deps.taiDir, "autonomy-attestations.json"));
            await recordAttestation(deps.taiDir, "a@b.co", "dev-yolo", "true");
            assert.match((await yoloStopReasons({ ...deps, oneRun: true }, task)).join("\n"), /no record that you turned DEV-YOLO on for this run/);
        }));

    it("the one-run record does not stand in for the setting's: without oneRun a ticket still needs the setting and its record", () =>
        world(async ({ deps, task }) => {
            const ctx = { docStore: deps.docStore, spaceKey: "TAIT", email: "a@b.co", aiSession: false };
            await changeAdmin(ctx, "add", "a@b.co");
            await recordAttestation(deps.taiDir, "a@b.co", "dev-yolo-once", "true");
            const reasons = (await yoloStopReasons(deps, task)).join("\n");
            assert.match(reasons, /DEV-YOLO is off/);
            assert.match(reasons, /no record that you turned DEV-YOLO on;/);
        }));

    it("still stops on a Database change under a one-run override", () =>
        world(async ({ deps, task, add }) => {
            const ctx = { docStore: deps.docStore, spaceKey: "TAIT", email: "a@b.co", aiSession: false };
            await changeAdmin(ctx, "add", "a@b.co");
            await recordAttestation(deps.taiDir, "a@b.co", "dev-yolo-once", "true");
            await add(SubtaskType.Database);
            assert.match((await yoloStopReasons({ ...deps, oneRun: true }, task)).join("\n"), /a Database change/);
        }));
});
