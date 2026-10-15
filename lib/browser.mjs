import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { defaultSession } from "./config.mjs";

export const version = "0.38.1";
// SHA-256 digests published with the upstream GitHub release assets.
const digests = {
  "linux-x64": "5100149a1903211c889de4e545bf36d90803740cea4f99aa22651649f9205ea1",
  "linux-arm64": "937b315ee0761e8a62f7950ddcfef9b3d3d8e8d5eb9c9d2bf9e23e5725664511",
  "darwin-x64": "9187f885f7da0a6d880ff6d2e7dea58e17bea490a1fec85bbb6a36067272ea8e",
  "darwin-arm64": "2e61287259053ea964d39e77002c6a34af0e589e55ccff25e659efae7e892e0d",
};
export const platform = `${process.platform}-${process.arch}`;
const defaultsFile = fileURLToPath(new URL("../agent-browser.json", import.meta.url));

/** One copy per machine, shared by every project and worktree. */
export function binaryPath(env = process.env) {
  const cache = env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(cache, "devkit", "agent-browser", version, `agent-browser-${platform}`);
}

const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function install(args) {
  if (args.some((arg) => arg !== "--with-deps")) throw new Error("Usage: devkit browser install [--with-deps]");
  const digest = digests[platform];
  if (!digest) throw new Error(`agent-browser has no release for ${platform}.`);
  const binary = binaryPath();
  const installed = await readFile(binary).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!installed || checksum(installed) !== digest) {
    console.log(`Installing agent-browser ${version} (${platform})...`);
    const response = await fetch(
      `https://github.com/vercel-labs/agent-browser/releases/download/v${version}/agent-browser-${platform}`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (checksum(bytes) !== digest) throw new Error("agent-browser checksum mismatch");
    await mkdir(path.dirname(binary), { recursive: true });
    const temporary = `${binary}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o755 });
      await rename(temporary, binary);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await chmod(binary, 0o755);
  // Downloads Chrome (and with --with-deps, Linux system libraries).
  const result = spawnSync(binary, ["install", ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * Host settings, lowest priority first: ~/.config/<name>/agent-browser.env
 * (shared by every worktree), then the checkout's ignored .env.agent-browser.
 * Variables already set in the environment win over both.
 */
export function loadHostSettings(config) {
  for (const file of [path.join(config.root, ".env.agent-browser"), path.join(homedir(), ".config", config.name, "agent-browser.env")]) {
    try {
      loadEnvFile(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export function browserEnv(config, env = process.env) {
  return {
    ...env,
    AGENT_BROWSER_SESSION: env.AGENT_BROWSER_SESSION || defaultSession(config),
    AGENT_BROWSER_SCREENSHOT_DIR: path.join(config.root, "output/agent-browser"),
  };
}

function browserArgs(config, args) {
  // A project can still commit its own agent-browser.json to change the defaults.
  const own = path.join(config.root, "agent-browser.json");
  return ["--config", existsSync(own) ? own : defaultsFile, ...args];
}

async function requireBinary() {
  const binary = binaryPath();
  try {
    await access(binary, constants.X_OK);
  } catch {
    throw new Error("agent-browser isn't installed. Run `pnpm browser:install` (devkit browser install).");
  }
  return binary;
}

/** Runs agent-browser with the terminal attached; resolves to its exit code. */
export async function run(config, args) {
  if (args[0] === "upgrade") throw new Error("devkit pins agent-browser's version; don't run its upgrade command.");
  const binary = await requireBinary();
  await mkdir(path.join(config.root, "output/agent-browser"), { recursive: true });
  const child = spawn(binary, browserArgs(config, args), { cwd: config.root, stdio: "inherit", env: browserEnv(config) });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** Runs agent-browser and returns its output, for devkit's own commands. */
export async function capture(config, args, { input, session } = {}) {
  const binary = await requireBinary();
  const env = browserEnv(config, session ? { ...process.env, AGENT_BROWSER_SESSION: session } : process.env);
  const result = spawnSync(binary, browserArgs(config, args), {
    cwd: config.root,
    env,
    input,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, session: env.AGENT_BROWSER_SESSION };
}
