import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../lib/config.mjs";
import { secretsFor } from "../lib/secrets.mjs";

const bin = fileURLToPath(new URL("../bin/devkit.mjs", import.meta.url));

/** A project with a fake `infisical` that serves folders from a JSON file and logs its calls. */
function fixture(t, folders, secrets = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "devkit-secrets-"));
  t.after(() => spawnSync("rm", ["-rf", root]));
  writeFileSync(path.join(root, ".infisical.json"), JSON.stringify({ workspaceId: "00000000-0000-4000-8000-000000000000", domain: "https://eu.infisical.com" }));
  writeFileSync(path.join(root, "devkit.config.json"), JSON.stringify({ name: "demo", secrets }));
  writeFileSync(path.join(root, "folders.json"), JSON.stringify(folders));
  mkdirSync(path.join(root, "bin"));
  const fake = path.join(root, "bin", "infisical");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(root, "calls.log"))}, args.join(" ") + "\\n");
const folder = (args.find((a) => a.startsWith("--path=")) || "").slice(7);
const data = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, "folders.json"))}, "utf8"));
if (args[0] === "export") {
  if (!data[folder]) process.exit(1);
  process.stdout.write(JSON.stringify(Object.entries(data[folder]).map(([key, value]) => ({ key, value }))));
}
`,
  );
  chmodSync(fake, 0o755);
  const env = { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, INFISICAL_ENV: "" };
  const run = (args, extra = {}) => spawnSync(process.execPath, [bin, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
  const calls = () => readFileSync(path.join(root, "calls.log"), "utf8");
  return { root, run, calls, env };
}

test("validates the secrets config", () => {
  const config = validateConfig({ name: "my-shop", secrets: { folders: { development: ["TYPESENSE_API_KEY"], qa: [] } } });
  assert.equal(config.secrets.prefix, "MY_SHOP");
  assert.deepEqual(config.secrets.startup, ["development", "qa"]);
  assert.deepEqual(config.secrets.environments, ["dev"]);
  assert.throws(() => validateConfig({ name: "x", secrets: { folders: { "Bad Folder": [] } } }), /bad secrets folder/);
  assert.throws(() => validateConfig({ name: "x", secrets: { folders: { a: ["lower"] } } }), /required key names/);
  assert.throws(() => validateConfig({ name: "x", secrets: { folders: { a: [] }, startup: ["b"] } }), /startup folder/);
  assert.throws(
    () => validateConfig({ name: "x", secrets: { folders: { a: [] }, worktree: { scopes: { a: ["K"] } } } }),
    /both a folder and a worktree scope/,
  );
});

test("run injects the folders, strips inherited secrets and refuses conflicts", (t) => {
  const f = fixture(t, { "/convex": { CONVEX_URL: "https://x.convex.cloud", SHARED: "1" }, "/web": { VITE_KEY: "v", SHARED: "1" }, "/other": { SHARED: "2" } }, {
    folders: { convex: [], web: [], other: [] },
  });
  const print = ["-e", "console.log(JSON.stringify(process.env))"];
  const result = f.run(["secrets", "run", "convex,web", "--", process.execPath, ...print], { OLD_SECRET: "leak", CONVEX_DEPLOYMENT: "dev:wrong" });
  assert.equal(result.status, 0, result.stderr);
  const env = JSON.parse(result.stdout);
  assert.equal(env.CONVEX_URL, "https://x.convex.cloud");
  assert.equal(env.VITE_KEY, "v");
  assert.equal(env.OLD_SECRET, undefined);
  assert.equal(env.CONVEX_DEPLOYMENT, undefined);
  assert.equal(env.DEMO_SECRETS_SCOPE, "convex,web");
  assert.deepEqual(env.DEMO_INJECTED_SECRET_NAMES.split(",").sort(), ["CONVEX_URL", "SHARED", "VITE_KEY"]);
  assert.match(f.calls(), /export --format=json --expand=true --secret-overriding=false --path=\/convex --projectId=00000000-0000-4000-8000-000000000000 --domain=https:\/\/eu.infisical.com --env=dev --silent/);
  const conflict = f.run(["secrets", "run", "convex,other", "--", "true"]);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /Conflicting secret SHARED/);
});

test("run refuses unknown folders, process-control keys, production Clerk keys and other environments", (t) => {
  const f = fixture(t, { "/bad": { PATH: "/evil" }, "/own": { DEMO_RUNTIME: "x" }, "/qa": { CLERK_SECRET_KEY: "sk_live_x" } }, {
    folders: { bad: [], own: [], qa: [], required: ["NEEDED"] },
  });
  assert.match(f.run(["secrets", "run", "nope", "--", "true"]).stderr, /Unknown secrets folder "nope"/);
  assert.match(f.run(["secrets", "run", "bad", "--", "true"]).stderr, /process-control setting PATH/);
  assert.match(f.run(["secrets", "run", "own", "--", "true"]).stderr, /process-control setting DEMO_RUNTIME/);
  assert.match(f.run(["secrets", "run", "qa", "--", "true"]).stderr, /must be a Clerk development key/);
  assert.match(f.run(["secrets", "run", "qa", "--", "true"], { INFISICAL_ENV: "prod" }).stderr, /INFISICAL_ENV=prod isn't allowed/);
  assert.match(f.run(["secrets", "run", "qa"]).stderr, /Usage: devkit secrets run/);
});

test("check reports counts and missing required settings, never values", (t) => {
  const f = fixture(t, { "/development": { TYPESENSE_API_KEY: "topsecret" }, "/media": { MEDIA_SECRET: "replace-with-real" } }, {
    folders: { development: ["TYPESENSE_API_KEY"], media: ["MEDIA_SECRET"] },
    startup: ["development"],
  });
  const startup = f.run(["secrets", "check", "--startup"]);
  assert.equal(startup.status, 0, startup.stderr);
  assert.equal(startup.stdout.trim(), "/development: 1 settings available (values hidden)");
  const full = f.run(["secrets", "check"]);
  assert.equal(full.status, 1);
  assert.match(full.stderr, /Missing settings in \/media: MEDIA_SECRET/);
  assert.doesNotMatch(full.stdout + full.stderr, /topsecret/);
});

test("allowReserved, expand and a project validator", async (t) => {
  const f = fixture(t, { "/development": { DEMO_RUNTIME: "dev", COLOUR: "red" } }, {
    folders: { development: [] },
    allowReserved: ["DEMO_RUNTIME"],
    expand: false,
    validator: "validate.mjs",
  });
  writeFileSync(path.join(f.root, "validate.mjs"), 'export function validateScope(scope, values) { if (values.COLOUR !== "blue") throw new Error(`/${scope} must be blue`); }\n');
  const result = f.run(["secrets", "check"]);
  assert.match(result.stderr, /\/development must be blue/);
  assert.match(f.calls(), /--expand=false/);
});

test("ciPassthrough runs the command as is in CI", (t) => {
  const f = fixture(t, {}, { folders: { web: [] }, ciPassthrough: true });
  const result = f.run(["secrets", "run", "web", "--", process.execPath, "-e", "console.log(process.env.FROM_CI)"], { CI: "true", FROM_CI: "kept" });
  assert.equal(result.stdout.trim(), "kept");
});

test("the library exposes the toolkit for project scripts", (t) => {
  const f = fixture(t, { "/development": { A: "1" } }, { folders: { development: [] } });
  process.env.PATH = f.env.PATH;
  const kit = secretsFor({ ...validateConfig({ name: "demo", secrets: { folders: { development: [] } } }), root: f.root });
  assert.deepEqual(kit.scopes, ["development"]);
  assert.deepEqual({ ...kit.fetchSecrets("/development") }, { A: "1" });
  assert.equal(kit.childEnvironment({ A: "1" }, "development", { HOME: "/h", GITHUB_TOKEN: "x" }).GITHUB_TOKEN, undefined);
  assert.match(kit.worktreeFolder("/repos/demo"), /^\/worktrees\/[0-9a-f]{24}$/);
});
