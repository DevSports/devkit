import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../lib/config.mjs";
import { assessDockerCapacity } from "../lib/docker.mjs";
import { interpolate, ownedRoutePort, planRoute, worktreeId } from "../lib/stack.mjs";
import { fingerprint, parseWatchArgs } from "../lib/watch.mjs";

const bin = fileURLToPath(new URL("../bin/devkit.mjs", import.meta.url));
const GiB = 1024 ** 3;

test("validates the stack config", () => {
  const { stack } = validateConfig({ name: "blk-scl", stack: {} });
  assert.equal(stack.prefix, "BLK_SCL");
  assert.deepEqual(stack.files, ["compose.yaml"]);
  assert.equal(stack.setupService, "setup");
  assert.throws(() => validateConfig({ name: "x", stack: { beforeUp: "node x.mjs" } }), /command array/);
  assert.throws(() => validateConfig({ name: "x", stack: { tailscale: { route: { target: { variable: "P" } } } } }), /numeric "default"/);
});

test("names a worktree after its folder and path", () => {
  assert.match(worktreeId("/repos/.worktrees/TSB Feature!"), /^tsb-feature-[0-9a-f]{8}$/);
  assert.notEqual(worktreeId("/a/tsb"), worktreeId("/b/tsb"));
});

test("interpolates print lines and skips ones missing a value", () => {
  assert.equal(interpolate("Admin: http://localhost:${PORT:-4200}", {}), "Admin: http://localhost:4200");
  assert.equal(interpolate("Host: ${HOST}", { HOST: "h.ts.net" }), "Host: h.ts.net");
  assert.equal(interpolate("Host: ${HOST}", {}), null);
});

test("plans the Tailscale route without replacing other routes", () => {
  const target = "http://127.0.0.1:4288";
  const route = (proxy, extra = {}) => ({ HTTPS: true, ...extra, proxy });
  const status = (routes) => ({
    TCP: Object.fromEntries(Object.keys(routes).map((port) => [port, { HTTPS: true }])),
    Web: Object.fromEntries(Object.entries(routes).map(([port, r]) => [`h.ts.net:${port}`, { Handlers: { "/": { Proxy: r.proxy } } }])),
  });
  assert.deepEqual(planRoute({}, "h.ts.net", target, undefined, [4200, 4288]), { port: 8443, action: "add" });
  assert.deepEqual(planRoute(status({ 8443: route("http://127.0.0.1:9") }), "h.ts.net", target, undefined), { port: 8444, action: "add" });
  assert.deepEqual(planRoute(status({ 9000: route(target) }), "h.ts.net", target, undefined), { port: 9000, action: "ready" });
  assert.deepEqual(planRoute(status({ 9000: route(target) }), "h.ts.net", target, 9000), { port: 9000, action: "ready" });
  assert.deepEqual(planRoute({}, "h.ts.net", target, 9100), { port: 9100, action: "add" });
  assert.equal(ownedRoutePort(status({ 9000: route(target) }), "h.ts.net", target, 9000), 9000);
  assert.equal(ownedRoutePort(status({ 9000: route("http://127.0.0.1:1") }), "h.ts.net", target, 9000), undefined);
  const funnel = { ...status({ 9000: route(target) }), AllowFunnel: { "h.ts.net:9000": true } };
  assert.equal(ownedRoutePort(funnel, "h.ts.net", target, 9000), undefined);
});

test("memory admission counts every other running container", () => {
  const base = { project: "dcbc", stackCapBytes: 8 * GiB, daemonBytes: 16 * GiB, hostBytes: 24 * GiB };
  const ok = assessDockerCapacity({ ...base, requestedBytes: 8 * GiB, containers: [{ running: true, memoryBytes: 4 * GiB, project: "arcdev-1" }] });
  assert.equal(ok.admitted, true);
  assert.throws(
    () => assessDockerCapacity({ ...base, requestedBytes: 8 * GiB, containers: [{ running: true, memoryBytes: 8 * GiB, project: "arcdev-1" }] }),
    /memory admission refused/,
  );
  assert.throws(
    () => assessDockerCapacity({ ...base, requestedBytes: GiB, containers: [{ running: true, name: "/unlimited", memoryBytes: 0, project: null }] }),
    /unlimited has no hard memory limit/,
  );
});

