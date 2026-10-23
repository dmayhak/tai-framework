/** How far a briefing's numbered section body sits in from its `## n. Title` heading, so the headings stand out when
 *  a person scans the output (TAI-620). Three spaces keeps a `- ` row a Markdown list item. */
export const SECTION_INDENT = "   ";

/** Indents every non-blank line of `rows`, including the continuation lines inside a multi-line row. */
export function indentSectionBody(rows: readonly string[]): string[] {
    return rows.flatMap((row) => row.split("\n")).map((line) => (line === "" ? line : `${SECTION_INDENT}${line}`));
}
