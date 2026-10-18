// Cloud Convex dev deployments, one per checkout.
//
// Each checkout (the primary one and every linked worktree) gets its own
// Convex cloud dev deployment, created through the Management API with a team
// access token. Worktree deployments expire unless `ensure` runs again, so
// abandoned worktrees clean themselves up. The team token can reach every
// deployment in the team, including production, so everything here refuses
// to touch a deployment that isn't a non-default dev deployment under this
// user's reference prefix.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { secretsFor } from "./secrets.mjs";

export const API = "https://api.convex.dev/v1";
export const REGIONS = ["aws-us-east-1", "aws-eu-west-1", "aws-ca-central-1", "aws-ap-southeast-2"];
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const DAY = 86_400_000;

/** Fills in defaults for the `convex` section of devkit.config.json. */
export function validateConvexConfig(raw) {
  if (raw === undefined) return undefined;
  const fail = (message) => {
    throw new Error(`devkit.config.json: ${message}`);
  };
  if (typeof raw.team !== "string" || !SLUG.test(raw.team)) fail('"convex.team" must be the Convex team slug.');
  if (typeof raw.project !== "string" || !SLUG.test(raw.project)) fail('"convex.project" must be the Convex project slug.');
  const region = raw.region ?? "aws-eu-west-1";
  if (!REGIONS.includes(region)) fail(`"convex.region" must be one of ${REGIONS.join(", ")}.`);
  const worktreeDays = raw.worktreeDays ?? 14;
  if (!Number.isInteger(worktreeDays) || worktreeDays < 1 || worktreeDays > 14) fail('"convex.worktreeDays" must be 1 to 14.');
  const token = { folder: raw.token?.folder ?? "convex", key: raw.token?.key ?? "CONVEX_TEAM_TOKEN" };
  if (!/^[a-z0-9/-]+$/.test(token.folder) || !/^[A-Z][A-Z0-9_]*$/.test(token.key)) fail('"convex.token" needs a secrets "folder" and an UPPER_SNAKE_CASE "key".');
  return { team: raw.team, project: raw.project, region, worktreeDays, token };
}

/** The Convex section, or a clear error for projects that don't have one. */
export function convexSettings(config) {
  if (!config.convex) throw new Error('This project has no "convex" section in devkit.config.json.');
  return config.convex;
}

/** `dev/<user>/`: the only references devkit creates, renews or deletes. */
export function ownedPrefix(user = currentUser()) {
  return `dev/${user}/`;
}

export function currentUser() {
  const name = (process.env.DEVKIT_CONVEX_USER ?? userInfo().username).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error("Couldn't derive a deployment owner from the user name; set DEVKIT_CONVEX_USER.");
  return name;
}

/** The reference for a checkout's deployment, e.g. dev/peter/worktree-1a2b3c4d5e6f. */
export function deploymentReference({ kind, id, user = currentUser() }) {
  if (!["primary", "worktree"].includes(kind)) throw new Error('Deployment kind must be "primary" or "worktree".');
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{2,40}$/.test(id)) throw new Error("Deployment id must be 3 to 41 lowercase letters, digits and dashes.");
  return `${ownedPrefix(user)}${kind}-${id}`;
}

/** Expiry for a new or renewed deployment: none for the primary checkout. */
export function expiryFor(kind, settings, now = Date.now()) {
  // The API caps expiry at the plan's retention window; keep an hour spare.
  return kind === "primary" ? null : now + settings.worktreeDays * DAY - 3_600_000;
}

/** The team token: CONVEX_TEAM_TOKEN in the environment, or the configured Infisical folder. */
export function resolveToken(config, { env = process.env, fetchSecrets } = {}) {
  const settings = convexSettings(config);
  const fromEnv = env[settings.token.key]?.trim();
  if (fromEnv) return fromEnv;
  const read = fetchSecrets ?? secretsFor(config).fetchSecrets;
  const token = read(`/${settings.token.folder}`)[settings.token.key]?.trim();
  if (!token) throw new Error(`Missing ${settings.token.key} in Infisical /${settings.token.folder}. Create a Convex team access token (dashboard → Team Settings → Access Tokens) and store it there.`);
  return token;
}

/** A small Management API client. Errors never include the token. */
export function managementClient(token, { fetch = globalThis.fetch, base = API } = {}) {
  const call = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Convex Management API ${method} ${route} failed (${response.status}): ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : undefined;
  };
  return {
    get: (route) => call("GET", route),
    post: (route, body = {}) => call("POST", route, body),
    patch: (route, body) => call("PATCH", route, body),
  };
}

/** Refuses anything but a non-default dev deployment under the owned prefix. */
export function assertOwned(deployment, user = currentUser()) {
  if (deployment?.deploymentType !== "dev" || deployment.isDefault || typeof deployment.reference !== "string" || !deployment.reference.startsWith(ownedPrefix(user))) {
    throw new Error(`Refusing to manage Convex deployment ${deployment?.name ?? "(unknown)"}: devkit only manages non-default dev deployments under ${ownedPrefix(user)}.`);
  }
  return deployment;
}

export async function findProject(client, settings) {
  const project = await client.get(`/teams/${settings.team}/projects/${settings.project}`);
  if (!project?.id) throw new Error(`Convex project ${settings.team}/${settings.project} wasn't found.`);
  return project;
}

export async function listOwned(client, projectId, user = currentUser()) {
  const deployments = await client.get(`/projects/${projectId}/list_deployments`);
  return deployments.filter((d) => d.deploymentType === "dev" && !d.isDefault && d.reference?.startsWith(ownedPrefix(user)));
}

