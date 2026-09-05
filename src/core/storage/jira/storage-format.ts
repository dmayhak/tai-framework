/**
 * TAI Framework — Markdown <-> Confluence storage format (TAI-13)
 *
 * THE DECISION THIS FILE ENCODES (the ticket asked for it explicitly):
 * `Page.content` is **markdown** — the portable domain format — on every backend.
 * Confluence natively stores XHTML "storage format", so the Confluence backend converts on
 * the way in and on the way out. The filesystem backend stores the markdown as-is.
 *
 * The alternative was to let `Page.content` be storage-format XHTML on this backend and
 * markdown on the other. That was rejected: it would leak Confluence into every persona
 * (an ADR is authored in markdown, not XHTML), make the two backends non-comparable in the
 * conformance suite, and hand callers a value whose format depends on which backend they
 * happen to be talking to — which is exactly the leak StorageBackend exists to prevent.
 *
 * MERMAID. Diagrams are the reason this can't just be "strip the tags". Confluence renders
 * Mermaid only via an `<ac:adf-extension>` node (brief/interface.ts document the recipe,
 * verified live). Treating a ```mermaid fence as that node makes diagrams work *portably*:
 * on the filesystem backend the same fence renders in any markdown viewer, and on
 * Confluence it renders as a real diagram. So Mermaid becomes a mapping rule rather than a
 * Confluence-shaped hole in the abstraction.
 *
 * ⚠️ A SECOND, INCOMPATIBLE MERMAID APP EXISTS ON THE LIVE SITE (found 2026-07-13, TAIT Home
 * page). This file implements the recipe interface.ts documents — a self-contained
 * `<ac:adf-extension>` node carrying the diagram source directly in
 * `guest-params.source`. The newer app instead renders an empty preview node (just a
 * `guest-params.index` integer, no source at all) that is correlated PURELY BY POSITIONAL
 * INDEX with an ordinary `<ac:structured-macro name="code">` block elsewhere on the page —
 * the Nth code macro in document order is that preview's source, regardless of language.
 * `storageToMarkdown` cannot recover a diagram written by the newer app (there is no
 * `source` parameter to read), and will emit an empty ```mermaid fence for it — this is a
 * real, currently-unresolved limitation, not something this file silently papers over.
 *
 * `TAI_DEV_MERMAID.extensionKey` IS NOW A REAL, VERIFIED VALUE (TAI-308, 2026-09-04) —
 * captured off a genuine human-authored diagram on this site's "Testing" page (id 12091397)
 * by fetching its raw storage-format HTML, then confirmed end-to-end by writing a real
 * diagram through this file's own `markdownToStorage` and checking it rendered live.
 * **Recommended app: "Mermaid Macros for Confluence" by 9ByNight** — the same app
 * interface.ts's original recipe comment described, free, confirmed working. If a target
 * project's Confluence site has no Mermaid app at all, point a human at installing this one
 * before relying on rendered diagrams — `MermaidConfig.extensionKey` is optional precisely
 * for the meantime (or the "never going to install one" case): `codeBlock` below degrades
 * to a plain, readable code block rather than a macro guaranteed to fail.
 *
 * Found live that the key alone wasn't the only gap: the ORIGINAL macro shape below was
 * also missing `extension-id` — Confluence's real editor output carries the app-id/env-id
 * pair in TWO places, bare (no ARI prefix) in `extension-key`, and ARI-prefixed in a
 * separate `extension-id` attribute. Rendering with only `extension-key` set (this file's
 * original shape) is exactly what produced "Error loading the extension!" live — the app
 * couldn't resolve itself from that alone. The real macro also carries
 * `layout`/`forge-environment`/`extension-title`/outer `text` attributes and a large
 * `embedded-macro-context` block (account-id, cloud-id, page id/version, space id/key) that
 * look like editor-stamped bookkeeping, not render-required data — omitted here
 * deliberately; if a future site's rendering still fails with just the fields below, that
 * context block is the next thing to try adding. Still unresolved: the newer, index-based
 * app's real extension key above (TAI-309: whether TAI ever needs to support writing that
 * shape too, or whether standardizing on one recommended app is enough, is undecided).
 *
 * FIDELITY, stated honestly: round-trip is exact for content TAI itself wrote (we control
 * both directions over a known subset). For a page a human authored in Confluence's rich
 * editor, `storageToMarkdown` is best-effort — it recovers the constructs below with full
 * markdown fidelity, and for anything else it recognizes but can't express in markdown
 * (presentational spans, unsupported macros), it degrades to plain text via
 * `inlineToMarkdown` rather than dropping it. That degrade-not-drop behavior is itself a fix:
 * an earlier version of this file silently discarded ANY block whose opening tag carried an
 * attribute (e.g. Confluence's own `local-id`, which is on virtually every real element),
 * which meant reading a real Confluence-authored page could return almost nothing. Every
 * block-level regex below is attribute-tolerant for exactly this reason.
 *
 * Supported subset: headings, paragraphs, bold, italic, inline code, fenced code blocks
 * (incl. mermaid), bullet/ordered lists, links, tables, blockquotes, horizontal rules.
 */

