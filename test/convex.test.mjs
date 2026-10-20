import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateConfig } from "../lib/config.mjs";
import {
  assertOwned,
  convexCommand,
  deleteDeployment,
  deploymentClient,
  deploymentReference,
  ensureDeployKeyFile,
  ensureDeployment,
  expiryFor,
  managementClient,
  resolveToken,
  validateConvexConfig,
} from "../lib/convex.mjs";
import { addFunnelPath, pathTarget } from "../lib/tailscale.mjs";

const settings = validateConvexConfig({ team: "acme", project: "shop" });
const user = "sam";

/** An in-memory Management API with one project, recording every call. */
function fakeApi(deployments = []) {
  const calls = [];
  const state = { deployments: [...deployments], keys: 0 };
  const client = {
    calls,
    state,
    async get(route) {
      calls.push(["GET", route]);
      if (route === "/teams/acme/projects/shop") return { id: 7, slug: "shop" };
      if (route === "/projects/7/list_deployments") return state.deployments;
      throw new Error(`unexpected GET ${route}`);
    },
    async post(route, body) {
      calls.push(["POST", route, body]);
      if (route === "/projects/7/create_deployment") {
        const created = { name: "brave-otter-1", deploymentType: body.type, reference: body.reference, isDefault: false, region: body.region, deploymentUrl: "https://brave-otter-1.convex.cloud", expiresAt: body.expiresAt };
        state.deployments.push(created);
        return created;
      }
      const key = /^\/deployments\/([^/]+)\/create_deploy_key$/.exec(route);
      if (key) return { deployKey: `dev:${key[1]}|secret${++state.keys}` };
      if (/^\/deployments\/[^/]+\/delete$/.test(route)) return undefined;
      throw new Error(`unexpected POST ${route}`);
    },
    async patch(route, body) {
      calls.push(["PATCH", route, body]);
      return undefined;
    },
  };
  return client;
}

test("validates the convex config and fills in defaults", () => {
  assert.deepEqual(validateConfig({ name: "shop", convex: { team: "acme", project: "shop" } }).convex, {
    team: "acme",
    project: "shop",
    region: "aws-eu-west-1",
    worktreeDays: 14,
    token: { folder: "convex", key: "CONVEX_TEAM_TOKEN" },
  });
  assert.equal(validateConfig({ name: "shop" }).convex, undefined);
  assert.throws(() => validateConvexConfig({ team: "Acme", project: "shop" }), /team slug/);
  assert.throws(() => validateConvexConfig({ team: "acme", project: "shop", region: "mars" }), /region/);
  assert.throws(() => validateConvexConfig({ team: "acme", project: "shop", worktreeDays: 30 }), /1 to 14/);
});

test("references live under the user's prefix", () => {
  assert.equal(deploymentReference({ kind: "worktree", id: "1a2b3c4d5e6f", user }), "dev/sam/worktree-1a2b3c4d5e6f");
  assert.equal(deploymentReference({ kind: "primary", id: "abc123", user }), "dev/sam/primary-abc123");
  assert.throws(() => deploymentReference({ kind: "prod", id: "abc", user }), /kind/);
  assert.throws(() => deploymentReference({ kind: "worktree", id: "../x", user }), /id/);
});

test("worktree deployments expire inside the plan's window; the primary never does", () => {
  assert.equal(expiryFor("primary", settings, 0), null);
  assert.equal(expiryFor("worktree", settings, 0), 14 * 86_400_000 - 3_600_000);
});

test("ensure creates a dev deployment once, then renews its expiry", async () => {
  const api = fakeApi();
  const first = await ensureDeployment(api, settings, { kind: "worktree", id: "aaa111", user, now: 0 });
  assert.equal(first.created, true);
  assert.equal(first.siteUrl, "https://brave-otter-1.convex.site");
  assert.deepEqual(api.calls.find(([method]) => method === "POST")[2], {
    type: "dev",
    reference: "dev/sam/worktree-aaa111",
    region: "aws-eu-west-1",
    isDefault: false,
    expiresAt: expiryFor("worktree", settings, 0),
  });
  const second = await ensureDeployment(api, settings, { kind: "worktree", id: "aaa111", user, now: 1000 });
  assert.equal(second.created, false);
  assert.deepEqual(api.calls.at(-1), ["PATCH", "/deployments/brave-otter-1", { expiresAt: expiryFor("worktree", settings, 1000) }]);
});

