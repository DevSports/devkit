// `devkit stack`: one Docker Compose launcher for the DevSports projects.
//
// Each project keeps its own compose.yaml and lists the rest in the "stack"
// section of devkit.config.json. The launcher does the common work: refuse
// non-development settings and root, name the Compose project per checkout,
// check Docker memory under a host-wide lock, build the setup image, export
// Infisical secrets into .env.compose/ (on the host, or in the auth container
// when the host CLI isn't logged in), publish the app with Tailscale Serve, and
// start, stop or pass commands through to Compose.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspectDockerCapacity, withDockerHostLock } from "./docker.mjs";
import { secretsFor } from "./secrets.mjs";
import { findTailscaleCli, publicUrl, readServeStatus, readTailscaleHostname, readEnvironmentFile, runTailscale } from "./tailscale.mjs";

const COMMAND = (value) => Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string");

/** Fills in defaults for the `stack` section of devkit.config.json. */
export function validateStackConfig(raw, name) {
  if (raw === undefined) return undefined;
  const prefix = raw.prefix ?? name.toUpperCase().replace(/-/g, "_");
  if (!/^[A-Z][A-Z0-9_]*$/.test(prefix)) throw new Error('devkit.config.json: "stack.prefix" must be UPPER_SNAKE_CASE.');
  const commandOrUndefined = (value, field) => {
    if (value === undefined) return undefined;
    if (!COMMAND(value)) throw new Error(`devkit.config.json: "stack.${field}" must be a command array, e.g. ["node", "scripts/x.mjs"].`);
    return value;
  };
  const secrets = raw.secrets ?? {};
  if (secrets.folders !== undefined && (!Array.isArray(secrets.folders) || secrets.folders.some((f) => !/^[a-z0-9-]+$/.test(f)))) {
    throw new Error('devkit.config.json: "stack.secrets.folders" must list folder names.');
  }
  const tailscale = raw.tailscale ?? {};
  const port = (value, field) => {
    if (value === undefined) return undefined;
    if (typeof value?.variable !== "string" || !Number.isInteger(value.default)) {
      throw new Error(`devkit.config.json: "stack.${field}" needs a "variable" and a numeric "default".`);
    }
    return value;
  };
  return {
    prefix,
    files: raw.files ?? ["compose.yaml"],
    worktreeFiles: raw.worktreeFiles ?? [],
    profileFiles: raw.profileFiles ?? {},
    worktreeProjects: raw.worktreeProjects ?? false,
    envFile: raw.envFile,
    profilesFile: raw.profilesFile,
    setupService: raw.setupService ?? "setup",
    authService: raw.authService ?? "auth",
    upArgs: raw.upArgs ?? [],
    secrets: {
      folders: secrets.folders,
      command: commandOrUndefined(secrets.command, "secrets.command"),
      containerCommand: commandOrUndefined(secrets.containerCommand, "secrets.containerCommand"),
      directory: secrets.directory ?? ".env.compose",
    },
    beforeUp: commandOrUndefined(raw.beforeUp, "beforeUp"),
    devHost: raw.devHost ?? false,
    tailscale: {
      route: tailscale.route && {
        target: port(tailscale.route.target, "tailscale.route.target"),
        localPorts: (tailscale.route.localPorts ?? []).map((p, i) => port(p, `tailscale.route.localPorts[${i}]`)),
        firstPort: tailscale.route.firstPort ?? 8443,
      },
      command: commandOrUndefined(tailscale.command, "tailscale.command"),
      stopCommand: commandOrUndefined(tailscale.stopCommand, "tailscale.stopCommand"),
      profile: tailscale.profile,
      manifest: tailscale.manifest ?? ".env.tailscale",
      worktreeManifest: tailscale.worktreeManifest,
      beforeSecrets: tailscale.beforeSecrets ?? false,
      manifestEnv: tailscale.manifestEnv ?? false,
    },
    worktree: raw.worktree && {
      detach: raw.worktree.detach ?? false,
      afterUp: commandOrUndefined(raw.worktree.afterUp, "worktree.afterUp"),
      follow: raw.worktree.follow ?? [],
    },
    print: raw.print ?? [],
  };
}

