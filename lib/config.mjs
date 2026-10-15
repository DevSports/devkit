import { createHash } from "node:crypto";
import { validateUrlsConfig } from "./urls.mjs";
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
  const config = { name, app: { url: app.url }, auth: undefined, secrets: validateSecretsConfig(raw.secrets, name), urls: validateUrlsConfig(raw.urls) };
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

const SECRETS_FOLDER = /^\/[a-z0-9/-]+$/;
const SECRET_KEY = /^[A-Z][A-Z0-9_]*$/;
/** Convex deployment selection; never inherited, so a child can't target the wrong backend. */
export const defaultSelectionKeys = [
  "CONVEX_DEPLOYMENT",
  "CONVEX_DEPLOY_KEY",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_URL",
  "CONVEX_SITE_URL",
];

/** Fills in defaults for the `secrets` section of devkit.config.json. */
export function validateSecretsConfig(raw, name) {
  if (raw === undefined) return undefined;
  const prefix = raw.prefix ?? name.toUpperCase().replace(/-/g, "_");
  if (!/^[A-Z][A-Z0-9_]*$/.test(prefix)) throw new Error('devkit.config.json: "secrets.prefix" must be UPPER_SNAKE_CASE.');
  const folders = raw.folders ?? {};
  for (const [folder, keys] of Object.entries(folders)) {
    if (!SECRETS_FOLDER.test(`/${folder}`)) throw new Error(`devkit.config.json: bad secrets folder "${folder}".`);
    if (!Array.isArray(keys) || keys.some((key) => !SECRET_KEY.test(key))) {
      throw new Error(`devkit.config.json: "secrets.folders.${folder}" must list required key names.`);
    }
  }
  const worktree = raw.worktree && {
    scopes: raw.worktree.scopes ?? {},
    legacyFiles: raw.worktree.legacyFiles ?? [],
    legacyStripKeys: raw.worktree.legacyStripKeys ?? [],
    stateDir: raw.worktree.stateDir ?? "local-data/worktree",
  };
  for (const folder of raw.startup ?? []) {
    if (!Object.hasOwn(folders, folder)) throw new Error(`devkit.config.json: startup folder "${folder}" isn't in "secrets.folders".`);
  }
  for (const [scope, keys] of Object.entries(worktree?.scopes ?? {})) {
    if (Object.hasOwn(folders, scope)) throw new Error(`devkit.config.json: "${scope}" is both a folder and a worktree scope.`);
    if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => !SECRET_KEY.test(key))) {
      throw new Error(`devkit.config.json: "secrets.worktree.scopes.${scope}" must list key names.`);
    }
  }
  return {
    prefix,
    folders,
    startup: raw.startup ?? Object.keys(folders),
    environments: raw.environments ?? ["dev"],
    expand: raw.expand ?? true,
    allowReserved: raw.allowReserved ?? [],
    selectionKeys: raw.selectionKeys ?? defaultSelectionKeys,
    validator: raw.validator,
    ciPassthrough: raw.ciPassthrough ?? false,
    worktree,
  };
}
