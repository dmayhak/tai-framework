/**
 * Runs the shared conformance suite (TAI-15) against the filesystem backend. Always runs,
 * offline, no credentials — this is the "does it stay green without network access" half
 * of the suite's job.
 */
import { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFilesystemBackend } from "./filesystem-backend.js";
import { toHumanId } from "./interface.js";
import { defineStorageConformance, type ConformanceHarness } from "./conformance.js";

const CURRENT_USER = { id: toHumanId("conformance-tester"), displayName: "Conformance Tester" };
const NOBODY = { id: toHumanId("nonexistent-human"), displayName: "Nobody" };

let tmpRoot: string | undefined;

after(async () => {
    // Fixture disposal is a no-op below (see disposeIssue/disposePage) — the whole tmp
    // directory is what actually gets torn down, once, here.
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

defineStorageConformance("filesystem", async (): Promise<ConformanceHarness> => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "tai-conformance-"));
    const backend = createFilesystemBackend(tmpRoot, CURRENT_USER);

    return {
        backend,
        projectKey: "TAI",
        spaceKey: "TAI",
        capabilities: {
            strictWorkflow: false, // permissive by design — every Status reachable from every Status
            validatesAssignee: false, // no external directory to validate an assignee against
            answersPageToIssueLinks: true, // reads its own local link index directly
        },
        validAssignee: CURRENT_USER,
        invalidAssignee: NOBODY, // "invalid" has no meaning here; capability flag documents that
        async disposeIssue() {
            // No-op: the whole tmp root is removed once, in the outer `after` above.
        },
        async disposePage() {
            // Same.
        },
    };
});
