/**
 * TAI Framework — "PR Reviewers" roster (rev 52, TAI-159 ADR — CodeReview subtask
 * retirement)
 *
 * Answers "which humans are eligible to review a PR" once review stops being a Jira
 * subtask a single Code Reviewer instance owns. Deliberately a SEPARATE Confluence page
 * from the Persona Roster (`personas/roster.ts`) — reviewer eligibility is orthogonal to
 * "who can act as which TAI persona": a senior engineer may be an eligible PR approver
 * without ever acting as a TAI persona, and the two lists can legitimately diverge.
 *
 * Same architecture as `personas/roster.ts` on purpose (DocStore-backed, a pure parse
 * function plus a fetch+cache loader, works against any backend with no `kind`
 * branching) — reuses its `sameHuman`/`tableCells` helpers rather than duplicating them,
 * since this is the same "match a human by id/email/display-name" and "read a markdown
 * table" problem, just against a flat human list instead of a persona-keyed one.
 *
 * Two consumers: `git-pr create` populates `GitHost.createPullRequest`'s `reviewers`
 * field from this list (additive with Bitbucket's own repo-level "default reviewers"
 * setting — Bitbucket unions whoever ends up on the PR, no conflict between the two);
 * `ready.ts`'s `readyToReview` checks whether the current human is on this list before
 * surfacing an open PR as theirs to review.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { sameHuman, tableCells, parseHumanCell } from "../personas/roster.js";
import type { DocStore, HumanRef, PageRef } from "../storage/interface.js";

export const PR_REVIEWERS_TITLE = "PR Reviewers";

/**
 * Parses the PR Reviewers markdown into a flat, de-duplicated human list. Finds the
 * first table with a column whose header looks like a reviewer list ("reviewer",
 * "reviewers", "human", "humans") — same tolerant-of-surrounding-prose posture as
 * `roster.ts`'s `parseRoster`. A single-column table skips the name-matching step
 * (nothing else it could be).
 */
export function parsePrReviewers(markdown: string): readonly HumanRef[] {
    const lines = markdown.split("\n");

    let start = -1;
    for (let i = 0; i < lines.length - 1; i++) {
        const cells = tableCells(lines[i]!);
        const isRule = /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]!);
        if (cells && isRule) {
            start = i;
            break;
        }
    }
    if (start === -1) {
        throw new Error(
            `"${PR_REVIEWERS_TITLE}" has no recognisable table (expected a "| Reviewer |" header, or ` +
                `similar). Refusing to return an empty list, which would silently deny every reviewer.`
        );
    }

    const header = tableCells(lines[start]!)!;
    let reviewerCol = header.findIndex((h) => /reviewer|human/i.test(h));
    if (reviewerCol === -1) {
        if (header.length === 1) {
            reviewerCol = 0;
        } else {
            throw new Error(
                `"${PR_REVIEWERS_TITLE}" table has ${header.length} columns and none look like a reviewer ` +
                    `column (expected one containing "reviewer" or "human"). Refusing to guess which column ` +
                    `to read.`
            );
        }
    }

    const humans: HumanRef[] = [];
    for (let i = start + 2; i < lines.length; i++) {
        const cells = tableCells(lines[i]!);
        if (!cells) break; // table ended
        for (const human of parseHumanCell(cells[reviewerCol] ?? "")) {
            if (!humans.some((h) => sameHuman(h, human))) humans.push(human);
        }
    }
    return humans;
}

/** Does `human` appear on the PR Reviewers list? The check `readyToReview` and
 *  `git-pr create`'s roster-derived reviewer assignment both rely on. */
export function isEligibleReviewer(reviewers: readonly HumanRef[], human: Pick<HumanRef, "id"> & Partial<HumanRef>): boolean {
    return reviewers.some((h) => sameHuman(h, human));
}

// ---------- loading + caching ----------

export interface LoadPrReviewersOptions {
    readonly spaceKey: string;
    readonly projectKey: string;
    /** Cache root; defaults to `.tai/cache`. Set to null to skip caching entirely. */
    readonly cacheRoot?: string | null;
    readonly title?: string;
}

function cachePath(cacheRoot: string, projectKey: string): string {
    return path.join(cacheRoot, projectKey, "pr-reviewers.json");
}

/**
 * Fetch the PR Reviewers page through DocStore, parse it, and (unless disabled) cache it
 * to `.tai/cache/<project>/pr-reviewers.json` (same brief §7 pattern as `loadRoster`).
 * Works on any backend.
 */
export async function loadPrReviewers(docStore: DocStore, opts: LoadPrReviewersOptions): Promise<readonly HumanRef[]> {
    const ref: PageRef = { spaceKey: opts.spaceKey, title: opts.title ?? PR_REVIEWERS_TITLE };
    const page = await docStore.getPage(ref);
    if (!page) {
        throw new Error(
            `"${opts.title ?? PR_REVIEWERS_TITLE}" page not found in space "${opts.spaceKey}". It is required ` +
                `— without it TAI cannot determine who's eligible to review a PR (rev 52, TAI-159 ADR).`
        );
    }
    const reviewers = parsePrReviewers(page.content);

    if (opts.cacheRoot !== null) {
        const root = opts.cacheRoot ?? path.join(".tai", "cache");
        const file = cachePath(root, opts.projectKey);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(reviewers, null, 2), "utf8");
    }
    return reviewers;
}

/** Read a previously-cached PR Reviewers list (brief §3.6 offline / degrade-to-cache).
 *  Null if absent. */
export async function loadCachedPrReviewers(cacheRoot: string, projectKey: string): Promise<readonly HumanRef[] | null> {
    try {
        const raw = await readFile(cachePath(cacheRoot, projectKey), "utf8");
        return JSON.parse(raw) as HumanRef[];
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
    }
}
