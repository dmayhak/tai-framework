/**
 * TAI Framework — a wall-of-text check for what the CLI writes to a ticket (TAI-504)
 *
 * A ticket description or comment is read by people. A session left to itself writes one
 * dense paragraph; the rule against that (brief §4) is a matter of judgment, so per TAI-455
 * it is a NOTE printed after the write, never a refusal. The note is what makes the rule hold
 * on a fresh install, where no session remembers being told.
 *
 * Pure text, no I/O. Works on Jira wiki markup and on markdown alike: only blank lines, list
 * markers and code blocks matter here.
 */

/** A paragraph longer than this, with no break in it, draws the note. Roughly five lines of
 *  a Jira description at normal width. */
export const LONG_PARAGRAPH = 500;

const LIST_ITEM = /^\s*(?:[*#-]+|\d+[.)])\s+/;
const CODE_FENCE = /^\s*(?:```|\{code(?::[^}]*)?\}|\{noformat\})/;

/**
 * Length in characters of the longest unbroken block of prose in `text`. A blank line ends a
 * block, every list item is a block of its own, and code blocks are not prose.
 */
export function longestParagraph(text: string): number {
    let longest = 0;
    let current = 0;
    let inCode = false;
    const close = (): void => {
        longest = Math.max(longest, current);
        current = 0;
    };
    for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
        if (CODE_FENCE.test(line)) {
            close();
            // A one-line {code}…{code} opens and closes on the same line.
            const markers = line.match(/```|\{code(?::[^}]*)?\}|\{noformat\}/g)?.length ?? 1;
            if (markers % 2 === 1) inCode = !inCode;
            continue;
        }
        if (inCode) continue;
        if (line.trim() === "") {
            close();
            continue;
        }
        if (LIST_ITEM.test(line)) close();
        current += line.trim().length + (current > 0 ? 1 : 0);
    }
    close();
    return longest;
}

/**
 * The note to print after writing `text` as a ticket's description or comment, or null when
 * it reads fine. `fixWith` is the command that rewrites it, when there is one.
 */
export function wallOfTextNote(what: "description" | "comment", text: string | undefined, fixWith?: string): string | null {
    if (!text) return null;
    const longest = longestParagraph(text);
    if (longest <= LONG_PARAGRAPH) return null;
    return (
        `_Note: this ${what} has an unbroken ${longest}-character paragraph, which is hard for a person to read. ` +
        `Write short paragraphs separated by a blank line, and "* " bullets when there are several items (brief §4).` +
        (fixWith ? ` Rewrite it with \`${fixWith}\`.` : " Keep the next one shorter.") +
        "_"
    );
}
