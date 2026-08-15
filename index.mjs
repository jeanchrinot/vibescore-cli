#!/usr/bin/env node
/**
 * vibescore-cli — measure what a Claude Code project actually cost to build.
 *
 *   npx --yes vibescore-cli | pbcopy      # macOS
 *   npx --yes vibescore-cli | Set-Clipboard   # Windows PowerShell
 *
 * Reads the session transcripts Claude Code already keeps in
 * ~/.claude/projects and reports on one project: whichever folder you ran
 * this command from (that folder and anything nested under it — every
 * transcript line carries the `cwd` it was written from, so this is exact,
 * not a guess). Run it from the project you're actually submitting.
 *
 * Why this exists rather than just using ccusage: ccusage reports only when a
 * session *ended* and does not say which project it belonged to. That leaves
 * two holes this closes.
 *
 *   Scoping   Every transcript line carries `cwd`, so which sessions belong
 *             to this project is exact — no picking session ids off a list,
 *             and no "which of these fifteen projects is this one" either.
 *   Time      Every line carries a `timestamp`, so a build has a real start
 *             and end — even a single-session one, which ccusage alone can
 *             only report as "unmeasurable".
 *
 * Cost comes from ccusage, which maintains the per-model price table, joined
 * on session id. Computing it still reads every transcript on the machine,
 * not just this project's — a Claude Code session that touched several
 * directories has its cost split by each directory's share of that
 * session's tokens, and getting the share right needs the session's *whole*
 * footprint, not just the part that happened here.
 *
 * Nothing here leaves your machine. The command prints to stdout; you choose
 * what to paste. Filesystem paths are deliberately *not* included in the
 * output — only the project's folder name — so pasting a report doesn't
 * disclose your directory layout.
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

/**
 * Gaps longer than this are treated as "you had left", not as build time.
 *
 * Applied only to the stretch after Claude replies and before you speak again
 * — the ball is in your court there. Claude's own turns are always counted:
 * an autonomous run that takes an hour is work, not idle, and it shows up as
 * a long chain of short gaps rather than one long one. The cap on those is
 * only a guard against a crashed or abandoned turn.
 */
const IDLE_THRESHOLD_MINUTES = 30;
const IDLE_MS = IDLE_THRESHOLD_MINUTES * 60_000;

const PAYLOAD_VERSION = 1;

/* ======================
   TRANSCRIPTS
====================== */

function walkJsonl(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, found);
    else if (entry.name.endsWith(".jsonl")) found.push(full);
  }
  return found;
}

/**
 * Windows records the same folder as both `d:\...` and `D:\...` depending on
 * how the shell was launched, and a mixed separator shows up too. Without
 * normalising, one project reports as two.
 */
function projectKeyFor(cwd) {
  let path = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[a-zA-Z]:/.test(path)) path = path[0].toLowerCase() + path.slice(1);
  return path.toLowerCase();
}

/**
 * True for the root directory itself and anything nested under it — a repo
 * worked on from a subdirectory (`cd packages/api && claude`) still counts
 * as part of the project you ran this command from.
 */
function isWithinRoot(cwd, rootKey) {
  const key = projectKeyFor(cwd);
  return key === rootKey || key.startsWith(`${rootKey}/`);
}

function folderName(cwd) {
  const parts = cwd.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || cwd;
}

function collectEvents() {
  const root = join(homedir(), ".claude", "projects");

  try {
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }

  const events = [];

  for (const file of walkJsonl(root)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const line of text.split("\n")) {
      if (!line.trim()) continue;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // A transcript being written to right now can end mid-line.
        continue;
      }

      const { timestamp, cwd, type, sessionId } = entry;
      if (!timestamp || !cwd) continue;

      const at = Date.parse(timestamp);
      if (Number.isNaN(at)) continue;

      events.push({
        at,
        type,
        cwd,
        sessionId: sessionId ?? null,
        usage: entry.message?.usage ?? null,
        model: entry.message?.model ?? null,
      });
    }
  }

  return events;
}

/* ======================
   TIME
====================== */

/**
 * Splits elapsed time into what you were present for and what merely passed.
 *
 * A gap counts in full when Claude was working. A gap after Claude finished
 * counts only if you came back within the idle threshold.
 */