test("the primary deployment is never given an expiry or renewed", async () => {
  const api = fakeApi([{ name: "calm-cat-2", deploymentType: "dev", isDefault: false, reference: "dev/sam/primary-abc123" }]);
  const result = await ensureDeployment(api, settings, { kind: "primary", id: "abc123", user });
  assert.equal(result.created, false);
  assert.equal(api.calls.some(([method]) => method === "PATCH"), false);
});

test("refuses production, default and other people's deployments", async () => {
  for (const deployment of [
    { name: "p", deploymentType: "prod", isDefault: false, reference: "dev/sam/primary-abc123" },
    { name: "d", deploymentType: "dev", isDefault: true, reference: "dev/sam/primary-abc123" },
    { name: "o", deploymentType: "dev", isDefault: false, reference: "dev/alex/primary-abc123" },
  ]) {
    assert.throws(() => assertOwned(deployment, user), /Refusing/);
  }
  const api = fakeApi([{ name: "keen-prod-1", deploymentType: "prod", isDefault: true, reference: "dev/sam/primary-abc123" }]);
  await assert.rejects(ensureDeployment(api, settings, { kind: "primary", id: "abc123", user }), /Refusing/);
  await assert.rejects(deleteDeployment(api, settings, "dev/sam/primary-abc123", user), /Refusing/);
  assert.equal(api.calls.some(([method, route]) => method === "POST" && route.endsWith("/delete")), false);
});

test("deploy keys are minted once per deployment and kept private", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "devkit-convex-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "secrets/deploy_key");
  const api = fakeApi();
  assert.deepEqual(await ensureDeployKeyFile(api, "brave-otter-1", file), { minted: true });
  assert.deepEqual(await ensureDeployKeyFile(api, "brave-otter-1", file), { minted: false });
  assert.equal(readFileSync(file, "utf8"), "dev:brave-otter-1|secret1\n");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // A key for another deployment is replaced.
  assert.deepEqual(await ensureDeployKeyFile(api, "other-deer-3", file), { minted: true });
  assert.match(readFileSync(file, "utf8"), /^dev:other-deer-3\|/);
});

test("the token comes from the environment or Infisical, never echoed in errors", async () => {
  const config = { root: "/x", convex: settings };
  assert.equal(resolveToken(config, { env: { CONVEX_TEAM_TOKEN: " env-token " } }), "env-token");
  assert.equal(resolveToken(config, { env: {}, fetchSecrets: (folder) => (folder === "/convex" ? { CONVEX_TEAM_TOKEN: "vault-token" } : {}) }), "vault-token");
  assert.throws(() => resolveToken(config, { env: {}, fetchSecrets: () => ({}) }), /Missing CONVEX_TEAM_TOKEN in Infisical \/convex/);
  const client = managementClient("very-secret", { fetch: async () => new Response("nope", { status: 403 }) });
  await assert.rejects(client.get("/token_details"), (error) => /403/.test(error.message) && !error.message.includes("very-secret"));
});

test("devkit convex ensure --json writes the key file and prints the deployment", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "devkit-convex-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines = [];
  process.env.DEVKIT_CONVEX_USER = user;
  t.after(() => delete process.env.DEVKIT_CONVEX_USER);
  const code = await convexCommand({ root: dir, convex: settings }, ["ensure", "--kind", "worktree", "--id", "bbb222", "--key-file", "key", "--json"], { client: fakeApi(), out: (line) => lines.push(line) });
  assert.equal(code, 0);
  const result = JSON.parse(lines[0]);
  assert.equal(result.reference, "dev/sam/worktree-bbb222");
  assert.equal(result.minted, true);
  assert.match(readFileSync(path.join(dir, "key"), "utf8"), /^dev:brave-otter-1\|/);
});

