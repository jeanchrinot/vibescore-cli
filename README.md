# vibescore

Measure what a Claude Code project actually cost to build, then list it on
[VibeScore](https://vibescore.dev).

```bash
npx vibescore | pbcopy          # macOS
npx vibescore | Set-Clipboard   # Windows PowerShell
npx vibescore | xclip -selection clipboard   # Linux
```

Paste the result on the submit page. A human-readable summary is printed to
stderr, so you still see what you are about to paste even when stdout is piped
to the clipboard.

## What it reads

Claude Code already keeps a transcript of every session in
`~/.claude/projects`. This reads those files and reports one entry per project.

Cost comes from [ccusage](https://github.com/ryoppippi/ccusage), which
maintains the per-model price table; the two are joined on session id. If
ccusage cannot be run, everything else is still reported and cost comes back
as `null` rather than `0` — an unknown cost and a free build are different
claims to put on a listing.

## Why not just ccusage

ccusage reports token usage per session, which leaves two gaps:

- **It doesn't say which project a session belonged to.** Every transcript line
  carries `cwd`, so grouping here is exact rather than you picking session ids
  off a list.
- **It only records when a session *ended*.** Transcript lines carry a
  timestamp each, so a build has a real start and end — including a
  single-session build, which ccusage alone can only call unmeasurable.

## Time to ship

Two numbers, because they answer different questions:

- **Active** — time you were actually engaged. Gaps after Claude finishes and
  before you reply are counted only if you came back within **30 minutes**;
  past that you had left. Claude's own turns always count, so a long
  autonomous run is work, not idle.
- **Wall-clock** — first activity to last, calendar time, no interpretation.

A real example: 45 hours of wall-clock on this project, 10 hours of active
time. Both are true; they just measure different things.

## Privacy

Nothing is uploaded. The command writes to stdout and you choose what to do
with it.

Filesystem paths are deliberately **not** included in the output — only a
project's folder name, widened to `parent/folder` only when two projects would
otherwise be indistinguishable. Pasting a report does not disclose your
directory layout.

The payload contains: folder label, session ids, message count, first/last
activity, wall-clock and active minutes, token counts per model, and cost.

## Licence

MIT