function measureTime(events) {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const first = sorted[0].at;
  const last = sorted[sorted.length - 1].at;

  let activeMs = 0;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].at - sorted[i - 1].at;
    if (gap <= 0) continue;

    const waitingOnHuman =
      sorted[i - 1].type === "assistant" && sorted[i].type === "user";

    if (waitingOnHuman) {
      if (gap <= IDLE_MS) activeMs += gap;
    } else {
      activeMs += Math.min(gap, IDLE_MS);
    }
  }

  return {
    firstActivity: new Date(first).toISOString(),
    lastActivity: new Date(last).toISOString(),
    wallMinutes: Math.max(1, Math.round((last - first) / 60_000)),
    activeMinutes: Math.max(1, Math.round(activeMs / 60_000)),
  };
}

/* ======================
   TOKENS
====================== */

function emptyTokens() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(target, usage) {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  target.inputTokens += input;
  target.outputTokens += output;
  target.cacheCreationTokens += cacheCreation;
  target.cacheReadTokens += cacheRead;
  target.totalTokens += input + output + cacheCreation + cacheRead;
}

/** Same four fields as addUsage, summed to one number — what a session's
 * cost-sharing math actually divides by. */
function usageDelta(usage) {
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

/* ======================
   COST (via ccusage)
====================== */

function runCcusage() {
  return new Promise((resolve) => {
    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const child = spawn(
      command,
      ["--yes", "ccusage@latest", "session", "--json"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out.replace(/^\uFEFF/, ""));
        const sessions = parsed.session ?? parsed.sessions ?? [];
        const bySession = new Map();
        for (const s of sessions) {
          const id = s.sessionId ?? s.period;
          const cost = s.totalCost ?? s.costUSD ?? s.cost;
          if (!id || typeof cost !== "number") continue;

          // ccusage already prices each model separately within a session;
          // keep that breakdown so it can be apportioned the same way as the
          // session total below, instead of collapsing to one number here.
          const models = new Map();
          for (const breakdown of s.modelBreakdowns ?? []) {
            const modelName = breakdown.modelName ?? breakdown.model;
            const modelCost = breakdown.cost ?? breakdown.costUSD;
            if (modelName && typeof modelCost === "number") {
              models.set(modelName, (models.get(modelName) ?? 0) + modelCost);
            }
          }

          bySession.set(id, { total: cost, models });
        }
        resolve(bySession);
      } catch {
        resolve(null);
      }
    });
  });
}

/* ======================
   MAIN
====================== */