// The extension key is SITE- and INSTALL-specific (interface.ts is explicit that it must be
// read off a working diagram on the target site rather than hardcoded) -- Injected, per
// project/site, not a single global default forever. `extensionKey` is the BARE
// "<app-id>/<env-id>/static/mermaid-diagram-macro" form (no ARI prefix) exactly as it
// appears in a real editor-authored macro's own `extension-key` attribute -- codeBlock
// below derives the ARI-prefixed `extension-id` attribute from it, rather than taking two
// separate config values for what's really one identity.
//
// TAI-308/TAI-309: `extensionKey` is optional -- undefined means "no Mermaid-rendering app
// configured for this project/site," a real, expected state (not every target project TAI
// manages will have one installed). codeBlock falls back to a plain fenced code block in
// that case rather than emitting a macro guaranteed to render "Error loading the
// extension!" -- a working plain-text diagram beats a broken live one.
export interface MermaidConfig {
    readonly extensionKey?: string;
}

// TAI-308: real, verified value for THIS site (TA/TAI) -- captured off a genuine
// human-authored diagram (see the file-header comment). A different target project's
// Confluence site will have its own app installation and therefore its own real value;
// this is a per-site default, not a universal constant.
export const TAI_DEV_MERMAID: MermaidConfig = {
    extensionKey: "5bc0f2ac-dc58-48e4-a6f3-72a04868af63/f588a647-291e-4a44-b053-24107662a91c/static/mermaid-diagram-macro",
};

// ---------- escaping ----------

function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function unesc(s: string): string {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&mdash;/g, "—")
        .replace(/&ndash;/g, "–")
        .replace(/&sect;/g, "§")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&"); // last, so an escaped &amp;lt; doesn't double-decode
}

/**
 * Escape a string for embedding inside an XML CDATA section, where the only thing that can
 * break it is the literal three-character sequence `]]>`. The standard technique: split on
 * that sequence and rejoin with `]]]]><![CDATA[>`, which closes the CDATA section right after
 * the first `]]`, then reopens a fresh one — the reader reassembles the original `]]>`
 * exactly, and nothing after it can escape into the surrounding markup.
 *
 * REGRESSION: an earlier version of this file inserted fenced-code-block bodies into a CDATA
 * section with no escaping at all. A code block whose content happened to contain `]]>`
 * (e.g. pasted XML) would terminate the CDATA early, and everything after it in the body
 * became unescaped, un-sandboxed XHTML sent straight to Confluence's PUT/POST.
 */
function cdataSafe(body: string): string {
    return body.split("]]>").join("]]]]><![CDATA[>");
}

