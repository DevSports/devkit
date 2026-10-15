// Development secrets from Infisical, shared by every DevSports project.
//
// Values are only ever read with `infisical export` into memory, validated, and
// handed to a child process's environment. They never go into argv, logs or
// files (writes use a private temporary file as stdin).
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { loadConfig } from "./config.mjs";
export { defaultSelectionKeys } from "./config.mjs";

const FOLDER = /^\/[a-z0-9/-]+$/;
const KEY = /^[A-Z][A-Z0-9_]*$/;
const SECRET_LIKE = /(?:SECRET|TOKEN|PASSWORD|KEY|PEPPER|SERVICE_ACCOUNT|WEBHOOK|DATABASE_URL|DSN)(?:_|$)/i;
const PROCESS_CONTROL = /^(PATH|HOME|SHELL|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|INFISICAL_.*|CLOUDFLARE_.*)$/;

/**
 * The secrets toolkit for one checkout. Project scripts import this instead of
 * keeping their own Infisical wrapper:
 *
 *   import { secretsFor } from "@devsports/devkit/secrets";
 *   export const { fetchSecrets, childEnvironment, ... } = secretsFor();
 */
export function secretsFor(config = loadConfig()) {
  const settings = config.secrets;
  if (!settings) throw new Error('This project has no "secrets" section in devkit.config.json.');
  const root = config.root;
  const environment = process.env.INFISICAL_ENV || "dev";
  if (!settings.environments.includes(environment)) {
    throw new Error(`INFISICAL_ENV=${environment} isn't allowed here (allowed: ${settings.environments.join(", ")}).`);
  }

  // Capture all CLI output: failure messages and mutation output can contain values.
  function runPrivate(command, args, { cwd = root, env = process.env, input, timeout = 60_000 } = {}) {
    let directory;
    let descriptor;
    let result;
    try {
      if (input !== undefined) {
        // Linux can't reopen spawnSync's stdin socket through /dev/stdin, so CLI
        // @file readers get a private regular file instead. Never put values in argv.
        directory = mkdtempSync(path.join(tmpdir(), "devkit-private-"));
        chmodSync(directory, 0o700);
        const filename = path.join(directory, "input");
        writeFileSync(filename, input, { mode: 0o600, flag: "wx" });
        descriptor = openSync(filename, "r");
      }
      result = spawnSync(command, args, {
        cwd,
        env,
        encoding: "utf8",
        stdio: [descriptor ?? "pipe", "pipe", "pipe"],
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      });
    } finally {
      try {
        if (descriptor !== undefined) closeSync(descriptor);
      } finally {
        if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
      }
    }
    if (result.error || result.status !== 0) {
      const hint = result.error?.code === "ENOENT" ? `${command} is not installed.` : `${command} failed (output hidden to protect secrets).`;
      throw new Error(`${hint} For Infisical, install the CLI and run infisical login --domain=https://eu.infisical.com.`);
    }
    return result.stdout;
  }

  function configuration(cwd = root) {
    const file = path.join(cwd, ".infisical.json");
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`Couldn't read ${file}.`);
    }
    if (!/^[a-f0-9-]{36}$/i.test(parsed.workspaceId ?? "") || parsed.domain !== "https://eu.infisical.com") {
      throw new Error(`Invalid Infisical project configuration in ${file}.`);
    }
    return parsed;
  }

  function infisical(args, options = {}) {
    const project = configuration(options.cwd);
    return runPrivate(
      "infisical",
      [...args, `--projectId=${project.workspaceId}`, `--domain=${project.domain}`, `--env=${environment}`, "--silent"],
      { ...options, env: { ...process.env, INFISICAL_DISABLE_UPDATE_CHECK: "true" } },
    );
  }

  function readEnvFile(filename) {
    return existsSync(filename) ? parseEnv(readFileSync(filename, "utf8")) : {};
  }

  function validateSecrets(values) {
    const own = new RegExp(`^${settings.prefix}_`);
    for (const [key, value] of Object.entries(values)) {
      if (!KEY.test(key) || typeof value !== "string" || value.includes("\0")) {
        throw new Error("Invalid secret name or value in Infisical (values hidden).");
      }
      if ((PROCESS_CONTROL.test(key) || own.test(key)) && !settings.allowReserved.includes(key)) {
        throw new Error(`Refusing process-control setting ${key} in a secrets folder.`);
      }
    }
    return values;
  }

  function fetchSecrets(folder, options = {}) {
    if (!FOLDER.test(folder)) throw new Error("Invalid secrets folder.");
    const output = infisical(
      ["export", "--format=json", `--expand=${options.expand ?? settings.expand}`, "--secret-overriding=false", `--path=${folder}`],
      options,
    );
    let entries;
    try {
      entries = JSON.parse(output);
    } catch {
      throw new Error("Infisical returned invalid JSON (output hidden).");
    }
    if (!Array.isArray(entries)) throw new Error("Unexpected Infisical export format.");
    const values = Object.create(null);
    for (const entry of entries) {
      if (typeof entry.key !== "string" || typeof entry.value !== "string") throw new Error("Invalid Infisical export entry.");
      if (Object.hasOwn(values, entry.key)) throw new Error(`Duplicate Infisical secret: ${entry.key}`);
      values[entry.key] = entry.value;
    }
    return validateSecrets(values);
  }

  function ensureFolder(folder, options = {}) {
    let parent = "/";
    for (const name of folder.split("/").filter(Boolean)) {
      try {
        infisical(["secrets", "folders", "create", `--path=${parent}`, `--name=${name}`], options);
      } catch {
        // Existing folders are fine; a read verifies access after any create failure.
        fetchSecrets(`${parent === "/" ? "" : parent}/${name}`, options);
      }
      parent = `${parent === "/" ? "" : parent}/${name}`;
    }
  }

  function writeSecret(folder, key, value, options = {}) {
    if (process.env.INFISICAL_TOKEN) {
      throw new Error("Writing secrets requires your personal Infisical login. Unset INFISICAL_TOKEN and run infisical login --domain=https://eu.infisical.com.");
    }
    if (!value) throw new Error(`Infisical needs a non-empty value for ${key}.`);
    validateSecrets({ [key]: value });
    infisical(["secrets", "set", `${key}=@/dev/stdin`, `--path=${folder}`], { ...options, input: value });
  }

  function mergeMissingSecrets(folder, values, options = {}) {
    validateSecrets(values);
    ensureFolder(folder, options);
    const existing = fetchSecrets(folder, { ...options, expand: false });
    for (const [key, value] of Object.entries(values)) {
      if (Object.hasOwn(existing, key) && existing[key] !== value) {
        throw new Error(`Conflict in ${folder}/${key}; existing Infisical value preserved. Resolve it before retrying.`);
      }
    }
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(existing, key)) writeSecret(folder, key, value, options);
    }
    const saved = fetchSecrets(folder, { ...options, expand: false });
    if (Object.entries(values).some(([key, value]) => saved[key] !== value)) {
      throw new Error(`Verification failed for ${folder}; local files preserved.`);
    }
    return saved;
  }

  /** The child's environment: inherited secrets and Convex selection stripped, then these values. */
  function childEnvironment(values, scope, inherited = process.env) {
    const env = { ...inherited };
    const injected = `${settings.prefix}_INJECTED_SECRET_NAMES`;
    for (const key of (env[injected] ?? "").split(",")) delete env[key];
    for (const key of Object.keys(env)) {
      if (key.startsWith("INFISICAL_") || settings.selectionKeys.includes(key) || SECRET_LIKE.test(key) || key === "DOCKER_AUTH_CONFIG") {
        delete env[key];
      }
    }
    return {
      ...env,
      ...values,
      [`${settings.prefix}_SECRETS_SCOPE`]: scope,
      [injected]: Object.keys(values).join(","),
    };
  }

  /** Required keys from the config, then development-only Clerk keys, then the project's own checks. */
  async function validateScope(scope, values) {
    const required = settings.folders[scope] ?? settings.worktree?.scopes[scope] ?? [];
    const missing = required.filter((key) => !values[key]?.trim() || values[key].startsWith("replace-with-"));
    if (missing.length) throw new Error(`Missing settings in /${scope}: ${missing.join(", ")}`);
    if (environment === "dev") {
      for (const [key, prefix] of [["CLERK_PUBLISHABLE_KEY", "pk_test_"], ["CLERK_SECRET_KEY", "sk_test_"]]) {
        if (values[key] !== undefined && !values[key].startsWith(prefix)) {
          throw new Error(`/${scope}/${key} must be a Clerk development key.`);
        }
      }
    }
    if (settings.validator) {
      const module = await import(pathToFileURL(path.join(root, settings.validator)).href);
      if (typeof module.validateScope !== "function") throw new Error(`${settings.validator} must export validateScope(scope, values).`);
      await module.validateScope(scope, values);
    }
    return values;
  }

  /** One folder (or worktree scope), fetched and validated. */
  async function loadScope(scope) {
    if (settings.worktree?.scopes[scope]) return validateScope(scope, loadWorktreeSecrets(settings.worktree.scopes[scope]));
    if (!Object.hasOwn(settings.folders, scope)) {
      const known = [...Object.keys(settings.folders), ...Object.keys(settings.worktree?.scopes ?? {})];
      throw new Error(`Unknown secrets folder "${scope}". Expected one of: ${known.join(", ")}.`);
    }
    return validateScope(scope, fetchSecrets(`/${scope}`));
  }

  /** Several scopes merged; the same key may not differ between them. */
  async function loadScopes(scopes) {
    const worktreeScopes = scopes.filter((scope) => settings.worktree?.scopes[scope]);
    if (worktreeScopes.length && settings.selectionKeys.some((key) => process.env[key])) {
      throw new Error("Unset inherited Convex selection variables before starting a worktree.");
    }
    const values = {};
    for (const scope of scopes) {
      const next = await loadScope(scope);
      for (const key of Object.keys(next)) {
        if (Object.hasOwn(values, key) && values[key] !== next[key]) throw new Error(`Conflicting secret ${key} across folders.`);
      }
      Object.assign(values, next);
    }
    return values;
  }

  // Worktree secrets: each linked checkout gets its own Infisical folder of
  // generated keys, so worktrees never share local service credentials.

  function worktreeFolder(checkout = root) {
    // Identical checkout paths on different machines must not share keys.
    const id = createHash("sha256").update(`${hostname()}\0${path.resolve(checkout)}`).digest("hex").slice(0, 24);
    return `/worktrees/${id}`;
  }

  function loadWorktreeSecrets(keys, checkout = root) {
    let linked = false;
    try {
      linked = readFileSync(path.join(checkout, ".git"), "utf8").startsWith("gitdir:");
    } catch {
      // A directory or missing .git means this isn't a linked worktree.
    }
    if (!linked) throw new Error("Worktree secrets require a linked checkout.");
    const directory = path.join(checkout, settings.worktree.stateDir);
    mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, "secrets.lock");
    if (existsSync(lock)) {
      const owner = Number(readFileSync(lock, "utf8"));
      if (!Number.isInteger(owner) || owner <= 0) {
        throw new Error(`Invalid worktree secrets lock; inspect ${path.relative(checkout, lock)} before retrying.`);
      }
      let alive = true;
      try {
        process.kill(owner, 0);
      } catch (error) {
        if (error.code === "ESRCH") alive = false;
      }
      if (alive) throw new Error("Worktree secret setup is already running; retry when it finishes.");
      rmSync(lock);
    }
    writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    try {
      return provisionWorktreeSecrets(keys, checkout);
    } finally {
      rmSync(lock, { force: true });
    }
  }

  function provisionWorktreeSecrets(keys, checkout) {
    const folder = worktreeFolder(checkout);
    const options = { cwd: checkout };
    const allKeys = [...new Set(Object.values(settings.worktree.scopes).flat())];
    // Worktrees made before secrets moved to Infisical kept them in local files:
    // upload those once, then strip them from the files.
    const legacyFiles = settings.worktree.legacyFiles.map((file) => path.join(checkout, file));
    const legacy = Object.assign({}, ...legacyFiles.map(readEnvFile));
    const legacySecrets = Object.fromEntries(allKeys.filter((key) => legacy[key]).map((key) => [key, legacy[key]]));
    let values;
    if (Object.keys(legacySecrets).length) {
      values = mergeMissingSecrets(folder, legacySecrets, options);
      const strip = [...allKeys, ...settings.worktree.legacyStripKeys];
      for (const file of legacyFiles.filter(existsSync)) {
        const kept = readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => !strip.some((key) => line.startsWith(`${key}=`)))
          .join("\n");
        writeFileSync(file, kept, { mode: 0o600 });
      }
    } else {
      ensureFolder(folder, options);
      values = fetchSecrets(folder, options);
    }
    for (const key of keys) {
      if (!Object.hasOwn(values, key)) writeSecret(folder, key, randomBytes(32).toString("hex"), options);
    }
    values = fetchSecrets(folder, options);
    if (keys.some((key) => !values[key])) throw new Error(`Missing worktree service keys in ${folder}.`);
    return Object.fromEntries(keys.map((key) => [key, values[key]]));
  }

  return {
    repositoryRoot: root,
    environment,
    settings,
    scopes: Object.keys(settings.folders),
    worktreeSecretScopes: settings.worktree?.scopes ?? {},
    selectionKeys: settings.selectionKeys,
    runPrivate,
    configuration,
    infisical,
    readEnvFile,
    validateSecrets,
    fetchSecrets,
    ensureFolder,
    writeSecret,
    mergeMissingSecrets,
    childEnvironment,
    validateScope,
    loadScope,
    loadScopes,
    worktreeFolder,
    loadWorktreeSecrets,
  };
}

