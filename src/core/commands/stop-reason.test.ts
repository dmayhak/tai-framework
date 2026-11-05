import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeStop, outputSection, refusedCommand, stopLines, trimmedOutput } from "./stop-reason.js";

describe("trimmedOutput (TAI-710)", () => {
    it("keeps the last eight non-empty lines, one per line, each cut to a readable length", () => {
        const text = Array.from({ length: 12 }, (_, n) => `  line ${n}  `).join("\n\n") + "\n" + "y".repeat(500);
        const out = trimmedOutput(text).split("\n");
        assert.equal(out.length, 8);
        assert.equal(out[0], "line 5");
        assert.ok(out[7]!.endsWith("…") && out[7]!.length === 240);
    });

    it("is empty for nothing", () => {
        assert.equal(trimmedOutput("  \n\n"), "");
    });
});

describe("refusedCommand (TAI-710)", () => {
    const cases: readonly (readonly [string, string, string | null])[] = [
        ["a command in backticks", "Permission to use Bash with command `git rm README.md` was denied.", "git rm README.md"],
        ["a permission refusal naming run", "The permission system refused me when I tried to run: git rm README.md", "git rm README.md"],
        ["haven't granted", "Claude requested permissions to use `npm publish`, but you haven't granted it yet.", "npm publish"],
        ["a refusal with no command", "I was denied permission to do that.", null],
    ];
    for (const [name, line, command] of cases) {
        it(`reads ${name}`, () => {
            const r = refusedCommand(`working\n${line}\nstopping`);
            assert.ok(r, "a refusal");
            assert.equal(r.command, command);
        });
    }

    it("does not read an ordinary stop as a refusal", () => {
        assert.equal(refusedCommand("npm ERR! code ELIFECYCLE\ntests failed\nI could not finish."), null);
        assert.equal(refusedCommand(""), null);
    });
});

describe("describeStop (TAI-710)", () => {
    it("an unfinished run names what happened to it, and says the cause is not known when nothing explains it", () => {
        const s = describeStop({ summary: "x", what: "the run was killed by SIGKILL", output: "halfway" }, "unfinished");
        assert.equal(s.what, "The build run did not finish: the run was killed by SIGKILL.");
        assert.match(s.cause, /not known/);
        assert.match(s.next, /\/tai-work/);
        assert.equal(s.output, "halfway");
    });

    it("reads a result that has only a summary, splitting at its own marker", () => {
        const s = describeStop({ summary: "the run exited with code 2. Last output:\nboom\nbang" }, "unfinished");
        assert.equal(s.what, "The build run did not finish: the run exited with code 2.");
        assert.equal(s.output, "boom\nbang");
    });

    it("a clean run with no PR says so, and a silent one says it printed nothing", () => {
        assert.equal(describeStop({ summary: "", output: "" }, "no-pr").what, "The build run finished but no open PR for this ticket was found.");
        assert.match(describeStop({ summary: "", output: "" }, "no-pr").cause, /printed nothing/);
    });

    it("names a refused command as a refusal, with the command", () => {
        const s = describeStop({ summary: "", output: "Permission to use Bash with command `git rm README.md` was denied." }, "no-pr");
        assert.equal(s.cause, "the permission system refused `git rm README.md`, and nobody was there to approve it.");
        assert.match(s.next, /allow that command/);
    });

    it("a refusal without a command quotes the line", () => {
        const s = describeStop({ summary: "", output: "I was denied permission to do that." }, "unfinished");
        assert.match(s.cause, /refused a command[\s\S]*I was denied permission to do that\./);
    });

    it("the lines are three, and the output section is apart from them", () => {
        const s = describeStop({ summary: "", output: "a\nb" }, "no-pr");
        assert.equal(stopLines(s).length, 3);
        assert.equal(outputSection(s.output), "\n\nThe end of the run's own output:\na\nb");
        assert.equal(outputSection(""), "");
    });
});
