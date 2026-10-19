import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createGitHostSession, hasGitHostCredentials, parseGitHostKind, resolveGitHostKind, selfReviewAllowed } from "./host-factory.js";

describe("resolveGitHostKind (TAI-583 ADR decision 2)", () => {
    it("uses TAI_GIT_HOST when set, without reading origin", async () => {
        let read = false;
        const kind = await resolveGitHostKind({ TAI_GIT_HOST: "GitHub" }, async () => {
            read = true;
            return "bitbucket";
        });
        assert.equal(kind, "github");
        assert.equal(read, false);
    });

    it("refuses an unknown TAI_GIT_HOST rather than guessing", async () => {
        await assert.rejects(resolveGitHostKind({ TAI_GIT_HOST: "gitlab" }, async () => null), /expected one of: bitbucket, github/);
    });

    it("detects from origin when unset, and falls back to Bitbucket", async () => {
        assert.equal(await resolveGitHostKind({}, async () => "github"), "github");
        assert.equal(await resolveGitHostKind({ TAI_GIT_HOST: " " }, async () => null), "bitbucket");
    });
});

describe("credentials", () => {
    it("knows what each host needs", () => {
        assert.equal(hasGitHostCredentials("github", { GITHUB_TOKEN: "t" }), true);
        assert.equal(hasGitHostCredentials("github", { BITBUCKET_EMAIL: "a", BITBUCKET_API_TOKEN: "b" }), false);
        assert.equal(hasGitHostCredentials("bitbucket", { BITBUCKET_EMAIL: "a" }), false);
    });

    it("names the missing variable", () => {
        assert.throws(() => createGitHostSession("github", {}), /GITHUB_TOKEN/);
        assert.throws(() => createGitHostSession("bitbucket", { BITBUCKET_EMAIL: "a" }), /BITBUCKET_API_TOKEN/);
    });

    it("builds each host's backend, with the email that matches the PR Reviewers page", () => {
        const gh = createGitHostSession("github", { GITHUB_TOKEN: "t" }, "me@x.com");
        assert.equal(gh.backend.kind, "github");
        assert.equal(gh.email, "me@x.com");
        const bb = createGitHostSession("bitbucket", { BITBUCKET_EMAIL: "bb@x.com", BITBUCKET_API_TOKEN: "t" }, "me@x.com");
        assert.equal(bb.backend.kind, "bitbucket");
        assert.equal(bb.email, "bb@x.com");
    });
});

describe("small parsers", () => {
    it("parseGitHostKind and selfReviewAllowed", () => {
        assert.equal(parseGitHostKind(" bitbucket "), "bitbucket");
        assert.equal(parseGitHostKind("gitea"), null);
        assert.equal(selfReviewAllowed({ TAI_PR_SELF_REVIEW: "TRUE" }), true);
        assert.equal(selfReviewAllowed({ TAI_PR_SELF_REVIEW: "1" }), false);
        assert.equal(selfReviewAllowed({}), false);
    });
});
