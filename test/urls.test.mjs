import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../lib/config.mjs";
import { allocatePublicPorts, proxyTarget, publicUrl, requiredLoopbackOrigin, requiredPort, service, statusPorts, updateEnvironmentFile } from "../lib/tailscale.mjs";

const bin = fileURLToPath(new URL("../bin/devkit.mjs", import.meta.url));

function project(t, urls, { worktree = false, manifest } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "devkit-urls-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "devkit.config.json"), JSON.stringify({ name: "demo", urls }));
  if (worktree) writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere\n");
  for (const [file, text] of Object.entries(manifest ?? {})) writeFileSync(path.join(root, file), text);
  return (...args) => spawnSync(process.execPath, [bin, "urls", ...args], { cwd: root, encoding: "utf8" });
}

const arcLike = {
  services: [
    { name: "client", variable: "CLIENT_PUBLIC_URL" },
    { name: "MCP", variable: "MCP_PUBLIC_URL", checkPath: "/health", extra: true },
  ],
  worktreeManifest: ".env.worktree",
  worktreeServices: [{ name: "client", variable: "WORKTREE_PUBLIC_URL" }],
  missingHint: "Run pnpm dev up.",
};

test("validates the urls config", () => {
  assert.equal(validateConfig({ name: "x", urls: { services: [{ name: "app", variable: "APP_URL" }] } }).urls.manifest, ".env.tailscale");
  assert.throws(() => validateConfig({ name: "x", urls: { services: [] } }), /at least one entry/);
  assert.throws(() => validateConfig({ name: "x", urls: { services: [{ name: "a", variable: "lower" }] } }), /UPPER_SNAKE/);
});

test("prints the primary checkout's URLs, extras only with --all", (t) => {
  const run = project(t, arcLike, { manifest: { ".env.tailscale": "CLIENT_PUBLIC_URL='https://host.ts.net:1'\nMCP_PUBLIC_URL=https://host.ts.net:2\n" } });
  assert.equal(run().stdout, "client         https://host.ts.net:1\n");
  assert.equal(run("--all").stdout, "client         https://host.ts.net:1\nMCP            https://host.ts.net:2\n");
  assert.deepEqual(JSON.parse(run("--json").stdout), [{ name: "client", variable: "CLIENT_PUBLIC_URL", url: "https://host.ts.net:1" }]);
});

test("a linked worktree reads its own manifest and services", (t) => {
  const run = project(t, arcLike, { worktree: true, manifest: { ".env.worktree": "WORKTREE_PUBLIC_URL=https://host.ts.net:9\n" } });
  assert.equal(run().stdout, "client         https://host.ts.net:9\n");
});

test("missing manifest and --check failures exit non-zero with a hint", async (t) => {
  const missing = project(t, arcLike)();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing Tailscale URL manifest[\s\S]*Run pnpm dev up/);
  const http = project(t, arcLike, { manifest: { ".env.tailscale": "CLIENT_PUBLIC_URL=http://insecure\n" } })("--check");
  assert.equal(http.status, 1);
  assert.match(http.stderr, /FAIL CLIENT_PUBLIC_URL: missing or not an HTTPS URL/);
  assert.match(project(t, arcLike)("--nope").stderr, /Unknown option: --nope/);
});

test("Tailscale helpers", async () => {
  assert.equal(publicUrl("h.ts.net", 443), "https://h.ts.net");
  assert.equal(publicUrl("h.ts.net", 8443), "https://h.ts.net:8443");
  assert.equal(requiredLoopbackOrigin("http://localhost:4200/x", "APP"), "http://127.0.0.1:4200");
  assert.throws(() => requiredLoopbackOrigin("https://example.com:1", "APP"), /loopback HTTP origin/);
  assert.throws(() => requiredPort("70000", "PORT"), /valid port/);
  const status = { TCP: { 8443: {}, x: {} }, Web: { "h.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4200" } } } } };
  assert.deepEqual([...statusPorts(status)], [8443]);
  assert.equal(proxyTarget(status, "h.ts.net", 8443), "http://127.0.0.1:4200");
  assert.deepEqual(service({ label: "client", localVariable: "L", publicVariable: "P", localUrl: "http://localhost:4200", targetUrl: "http://localhost:4288" }).target, "http://127.0.0.1:4288");
  const excluded = new Set([1]);
  const ports = await allocatePublicPorts(2, excluded);
  assert.equal(new Set(ports).size, 2);
  assert.ok(ports.every((port) => excluded.has(port)));
  const dir = mkdtempSync(path.join(tmpdir(), "devkit-env-"));
  const file = path.join(dir, "runtime.env");
  writeFileSync(file, "# keep\nA='1'\nB='2'\n");
  updateEnvironmentFile(file, { A: "3" }, ["B"]);
  assert.equal((await import("node:fs")).readFileSync(file, "utf8"), "# keep\nA='3'\n");
  rmSync(dir, { recursive: true, force: true });
});

test("--check reports an unreachable URL", (t) => {
  const run = project(t, { services: [{ name: "app", variable: "APP_URL" }] }, { manifest: { ".env.tailscale": "APP_URL=https://127.0.0.1:1\n" } });
  const result = run("--check");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^app +https:\/\/127\.0\.0\.1:1\n$/);
  assert.match(result.stderr, /^FAIL APP_URL: /);
});