/** A linked worktree's ID: its folder name and a short hash of its path. */
export function worktreeId(root) {
  const slug =
    path
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "worktree";
  return `${slug}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
}

export function isLinkedWorktree(root) {
  try {
    return statSync(path.join(root, ".git")).isFile();
  } catch {
    return false;
  }
}

/** `${VAR:-default}` and `${VAR}` from the environment; null when a `${VAR}` without a default is unset. */
export function interpolate(text, env) {
  let missing = false;
  const result = text.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    if (env[name]) return env[name];
    if (fallback === undefined) missing = true;
    return fallback ?? "";
  });
  return missing ? null : result;
}

// Tailscale Serve route for the app's proxy: reuse the saved port, then an
// existing exact route, then the first free port from firstPort. Never replace
// another route, and never touch a route that's public through Funnel.
function servesTarget(status, hostname, port, target) {
  const address = `${hostname}:${port}`;
  const handlers = status.Web?.[address]?.Handlers ?? {};
  return status.TCP?.[port]?.HTTPS === true && Object.keys(handlers).length === 1 && handlers["/"]?.Proxy === target && !status.AllowFunnel?.[address];
}

export function savedRoutePort(manifest) {
  if (!manifest.TAILSCALE_APP_URL) return undefined;
  const port = Number(new URL(manifest.TAILSCALE_APP_URL).port || 443);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

export function planRoute(status, hostname, target, saved, localPorts = [], firstPort = 8443) {
  const used = new Set([...Object.keys(status.TCP ?? {}).map(Number), ...localPorts]);
  if (saved && !localPorts.includes(saved)) {
    if (servesTarget(status, hostname, saved, target)) return { port: saved, action: "ready" };
    if (!used.has(saved)) return { port: saved, action: "add" };
  }
  const existing = Object.keys(status.TCP ?? {})
    .map(Number)
    .filter((port) => servesTarget(status, hostname, port, target));
  if (existing.length === 1) return { port: existing[0], action: "ready" };
  let port = firstPort;
  while (used.has(port)) port += 1;
  return { port, action: "add" };
}

export function ownedRoutePort(status, hostname, target, saved) {
  return saved && servesTarget(status, hostname, saved, target) ? saved : undefined;
}

function writeManifestValue(file, key, value) {
  const kept = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line && !line.startsWith(`${key}=`)) : [];
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, [...kept, `${key}=${value}`, ""].join("\n"), { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function tailscaleCli() {
  try {
    return findTailscaleCli();
  } catch {
    return undefined;
  }
}

/** This machine's MagicDNS name while Tailscale is running, else undefined. */
function devHost(cli) {
  if (!cli) return undefined;
  try {
    const host = readTailscaleHostname(cli);
    return /^[a-z0-9][a-z0-9.-]*\.ts\.net$/i.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

export const usage = `Usage: devkit stack <up|down|stop|login|secrets|stats|...> [compose args]

  up       Check memory, build the setup image, export secrets, publish the app
           with Tailscale Serve, then docker compose up (args pass through)
  down     Stop the stack (all profiles) and remove this checkout's Tailscale route
  stop     Stop containers (all profiles unless services are named)
  login    Log in to Infisical inside the stack's auth container
  secrets  Export secrets into the Compose secrets folder only
  stats    docker stats for this stack's containers
  other    Passed to docker compose (logs, ps, exec, run, build, restart, config, …)`;

export async function stackCommand(config, argv) {
  const settings = config.stack;
  if (!settings) throw new Error('This project has no "stack" section in devkit.config.json.');
  const [action = "up", ...args] = argv;
  if (action === "--help" || action === "-h") {
    console.log(usage);
    return 0;
  }
  const root = config.root;
  if (action === "export-secrets") {
    // Runs inside the auth container when the host's Infisical CLI isn't logged in.
    if (!settings.secrets.folders) throw new Error('"stack.secrets.folders" isn\'t set.');
    exportFolders(config, settings.secrets.folders, path.resolve(args[0] ?? path.join(root, settings.secrets.directory)));
    return 0;
  }
  const linked = isLinkedWorktree(root);
  const project = process.env.COMPOSE_PROJECT_NAME ?? (linked && settings.worktreeProjects ? `${config.name}-${worktreeId(root)}` : config.name);
  const secretsDirectory = path.join(root, settings.secrets.directory);
  const manifestPath = path.join(root, linked && settings.tailscale.worktreeManifest ? settings.tailscale.worktreeManifest : settings.tailscale.manifest);
  let env = { ...process.env, COMPOSE_PROJECT_NAME: project };

  if ((env.INFISICAL_ENV || "dev") !== "dev") throw new Error("The Compose stack supports the development environment only.");
  env[`${settings.prefix}_UID`] ??= String(process.getuid());
  env[`${settings.prefix}_GID`] ??= String(process.getgid());
  if (!/^\d+$/.test(env[`${settings.prefix}_UID`]) || env[`${settings.prefix}_UID`] === "0" || !/^\d+$/.test(env[`${settings.prefix}_GID`])) {
    throw new Error("Run the development stack as a non-root user.");
  }
  const profilesFile = settings.profilesFile && path.join(root, settings.profilesFile);
  if (env.COMPOSE_PROFILES === undefined && profilesFile && existsSync(profilesFile)) env.COMPOSE_PROFILES = readFileSync(profilesFile, "utf8").trim();
  const profiles = () => new Set((env.COMPOSE_PROFILES ?? "").split(",").filter(Boolean));

  const composeArgs = ({ bootstrap = false } = {}) => {
    const files = [...settings.files, ...(linked ? settings.worktreeFiles : [])];
    if (!bootstrap) for (const profile of profiles()) files.push(...(settings.profileFiles[profile] ?? []));
    const envFile = settings.envFile && path.join(root, settings.envFile);
    return [
      "compose",
      "--project-name",
      project,
      ...(settings.envFile ? ["--env-file", !bootstrap && existsSync(envFile) ? envFile : "/dev/null"] : []),
      ...files.flatMap((file) => ["--file", file]),
    ];
  };
  const run = (command, commandArgs, options = {}) => {
    const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: "inherit", ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${commandArgs.slice(0, 2).join(" ")} exited with status ${result.status ?? 1}.`);
    return result;
  };
  const compose = (composeOptions, ...rest) => run("docker", [...composeArgs(composeOptions), ...rest]);
  const hook = (command) => run(command[0], command.slice(1));
  const prepareDirectory = () => {
    mkdirSync(secretsDirectory, { recursive: true, mode: 0o700 });
    chmodSync(secretsDirectory, 0o700);
  };
  const buildSetup = () => compose({ bootstrap: true }, "build", settings.setupService);
  // Only projects whose compose.yaml reads the Tailscale manifest (ports, URLs) get it in Compose's environment.
  const loadManifest = () => {
    if (!settings.tailscale.manifestEnv) return;
    env = { ...env, ...readEnvironmentFile(manifestPath), ...process.env, COMPOSE_PROJECT_NAME: project, COMPOSE_PROFILES: env.COMPOSE_PROFILES };
  };

  if (action === "login") {
    prepareDirectory();
    buildSetup();
    compose({ bootstrap: true }, "run", "--rm", "--no-deps", settings.authService, ...args);
    return 0;
  }
  if (action === "stats") {
    const ids = spawnSync("docker", [...composeArgs(), "ps", "--quiet"], { cwd: root, env, encoding: "utf8" }).stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length) run("docker", ["stats", ...args, ...ids]);
    else console.log("This checkout's Compose stack isn't running.");
    return 0;
  }
  if (action === "down" || action === "stop") {
    loadManifest();
    if (action === "down" || args.length === 0) compose({}, "--profile", "*", action, ...args);
    else compose({}, action, ...args);
    if (args.length === 0) stopTailscale(settings, env, root, manifestPath, run);
    return 0;
  }
  if (action !== "up" && action !== "secrets") {
    compose({}, action, ...args);
    return 0;
  }

  // up / secrets
  prepareDirectory();
  await withDockerHostLock(async () => {
    if (action === "up") {
      const requested = requestedMemory(root, env, composeArgs());
      inspectDockerCapacity({ project, requestedBytes: requested });
    }
    buildSetup();
  });
  loadManifest();
  const cli = tailscaleCli();
  const tailscaleOn = (env.TAILSCALE_ENABLED ?? "true") !== "false" && (!settings.tailscale.profile || profiles().has(settings.tailscale.profile));
  // Some exports read the Tailscale URLs, so their setup runs first.
  if (tailscaleOn && settings.tailscale.beforeSecrets) startTailscale(settings, env, cli, manifestPath, run);
  exportSecrets(config, settings, env, root, secretsDirectory, compose);
  if (settings.beforeUp) hook(settings.beforeUp);
  if (action === "secrets") return 0;

  loadManifest();
  if (settings.devHost && !env[`${settings.prefix}_DEV_HOST`]) {
    const host = devHost(cli);
    if (host) env[`${settings.prefix}_DEV_HOST`] = host;
  }
  if (tailscaleOn && !settings.tailscale.beforeSecrets) startTailscale(settings, env, cli, manifestPath, run);
  loadManifest();
  const printEnv = {
    ...(settings.envFile ? readEnvironmentFile(path.join(root, settings.envFile)) : {}),
    ...readEnvironmentFile(manifestPath),
    ...env,
  };
  for (const line of settings.print) {
    const text = interpolate(line, printEnv);
    if (text !== null) console.log(text);
  }

  const upArgs = [...settings.upArgs, ...args];
  if (linked && settings.worktree?.detach) {
    const detached = upArgs.filter((arg) => !["--detach", "-d"].includes(arg));
    compose({}, "up", "--detach", ...detached);
    if (settings.worktree.afterUp) hook(settings.worktree.afterUp);
    if (!args.some((arg) => ["--detach", "-d", "--wait"].includes(arg)) && settings.worktree.follow.length) {
      compose({}, "logs", "--follow", ...settings.worktree.follow);
    }
    return 0;
  }
  // Foreground compose up, with signals passed through so Ctrl-C stops it cleanly.
  const child = spawn("docker", [...composeArgs(), "up", ...upArgs], { cwd: root, env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** Total hard memory caps of the services `up` would start. */
function requestedMemory(root, env, composeArgs) {
  const result = spawnSync("docker", [...composeArgs, "config", "--format", "json"], { cwd: root, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`docker compose config failed: ${result.stderr.trim()}`);
  const services = JSON.parse(result.stdout).services ?? {};
  let total = 0;
  for (const [name, service] of Object.entries(services)) {
    const bytes = Number(service.mem_limit);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`Service ${name} has no hard memory limit (mem_limit).`);
    total += bytes;
  }
  return total;
}

function exportSecrets(config, settings, env, root, directory, compose) {
  const { folders, command, containerCommand } = settings.secrets;
  if (!folders && !command) return;
  const hostLoggedIn =
    spawnSync("infisical", ["login", "status", "--domain=https://eu.infisical.com", "--json"], { stdio: "ignore", env }).status === 0;
  if (hostLoggedIn) {
    if (folders) exportFolders(config, folders, directory);
    else spawnOrThrow(command[0], command.slice(1), root, env);
    return;
  }
  // No host login: run the same export inside the auth container, which has its own login.
  if (containerCommand) {
    spawnOrThrow(containerCommand[0], containerCommand.slice(1), root, env);
    return;
  }
  const inner = folders
    ? ["node", "node_modules/@devsports/devkit/bin/devkit.mjs", "stack", "export-secrets", "/secrets"]
    : [...command, "/secrets"];
  compose({ bootstrap: true }, "run", "--rm", "--no-deps", settings.authService, ...inner);
}

/** Writes each folder's settings to <directory>/<folder>.json (mode 600). */
export function exportFolders(config, folders, directory) {
  const kit = secretsFor(config);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  for (const folder of folders) {
    const values = kit.fetchSecrets(`/${folder}`);
    const file = path.join(directory, `${folder}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(values), { mode: 0o600 });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  }
  console.log("Prepared development configuration for Compose (values hidden).");
}

function spawnOrThrow(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 1}.`);
}

function startTailscale(settings, env, cli, manifestPath, run) {
  const { route, command } = settings.tailscale;
  if (command) {
    run(command[0], command.slice(1));
    return;
  }
  if (!route) return;
  const host = env[`${settings.prefix}_DEV_HOST`] ?? devHost(cli);
  if (!cli || !host) return;
  const targetPort = Number(env[route.target.variable] || route.target.default);
  const target = `http://127.0.0.1:${targetPort}`;
  const localPorts = [targetPort, ...route.localPorts.map((p) => Number(env[p.variable] || p.default))];
  let status = {};
  try {
    status = readServeStatus(cli);
  } catch {
    // Unreadable status means Serve has no routes yet.
  }
  const { port, action } = planRoute(status, host, target, savedRoutePort(readEnvironmentFile(manifestPath)), localPorts, route.firstPort);
  try {
    if (action === "add") runTailscale(cli, ["serve", "--bg", `--https=${port}`, target]);
    const url = publicUrl(host, port);
    writeManifestValue(manifestPath, "TAILSCALE_APP_URL", url);
    console.log(`Tailscale: ${url}`);
  } catch {
    console.error(`Couldn't add the Tailscale HTTPS route. Run: tailscale serve --bg --https=${port} ${target}`);
  }
}

function stopTailscale(settings, env, root, manifestPath, run) {
  const { route, stopCommand, profile } = settings.tailscale;
  if (stopCommand) {
    if (profile && !(env.COMPOSE_PROFILES ?? "").split(",").includes(profile)) return;
    if (env.TAILSCALE_ENABLED === "false") return;
    run(stopCommand[0], stopCommand.slice(1));
    return;
  }
  if (!route) return;
  const manifest = readEnvironmentFile(manifestPath);
  const cli = tailscaleCli();
  if (!cli || !manifest.TAILSCALE_APP_URL) return;
  const host = new URL(manifest.TAILSCALE_APP_URL).hostname;
  const target = `http://127.0.0.1:${Number(env[route.target.variable] || route.target.default)}`;
  let status = {};
  try {
    status = readServeStatus(cli);
  } catch {
    return;
  }
  const port = ownedRoutePort(status, host, target, savedRoutePort(manifest));
  if (port) {
    runTailscale(cli, ["serve", `--https=${port}`, "off"]);
    console.log(`Removed Tailscale route on port ${port}.`);
  }
}
