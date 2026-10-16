import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSession, developmentUrl, validateConfig } from "../lib/config.mjs";
import { parseAuthArgs, signInScript } from "../lib/auth.mjs";

const auth = {
  users: { staff: "staff+clerk_test@example.com", admin: "admin+clerk_test@example.com" },
};

test("fills in auth defaults", () => {
  const config = validateConfig({ name: "shop", app: { url: "http://localhost:4287/x" }, auth });
  assert.equal(config.app.url, "http://localhost:4287");
  assert.deepEqual(
    { ...config.auth, users: undefined },
    { users: undefined, defaultUser: "staff", code: "424242", signInPath: "/", landingPath: "/", stateDir: ".agents/auth" },
  );
});

test("refuses anything that isn't a Clerk test address", () => {
  assert.throws(() => validateConfig({ name: "x", auth: { users: { a: "real@example.com" } } }), /Clerk test address/);
  assert.throws(() => validateConfig({ name: "x", auth: { users: {} } }), /at least one user/);
  assert.throws(() => validateConfig({ name: "X Y" }), /lowercase/);
  assert.throws(() => validateConfig({ name: "x", auth: { ...auth, defaultUser: "nobody" } }), /defaultUser/);
  assert.throws(() => validateConfig({ name: "x", auth: { ...auth, code: "12" } }), /six digits/);
});

test("only accepts development origins", () => {
  assert.equal(developmentUrl("https://host.example.ts.net:8443/login"), "https://host.example.ts.net:8443");
  assert.equal(developmentUrl("http://127.0.0.1:4200"), "http://127.0.0.1:4200");
  assert.throws(() => developmentUrl("https://app.example.com"), /development URL/);
  assert.throws(() => developmentUrl("https://user:pw@x.ts.net"), /development URL/);
  assert.throws(() => developmentUrl("ftp://localhost"), /development URL/);
});

test("names the default session after the project and checkout", () => {
  const a = defaultSession({ name: "shop", root: "/repos/shop" });
  assert.match(a, /^shop-[0-9a-f]{10}$/);
  assert.notEqual(a, defaultSession({ name: "shop", root: "/repos/.worktrees/shop-x" }));
});

test("parses auth arguments", () => {
  const config = { root: "/r", app: {}, ...validateConfig({ name: "shop", auth }) };
  const one = parseAuthArgs(["admin", "--url", "http://localhost:1", "--save"], config);
  assert.deepEqual(one.users, ["admin"]);
  assert.equal(one.statePath("admin"), "/r/.agents/auth/admin.json");
  const all = parseAuthArgs(["--all", "--save", "--url", "http://localhost:1"], config);
  assert.deepEqual(all.users, ["staff", "admin"]);
  assert.equal(parseAuthArgs(["--url", "http://localhost:1"], config).statePath("staff"), undefined);
  assert.throws(() => parseAuthArgs(["--all", "--url", "http://localhost:1"], config), /needs --save/);
  assert.equal(parseAuthArgs(["admin", "--temp", "--save", "--url", "http://localhost:1"], config).temp, true);
  assert.equal(all.temp, true);
  assert.equal(one.temp, false);
  assert.throws(() => parseAuthArgs(["--temp", "--url", "http://localhost:1"], config), /--temp/);
  assert.throws(() => parseAuthArgs(["nobody", "--url", "http://localhost:1"], config), /Unknown user/);
  assert.throws(() => parseAuthArgs([], config), /No app URL/);
  assert.throws(() => parseAuthArgs(["--url", "https://prod.example.com"], config), /development URL/);
});

test("embeds the address and code safely in the page script", () => {
  const script = signInScript('a"+clerk_test@x.com', "424242");
  assert.match(script, /const email = "a\\"\+clerk_test@x\.com";/);
  assert.match(script, /pk_test_/);
  new Function(`return ${script}`); // Parses as JavaScript.
});