test("Funnel paths: added once, refused when another target or Serve owns them", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "devkit-funnel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = "box.tail1.ts.net";
  const log = path.join(dir, "calls");
  const statusFile = path.join(dir, "status.json");
  const cli = path.join(dir, "tailscale");
  writeFileSync(cli, `#!/bin/sh\nif [ "$1" = status ]; then echo '{"Self":{"DNSName":"${host}."}}'; exit 0; fi\nif [ "$1 $2" = "serve status" ]; then cat ${statusFile}; exit 0; fi\necho "$@" >> ${log}\n`, { mode: 0o755 });
  const status = (web, allow = true) => writeFileSync(statusFile, JSON.stringify({ TCP: { 8443: { HTTPS: true } }, Web: { [`${host}:8443`]: { Handlers: web } }, AllowFunnel: { [`${host}:8443`]: allow } }));

  writeFileSync(statusFile, "{}");
  assert.equal(addFunnelPath(cli, { port: 8443, mount: "/shop-a/search", target: "http://127.0.0.1:4000" }), `https://${host}:8443/shop-a/search`);
  assert.equal(readFileSync(log, "utf8"), "funnel --bg --https=8443 --set-path=/shop-a/search http://127.0.0.1:4000\n");

  status({ "/shop-a/search": { Proxy: "http://127.0.0.1:4000" } });
  assert.equal(pathTarget(JSON.parse(readFileSync(statusFile, "utf8")), host, 8443, "/shop-a/search"), "http://127.0.0.1:4000");
  addFunnelPath(cli, { port: 8443, mount: "/shop-a/search", target: "http://127.0.0.1:4000" });
  assert.equal(readFileSync(log, "utf8").split("\n").filter(Boolean).length, 1, "an existing mapping is left alone");
  assert.throws(() => addFunnelPath(cli, { port: 8443, mount: "/shop-a/search", target: "http://127.0.0.1:5000" }), /already points/);

  status({ "/": { Proxy: "http://127.0.0.1:9" } }, false);
  assert.throws(() => addFunnelPath(cli, { port: 8443, mount: "/x", target: "http://127.0.0.1:4000" }), /tailnet-only Serve/);
  assert.throws(() => addFunnelPath(cli, { port: 4443, mount: "/x", target: "http://127.0.0.1:4000" }), /only serves ports/);
});

test("deployment environment: one request for many variables, dev keys only", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    if (url.endsWith("/api/query")) return new Response(JSON.stringify({ status: "success", value: requests.length === 1 ? { name: "A", value: "1" } : null }));
    return new Response("");
  };
  const deployment = deploymentClient({ url: "https://brave-otter-1.convex.cloud", deployKey: "dev:brave-otter-1|secret" }, { fetch });

  assert.equal(await deployment.getEnvironment("A"), "1");
  assert.equal(await deployment.getEnvironment("B"), null);
  await deployment.setEnvironment({ A: "x=y\nz", B: 2, C: null });
  await deployment.setEnvironment({});
  assert.equal(requests.length, 3, "an empty change set sends nothing");
  assert.deepEqual(requests[0].body, { path: "_system/cli/queryEnvironmentVariables:get", args: { name: "A" }, format: "json" });
  assert.equal(requests[2].url, "https://brave-otter-1.convex.cloud/api/update_environment_variables");
  assert.deepEqual(requests[2].body, { changes: [{ name: "A", value: "x=y\nz" }, { name: "B", value: "2" }, { name: "C" }] });
  assert.equal(requests[2].auth, "Convex dev:brave-otter-1|secret");

  assert.throws(() => deploymentClient({ url: "https://x.convex.cloud", deployKey: "prod:x|secret" }), /dev deploy key/);
  const failing = deploymentClient({ url: "https://x.convex.cloud", deployKey: "dev:x|secret" }, { fetch: async () => new Response("bad key", { status: 401 }) });
  await assert.rejects(failing.setEnvironment({ A: "1" }), (error) => /\(401\)/.test(error.message) && !error.message.includes("secret"));
});
