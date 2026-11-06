import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeStop, forJira, outputSection, refusedCommand, stopLines, trimmedOutput } from "./stop-reason.js";

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

    it("does not read an operating-system or ci error as the permission system refusing a command", () => {
        for (const line of [
            "npm ERR! EACCES: permission denied, open '/usr/lib/x'",
            "git@github.com: Permission denied (publickey).",
            "mkdir: cannot create directory: Permission denied",
            "The CI step was blocked by a failing check.",
            "Deploying requires approval from a maintainer.",
            "The login was denied by the server.",
        ]) {
            assert.equal(refusedCommand(`working\n${line}\n`), null, line);
            assert.doesNotMatch(describeStop({ summary: "", output: line }, "unfinished").cause, /permission system/, line);
        }
    });

    it("reads a refusal only among the last four lines, not one the run worked around earlier", () => {
        const refused = "Permission to use Bash with command `git rm a` was denied.";
        assert.ok(refusedCommand(`${refused}\nb\nc\nd`), "four lines from the end");
        assert.equal(refusedCommand(`${refused}\nb\nc\nd\ne`), null, "five lines from the end");
        assert.match(describeStop({ summary: "", output: `${refused}\nI used another way\n1 test failed\nexit\nbye` }, "unfinished").cause, /not known/);
    });

    it("does not read an ordinary stop as a refusal", () => {
        assert.equal(refusedCommand("npm ERR! code ELIFECYCLE\ntests failed\nI could not finish."), null);
        assert.equal(refusedCommand(""), null);
    });
});

describe("for a Jira comment (TAI-710)", () => {
    it("writes the command as monospace wiki markup", () => {
        assert.equal(forJira("refused `git rm README.md`, and `ls`."), "refused {{git rm README.md}}, and {{ls}}.");
        assert.equal(forJira("no ticks"), "no ticks");
        assert.equal(forJira("could not start /opt/my_tools/claude_cli *now*"), "could not start /opt/my\\_tools/claude\\_cli \\*now\\*", "markup characters outside backticks stay as written");
        assert.equal(forJira("exit ~1 a|b ^c +d wow!"), "exit \\~1 a\\|b \\^c \\+d wow\\!", "the other wiki characters are escaped too");
        assert.equal(forJira("refused `echo ${HOME}`"), "refused {{echo $\\{HOME\\}}}", "braces inside are escaped");
    });
});

describe("describeStop (TAI-710)", () => {
    it("does not read a firewall block, a refused connection or a test log line as a permission refusal", () => {
        for (const line of ["the command was blocked by the firewall", "the connection was refused by the command server", "ok 4 - the command is refused when empty", "it denied the request for a command"]) {
            assert.equal(refusedCommand(line), null, line);
        }
    });

    it("leaves the note about an unrecognised limit out of the output tail when reading a summary", () => {
        const s = describeStop({ summary: 'the run exited with code 1. Last output:\nboom\n(Its output mentions a limit, "x", but matches no known usage-limit message, so it was treated as a failure. If it was a usage limit, capture the wording for TAI-743.)' }, "unfinished");
        assert.equal(s.output, "boom");
    });

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
        assert.equal(s.cause, "the permission system looks to have refused `git rm README.md`, and nobody was there to approve it.");
        assert.match(s.next, /allow that command/);
    });

    it("an unrecognised limit wording is named in the cause, so the capture path stays visible", () => {
        const s = describeStop({ summary: "", output: "something\nthe quota is used up", what: "the run exited with code 1", limitNote: "the quota is used up" }, "unfinished");
        assert.match(s.cause, /mentions a usage limit that matches no known message \(the output below has the line\)[\s\S]*TAI-743/);
        assert.equal(s.output, "something\nthe quota is used up");
        const both = describeStop({ summary: "", output: "Permission to use Bash with command `git rm a` was denied.", limitNote: "limit" }, "unfinished");
        assert.match(both.cause, /looks to have refused `git rm a`[\s\S]*also mentions a usage limit[\s\S]*TAI-743/, "a refusal is still named when a limit is also mentioned");
    });

    it("takes backticked text as the refused command only when it starts like one, and hedges the cause", () => {
        const title = describeStop({ summary: "", output: "The command for `returns 403 when permission is denied` was refused" }, "unfinished");
        assert.equal(refusedCommand(title.output)?.command, null, "a test title is not a command");
        assert.doesNotMatch(title.cause, /refused `returns/);
        assert.match(title.cause, /looks to have refused a command/);
        assert.match(title.next, /if that is what happened/);
        assert.equal(refusedCommand("Permission to use Bash with command `./scripts/run.sh --all` was denied")?.command, "./scripts/run.sh --all");
    });

    it("a refusal without a command quotes the line", () => {
        const s = describeStop({ summary: "", output: "I was denied permission to do that." }, "unfinished");
        assert.match(s.cause, /refused a command, and nobody was there to approve it \(the output below has the line\)\./);
        assert.doesNotMatch(s.cause, /I was denied/, "the agent's line is in the output block, not the cause");
    });

    it("the lines are three, and the output section is apart from them", () => {
        const s = describeStop({ summary: "", output: "a\nb" }, "no-pr");
        assert.equal(stopLines(s).length, 3);
        assert.equal(outputSection(s.output), "\n\nThe end of the run's own output:\n{noformat}\na\nb\n{noformat}");
        assert.equal(outputSection("x {noformat} y"), "\n\nThe end of the run's own output:\n{noformat}\nx { noformat } y\n{noformat}", "agent text cannot close the block early");
        assert.equal(outputSection(""), "");
    });
});