/**
 * Creates the checkout's deployment, or renews the expiry of the existing one.
 * Returns the deployment, its URLs and whether it was just created (so the
 * caller knows to seed it).
 */
export async function ensureDeployment(client, settings, { kind, id, user = currentUser(), now = Date.now() }) {
  const reference = deploymentReference({ kind, id, user });
  const project = await findProject(client, settings);
  const existing = (await client.get(`/projects/${project.id}/list_deployments`)).find((d) => d.reference === reference);
  const expiresAt = expiryFor(kind, settings, now);
  let deployment;
  let created = false;
  if (existing) {
    deployment = assertOwned(existing, user);
    if (expiresAt !== null) await client.patch(`/deployments/${deployment.name}`, { expiresAt });
  } else {
    deployment = await client.post(`/projects/${project.id}/create_deployment`, { type: "dev", reference, region: settings.region, isDefault: false, expiresAt });
    created = true;
  }
  assertOwned(deployment, user);
  return { ...describe(deployment), expiresAt, created };
}

export function describe(deployment) {
  const url = deployment.deploymentUrl ?? `https://${deployment.name}.convex.cloud`;
  return {
    name: deployment.name,
    reference: deployment.reference,
    region: deployment.region,
    url,
    siteUrl: url.replace(/\.convex\.cloud$/, ".convex.site"),
    dashboardUrl: `https://dashboard.convex.dev/d/${deployment.name}`,
  };
}

/** A deploy key scoped to one deployment, for CONVEX_DEPLOY_KEY. */
export async function createDeployKey(client, deploymentName, keyName = `devkit-${currentUser()}`) {
  const { deployKey } = await client.post(`/deployments/${deploymentName}/create_deploy_key`, { name: keyName });
  if (!isDeployKeyFor(deployKey, deploymentName)) throw new Error(`Convex returned a deploy key for another deployment than ${deploymentName}.`);
  return deployKey;
}

export function isDeployKeyFor(key, deploymentName) {
  return typeof key === "string" && key.startsWith(`dev:${deploymentName}|`);
}

/**
 * Keeps a deploy key for the deployment in `file` (mode 600), minting a new
 * one only when the file is missing or belongs to another deployment.
 */
export async function ensureDeployKeyFile(client, deploymentName, file) {
  const current = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (isDeployKeyFor(current, deploymentName)) return { minted: false };
  const key = await createDeployKey(client, deploymentName);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${key}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
  return { minted: true };
}

export async function deleteDeployment(client, settings, reference, user = currentUser()) {
  const project = await findProject(client, settings);
  const deployment = (await client.get(`/projects/${project.id}/list_deployments`)).find((d) => d.reference === reference);
  if (!deployment) return false;
  assertOwned(deployment, user);
  await client.post(`/deployments/${deployment.name}/delete`);
  return true;
}

export const convexUsage = `Usage: devkit convex <command>

  ensure --kind primary|worktree --id <id> [--key-file <path>] [--json]
      Create this checkout's dev deployment, or renew its expiry. With
      --key-file, keep a deploy key for it there (mode 600).
  list                  Your devkit-managed deployments and when they expire
  delete <reference>    Delete one of them, e.g. dev/<you>/worktree-<id>

The team token comes from CONVEX_TEAM_TOKEN or the "convex.token" Infisical folder.`;

export async function convexCommand(config, args, { client: injected, out = console.log } = {}) {
  const settings = convexSettings(config);
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    out(convexUsage);
    return 0;
  }
  const client = injected ?? managementClient(resolveToken(config));
  if (command === "ensure") {
    const options = parseOptions(rest, ["--kind", "--id", "--key-file"], ["--json"]);
    const result = await ensureDeployment(client, settings, { kind: options["--kind"], id: options["--id"] });
    if (options["--key-file"]) Object.assign(result, await ensureDeployKeyFile(client, result.name, path.resolve(config.root, options["--key-file"])));
    if (options["--json"]) out(JSON.stringify(result, null, 2));
    else out(`${result.created ? "Created" : "Using"} ${result.reference} (${result.name}): ${result.url}${result.expiresAt ? `, expires ${new Date(result.expiresAt).toISOString()}` : ""}`);
    return 0;
  }
  if (command === "list") {
    const project = await findProject(client, settings);
    const owned = await listOwned(client, project.id);
    if (owned.length === 0) out(`No deployments under ${ownedPrefix()} in ${settings.project}.`);
    for (const d of owned) out(`${d.reference.padEnd(40)} ${d.name.padEnd(24)} ${d.expiresAt ? `expires ${new Date(d.expiresAt).toISOString().slice(0, 10)}` : "no expiry"}`);
    return 0;
  }
  if (command === "delete") {
    if (!rest[0]) throw new Error("Usage: devkit convex delete <reference>");
    out((await deleteDeployment(client, settings, rest[0])) ? `Deleted ${rest[0]}.` : `No deployment ${rest[0]}.`);
    return 0;
  }
  throw new Error(`Unknown convex command: ${command}\n\n${convexUsage}`);
}

function parseOptions(args, valued, flags) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (flags.includes(argument)) options[argument] = true;
    else if (valued.includes(argument) && args[index + 1] !== undefined) options[argument] = args[++index];
    else throw new Error(`Unexpected argument: ${argument}\n\n${convexUsage}`);
  }
  return options;
}
