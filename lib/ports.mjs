// Local ports for a checkout's published services.
//
// Every checkout (the primary one and every linked worktree) picks its own
// random loopback ports once and saves them, so its local URLs stay put across
// restarts. Ports come from below the range the OS hands out for outgoing
// connections (Linux 32768–60999, macOS 49152–65535): a saved port of a
// stopped stack is then never taken by a browser or a download in between.
import { spawnSync } from "node:child_process";
import net from "node:net";

export const LOCAL_PORT_RANGE = Object.freeze({ min: 20000, max: 32767 });

/** Whether nothing else holds the port on the loopback address. */
export function canBindPort(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port }, () => server.close(() => resolve(true)));
  });
}

/**
 * Picks a free port for each name, avoiding `reserved` and each other.
 * Returns `{ name: port }`; save it and reuse it on later starts.
 */
export async function allocateLocalPorts(names, { reserved = [], canBind = canBindPort, random = Math.random, range = LOCAL_PORT_RANGE, attempts = 200 } = {}) {
  const taken = new Set(reserved);
  const ports = {};
  for (const name of names) {
    for (let attempt = 0; attempt < attempts && ports[name] === undefined; attempt += 1) {
      const candidate = range.min + Math.floor(random() * (range.max - range.min + 1));
      if (!taken.has(candidate) && (await canBind(candidate))) ports[name] = candidate;
    }
    if (ports[name] === undefined) throw new Error(`No free local port found for ${name} in ${range.min}–${range.max}; retry.`);
    taken.add(ports[name]);
  }
  return ports;
}

/** Host ports published by the running containers of a Compose project. */
export function publishedPorts(project) {
  const result = spawnSync("docker", ["ps", "--quiet", "--filter", `label=com.docker.compose.project=${project}`], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`Docker ps failed: ${result.error?.message ?? result.stderr.trim()}`);
  const ids = result.stdout.split(/\s+/).filter(Boolean);
  if (ids.length === 0) return [];
  const inspected = spawnSync("docker", ["container", "inspect", ...ids], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (inspected.error || inspected.status !== 0) throw new Error(`Docker inspect failed: ${inspected.error?.message ?? inspected.stderr.trim()}`);
  return JSON.parse(inspected.stdout).flatMap((container) =>
    Object.values(container.NetworkSettings?.Ports ?? {}).flatMap((bindings) => (bindings ?? []).map((binding) => Number(binding.HostPort))),
  );
}

/**
 * Refuses to start when a saved port is held by something other than the
 * stack itself (`owned`, e.g. from publishedPorts), naming the port instead of
 * leaving Docker's "port is already allocated".
 */
export async function assertPortsAvailable(ports, { owned = [], canBind = canBindPort, remedy = "Stop the process holding it, then retry." } = {}) {
  const ownedSet = new Set(owned);
  for (const [name, port] of Object.entries(ports)) {
    if (ownedSet.has(port) || (await canBind(port))) continue;
    throw new Error(`The ${name} port 127.0.0.1:${port} is held by another process. ${remedy}`);
  }
}