test("watch arguments and fingerprints", () => {
  assert.throws(() => parseWatchArgs(["--path", "src"]), /Usage/);
  const parsed = parseWatchArgs(["--path", "src", "--interval", "500", "--", "pnpm", "build"]);
  assert.deepEqual(parsed.command, ["pnpm", "build"]);
  assert.equal(parsed.interval, 500);
  const dir = mkdtempSync(path.join(tmpdir(), "devkit-watch-"));
  writeFileSync(path.join(dir, "a.ts"), "1");
  const before = fingerprint([dir]);
  writeFileSync(path.join(dir, "a.ts"), "22");
  assert.notEqual(fingerprint([dir]), before);
  rmSync(dir, { recursive: true, force: true });
});

/** A project with fake docker, infisical and tailscale CLIs that log their arguments. */
function project(t, stack, { linked = false, loggedIn = true, folders = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "devkit-stack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "devkit.config.json"), JSON.stringify({ name: "demo", secrets: { folders: Object.fromEntries(Object.keys(folders).map((f) => [f, []])) }, stack }));
  writeFileSync(path.join(root, ".infisical.json"), JSON.stringify({ workspaceId: "0dbcc24f-a964-4470-8517-cbb3aac72b39", domain: "https://eu.infisical.com" }));
  if (linked) writeFileSync(path.join(root, ".git"), "gitdir: /elsewhere\n");
  else mkdirSync(path.join(root, ".git"));
  const fakes = path.join(root, "fakes");
  mkdirSync(fakes);
  const log = path.join(root, "calls.log");
  const fake = (name, body) => {
    writeFileSync(path.join(fakes, name), `#!${process.execPath}\nconst fs=require("fs");const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)}+" "+a.join(" ")+"\\n");${body}\n`);
    chmodSync(path.join(fakes, name), 0o755);
  };
  fake(
    "docker",
    `if (a[0]==="info") { process.stdout.write(JSON.stringify({ID:"daemon",MemTotal:${16 * GiB}})); }
     else if (a[0]==="ps") { process.stdout.write(""); }
     else if (a.includes("config")) { process.stdout.write(JSON.stringify({services:{setup:{mem_limit:${GiB}},app:{mem_limit:${2 * GiB}}}})); }`,
  );
  fake(
    "infisical",
    `if (a[0]==="login") process.exit(${loggedIn ? 0 : 1});
     if (a[0]==="export") { const f=(a.find(x=>x.startsWith("--path="))||"").slice(7); const v=${JSON.stringify(folders)}[f.slice(1)]||{}; process.stdout.write(JSON.stringify(Object.entries(v).map(([key,value])=>({key,value})))); }`,
  );
  const env = { ...process.env, PATH: `${fakes}:/usr/bin:/bin`, TAILSCALE_CLI: path.join(fakes, "missing-tailscale"), INFISICAL_ENV: "", COMPOSE_PROFILES: "" };
  delete env.COMPOSE_PROJECT_NAME;
  const run = (...args) => spawnSync(process.execPath, [bin, "stack", ...args], { cwd: root, env, encoding: "utf8" });
  const calls = () => readFileSync(log, "utf8").trim().split("\n");
  return { root, run, calls };
}

test("up: checks memory, builds setup, exports folders, then runs compose up", (t) => {
  const p = project(t, { secrets: { folders: ["admin"] }, upArgs: ["--build"], print: ["App: http://localhost:${APP_PORT:-4200}"] }, { folders: { admin: { CONVEX_URL: "https://x.convex.cloud" } } });
  const result = p.run("up", "--detach");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /App: http:\/\/localhost:4200/);
  const docker = p.calls().filter((line) => line.startsWith("docker compose"));
  assert.deepEqual(docker, [
    "docker compose --project-name demo --file compose.yaml config --format json",
    "docker compose --project-name demo --file compose.yaml build setup",
    "docker compose --project-name demo --file compose.yaml up --build --detach",
  ]);
  const exported = path.join(p.root, ".env.compose/admin.json");
  assert.deepEqual(JSON.parse(readFileSync(exported, "utf8")), { CONVEX_URL: "https://x.convex.cloud" });
  assert.equal(statSync(exported).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(p.root, ".env.compose")).mode & 0o777, 0o700);
});

