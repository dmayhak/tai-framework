import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractReason } from "./rest-client.js";

const reasonOf = (body: unknown, status = 400) => extractReason(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));

describe("extractReason (TAI-497)", () => {
    it("reads Jira's errorMessages and field errors", async () => {
        assert.equal(await reasonOf({ errorMessages: ["Issue does not exist"], errors: { summary: "is required" } }), "Issue does not exist; summary: is required");
    });

    it("renders a Confluence error list as text, not [object Object]", async () => {
        const reason = await reasonOf({
            statusCode: 400,
            data: { errors: [{ message: { translation: "A page with this title already exists: Persona Roster", args: [] } }] },
            message: "com.atlassian.confluence.api.service.exceptions.BadRequestException: A page with this title already exists",
        });
        assert.equal(reason, "A page with this title already exists: Persona Roster");
    });

    it("renders a top-level errors array of objects or strings", async () => {
        assert.equal(await reasonOf({ errors: [{ message: "first" }, "second", { translation: "third" }] }), "first; second; third");
    });

    it("never prints [object Object]: an entry of an unknown shape is shown as JSON", async () => {
        const reason = await reasonOf({ errors: [{ code: 7 }] });
        assert.equal(reason, '{"code":7}');
        assert.doesNotMatch(reason, /object Object/);
    });

    it("keeps a top-level message next to Jira's errors, and drops the one that only repeats a Confluence error list", async () => {
        assert.equal(await reasonOf({ errorMessages: ["Issue does not exist"], message: "Not Found" }, 404), "Issue does not exist; Not Found");
        assert.equal(
            await reasonOf({ errors: [{ message: "A page with this title already exists" }], message: "BadRequestException: A page with this title already exists" }),
            "A page with this title already exists"
        );
    });

    it("falls back to the message, then to the raw body", async () => {
        assert.equal(await reasonOf({ message: "Forbidden" }, 403), "Forbidden");
        assert.equal(await reasonOf("plain text body", 500), "plain text body");
    });
});
