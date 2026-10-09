import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toIssueKey, toPageId, type PageId } from "./interface.js";
import { checkClarificationGate, clarificationGateReason, findClarificationQuestions, findUnresolvedClarifications } from "./review-gate.js";

const page = (id: string, title: string, content: string) => ({ id: toPageId(id), title, content });

describe("NEEDS CLARIFICATION markers in linked pages (TAI-480)", () => {
    it("finds each marker's question, with or without a colon", () => {
        const content = ["Users sign in with email.", "", "NEEDS CLARIFICATION: do we support SSO?", "- limits: NEEDS CLARIFICATION how many seats per plan"].join("\n");
        assert.deepEqual(findClarificationQuestions(content), ["do we support SSO?", "how many seats per plan"]);
    });

    it("counts a marker with nothing after it, and one wrapped in bold", () => {
        assert.deepEqual(findClarificationQuestions("NEEDS CLARIFICATION"), [""]);
        assert.deepEqual(findClarificationQuestions("**NEEDS CLARIFICATION: which regions?**"), ["which regions?"]);
    });

    it("counts a marker whose two words are split by emphasis or a line break", () => {
        assert.deepEqual(findClarificationQuestions("**NEEDS** CLARIFICATION: which regions?"), ["which regions?"]);
        assert.deepEqual(findClarificationQuestions("**NEEDS CLARIFICATION**: which regions?"), ["which regions?"]);
        assert.deepEqual(findClarificationQuestions("_NEEDS_ _CLARIFICATION_ which regions?"), ["which regions?"]);
        assert.deepEqual(findClarificationQuestions("Open point: NEEDS\nCLARIFICATION: retention period?"), ["retention period?"]);
    });

    it("does not count a longer word that only starts with the marker", () => {
        assert.deepEqual(findClarificationQuestions("This section NEEDS CLARIFICATIONS from several teams."), []);
        assert.deepEqual(findClarificationQuestions("A NEEDS CLARIFICATION-free draft."), []);
        assert.deepEqual(findClarificationQuestions("NEEDS CLARIFICATION - which plan?"), ["which plan?"]);
    });

    it("ignores a marker inside inline code or a fenced block, so a page can describe the convention", () => {
        const content = ["Mark a gap with `NEEDS CLARIFICATION: <question>`.", "", "```", "NEEDS CLARIFICATION: example only", "```", "", "~~~text", "NEEDS CLARIFICATION: another example", "~~~"].join("\n");
        assert.deepEqual(findClarificationQuestions(content), []);
    });

    it("is case-sensitive: ordinary prose about needing clarification is not a marker", () => {
        assert.deepEqual(findClarificationQuestions("This needs clarification from legal at some point."), []);
    });

    it("returns only the pages that still carry a marker", () => {
        const found = findUnresolvedClarifications([page("1", "PRD", "All settled."), page("2", "UX flows", "NEEDS CLARIFICATION: empty state?")]);
        assert.deepEqual(found, [{ pageId: toPageId("2"), title: "UX flows", questions: ["empty state?"] }]);
    });

    it("checkClarificationGate reads every linked page and skips one that no longer exists", async () => {
        const pages = new Map<string, ReturnType<typeof page>>([
            ["1", page("1", "PRD", "NEEDS CLARIFICATION: SSO?")],
            ["3", page("3", "WBS", "Nothing open.")],
        ]);
        const read: string[] = [];
        const found = await checkClarificationGate(toIssueKey("TAI-1"), {
            getLinkedPages: async () => [toPageId("1"), toPageId("2"), toPageId("3")],
            getPage: async (ref: { readonly id: PageId }) => (read.push(ref.id), pages.get(ref.id) ?? null),
        });
        assert.deepEqual(read, ["1", "2", "3"]);
        assert.deepEqual(found.map((f) => f.title), ["PRD"]);
    });

    it("a ticket with no linked pages, or only clean ones, passes", async () => {
        const none = await checkClarificationGate(toIssueKey("TAI-1"), { getLinkedPages: async () => [], getPage: async () => null });
        assert.deepEqual(none, []);
    });

    it("a page that cannot be read fails the check instead of passing it", async () => {
        await assert.rejects(
            checkClarificationGate(toIssueKey("TAI-1"), {
                getLinkedPages: async () => [toPageId("1")],
                getPage: async () => Promise.reject(new Error("confluence down")),
            }),
            /confluence down/
        );
    });

    it("the reason names the ticket, each page and each question, and says how a marker is resolved", () => {
        const reason = clarificationGateReason(toIssueKey("TAI-9"), [
            { pageId: toPageId("7"), title: "PRD", questions: ["SSO?", ""] },
            { pageId: toPageId("8"), title: "UX flows", questions: ["empty state?"] },
        ]);
        assert.match(reason, /^TAI-9 is blocked by its review gate — 3 unresolved "NEEDS CLARIFICATION" markers/);
        assert.match(reason, /- "PRD" \(page 7\): SSO\?/);
        assert.match(reason, /- "PRD" \(page 7\): \(no question written after the marker\)/);
        assert.match(reason, /- "UX flows" \(page 8\): empty state\?/);
        assert.match(reason, /edit its marker out of the page; approving does not resolve one/);
    });
});