/** Inverse of cdataSafe() — reassembles the original `]]>` from its escaped form. */
function cdataUnescape(body: string): string {
    return body.split("]]]]><![CDATA[>").join("]]>");
}

// ---------- inline ----------

// Internal placeholder token for extracted code spans, and (in storageToMarkdown) for
// extracted blocks. Printable and unlikely to the point of practical impossibility to collide
// with real content — unlike an earlier version of this file, which used raw NUL bytes for
// the same purpose. That made every text tool that touched the file (git diff, grep, `file`)
// treat it as a binary blob, which is exactly what happened here: git showed this file as
// `Bin 0 -> 12942 bytes` instead of a normal diff, and several `grep` invocations against it
// silently returned nothing.
const CODE_MARK = (i: number): string => `@@TAI_CODE_${i}@@`;
const CODE_MARK_RE = /@@TAI_CODE_(\d+)@@/g;
const BLOCK_MARK = (i: number): string => `@@TAI_BLOCK_${i}@@`;
const BLOCK_SPLIT_RE = /(@@TAI_BLOCK_\d+@@)/;
const BLOCK_MATCH_RE = /^@@TAI_BLOCK_(\d+)@@$/;

/** Inline markdown -> storage. Order matters: code spans are extracted first so their
 *  contents can't be mangled by the emphasis passes. */
function inlineToStorage(md: string): string {
    const codes: string[] = [];
    let s = md.replace(/`([^`]+)`/g, (_m, code: string) => {
        codes.push(code);
        return CODE_MARK(codes.length - 1);
    });

    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, href: string) => {
        return `<a href="${href}">${text}</a>`;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");

    return s.replace(CODE_MARK_RE, (_m, i: string) => `<code>${esc(codes[Number(i)]!)}</code>`);
}

function inlineToMarkdown(html: string): string {
    let s = html;
    // TAI-295: do NOT unesc() the code span's content here -- that restores literal `<`/`>`
    // (e.g. a `<KEY>` placeholder) into the string before the catch-all tag-strip pass below
    // runs, which then mistakes the now-literal content for a real, unrecognized HTML tag and
    // silently drops it. Leaving it entity-escaped here lets it survive that pass unmatched;
    // the function's own final unesc(s) call (below) restores it as the very last step.
    s = s.replace(/<code>(.*?)<\/code>/gs, (_m, c: string) => `\`${c}\``);
    s = s.replace(/<strong>(.*?)<\/strong>|<b>(.*?)<\/b>/gs, (_m, a?: string, b?: string) => `**${a ?? b}**`);
    s = s.replace(/<em>(.*?)<\/em>|<i>(.*?)<\/i>/gs, (_m, a?: string, b?: string) => `*${a ?? b}*`);
    // Tolerant of extra attributes on <a> (Confluence's own editor commonly adds
    // data-linked-resource-id, rel, etc. alongside href) — a stricter match here would let
    // the href fall through to the generic tag-strip below and silently lose the link target.
    s = s.replace(/<a\s[^>]*?href="([^"]*)"[^>]*>(.*?)<\/a>/gs, "[$2]($1)");
    s = s.replace(/<br\s*\/?>/g, "\n");
    s = s.replace(/<[^>]+>/g, ""); // drop anything else — presentational markup we can't express
    return unesc(s).trim();
}

// ---------- markdown -> storage ----------

