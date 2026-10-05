import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RestClient as JiraRestClient, apiTokenAuth as jiraApiTokenAuth } from "../storage/jira/rest-client.js";
import { parseTypeAliasesPage } from "../storage/jira/type-alias-config.js";
import { EMPTY_TYPE_ALIAS_MAP, jqlString } from "../storage/jira/mappers.js";
import {
    mappedIssueTypeNames,
    renderUnmappedTypesNote,
    scanProjectIssueTypes,
    summarizeUnmappedTypes,
} from "./unmapped-types-report.js";

const rows = (...pairs: [string, string][]) => pairs.map(([key, typeName]) => ({ key, typeName }));

describe("summarizeUnmappedTypes (TAI-413)", () => {
    it("reports nothing when every ticket's type is a TAI type", () => {
        assert.deepEqual(summarizeUnmappedTypes(rows(["P-1", "Story"], ["P-2", "Dev"], ["P-3", "Epic"]), EMPTY_TYPE_ALIAS_MAP), []);
    });

    it("groups unmapped types with a count and the first example keys, biggest group first", () => {
        const groups = summarizeUnmappedTypes(
            rows(["P-1", "Story"], ["P-2", "Task"], ["P-3", "Sub-task"], ["P-4", "Task"], ["P-5", "Task"], ["P-6", "Task"], ["P-7", "Task"]),
            EMPTY_TYPE_ALIAS_MAP
        );
        assert.deepEqual(groups, [
            { typeName: "Task", count: 5, exampleKeys: ["P-2", "P-4", "P-5"] },
            { typeName: "Sub-task", count: 1, exampleKeys: ["P-3"] },
        ]);
    });

    it("a type covered by the Type Aliases page is mapped, so it is not reported", () => {
        const aliases = parseTypeAliasesPage("```yaml\nTask: story\n```");
        assert.deepEqual(summarizeUnmappedTypes(rows(["P-1", "Task"], ["P-2", "Weird"]), aliases).map((g) => g.typeName), ["Weird"]);
    });
});

describe("renderUnmappedTypesNote (TAI-413)", () => {
    it("is absent when nothing is unmapped", () => {
        assert.equal(renderUnmappedTypesNote([], false), undefined);
    });

    it("names each type with its count and examples, the fix path, and that it is report-only", () => {
        const note = renderUnmappedTypesNote([{ typeName: "Task", count: 5, exampleKeys: ["P-2", "P-4", "P-5"] }], false)!;
        assert.match(note, /"Task" — 5 tickets \(e\.g\. P-2, P-4, P-5\)/);
        assert.match(note, /Type Aliases Confluence page/);
        assert.match(note, /unmanaged/);
        assert.match(note, /nothing was changed/i);
    });

    it("says when the scan stopped early", () => {
        const note = renderUnmappedTypesNote([{ typeName: "Task", count: 1, exampleKeys: ["P-2"] }], true)!;
        assert.match(note, /covered only the first 5000 tickets/i);
    });
});

describe("mappedIssueTypeNames (TAI-413)", () => {
    it("is every TAI display name plus every aliased native name, sorted and unique", () => {
        const names = mappedIssueTypeNames(parseTypeAliasesPage("```yaml\nTask: story\nSub-task: dev\n```"));
        assert.ok(names.includes("Story") && names.includes("Dev") && names.includes("Epic"));
        assert.ok(names.includes("Task") && names.includes("Sub-task"), "aliased native names count as mapped");
        assert.deepEqual(names, [...new Set(names)].sort());
    });

    it("without aliases it is just TAI's own display names", () => {
        assert.ok(!mappedIssueTypeNames(EMPTY_TYPE_ALIAS_MAP).includes("Task"));
    });
});

describe("scanProjectIssueTypes (TAI-413)", () => {
    function clientFor(pages: { issues: { key: string; fields: { issuetype: { name: string } } }[]; nextPageToken?: string; isLast: boolean }[]) {
        const seen: { jql: string; nextPageToken?: string }[] = [];
        let i = 0;
        const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
            assert.match(String(input), /\/rest\/api\/2\/search\/jql/);
            seen.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify(pages[i++]), { status: 200, headers: { "content-type": "application/json" } });
        }) as unknown as typeof fetch;
        const client = new JiraRestClient({ siteUrl: "https://x.atlassian.net", auth: jiraApiTokenAuth("a@b.c", "t"), fetchImpl });
        return { client, seen };
    }
    const issue = (key: string, type: string) => ({ key, fields: { issuetype: { name: type } } });

    it("follows the cursor and returns every ticket's key and raw type name", async () => {
        const { client, seen } = clientFor([
            { issues: [issue("P-1", "Story"), issue("P-2", "Task")], nextPageToken: "t1", isLast: false },
            { issues: [issue("P-3", "Task")], isLast: true },
        ]);
        const result = await scanProjectIssueTypes(client, "P", ["Story", "Dev"]);
        assert.deepEqual(result.rows, rows(["P-1", "Story"], ["P-2", "Task"], ["P-3", "Task"]));
        assert.equal(result.truncated, false);
        assert.equal(seen.length, 2);
        assert.match(seen[0]!.jql, /project = "P"/);
        assert.equal(seen[1]!.nextPageToken, "t1");
    });

    it("asks Jira only for tickets whose type is NOT one of the mapped names, so the page holds the few that matter", async () => {
        const { client, seen } = clientFor([{ issues: [issue("P-2", "Task")], isLast: true }]);
        await scanProjectIssueTypes(client, "P", ["Story", "Dev"]);
        assert.equal(seen[0]!.jql, 'project = "P" AND issuetype NOT IN ("Story", "Dev") ORDER BY key ASC');
    });

    it("escapes quotes and backslashes in the project key", async () => {
        const { client, seen } = clientFor([{ issues: [], isLast: true }]);
        await scanProjectIssueTypes(client, 'P"X\\', ["Story"]);
        assert.match(seen[0]!.jql, /project = "P\\"X\\\\" AND/);
        assert.equal(jqlString('a"b'), '"a\\"b"');
    });

    it("stops at the page cap and says it was truncated instead of looping", async () => {
        const forever = { issues: [issue("P-1", "Task")], nextPageToken: "t", isLast: false };
        const { client, seen } = clientFor(Array.from({ length: 5 }, () => forever));
        const result = await scanProjectIssueTypes(client, "P", ["Story"], 3);
        assert.equal(result.truncated, true);
        assert.equal(seen.length, 3);
    });
});
