import assert from "node:assert/strict";
import { test } from "node:test";
import { browserEnv, idleTimeoutMs } from "../lib/browser.mjs";

const config = { name: "shop", root: "/work/shop" };

test("browser sessions shut down after ten idle minutes unless the host says otherwise", () => {
  assert.equal(idleTimeoutMs, 600_000);
  assert.equal(browserEnv(config, {}).AGENT_BROWSER_IDLE_TIMEOUT_MS, "600000");
  assert.equal(browserEnv(config, { AGENT_BROWSER_IDLE_TIMEOUT_MS: "0" }).AGENT_BROWSER_IDLE_TIMEOUT_MS, "0");
  assert.equal(browserEnv(config, { AGENT_BROWSER_IDLE_TIMEOUT_MS: "3600000" }).AGENT_BROWSER_IDLE_TIMEOUT_MS, "3600000");
});
