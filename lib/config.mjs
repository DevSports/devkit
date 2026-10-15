import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const CONFIG_FILE = "devkit.config.json";
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const USER = /^[a-z0-9][a-z0-9-]*$/;

/** The nearest directory at or above `from` with a devkit.config.json. */
export function findRoot(from = process.cwd()) {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir;
    if (path.dirname(dir) === dir) {
      throw new Error(`No ${CONFIG_FILE} in ${from} or above. Run devkit from a project checkout.`);
    }
  }
}

export function loadConfig(root = findRoot()) {
  const file = path.join(root, CONFIG_FILE);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Couldn't read ${file}: ${error.message}`);
  }
  return { root, ...validateConfig(raw) };
}

/** Checks the project's config and fills in defaults. */
export function validateConfig(raw) {
  if (!raw || typeof raw !== "object") throw new Error(`${CONFIG_FILE} must be a JSON object.`);
  const { name, app = {}, auth } = raw;
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new Error(`${CONFIG_FILE}: "name" must be lowercase letters, digits and dashes.`);
  }
  const config = { name, app: { url: app.url }, auth: undefined };
  if (app.url !== undefined) config.app.url = developmentUrl(app.url);
  if (auth !== undefined) {
    const users = auth.users ?? {};
    const names = Object.keys(users);
    if (names.length === 0) throw new Error(`${CONFIG_FILE}: "auth.users" needs at least one user.`);
    for (const user of names) {
      if (!USER.test(user)) throw new Error(`${CONFIG_FILE}: bad user name "${user}".`);
      testEmail(users[user], user);
    }
    const defaultUser = auth.defaultUser ?? names[0];
    if (!Object.hasOwn(users, defaultUser)) {
      throw new Error(`${CONFIG_FILE}: "auth.defaultUser" must be one of ${names.join(", ")}.`);
    }
    config.auth = {
      users,
      defaultUser,
      code: String(auth.code ?? "424242"),
      signInPath: auth.signInPath ?? "/",
      landingPath: auth.landingPath ?? "/",
      stateDir: auth.stateDir ?? ".agents/auth",
    };
    for (const key of ["signInPath", "landingPath"]) {
      if (!config.auth[key].startsWith("/")) throw new Error(`${CONFIG_FILE}: "auth.${key}" must start with /.`);
    }
    if (!/^\d{6}$/.test(config.auth.code)) throw new Error(`${CONFIG_FILE}: "auth.code" must be six digits.`);
  }
  return config;
}

/**
 * Clerk test addresses (`+clerk_test`) sign in with a fixed code on development
 * instances only and never receive email. Anything else is refused.
 */
export function testEmail(value, user) {
  if (typeof value !== "string" || !/^[^\s@]+\+clerk_test@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error(`${CONFIG_FILE}: user "${user}" must have a Clerk test address (name+clerk_test@domain).`);
  }
  return value;
}

/** Only localhost and tailnet origins: never a production host. */
export function developmentUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Not a URL: ${value}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !(local || url.hostname.endsWith(".ts.net"))) {
    throw new Error(`Use a localhost or Tailscale (.ts.net) development URL, not ${url.origin}.`);
  }
  return url.origin;
}

/** The default browser session: one per checkout, so worktrees don't share one. */
export function defaultSession(config) {
  const checkout = createHash("sha256").update(config.root).digest("hex").slice(0, 10);
  return `${config.name}-${checkout}`;
}