function codeBlock(lang: string, body: string, mermaid: MermaidConfig): string {
    // TAI-308/TAI-309: no Mermaid app configured for this project/site -- fall through to
    // the plain code-macro path below (a readable, working plain-text diagram) rather than
    // emitting the extension macro, which needs a real extensionKey to have any chance of
    // rendering.
    if (lang === "mermaid" && mermaid.extensionKey) {
        // TAI-308: shape verified against a real editor-authored diagram (see this file's
        // header comment) -- an <ac:adf-extension> wrapping an <ac:adf-node type="extension">,
        // source entity-escaped (NOT CDATA-wrapped), plus an <ac:adf-fallback> sibling
        // duplicating the node. `extension-id` carries the SAME app-id/env-id pair as
        // `extension-key`, just ARI-prefixed -- the earlier version of this function only set
        // `extension-key`, which is exactly what produced "Error loading the extension!" live.
        // NOTE: `layout` genuinely appears twice with different values, not a copy-paste bug --
        // the real captured macro has both `parameters > layout` ("extension", an ADF display
        // hint the macro's own guest-params consumes) and a node-level `layout` ("default", an
        // unrelated ADF block-layout attribute every extension node carries). Confirmed by
        // diffing directly against a real editor-authored macro (this file's header comment);
        // don't "dedupe" this.
        const localId = `tai-${Math.random().toString(36).slice(2, 10)}`;
        const extensionId = `ari:cloud:ecosystem::extension/${mermaid.extensionKey}`;
        const node =
            `<ac:adf-node type="extension">` +
            `<ac:adf-attribute key="extension-key">${mermaid.extensionKey}</ac:adf-attribute>` +
            `<ac:adf-attribute key="extension-type">com.atlassian.ecosystem</ac:adf-attribute>` +
            `<ac:adf-attribute key="parameters">` +
            `<ac:adf-parameter key="layout">extension</ac:adf-parameter>` +
            `<ac:adf-parameter key="guest-params">` +
            `<ac:adf-parameter key="display">diagram</ac:adf-parameter>` +
            `<ac:adf-parameter key="source">${esc(body)}</ac:adf-parameter>` +
            `</ac:adf-parameter>` +
            `<ac:adf-parameter key="forge-environment">PRODUCTION</ac:adf-parameter>` +
            `</ac:adf-attribute>` +
            `<ac:adf-attribute key="local-id">${localId}</ac:adf-attribute>` +
            `<ac:adf-attribute key="extension-id">${extensionId}</ac:adf-attribute>` +
            `<ac:adf-attribute key="extension-title">Mermaid Diagram</ac:adf-attribute>` +
            `<ac:adf-attribute key="text">Mermaid Diagram</ac:adf-attribute>` +
            `<ac:adf-attribute key="layout">default</ac:adf-attribute>` +
            `</ac:adf-node>`;
        return `<ac:adf-extension>${node}<ac:adf-fallback>${node}</ac:adf-fallback></ac:adf-extension>`;
    }
    return (
        `<ac:structured-macro ac:name="code">` +
        (lang ? `<ac:parameter ac:name="language">${esc(lang)}</ac:parameter>` : "") +
        `<ac:plain-text-body><![CDATA[${cdataSafe(body)}]]></ac:plain-text-body>` +
        `</ac:structured-macro>`
    );
}