async function main() {
  const events = collectEvents();

  if (events.length === 0) {
    process.stderr.write(
      "No Claude Code transcripts found in ~/.claude/projects.\n" +
        "If you built this app with a different tool, list it as self-reported instead.\n",
    );
    process.exit(1);
  }

  const cwd = process.cwd();
  const rootKey = projectKeyFor(cwd);

  // Exactly one bucket, not one per distinct `cwd` seen on the machine — the
  // report is scoped to the folder this command was run from (and anything
  // nested under it), so there's nothing to pick between on the submit page.
  let scoped = null;
  /** sessionId -> total tokens across every project that session touched,
   * in or out of scope — needed below to split a session's cost by its
   * *whole* footprint, not just the part that happened in this folder. */
  const sessionTotals = new Map();

  for (const event of events) {
    let delta = 0;
    if (event.usage && event.sessionId) {
      delta = usageDelta(event.usage);
      sessionTotals.set(
        event.sessionId,
        (sessionTotals.get(event.sessionId) ?? 0) + delta,
      );
    }

    if (!isWithinRoot(event.cwd, rootKey)) continue;

    if (!scoped) {
      scoped = {
        events: [],
        sessionIds: new Set(),
        tokens: emptyTokens(),
        byModel: new Map(),
        // Tokens *this* folder drew from each session it appears in. A
        // session that also touched other directories only gets charged its
        // share here, not the whole thing.
        tokensBySession: new Map(),
      };
    }

    scoped.events.push(event);
    if (event.sessionId) scoped.sessionIds.add(event.sessionId);

    if (event.usage) {
      addUsage(scoped.tokens, event.usage);

      // Claude Code tags a few internal, non-billed turns (auto-compaction,
      // interrupts) with model "<synthetic>" and a zero-valued usage object.
      // It is real JSON, not a bug in the transcript, but it isn't a model —
      // counting it inflated "models used" by one with nothing to show for it.
      const model = event.model ?? "unknown";
      if (model !== "<synthetic>") {
        if (!scoped.byModel.has(model)) scoped.byModel.set(model, emptyTokens());
        addUsage(scoped.byModel.get(model), event.usage);
      }

      if (event.sessionId) {
        const before = scoped.tokensBySession.get(event.sessionId) ?? 0;
        scoped.tokensBySession.set(event.sessionId, before + delta);
      }
    }
  }

  if (!scoped) {
    process.stderr.write(
      `No Claude Code sessions found for this folder:\n  ${cwd}\n\n` +
        "Run this from the project you're actually submitting — the same folder (or a parent of it) you had open in Claude Code while building it.\n",
    );
    process.exit(1);
  }

  const costBySession = await runCcusage();

  const projects = [scoped]
    .map((group) => {
      const time = measureTime(group.events);
      const sessionIds = [...group.sessionIds];

      // Null rather than 0 when ccusage didn't run: an unknown cost and a
      // free build are very different claims to put on a listing.
      //
      // A session that moved between directories belongs partly to each, so
      // its cost is split by the share of that session's tokens spent here.
      // Summing the whole session into every project it touched would have
      // reported the same $288 against four different builds.
      let totalCost = null;
      const costByModel = new Map();
      if (costBySession) {
        totalCost = sessionIds.reduce((sum, id) => {
          const session = costBySession.get(id);
          if (!session) return sum;

          const mine = group.tokensBySession.get(id) ?? 0;
          const whole = sessionTotals.get(id) ?? 0;
          const share = whole > 0 ? mine / whole : 0;

          // Same share as the total above, applied per model, so the two
          // always add back up to the same number.
          for (const [modelName, modelCost] of session.models) {
            costByModel.set(
              modelName,
              (costByModel.get(modelName) ?? 0) + modelCost * share,
            );
          }

          return sum + session.total * share;
        }, 0);
      }

      return {
        label: folderName(cwd),
        sessionCount: sessionIds.length,
        messageCount: group.events.length,
        ...time,
        idleThresholdMinutes: IDLE_THRESHOLD_MINUTES,
        totalCost,
        tokens: group.tokens,
        modelBreakdowns: [...group.byModel.entries()].map(
          ([modelName, tokens]) => ({
            modelName,
            ...tokens,
            cost: costByModel.get(modelName) ?? 0,
          }),
        ),
        sessionIds,
      };
    })
    // Only ever one entry, but a build with genuinely nothing billable in it
    // (a session that touched this folder without any usage) shouldn't be
    // reported as a listing.
    .filter((project) => project.tokens.totalTokens > 0);

  const payload = {
    tool: "vibescore-cli",
    version: PAYLOAD_VERSION,
    agent: "claude",
    generatedAt: new Date().toISOString(),
    idleThresholdMinutes: IDLE_THRESHOLD_MINUTES,
    costAvailable: costBySession !== null,
    projects,
  };

  if (projects.length === 0) {
    process.stderr.write(
      `Found Claude Code activity for this folder, but no billable usage in it — nothing to report.\n`,
    );
    process.exit(1);
  }

  // Summary on stderr so it stays visible even when stdout is piped to the
  // clipboard — otherwise you paste a payload you have never seen.
  const p = projects[0];
  const cost = p.totalCost === null ? "cost n/a" : `$${p.totalCost.toFixed(2)}`;
  const lines = [
    "",
    `  ${p.label.padEnd(28).slice(0, 28)} ${String(p.activeMinutes + "m active").padStart(12)} ` +
      `${String(Math.round(p.wallMinutes / 60) + "h wall").padStart(9)}  ${cost}`,
  ];
  if (!costBySession) {
    lines.push(
      "",
      "  ccusage could not be run, so cost is missing. Everything else is fine.",
    );
  }
  lines.push("", "  JSON written to stdout — paste it on the submit page.", "");
  process.stderr.write(lines.join("\n"));

  process.stdout.write(JSON.stringify(payload));
}

main().catch((error) => {
  process.stderr.write(`vibescore failed: ${error?.message ?? error}\n`);
  process.exit(1);
});
