/**
 * TAI-731: the revision numbers of `CHANGELOG.md` and the brief's header. A change claims its rev by hand, so two changes made at
 * the same time can take the same number. A text conflict stops the second merge; this check catches what a resolution leaves
 * (a duplicate, a skipped number, a header that names a different rev than the newest entry) before anything merges.
 */

/** Entries below this rev were moved out of the brief unchanged (TAI-486) and have a gap at 14, so only the later ones are counted. */
export const FIRST_COUNTED_REV = 81;

/** Problems with the rev numbers, empty when there are none. `changelog` and `brief` are the files' text. */
export function revisionProblems(changelog: string, brief: string): string[] {
    const revs = [...changelog.matchAll(/^## rev (\d+)\b/gm)].map((m) => Number(m[1]));
    const problems: string[] = [];
    if (revs.length === 0) return ["CHANGELOG.md has no `## rev N` entry"];
    const seen = new Set<number>();
    for (const rev of revs) {
        if (seen.has(rev)) problems.push(`rev ${rev} appears more than once in CHANGELOG.md`);
        seen.add(rev);
    }
    for (let i = 1; i < revs.length; i++) {
        const above = revs[i - 1]!;
        const rev = revs[i]!;
        if (rev === above || above < FIRST_COUNTED_REV) continue;
        if (rev !== above - 1) problems.push(`CHANGELOG.md goes from rev ${above} to rev ${rev}; the entries run newest first with no number skipped`);
    }
    const header = /Last updated:\*\*[^\n]*?\(rev (\d+)\)/.exec(brief);
    if (!header) problems.push("PROJECT_BRIEF.md's Last-updated line names no `(rev N)`");
    else if (Number(header[1]) !== revs[0]) problems.push(`PROJECT_BRIEF.md's header says rev ${header[1]}, but the newest CHANGELOG.md entry is rev ${revs[0]}`);
    return problems;
}
