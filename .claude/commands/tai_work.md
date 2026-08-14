---
description: Load/refresh a TAI unit of work's briefing and invoke its owning persona (brief §3.8)
---

Run this and read its full output:

```bash
npx tsx src/hosts/cli.ts work $ARGUMENTS
```

The output starts with a `# Persona: <name> (<id>)` heading followed by that persona's own
instructions, then a `---` separator, then the assembled briefing (the unit of work plus its
immediate parent and linked Confluence pages, brief §3.6).

For the rest of this turn, **act as that persona**: follow its instructions against the
briefing exactly as it would if invoked directly (brief §3.8's `/tai_work <KEY>`) — same
flow whether this is starting fresh or resuming, no separate handling for either case.

If the command errors (no such issue, no persona assigned, or the persona isn't permitted
to work on this issue type), report the error to the human rather than guessing a persona
or proceeding anyway.
