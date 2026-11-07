import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jiraLinks } from "./jira-backend.js";
import type { IssueKey, PageId } from "../interface.js";

describe("jiraLinks (TAI-749)", () => {
    const links = jiraLinks("https://x.atlassian.net");

    it("an issue is its browse address", () => {
        assert.equal(links.issue("TAI-749" as IssueKey), "https://x.atlassian.net/browse/TAI-749");
    });

    it("a page is its Confluence address in its space", () => {
        assert.equal(links.page({ id: "68747265" as PageId, spaceKey: "TA" }), "https://x.atlassian.net/wiki/spaces/TA/pages/68747265");
    });

    it("a trailing slash on the site URL does not double up", () => {
        assert.equal(jiraLinks("https://x.atlassian.net//").issue("TAI-1" as IssueKey), "https://x.atlassian.net/browse/TAI-1");
    });
});
