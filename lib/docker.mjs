// Docker safety shared by every DevSports stack on a machine: one lock per
// Docker daemon, so two checkouts never start or build at the same time, and a
// memory check, so a new stack only starts when every container's hard memory
// limit still fits in the daemon (and host) with headroom.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import path from "node:path";

const MIB = 1024 * 1024;
export const DEFAULT_DAEMON_HEADROOM_BYTES = 512 * MIB;

function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 16 * MIB });
  if (result.error || result.status !== 0) {
    throw new Error(`Docker ${args[0]} inspection failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  }
  return result.stdout.trim();
}

export function daemonInfo() {
  const info = JSON.parse(docker(["info", "--format", "{{json .}}"]));
  if (!info.ID || !Number.isSafeInteger(info.MemTotal) || info.MemTotal <= 0) {
    throw new Error("Docker daemon identity or memory capacity is unavailable");
  }
  return { id: info.ID, memoryBytes: info.MemTotal };
}

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** One non-waiting cross-process lock for stack changes on this Docker daemon. */
export async function withDockerHostLock(callback, { daemonId = daemonInfo().id, lockRoot = tmpdir(), name = "devsports" } = {}) {
  const digest = createHash("sha256").update(daemonId).digest("hex").slice(0, 24);
  const lockDir = path.join(lockRoot, `${name}-docker-host-${digest}.lock`);
  const metadataPath = path.join(lockDir, "owner.json");
  const acquire = () => {
    try {
      mkdirSync(lockDir);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return false;
    }
  };
  if (!acquire()) {
    const recoveryDir = `${lockDir}.recover`;
    try {
      mkdirSync(recoveryDir);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("Another command is checking a stale Docker lock; retry");
      throw error;
    }
    try {
      let previous;
      try {
        previous = statSync(lockDir);
      } catch {
        throw new Error("Docker lock changed while checking it; retry");
      }
      let owner;
      try {
        owner = JSON.parse(readFileSync(metadataPath, "utf8"));
      } catch {
        // May be between mkdir and metadata write.
      }
      const ageMs = Date.now() - previous.mtimeMs;
      if (owner ? pidIsAlive(owner.pid) : ageMs < 5000) {
        throw new Error(`Docker daemon is locked by another stack command${owner?.pid ? ` (PID ${owner.pid})` : ""}; retry after it exits`);
      }
      const current = statSync(lockDir);
      if (current.ino !== previous.ino || current.dev !== previous.dev) throw new Error("Docker lock changed while checking it; retry");
      const stale = `${lockDir}.stale-${randomUUID()}`;
      renameSync(lockDir, stale);
      rmSync(stale, { recursive: true, force: true });
      if (!acquire()) throw new Error("Docker daemon lock was acquired by another command; retry");
    } finally {
      rmSync(recoveryDir, { recursive: true, force: true });
    }
  }
  const owner = { pid: process.pid, daemonId, startedAt: new Date().toISOString(), nonce: randomUUID() };
  writeFileSync(metadataPath, JSON.stringify(owner), { mode: 0o600 });
  try {
    return await callback();
  } finally {
    // Don't delete a lock another process has recovered or replaced.
    try {
      if (JSON.parse(readFileSync(metadataPath, "utf8")).nonce === owner.nonce) rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // The original lock no longer exists.
    }
  }
}

/** requestedBytes is the project's total hard cap after the operation. */
export function assessDockerCapacity({ containers, project, requestedBytes, stackCapBytes, daemonBytes, hostBytes, headroomBytes = DEFAULT_DAEMON_HEADROOM_BYTES }) {
  for (const [name, value] of Object.entries({ requestedBytes, stackCapBytes, daemonBytes, hostBytes, headroomBytes })) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name} for Docker memory admission`);
  }
  if (!project) throw new Error("Docker project identity is required for memory admission");
  let ownBytes = 0;
  let otherBytes = 0;
  for (const container of containers) {
    if (!container.running) continue;
    if (!Number.isSafeInteger(container.memoryBytes) || container.memoryBytes <= 0) {
      throw new Error(`Running Docker container ${container.name || container.id || "unknown"} has no hard memory limit; can't safely start another stack`);
    }
    if (container.project === project) ownBytes += container.memoryBytes;
    else otherBytes += container.memoryBytes;
  }
  const projectBytes = Math.max(ownBytes, requestedBytes);
  if (projectBytes > stackCapBytes) throw new Error(`Stack cap exceeded: ${projectBytes} > ${stackCapBytes} bytes`);
  const capacityBytes = Math.min(daemonBytes, hostBytes);
  const committedBytes = otherBytes + projectBytes + headroomBytes;
  if (committedBytes > capacityBytes) {
    throw new Error(
      `Docker memory admission refused: ${Math.ceil(committedBytes / MIB)} MiB committed including headroom, ${Math.floor(capacityBytes / MIB)} MiB available; stop another stack or give Docker more memory`,
    );
  }
  return { admitted: true, projectBytes, otherBytes, committedBytes, capacityBytes, headroomBytes };
}

/** Read-only inspection of the running containers; call under withDockerHostLock. */
export function inspectDockerCapacity({ project, requestedBytes, stackCapBytes = requestedBytes, headroomBytes = DEFAULT_DAEMON_HEADROOM_BYTES }) {
  const daemon = daemonInfo();
  const ids = docker(["ps", "--quiet", "--no-trunc"]).split(/\s+/).filter(Boolean);
  const inspected = ids.length ? JSON.parse(docker(["container", "inspect", ...ids])) : [];
  const containers = inspected.map((item) => ({
    id: item.Id,
    name: item.Name,
    running: item.State?.Running === true,
    memoryBytes: item.HostConfig?.Memory,
    project: item.Config?.Labels?.["com.docker.compose.project"] ?? null,
  }));
  return assessDockerCapacity({ containers, project, requestedBytes, stackCapBytes, daemonBytes: daemon.memoryBytes, hostBytes: totalmem(), headroomBytes });
}