export function markdownToStorage(md: string, mermaid: MermaidConfig = TAI_DEV_MERMAID): string {
    const lines = md.replace(/\r\n/g, "\n").split("\n");
    const out: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i]!;

        // Fenced code (incl. mermaid) — consumed first so nothing inside is interpreted.
        const fence = /^```(\w*)\s*$/.exec(line);
        if (fence) {
            const lang = fence[1] ?? "";
            const body: string[] = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
            i++; // closing fence
            out.push(codeBlock(lang, body.join("\n"), mermaid));
            continue;
        }

        if (/^\s*$/.test(line)) {
            i++;
            continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            const level = heading[1]!.length;
            out.push(`<h${level}>${inlineToStorage(heading[2]!)}</h${level}>`);
            i++;
            continue;
        }

        if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            out.push("<hr />");
            i++;
            continue;
        }

        // Table (GFM): header row, separator row, then body rows.
        if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]!)) {
            const cells = (r: string) =>
                r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
            const header = cells(line);
            i += 2;
            const rows: string[][] = [];
            while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
            const th = header.map((c) => `<th>${inlineToStorage(c)}</th>`).join("");
            const body = rows
                .map((r) => `<tr>${r.map((c) => `<td>${inlineToStorage(c)}</td>`).join("")}</tr>`)
                .join("");
            out.push(`<table><tbody><tr>${th}</tr>${body}</tbody></table>`);
            continue;
        }

        // Lists — consume the whole run so consecutive items become one <ul>/<ol>.
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
        if (bullet || ordered) {
            const isOrdered = !!ordered;
            const items: string[] = [];
            while (i < lines.length) {
                const m = isOrdered
                    ? /^\s*\d+\.\s+(.*)$/.exec(lines[i]!)
                    : /^\s*[-*]\s+(.*)$/.exec(lines[i]!);
                if (!m) break;
                items.push(`<li>${inlineToStorage(m[1]!)}</li>`);
                i++;
            }
            const tag = isOrdered ? "ol" : "ul";
            out.push(`<${tag}>${items.join("")}</${tag}>`);
            continue;
        }

        const quote = /^>\s?(.*)$/.exec(line);
        if (quote) {
            const parts: string[] = [];
            while (i < lines.length) {
                const m = /^>\s?(.*)$/.exec(lines[i]!);
                if (!m) break;
                parts.push(m[1]!);
                i++;
            }
            out.push(`<blockquote><p>${inlineToStorage(parts.join(" "))}</p></blockquote>`);
            continue;
        }

        // Paragraph: gather until a blank line or the start of another construct.
        const para: string[] = [];
        while (i < lines.length && !/^\s*$/.test(lines[i]!) && !/^(#{1,6}\s|```|>|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]!)) {
            para.push(lines[i++]!);
        }
        if (para.length) out.push(`<p>${inlineToStorage(para.join(" "))}</p>`);
    }

    return out.join("");
}

// ---------- storage -> markdown ----------

/**
 * Every block regex below is deliberately ATTRIBUTE-TOLERANT (`<h1[^>]*>`, not `<h1>`).
 *
 * REGRESSION this fixes: real Confluence storage format — anything a human edited via the
 * rich UI, or that Confluence itself emits — carries a `local-id` (and often more) attribute
 * on virtually every element. The bare-tag-only version of these regexes never matched such
 * content, and unmatched content was silently dropped in the final assembly step (see below),
 * not merely left unformatted. Reading the live TAIT Home page through this function returned
 * 99 characters total out of a full page with a welcome panel, task list, headings, links,
 * and three code blocks — everything but three empty mermaid fences vanished. Both halves of
 * that bug are fixed here: the regexes now match attributed real content, and anything still
 * left over after every known pattern has run is degraded via `inlineToMarkdown` rather than
 * disappearing.
 */
