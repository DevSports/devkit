// Tailscale Serve helpers shared by the projects' setup-tailscale scripts.
// Each project decides which services to expose and where it keeps its
// manifest; these do the Tailscale side: find the CLI, read status, choose
// free HTTPS ports, add and remove mappings, and write the URL manifest.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { parseEnv } from "node:util";

/** The CLI: $TAILSCALE_CLI, `tailscale` on PATH, or the macOS app's binary. */
export function findTailscaleCli() {
  const candidates = [
    process.env.TAILSCALE_CLI?.trim(),
    commandPath("tailscale"),
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("Tailscale CLI was not found. Install Tailscale or set TAILSCALE_CLI.");
  return executable;
}

export function commandPath(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Adds `--socket` for a daemon on a custom socket ($TAILSCALE_SOCKET). */
export function tailscaleArguments(args) {
  const socket = process.env.TAILSCALE_SOCKET?.trim();
  return socket ? [`--socket=${socket}`, ...args] : args;
}

/** This machine's MagicDNS name, e.g. mac-mini.tail1234.ts.net. */
export function readTailscaleHostname(tailscale) {
  const result = spawnSync(tailscale, tailscaleArguments(["status", "--json"]), { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Unable to read Tailscale status.");
  const status = JSON.parse(result.stdout);
  const hostname = status?.Self?.DNSName?.replace(/\.$/, "");
  if (!hostname || !hostname.includes(".")) throw new Error("Tailscale MagicDNS is required to expose this checkout.");
  return hostname;
}

export function readServeStatus(tailscale) {
  const result = spawnSync(tailscale, tailscaleArguments(["serve", "status", "--json"]), { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Unable to read Tailscale Serve status.");
  return JSON.parse(result.stdout || "{}");
}

/** HTTPS ports Tailscale Serve already uses. */
export function statusPorts(status) {
  return new Set(
    Object.keys(status?.TCP ?? {})
      .map(Number)
      .filter((port) => Number.isInteger(port)),
  );
}

/** Where a Serve port currently proxies to, if anywhere. */
export function proxyTarget(status, hostname, port) {
  return status?.Web?.[`${hostname}:${port}`]?.Handlers?.["/"]?.Proxy;
}

export function isFunnelAllowed(status, hostname, port) {
  return status?.AllowFunnel?.[`${hostname}:${port}`] === true;
}

export function runTailscale(tailscale, args) {
  const result = spawnSync(tailscale, tailscaleArguments(args), { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tailscale ${args.join(" ")} exited with status ${result.status}`);
}

/** Removes a mapping only while it still points at this service's target. */
export function removeMappingIfOwned(tailscale, status, hostname, service) {
  const currentTarget = proxyTarget(status, hostname, service.publicPort);
  if (!currentTarget) return false;
  if (currentTarget !== service.target) {
    console.warn(`Keeping Tailscale port ${service.publicPort}; it now points to ${currentTarget}.`);
    return false;
  }
  runTailscale(tailscale, [service.exposure, `--https=${service.publicPort}`, "off"]);
  return true;
}

/** A service to expose: its local origin, the Serve target and manifest variables. */
export function service({ label, localVariable, publicVariable, localUrl, targetUrl = localUrl, targetVariable, exposure = "serve", publicPort }) {
  const url = new URL(localUrl);
  const target = new URL(targetUrl);
  return {
    label,
    localVariable,
    publicVariable,
    localUrl: url.origin,
    localPort: Number(url.port),
    target: `http://127.0.0.1:${target.port}`,
    targetVariable,
    exposure,
    publicPort,
  };
}

export function publicUrl(hostname, port) {
  return `https://${hostname}${port === 443 ? "" : `:${port}`}`;
}

/** Free local ports that aren't in `excludedPorts` (which it extends). */
export async function allocatePublicPorts(count, excludedPorts) {
  const servers = [];
  const ports = [];
  try {
    while (ports.length < count) {
      const { port, server } = await reservePort();
      if (excludedPorts.has(port)) {
        await closeServer(server);
        continue;
      }
      servers.push(server);
      ports.push(port);
      excludedPorts.add(port);
    }
  } finally {
    await Promise.all(servers.map(closeServer));
  }
  return ports;
}

export function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        server.close();
        reject(new Error("Unable to allocate a Tailscale Serve port"));
        return;
      }
      resolve({ port: address.port, server });
    });
  });
}

export function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function requiredLoopbackOrigin(value, name) {
  if (!value) throw new Error(`${name} is missing.`);
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.port) {
    throw new Error(`${name} must be a loopback HTTP origin, received ${value}`);
  }
  return `http://127.0.0.1:${url.port}`;
}

export function requiredPort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${name} must be a valid port.`);
  return port;
}

/** A directory lock, so two checkouts don't configure Serve at the same time. */
export async function acquireLock(lockPath, label = "Tailscale") {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      mkdirSync(lockPath);
      return () => rmdirSync(lockPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for the ${label} lock.`);
}

export function readEnvironmentFile(filePath) {
  if (!existsSync(filePath)) return {};
  return parseEnv(readFileSync(filePath, "utf8"));
}

/** Writes the URL manifest atomically, readable only by you. */
export function writeManifest(filePath, environment, header = "# Generated by scripts/setup-tailscale.mjs. Do not commit or edit.") {
  const lines = [header, ...Object.entries(environment).map(([name, value]) => `${name}=${value}`), ""];
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, lines.join("\n"), { mode: 0o600 });
  renameSync(temporaryPath, filePath);
  chmodSync(filePath, 0o600);
}

/** Sets and removes variables in an env file, keeping every other line. */
export function updateEnvironmentFile(filePath, updates, removals = []) {
  const removed = new Set([...removals, ...Object.keys(updates)]);
  const lines = readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => {
      const separator = line.indexOf("=");
      return separator < 1 || !removed.has(line.slice(0, separator));
    });
  while (lines.at(-1) === "") lines.pop();
  for (const [name, value] of Object.entries(updates)) lines.push(`${name}='${value}'`);
  lines.push("");
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, lines.join("\n"), { mode: 0o600 });
  renameSync(temporaryPath, filePath);
  chmodSync(filePath, 0o600);
}
