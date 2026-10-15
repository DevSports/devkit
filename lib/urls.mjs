// `devkit urls`: prints (and with --check, requests) the checkout's public
// Tailscale URLs from the manifest its setup script writes.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const ENTRY = /^[A-Z][A-Z0-9_]*$/;

/** Fills in defaults for the `urls` section of devkit.config.json. */
export function validateUrlsConfig(raw) {
  if (raw === undefined) return undefined;
  const entries = (list, field) => {
    if (!Array.isArray(list) || list.length === 0) throw new Error(`devkit.config.json: "urls.${field}" needs at least one entry.`);
    return list.map((entry) => {
      if (typeof entry?.name !== "string" || !ENTRY.test(entry?.variable ?? "")) {
        throw new Error(`devkit.config.json: each "urls.${field}" entry needs a name and an UPPER_SNAKE variable.`);
      }
      return { name: entry.name, variable: entry.variable, checkPath: entry.checkPath ?? "/", extra: entry.extra === true };
    });
  };
  return {
    manifest: raw.manifest ?? ".env.tailscale",
    worktreeManifest: raw.worktreeManifest,
    manifestEnv: raw.manifestEnv,
    services: entries(raw.services, "services"),
    worktreeServices: raw.worktreeServices && entries(raw.worktreeServices, "worktreeServices"),
    missingHint: raw.missingHint,
    worktreeMissingHint: raw.worktreeMissingHint ?? raw.missingHint,
  };
}

function parseManifest(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1], match[2].replace(/^(['"])(.*)\1$/, "$2"));
  }
  return values;
}

export async function urlsCommand(config, args) {
  const settings = config.urls;
  if (!settings) throw new Error('This project has no "urls" section in devkit.config.json.');
  const options = new Set(args.filter((arg) => arg !== "--"));
  for (const option of options) {
    if (!["--check", "--json", "--all", "--help", "-h"].includes(option)) throw new Error(`Unknown option: ${option}`);
  }
  if (options.has("--help") || options.has("-h")) {
    console.log("Usage: devkit urls [--check] [--json] [--all]\n\nPrints this checkout's public URLs; --check requests each one; --all adds optional services.");
    return 0;
  }
  const isWorktree = await stat(path.join(config.root, ".git")).then((entry) => entry.isFile(), () => false);
  const configured = settings.manifestEnv && process.env[settings.manifestEnv];
  const manifestPath = configured
    ? path.resolve(configured)
    : path.join(config.root, isWorktree && settings.worktreeManifest ? settings.worktreeManifest : settings.manifest);
  let text;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    console.error(`Missing Tailscale URL manifest: ${manifestPath}`);
    const hint = isWorktree ? settings.worktreeMissingHint : settings.missingHint;
    if (hint) console.error(hint);
    return 1;
  }
  const values = parseManifest(text);
  // A worktree's manifest lists its own services (e.g. only its client).
  const worktreeEntries = settings.worktreeServices;
  const readingWorktreeManifest = !configured && isWorktree && Boolean(settings.worktreeManifest);
  const useWorktree = worktreeEntries && (readingWorktreeManifest || worktreeEntries.some((entry) => values.has(entry.variable)));
  const entries = (useWorktree ? worktreeEntries : settings.services).filter((entry) => !entry.extra || options.has("--all"));
  const urls = entries.map((entry) => ({ ...entry, url: values.get(entry.variable) ?? null }));

  if (options.has("--json")) {
    console.log(JSON.stringify(urls.map(({ name, variable, url }) => ({ name, variable, url })), null, 2));
  } else {
    for (const entry of urls) console.log(`${entry.name.padEnd(14)} ${entry.url ?? "<missing>"}`);
  }
  if (!options.has("--check")) return 0;

  let failed = false;
  for (const entry of urls) {
    if (!entry.url || !/^https:\/\//.test(entry.url)) {
      console.error(`FAIL ${entry.variable}: missing or not an HTTPS URL`);
      failed = true;
      continue;
    }
    try {
      const response = await fetch(new URL(entry.checkPath, entry.url), { redirect: "manual", signal: AbortSignal.timeout(8_000) });
      const ok = response.status >= 200 && response.status < 400;
      console.error(`${ok ? "PASS" : "FAIL"} ${entry.variable}: HTTP ${response.status}`);
      if (!ok) failed = true;
    } catch (error) {
      console.error(`FAIL ${entry.variable}: ${error instanceof Error ? error.message : String(error)}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
