/**
 * TAI Framework — the shape of a persona-led turn (TAI-395 groom, TAI-428 review-prep)
 *
 * `work`, `groom` and `git-pr review-prep` all hand the invoking session the same thing: a
 * "# Persona: Name (id)" heading, the persona's own instructions, a `---` separator, then the
 * unit-of-work body. Kept in one place so a host that knows how to follow one turn follows them all.
 *
 * TAI-470: when the target project has a rules file, its rendered section (`renderProjectContext`)
 * comes straight after the separator, ahead of the body.
 */

export function renderPersonaTurn(persona: { displayName: string; id: string; prompt: string }, body: string, projectContext?: string): string {
    const context = projectContext ? [projectContext, ""] : [];
    return [`# Persona: ${persona.displayName} (${persona.id})`, "", persona.prompt, "", "---", "", ...context, body].join("\n");
}
