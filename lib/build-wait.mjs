// Waits for a dev server's next build to finish, by reading its timestamped
// logs. Agents used to poll `docker compose logs` in sleep loops after every
// save; this blocks until the build has settled and prints only the result.
import { setTimeout as sleep } from "node:timers/promises";

/** Log patterns for the dev servers DevSports stacks run. */
export const presets = {
  // Angular CLI (`ng serve`, esbuild).
  angular: {
    start: /Changes detected\. Rebuilding|^Building\.\.\./,
    done: /Application bundle generation complete\./,
    failed: /Application bundle generation failed\./,
    error: /\[ERROR\]/,
  },
  // `convex dev`: a failed push prints a ✖ line and waits for the next change.
  convex: {
    start: /Preparing Convex functions/,
    done: /Convex functions ready!/,
    failed: /^✖ /,
    error: /^✖ |Error/,
  },
};

/** A preset name, or `{ start, done, failed, error? }` regular expressions (or their sources). */
export function resolvePatterns(value, where = "wait") {
  if (typeof value === "string") {
    if (!Object.hasOwn(presets, value)) throw new Error(`${where}: unknown build preset "${value}" (use ${Object.keys(presets).join(" or ")}).`);
    return presets[value];
  }
  if (!value || typeof value !== "object") throw new Error(`${where}: needs a preset name or { start, done, failed } patterns.`);
  const pattern = (field, required) => {
    const source = value[field];
    if (source === undefined && !required) return undefined;
    if (source instanceof RegExp) return source;
    if (typeof source !== "string" || !source) throw new Error(`${where}: "${field}" must be a regular expression.`);
    return new RegExp(source);
  };
  return { start: pattern("start", true), done: pattern("done", true), failed: pattern("failed", true), error: pattern("error", false) };
}

/** `docker logs --timestamps` output as `{ time, text }` lines (time in ms). */
export function parseTimestampedLogs(output) {
  const lines = [];
  for (const raw of output.split("\n")) {
    const match = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) ?(.*)$/.exec(raw.trimEnd());
    if (match) lines.push({ time: Date.parse(match[1]), text: match[2] });
  }
  return lines;
}

/**
 * The state of the latest build in the logs: `building` (a build started and
 * hasn't finished), `complete`, `failed` or `unknown` (no build in the logs yet).
 */
export function buildState(lines, patterns) {
  let start = -1;
  let result = -1;
  lines.forEach(({ text }, index) => {
    if (patterns.start.test(text)) start = index;
    else if (patterns.done.test(text) || patterns.failed.test(text)) result = index;
  });
  if (result < 0) return { state: start < 0 ? "unknown" : "building" };
  if (start > result) return { state: "building", startedAt: lines[start].time };
  const line = lines[result];
  const failed = patterns.failed.test(line.text);
  const errors = failed && patterns.error ? lines.slice(start + 1, result + 1).filter(({ text }) => patterns.error.test(text)).map(({ text }) => text) : [];
  return { state: failed ? "failed" : "complete", finishedAt: line.time, summary: line.text, errors };
}

/**
 * Waits until the latest build has finished and no new one has started for
 * `settleMs` (a save just before the call may not have been noticed yet).
 * `readLogs` returns the service's recent `{ time, text }` lines, stderr
 * included (`convex dev` reports on stderr; `docker compose logs` merges both).
 * Resolves `{ state, rebuilt, ... }`, where `rebuilt` says whether the build
 * finished after the call began; `state` is `timeout` if it never settled.
 */
export async function waitForBuild({ readLogs, patterns, timeoutMs = 600_000, settleMs = 3_000, intervalMs = 1_000, now = Date.now, wait = sleep }) {
  const began = now();
  for (;;) {
    const current = buildState(await readLogs(), patterns);
    const finished = current.state === "complete" || current.state === "failed";
    if (finished && now() - began >= settleMs) return { ...current, rebuilt: current.finishedAt >= began };
    if (now() - began >= timeoutMs) return { ...current, state: "timeout" };
    await wait(intervalMs);
  }
}

/** Prints the result for `name` and returns the exit code: 0 complete, 1 failed, 2 timed out. */
export function reportBuild(name, result, { log = console.log, error = console.error } = {}) {
  const at = (time) => new Date(time).toISOString().slice(11, 19);
  if (result.state === "timeout") {
    error(result.startedAt ? `${name}: still building (started ${at(result.startedAt)} UTC).` : `${name}: no finished build in the logs yet.`);
    return 2;
  }
  const when = result.rebuilt ? "" : " (no rebuild since you asked; this is the last build)";
  if (result.state === "complete") {
    log(`${name}: ${result.summary}${when}`);
    return 0;
  }
  error(`${name}: ${result.summary}${when}`);
  for (const line of result.errors.slice(0, 20)) error(`  ${line}`);
  if (result.errors.length > 20) error(`  …and ${result.errors.length - 20} more. Read the full logs for the rest.`);
  return 1;
}

/** Options for `wait`: `--timeout <seconds>` and `--settle <seconds>`. */
export function parseWaitArgs(args) {
  const services = [];
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--timeout" || arg === "--settle") {
      const seconds = Number(args[++i]);
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`${arg} needs a number of seconds.`);
      options[arg === "--timeout" ? "timeoutMs" : "settleMs"] = seconds * 1000;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      services.push(arg);
    }
  }
  return { services, options };
}