export function storageToMarkdown(storage: string): string {
    let s = storage.replace(/\r\n/g, "\n");

    // Normalize self-closing empty elements (`<p local-id="x" />`) to an explicit open+close
    // pair BEFORE any block regex runs.
    //
    // REGRESSION this fixes: every block regex below requires an explicit closing tag
    // (`<p[^>]*>([\s\S]*?)<\/p>`). A self-closing `<p ... />` — which real Confluence content
    // genuinely emits for an empty paragraph, found live on the TAIT Home page — is NOT
    // distinguished from a normal opening tag by `[^>]*` (it happily consumes the trailing
    // `/`), so the regex engine went hunting forward for the NEXT `</p>` anywhere in the
    // document instead of recognizing this element as already complete. That swallowed
    // everything in between — including placeholder tokens already inserted for earlier
    // blocks — into one erroneous paragraph match, causing an already-resolved block's
    // placeholder to leak into the final markdown as literal text instead of being replaced.
    s = s.replace(/<(p|h[1-6]|blockquote|ul|ol|li|table|tr|th|td)([^>]*)\/>/g, "<$1$2></$1>");

    const blocks: string[] = [];

    // Mermaid first — pull the source back out of the adf-extension into a fence, which is
    // what makes diagrams round-trip instead of collapsing into unreadable markup. (See the
    // file-header warning: this only recovers the self-contained-source app's diagrams.)
    s = s.replace(/<ac:adf-extension[^>]*>[\s\S]*?<\/ac:adf-extension>/g, (m) => {
        const src = /<ac:adf-parameter key="source">([\s\S]*?)<\/ac:adf-parameter>/.exec(m);
        blocks.push("```mermaid\n" + (src ? unesc(src[1]!) : "") + "\n```");
        return BLOCK_MARK(blocks.length - 1);
    });

    // Attribute order is not guaranteed (real content puts local-id/macro-id/schema-version
    // before ac:name), so this matches ac:name="code" appearing ANYWHERE in the opening tag,
    // not only as the first/only attribute.
    s = s.replace(
        /<ac:structured-macro\b[^>]*\sac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g,
        (m) => {
            const lang = /<ac:parameter ac:name="language">(.*?)<\/ac:parameter>/.exec(m);
            const body = /<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>/.exec(m);
            const text = body ? cdataUnescape(body[1]!) : "";
            blocks.push("```" + (lang ? unesc(lang[1]!) : "") + "\n" + text + "\n```");
            return BLOCK_MARK(blocks.length - 1);
        }
    );

    s = s.replace(/<table[^>]*>[\s\S]*?<\/table>/g, (m) => {
        const rows = [...m.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
            [...r[1]!.matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/g)].map((c) => inlineToMarkdown(c[1]!))
        );
        if (rows.length === 0) return "";
        const md = [
            `| ${rows[0]!.join(" | ")} |`,
            `| ${rows[0]!.map(() => "---").join(" | ")} |`,
            ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`),
        ].join("\n");
        blocks.push(md);
        return BLOCK_MARK(blocks.length - 1);
    });

    s = s.replace(/<(ul|ol)[^>]*>([\s\S]*?)<\/\1>/g, (_m, tag: string, inner: string) => {
        const items = [...inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((x, n) =>
            tag === "ol" ? `${n + 1}. ${inlineToMarkdown(x[1]!)}` : `- ${inlineToMarkdown(x[1]!)}`
        );
        blocks.push(items.join("\n"));
        return BLOCK_MARK(blocks.length - 1);
    });

    s = s.replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/g, (m) => {
        const text = inlineToMarkdown(m.replace(/<\/?blockquote[^>]*>|<\/?p[^>]*>/g, ""));
        blocks.push(`> ${text}`);
        return BLOCK_MARK(blocks.length - 1);
    });

    s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_m, lvl: string, inner: string) => {
        blocks.push(`${"#".repeat(Number(lvl))} ${inlineToMarkdown(inner)}`);
        return BLOCK_MARK(blocks.length - 1);
    });

    s = s.replace(/<hr[^>]*>/g, () => {
        blocks.push("---");
        return BLOCK_MARK(blocks.length - 1);
    });

    s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/g, (_m, inner: string) => {
        blocks.push(inlineToMarkdown(inner));
        return BLOCK_MARK(blocks.length - 1);
    });

    // Reassemble in document order. Anything between recognized-block placeholders is markup
    // NONE of the passes above matched (an unsupported macro, a bare stray tag, orphaned
    // whitespace) — rather than silently vanishing, it is degraded through the same
    // inlineToMarkdown fallback every recognized block already uses, so real content is never
    // just gone. This is the actual fix, not the attribute-tolerance above: even a construct
    // this file will never explicitly support still surfaces as plain text.
    const parts = s.split(BLOCK_SPLIT_RE);
    const result: string[] = [];
    for (const part of parts) {
        const m = BLOCK_MATCH_RE.exec(part);
        if (m) {
            const block = blocks[Number(m[1])]!;
            if (block.trim() !== "") result.push(block);
        } else if (part.trim() !== "") {
            result.push(inlineToMarkdown(part));
        }
    }
    return result.join("\n\n");
}
