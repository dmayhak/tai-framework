import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { hasAttestation, recordAttestation } from "./attestation.js";

async function inDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(path.join(tmpdir(), "tai-attest-"));
    try {
        await run(path.join(dir, ".tai"));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe("autonomy attestation (TAI-634)", () => {
    it("has nothing until a person records a value, and matches email without case", () =>
        inDir(async (dir) => {
            assert.equal(await hasAttestation(dir, "a@b.co", "dev-yolo", "true"), false);
            await recordAttestation(dir, "A@B.co", "dev-yolo", "true");
            assert.equal(await hasAttestation(dir, "a@b.co", "dev-yolo", "true"), true);
            assert.equal(await hasAttestation(dir, "x@y.co", "dev-yolo", "true"), false);
            assert.equal(await hasAttestation(dir, "a@b.co", "review-rounds", "true"), false);
        }));

    it("a later record replaces the earlier one for that person and key, and keeps others", () =>
        inDir(async (dir) => {
            await recordAttestation(dir, "a@b.co", "dev-yolo", "true");
            await recordAttestation(dir, "x@y.co", "dev-yolo", "true");
            await recordAttestation(dir, "a@b.co", "dev-yolo", "false");
            assert.equal(await hasAttestation(dir, "a@b.co", "dev-yolo", "true"), false);
            assert.equal(await hasAttestation(dir, "a@b.co", "dev-yolo", "false"), true);
            assert.equal(await hasAttestation(dir, "x@y.co", "dev-yolo", "true"), true);
        }));

    it("a file that is not valid reads as no record", () =>
        inDir(async (dir) => {
            await recordAttestation(dir, "a@b.co", "dev-yolo", "true");
            await writeFile(path.join(dir, "autonomy-attestations.json"), "not json");
            assert.equal(await hasAttestation(dir, "a@b.co", "dev-yolo", "true"), false);
        }));
});