export const runUsage = `Usage: devkit secrets run <folder>[,<folder>...] [--] <command> [args...]
       devkit secrets check [--startup]

run    Runs the command with those Infisical folders' settings in its
       environment (dev unless INFISICAL_ENV says otherwise and the project
       allows it). Inherited secrets and Convex selection are removed first.
check  Checks every folder in devkit.config.json (or only its "startup" ones)
       has its required settings. Prints counts, never values.`;

/** `devkit secrets run|check`. */
export async function secretsCommand(config, args) {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(runUsage);
    return 0;
  }
  if (sub === "check") {
    const options = rest.filter((arg) => arg !== "--");
    if (options.some((arg) => arg !== "--startup")) throw new Error("Usage: devkit secrets check [--startup]");
    const kit = secretsFor(config);
    const folders = options.includes("--startup") ? kit.settings.startup : kit.scopes;
    for (const folder of folders) {
      const values = await kit.loadScope(folder);
      console.log(`/${folder}: ${Object.keys(values).length} settings available (values hidden)`);
    }
    return 0;
  }
  if (sub !== "run") throw new Error(runUsage);
  const [scope, ...after] = rest;
  const command = after[0] === "--" ? after.slice(1) : after;
  if (!scope || scope.startsWith("-") || command.length === 0) throw new Error(runUsage);
  const settings = config.secrets;
  if (!settings) throw new Error('This project has no "secrets" section in devkit.config.json.');
  // CI workflows pass their own environment.
  if (settings.ciPassthrough && process.env.CI) return spawnCommand(command, process.env);
  const kit = secretsFor(config);
  const values = await kit.loadScopes(scope.split(","));
  const env = kit.childEnvironment(values, scope);
  env[`${settings.prefix}_SECRETS_RUNNER_PID`] = String(process.pid);
  return spawnCommand(command, env);
}

function spawnCommand([command, ...args], env) {
  const child = spawn(command, args, { env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  return new Promise((resolve) => {
    child.on("error", () => {
      console.error(`Couldn't start ${command}.`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
  });
}
