# Upgrading a project to cloud Convex dev deployments

This is how ARC moved from a local, self-hosted Convex backend in every
checkout to one Convex cloud dev deployment per checkout (devkit 0.5.0). Follow
the same steps in any DevSports project that runs Convex locally in its Docker
stack.

## Why

A local Convex backend needed 2.5 GiB in every checkout, and two or three
worktrees on one development host ran out of memory. Convex recommends a
separate cloud dev deployment for every worktree or coding agent. With it:

- each checkout still has its own isolated data;
- the stack needs no backend container, admin key or local dashboard;
- an abandoned worktree's deployment expires on its own.

What stays local: the project's other services (Typesense, media, renderers),
the Convex watcher that bundles and pushes code (`convex dev`), and the
declaration and shared-package watchers.

## Before you start

1. **Plan.** On the Professional plan a team can have 300 deployments; on Free
   or Starter, 40. Each checkout uses one. Function calls and database
   bandwidth count against the plan, which seeding and normal development
   stay well inside on Professional.
2. **Team access token.** In the Convex dashboard: Team Settings → Access
   Tokens → create one, for example "devkit deployments". Store it in the
   project's Infisical development environment as `CONVEX_TEAM_TOKEN` in the
   `/convex` folder (or wherever the project's `convex.token` points). One
   token works for every project in the team.
3. **Funnel**, if the cloud deployment calls local services. Check the host
   with `tailscale status --json` and look for `funnel` under
   `Self.Capabilities`. If it's missing, a tailnet admin adds this to the
   tailnet policy file (admin console → Access controls), from any browser:

   ```json
   "nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]
   ```

   Nothing needs to be run on the host itself, so headless VMs are fine.

## 1. Configure devkit

Pin the release in the workspace root and add the `convex` section:

```sh
pnpm add -Dw github:DevSports/devkit#v0.5.0
```

```json
"convex": { "team": "<team-slug>", "project": "<project-slug>", "region": "aws-eu-west-1" }
```

Find the slugs with `GET https://api.convex.dev/v1/token_details` and
`/teams/<teamId>/list_projects`, or in the dashboard URL.

**Check every script that copies an Infisical folder into Convex.** ARC's
`pnpm secrets:sync:convex` pushed every key in `/convex` to a deployment; it now
skips `CONVEX_TEAM_TOKEN` (`toolingKeys` in `scripts/secrets/convex.mjs`), with
a test. A team token in a deployment's environment is readable by anyone with
dashboard access to that deployment.

## 2. Create the deployment during start-up

In the project's `dev up` (ARC: `ensureCloudConvex` in `scripts/dev/stack.mjs`):

```js
import { loadConfig } from "@devsports/devkit/config";
import { ensureDeployment, ensureDeployKeyFile, managementClient, resolveToken } from "@devsports/devkit/convex";

const config = loadConfig(root);
const client = managementClient(resolveToken(config));
const deployment = await ensureDeployment(client, config.convex, { kind: checkoutKind, id: stackId });
await ensureDeployKeyFile(client, deployment.name, "local-data/dev/secrets/convex_deploy_key");
```

- `kind` is `primary` for the main checkout (never expires) and `worktree` for
  linked worktrees (expires 14 days after the last start).
- Save `deployment.name`, `url` and `siteUrl` in the stack's manifest.
- If `deployment.created` is true, or the saved name changed because an old
  deployment expired, clear the stack's "seeded" markers and seed again.

## 3. Point everything at the deployment

| Was | Now |
| --- | --- |
| `CONVEX_SELF_HOSTED_URL` + admin key in tool containers and the watcher | `CONVEX_DEPLOY_KEY` from the key file, mounted as a Compose secret. Unset `CONVEX_DEPLOYMENT` and `CONVEX_SELF_HOSTED_*`. |
| Client `convexUrl` / `convexSiteUrl` from the local gateway | `deployment.url` / `deployment.siteUrl` |
| `backend/.../.env.local` with self-hosted URLs | `CONVEX_DEPLOY_KEY`, `CONVEX_URL`, `CONVEX_SITE_URL`, so host `convex logs/run/export` reach this checkout's deployment only |
| Callbacks to `http://convex:3211/...` on the Docker network | `${siteUrl}/...` |
| Service URLs on the Docker network (`http://typesense:8108`) | A Funnel path (step 4) |
| Self-hosted dashboard service | The cloud dashboard: `https://dashboard.convex.dev/d/<name>` |

Remove the `convex` service, its data volume declaration, its instance secret
and admin-key generation from Compose, and drop `convex` from every
`depends_on`. Remove the gateway's Convex and Convex HTTP ports and the
Tailscale Serve routes for them.

ARC kept `ARC_RUNTIME=local-docker` for these deployments rather than
`development-cloud`: in ARC that runtime decides whether real third-party
provisioning (OpenRouter keys) runs, and every checkout's deployment sharing
one provider prefix would let one checkout's seed reset delete another's keys.
Check what your project's runtime flag switches on. The seed guard now accepts
the stack's own `*.convex.cloud` URL instead of its old tailnet URL.

## 4. Publish what the deployment calls

List every URL the Convex functions fetch (not URLs they only hand to the
browser). In ARC that was Typesense on every search, and the Canvas render
worker during exports. For each:

```js
import { addFunnelPath, findTailscaleCli } from "@devsports/devkit/tailscale";
const typesense = addFunnelPath(findTailscaleCli(), {
  port: 8443, mount: `/arc-${stackId}/typesense`, target: `http://127.0.0.1:${typesensePort}`,
});
```

- Publish through a loopback port on the stack's gateway; Funnel needs a host
  target.
- The service must check a secret on every request (Typesense's API key,
  signed render requests). Never Funnel a client, dashboard or admin tool.
- Code that requires a bare origin (ARC's `CANVAS_RENDER_BASE_URL`) gets a
  whole Funnel port (`mount: "/"`), so only one checkout per host can use it
  at once. ARC only publishes it in Canvas mode.
- Remove the paths in `dev down` and `dev destroy` with `removeFunnelPath`.
- Test from outside: requests from the host to its own Funnel URL can fail,
  but a Convex action's `fetch` is the real path.

## 5. Migrate existing stacks on their next start

ARC's `pnpm dev up` moves an old stack over without manual steps:

1. Rewrites the manifest's ports: the old Convex port becomes the Typesense
   Funnel port, so the primary checkout's fixed ports don't move.
2. Creates and seeds a new cloud deployment.
3. Removes the old `convex` container (`docker rm -f` by its stack and service
   labels) to free its memory.
4. Keeps the old `convex_data` volume until `dev destroy`, in case anyone
   needs its documents. Copy them with `convex export` from a temporary
   self-hosted container and `convex import --replace-all` if needed.

Other commands on an unmigrated stack say "run `pnpm dev up` once". `dev
destroy` now also deletes the cloud deployment.

## 6. Retire local-backend tooling

ARC removed `pnpm dev export/import/native-export` and its migration module:
they moved data in and out of the local backend. The Convex CLI does the same
against the cloud deployment:

```sh
pnpm -C backend/apps/convex exec convex export --include-file-storage --path snapshot.zip
pnpm -C backend/apps/convex exec convex import --replace-all snapshot.zip
```

## 7. Verify

- `pnpm dev up` in a linked worktree: a deployment named
  `dev/<you>/worktree-<id>` appears in `devkit convex list` with an expiry.
- The seed completes and search sync succeeds (proves the Funnel path works
  from the cloud).
- Sign in on the client URL and use a page that searches.
- `pnpm dev status` shows the deployment, dashboard link and expiry, and no
  `convex` container.
- `pnpm dev destroy arcdev-<id>` deletes the deployment and the Funnel path.
- Unit tests for the stack script, Compose config, the seed guard and the
  secrets sync.

## Memory

ARC's core stack fell from 13,312 to 10,752 MiB of hard caps. The default
budget stayed at 13,312 MiB, so the media Worker (1,024 MiB) now runs beside
Convex source watching instead of replacing it.