test("up without a host Infisical login exports inside the auth container", (t) => {
  const p = project(t, { secrets: { folders: ["admin"] } }, { loggedIn: false });
  assert.equal(p.run("up").status, 0);
  assert.ok(p.calls().includes("docker compose --project-name demo --file compose.yaml run --rm --no-deps auth node node_modules/@devsports/devkit/bin/devkit.mjs stack export-secrets /secrets"));
});

test("worktrees get their own project, files and detached flow", (t) => {
  const p = project(t, { worktreeProjects: true, worktreeFiles: ["compose.worktree.yaml"], worktree: { detach: true, follow: ["client"] } }, { linked: true });
  assert.equal(p.run("up").status, 0);
  // devkit finds the root from the working directory, which is always the real path.
  const id = worktreeId(realpathSync(p.root));
  const prefix = `docker compose --project-name demo-${id} --file compose.yaml --file compose.worktree.yaml`;
  const docker = p.calls().filter((line) => line.startsWith("docker compose"));
  assert.ok(docker.includes(`${prefix} up --detach`), docker.join("\n"));
  assert.ok(docker.includes(`${prefix} logs --follow client`));
});

test("down stops every profile; other actions pass through; root and production are refused", (t) => {
  const p = project(t, { envFile: ".env.compose/compose.env" });
  const down = p.run("down");
  assert.equal(down.status, 0, down.stderr + down.stdout);
  assert.equal(p.run("logs", "app").status, 0);
  const docker = p.calls().filter((line) => line.startsWith("docker compose"));
  assert.deepEqual(docker, [
    "docker compose --project-name demo --env-file /dev/null --file compose.yaml --profile * down",
    "docker compose --project-name demo --env-file /dev/null --file compose.yaml logs app",
  ]);
  const prod = spawnSync(process.execPath, [bin, "stack", "up"], { cwd: p.root, env: { ...process.env, INFISICAL_ENV: "prod" }, encoding: "utf8" });
  assert.match(prod.stderr, /development environment only/);
});

test("a project's own container export and Tailscale-before-secrets order", (t) => {
  const p = project(t, {
    secrets: { command: [process.execPath, "-e", "require('fs').appendFileSync('calls.log','host-export\\n')"], containerCommand: [process.execPath, "-e", "require('fs').appendFileSync('calls.log','container-export\\n')"] },
    tailscale: { command: [process.execPath, "-e", "require('fs').appendFileSync('calls.log','tailscale\\n')"], beforeSecrets: true },
    envFile: ".env.compose/compose.env",
    print: ["Frontend: http://localhost:${CLIENT_PORT:-1}"],
  }, { loggedIn: false });
  mkdirSync(path.join(p.root, ".env.compose"), { recursive: true });
  writeFileSync(path.join(p.root, ".env.compose/compose.env"), "CLIENT_PORT=4343\n");
  const result = p.run("up");
  assert.equal(result.status, 0, result.stderr);
  const order = p.calls().filter((line) => ["tailscale", "container-export", "host-export"].includes(line));
  assert.deepEqual(order, ["tailscale", "container-export"]);
  assert.match(result.stdout, /Frontend: http:\/\/localhost:4343/);
});

test("hooks see the action, and the manifest loads before the memory check", (t) => {
  const p = project(t, { beforeUp: [process.execPath, "-e", "require('fs').appendFileSync('calls.log','hook '+process.env.DEVKIT_STACK_ACTION+'\\n')"], tailscale: { manifestEnv: true } });
  writeFileSync(path.join(p.root, ".env.tailscale"), "CLIENT_PORT=4287\n");
  assert.equal(p.run("secrets").status, 0);
  assert.ok(p.calls().includes("hook secrets"));
});
