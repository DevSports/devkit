import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConfig } from "../lib/config.mjs";
import { buildState, parseTimestampedLogs, parseWaitArgs, presets, reportBuild, resolvePatterns, waitForBuild } from "../lib/build-wait.mjs";

const angularLogs = `2026-10-24T15:18:38.358287938Z Application bundle generation complete. [44.225 seconds] - 2026-10-24T15:18:38.341Z
2026-10-24T15:18:38.365056836Z Page reload sent to client(s).
2026-10-24T15:18:54.153389263Z ❯ Changes detected. Rebuilding...
2026-10-24T15:19:38.193334528Z ✔ Changes detected. Rebuilding...
2026-10-24T15:19:38.201969518Z Initial chunk files | Names | Raw size
2026-10-24T15:19:38.202010555Z Application bundle generation complete. [44.040 seconds] - 2026-10-24T15:19:38.193Z
`;

const lines = (text) => parseTimestampedLogs(text);

test("parses docker --timestamps output", () => {
  const parsed = lines(angularLogs);
  assert.equal(parsed.length, 6);
  assert.equal(parsed[2].text, "❯ Changes detected. Rebuilding...");
  assert.equal(parsed[2].time, Date.parse("2026-10-24T15:18:54.153Z"));
});

test("reads an Angular build's state", () => {
  const all = lines(angularLogs);
  assert.equal(buildState(all.slice(0, 3), presets.angular).state, "building");
  const done = buildState(all, presets.angular);
  assert.equal(done.state, "complete");
  assert.match(done.summary, /44\.040 seconds/);
  const failed = buildState(
    lines(`2026-10-24T10:00:00Z ❯ Changes detected. Rebuilding...
2026-10-24T10:00:30Z ✘ [ERROR] TS2339: Property 'x' does not exist on type 'Y'. [plugin angular-compiler]
2026-10-24T10:00:31Z Application bundle generation failed. [31.2 seconds] - 2026-10-24T10:00:31Z
`),
    presets.angular,
  );
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.errors, ["✘ [ERROR] TS2339: Property 'x' does not exist on type 'Y'. [plugin angular-compiler]"]);
  assert.equal(buildState([], presets.angular).state, "unknown");
});

test("reads a Convex push's state", () => {
  const log = `2026-10-24T14:43:04Z Filesystem changed during push, retrying...
2026-10-24T14:43:04Z - Preparing Convex functions...
2026-10-24T14:43:25Z ✔ 14:43:25 Convex functions ready! (20.41s)
2026-10-24T14:44:23Z - Preparing Convex functions...
`;
  assert.equal(buildState(lines(log), presets.convex).state, "building");
  assert.equal(buildState(lines(`${log}2026-10-24T14:44:45Z ✔ 14:44:45 Convex functions ready! (21.9s)\n`), presets.convex).state, "complete");
  const failed = buildState(lines(`${log}2026-10-24T14:44:40Z ✖ Schema validation failed.\n`), presets.convex);
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.errors, ["✖ Schema validation failed."]);
});

test("waits for the build that starts after the call, then settles", async () => {
  let clock = Date.parse("2026-10-24T15:18:52Z");
  const all = lines(angularLogs);
  // The watcher notices the save 2s into the wait; the build finishes 44s later.
  const readLogs = () => all.filter(({ time }) => time <= clock);
  const result = await waitForBuild({ readLogs, patterns: presets.angular, settleMs: 3_000, intervalMs: 1_000, now: () => clock, wait: async (ms) => (clock += ms) });
  assert.equal(result.state, "complete");
  assert.equal(result.rebuilt, true);
  assert.match(result.summary, /44\.040/);
  assert.equal(clock, Date.parse("2026-10-24T15:19:39Z"));
});

test("reports the last build when nothing changed, and times out a stuck one", async () => {
  let clock = Date.parse("2026-10-24T16:00:00Z");
  const fake = { now: () => clock, wait: async (ms) => (clock += ms) };
  const idle = await waitForBuild({ readLogs: () => lines(angularLogs), patterns: presets.angular, ...fake });
  assert.equal(idle.state, "complete");
  assert.equal(idle.rebuilt, false);
  const stuck = await waitForBuild({ readLogs: () => lines(angularLogs).slice(0, 3), patterns: presets.angular, timeoutMs: 10_000, ...fake });
  assert.equal(stuck.state, "timeout");
});

test("prints the result and returns an exit code", () => {
  const out = [];
  const sink = { log: (line) => out.push(line), error: (line) => out.push(line) };
  assert.equal(reportBuild("client", { state: "complete", rebuilt: true, summary: "Application bundle generation complete. [2 seconds]" }, sink), 0);
  assert.equal(reportBuild("client", { state: "failed", rebuilt: true, summary: "Application bundle generation failed.", errors: ["✘ [ERROR] TS1"] }, sink), 1);
  assert.equal(reportBuild("client", { state: "timeout", startedAt: 0 }, sink), 2);
  assert.deepEqual(out.slice(1, 3), ["client: Application bundle generation failed.", "  ✘ [ERROR] TS1"]);
});

test("parses wait arguments and stack.wait config", () => {
  assert.deepEqual(parseWaitArgs(["client", "--timeout", "120", "--settle", "5"]), { services: ["client"], options: { timeoutMs: 120_000, settleMs: 5_000 } });
  assert.throws(() => parseWaitArgs(["--timeout", "soon"]), /seconds/);
  assert.throws(() => parseWaitArgs(["--follow"]), /Unknown option/);
  const { stack } = validateConfig({ name: "shop", stack: { wait: { app: "angular", api: { start: "Compiling", done: "Compiled", failed: "Failed" } } } });
  assert.equal(stack.wait.app, presets.angular);
  assert.ok(stack.wait.api.done.test("Compiled in 2s"));
  assert.throws(() => validateConfig({ name: "shop", stack: { wait: { app: "vite" } } }), /unknown build preset/);
  assert.throws(() => resolvePatterns({ start: "a", done: "b" }), /"failed"/);
});
