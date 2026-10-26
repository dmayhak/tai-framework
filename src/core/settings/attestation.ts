/**
 * TAI Framework — the local record that a person turned an autonomy setting on (TAI-634, ADR page 64782337 decision 9).
 *
 * The `Settings` page and its `Autonomy admins` list are editable by anyone who can edit the Confluence page, so a value read
 * from them is not proof that a person chose it. `tai-settings set` writes this file on the machine where the human ran it,
 * in a plain terminal, and the unattended run requires it as well. A page edited by hand leaves no such record. Like the
 * AI-session check, it guards against a setting raised by accident or by a page edit, not against someone with write access
 * to this checkout.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Attestation {
    readonly email: string;
    readonly key: string;
    readonly value: string;
    readonly at: string;
}

const FILE = "autonomy-attestations.json";

function filePath(taiDir: string): string {
    return path.join(taiDir, FILE);
}

async function readAll(taiDir: string): Promise<Attestation[]> {
    try {
        const parsed: unknown = JSON.parse(await readFile(filePath(taiDir), "utf8"));
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (a): a is Attestation =>
                typeof a === "object" && a !== null && ["email", "key", "value", "at"].every((k) => typeof (a as Record<string, unknown>)[k] === "string")
        );
    } catch {
        return [];
    }
}

/** Records that `email` set `key` to `value` on this machine; replaces that person's earlier record for the key. */
export async function recordAttestation(taiDir: string, email: string, key: string, value: string, now: Date = new Date()): Promise<void> {
    const who = email.toLowerCase();
    const kept = (await readAll(taiDir)).filter((a) => !(a.email === who && a.key === key));
    kept.push({ email: who, key, value, at: now.toISOString() });
    await mkdir(taiDir, { recursive: true });
    const tmp = `${filePath(taiDir)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(kept, null, 2) + "\n", "utf8");
    await rename(tmp, filePath(taiDir));
}

/** True when this machine holds a record that `email` set `key` to `value`. */
export async function hasAttestation(taiDir: string, email: string, key: string, value: string): Promise<boolean> {
    const who = email.toLowerCase();
    return (await readAll(taiDir)).some((a) => a.email === who && a.key === key && a.value === value);
}
