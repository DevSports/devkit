# devkit

Shared development tooling for the DevSports projects, so a fix lands once
instead of in every repo.

- **`devkit browser`**: [agent-browser](https://agent-browser.dev), pinned by
  version and SHA-256 digest, running headless Chrome. One copy per machine.
- **`devkit auth`**: signs a browser session in as a Clerk test user with the
  fixed test code. No passwords, secret keys or email.
- **`devkit secrets`**: runs commands with development settings from
  Infisical, and gives project scripts one shared Infisical toolkit.
- **`devkit stack`**: one Docker Compose launcher for every project's
  development stack, with a host-wide Docker lock and memory check.
- **`devkit watch`**: reruns a command when files change, by polling (native
  watchers don't work on Docker Desktop's macOS file sharing).
- **`devkit urls`** and **`@devsports/devkit/tailscale`**: the checkout's
  public Tailscale URLs, and the Tailscale Serve and Funnel helpers behind each
  project's `setup:tailscale`.
- **`devkit convex`** and **`@devsports/devkit/convex`**: one Convex cloud dev
  deployment per checkout, created, renewed and deleted with a team token,
  so no checkout runs a local Convex backend.

This repository is public. Never commit secrets, hostnames or user data;
anything project-specific belongs in the project's `devkit.config.json`.

## Use it in a project

Add it to the workspace root, pinned to a release tag:

```sh
pnpm add -Dw github:DevSports/devkit#v0.4.2
```

Add the scripts the project's docs and agents use:

```json
"browser": "devkit browser",
"browser:install": "devkit browser install",
"auth": "devkit auth",
"secrets:run": "devkit secrets run",
"secrets:check": "devkit secrets check",
"ui:urls": "devkit urls"
```

And a `devkit.config.json` at the root:

```json
{
  "name": "shop",
  "app": { "url": "http://localhost:4287" },
  "auth": {
    "signInPath": "/login",
    "landingPath": "/home",
    "defaultUser": "staff",
    "users": {
      "staff": "staff+clerk_test@example.com",
      "org-admin": "org-admin+clerk_test@example.com"
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `name` | Short project name: the default browser session prefix and the host settings folder `~/.config/<name>/`. |
| `app.url` | Default app origin when `--url` and `APP_URL` aren't set. Only localhost and `*.ts.net` origins are accepted. |
| `auth.users` | Role name → Clerk test address. Every address must contain `+clerk_test`. |
| `auth.defaultUser` | Used when no user is given (default: the first). |
| `auth.signInPath` | A page that loads Clerk, usually the sign-in page (default `/`). |
| `auth.landingPath` | Opened after signing in (default `/`). |
| `auth.stateDir` | Where `--save` writes `<user>.json` (default `.agents/auth`, which must be git-ignored). |
| `auth.code` | The test code (default `424242`). |

To update every project, release a new tag here and bump the tag in each
project's `package.json`.

## Browser

```sh
pnpm browser:install            # once per machine; Linux: add --with-deps
pnpm browser --version
pnpm browser --help             # commands supported by the pinned version
pnpm browser doctor --offline --quick
```

The binary lives in `~/.cache/devkit/agent-browser/<version>/` (or under
`$XDG_CACHE_HOME`), shared by every project and worktree; Chrome lives in
agent-browser's own cache. Commands run with:

- `--config` set to this package's `agent-browser.json` (headless Chrome,
  visible scrollbars), unless the project commits its own `agent-browser.json`;
- `AGENT_BROWSER_SESSION` defaulting to `<name>-<checkout hash>`. Agents should
  always set their own unique session;
- screenshots defaulting to the project's ignored `output/agent-browser/`.

### Host settings

Normal macOS and Linux hosts need none. When a host does, put the variables in
`~/.config/<name>/agent-browser.env` (shared by every worktree) or a
checkout's ignored `.env.agent-browser`. Variables already in the environment
win, then the checkout file, then the host file. Never commit them.

- **`No usable sandbox`:** fix Chrome's sandbox through host administration if
  you can. On an isolated development server where you can't, set
  `AGENT_BROWSER_ARGS=--no-sandbox`.
- **Userspace Tailscale** that can't reach its own tailnet address: run the
  daemon with a loopback `--outbound-http-proxy-listen`, then set
  `AGENT_BROWSER_PROXY`, `http_proxy` and `https_proxy` to it, with
  `no_proxy=localhost,127.0.0.1`. Keep using the public HTTPS URL.

### Live dashboard

`pnpm browser dashboard start` serves agent-browser's dashboard at
`http://127.0.0.1:4848`, showing live sessions. To watch from another device,
`tailscale serve` it on an unused HTTPS port and start it with
`--allowed-origins "https://<host>.ts.net:<port>"` (or set
`AGENT_BROWSER_DASHBOARD_ALLOWED_ORIGINS` in the host settings). Keep it on the
tailnet; never Funnel it, and don't paste its access link into chat.

### Upgrading agent-browser

Change `version` and the four digests in `lib/browser.mjs` (from the release's
assets), run `devkit browser install` and a signed-in smoke check, then release
a new tag. Don't use agent-browser's own `upgrade` command; devkit refuses it.

## Signing in

Clerk development instances accept any address containing `+clerk_test` with
the code `424242`, and send no email. Each project lists one such user per role.
`devkit auth` opens the app in your browser session and signs in through the
page's own Clerk, so it works with any sign-in UI:

```sh
export AGENT_BROWSER_SESSION=shop-my-task
pnpm auth --url "$APP_URL"                 # the default user
pnpm auth org-admin --url "$APP_URL"       # switch user in the same session
pnpm auth --list                           # users and addresses
pnpm auth --all --save --url "$APP_URL"    # save every user for test suites
pnpm auth staff --temp --save --url "$APP_URL"  # save one, without touching your session
pnpm browser --state .agents/auth/org-admin.json open "$APP_URL"
```

It refuses non-development URLs, addresses without `+clerk_test`, and apps
using a Clerk production key. Saved state files are credentials: keep them in
an ignored folder and never print, commit or copy them.

To sign in by hand, type the address on the sign-in page and enter `424242`
when asked for a code.

### Setting up a project's test users

For each role, either create a Clerk user with a `+clerk_test` address in the
development instance, or add one to the existing development user so its ID,
roles and data stay the same:

```sh
curl -sS https://api.clerk.com/v1/email_addresses \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" -H "Content-Type: application/json" \
  -d '{"user_id":"user_…","email_address":"staff+clerk_test@example.com","verified":true,"primary":false}'
```

The instance needs **Email verification code** turned on as a sign-in
option (Clerk dashboard → User & authentication).

## Secrets

Development settings live in Infisical (the project's `.infisical.json`,
environment `dev`), one folder per service. List the folders in
`devkit.config.json`, each with the keys it must have:

```json
"secrets": {
  "folders": {
    "development": ["TYPESENSE_API_KEY"],
    "convex": ["CLERK_JWT_ISSUER_DOMAIN"],
    "qa": []
  },
  "startup": ["development", "convex"]
}
```

```sh
pnpm secrets:run convex,web -- pnpm dev      # devkit secrets run ...
pnpm secrets:check                            # every folder; --startup for the startup ones
```

`run` fetches each folder with `infisical export` (never `.env` files),
refuses a key that differs between folders, then starts the command with:

- inherited secret-looking variables (`*_SECRET`, `*_TOKEN`, `*_KEY`, …),
  `INFISICAL_*` and the Convex selection (`CONVEX_DEPLOYMENT`, `CONVEX_URL`, …)
  removed, so nothing leaks in from your shell or targets the wrong backend;
- the folders' values, plus `<PREFIX>_SECRETS_SCOPE`,
  `<PREFIX>_INJECTED_SECRET_NAMES` and `<PREFIX>_SECRETS_RUNNER_PID`.

Every folder is checked: key names must be `UPPER_SNAKE_CASE`, process-control
names (`PATH`, `NODE_OPTIONS`, `INFISICAL_*`, `<PREFIX>_*` …) are refused, and in
`dev` Clerk keys must be development keys (`pk_test_`, `sk_test_`).

| Field | Meaning |
| --- | --- |
| `folders` | Folder → required keys. Only these folders can be used. |
| `startup` | Folders `check --startup` covers (default: all). |
| `prefix` | Prefix for the variables above and for refused names (default: the project name, e.g. `MY_SHOP` for `my-shop`). |
| `allowReserved` | `<PREFIX>_…` or `CLOUDFLARE_…` names a folder may still set. |
| `expand` | Expand `${…}` references in values (default `true`). |
| `environments` | `INFISICAL_ENV` values allowed (default `["dev"]`). |
| `validator` | A project module exporting `validateScope(folder, values)` for extra checks. |
| `ciPassthrough` | In CI (`CI` set), run the command unchanged; workflows pass their own environment. |
| `worktree.scopes` | Generated per-worktree keys, e.g. `{"worktree-core": ["TYPESENSE_API_KEY"]}`, stored in Infisical `/worktrees/<id>`. |
| `worktree.legacyFiles` | Older worktree files to migrate those keys from, once. |

Project scripts use the same toolkit instead of their own Infisical wrapper:

```js
import { secretsFor } from "@devsports/devkit/secrets";
export const { fetchSecrets, childEnvironment, mergeMissingSecrets } = secretsFor();
```

## Tailscale URLs

Each project's `setup:tailscale` exposes its development services with
Tailscale Serve and writes their HTTPS URLs to a manifest (`.env.tailscale`, or
`.env.worktree` in a linked worktree). `devkit urls` prints them, `--check`
requests each one, `--json` prints a list, and `--all` adds optional services:

```json
"urls": {
  "services": [
    { "name": "client", "variable": "CLIENT_PUBLIC_URL" },
    { "name": "MCP", "variable": "MCP_PUBLIC_URL", "checkPath": "/health", "extra": true }
  ],
  "worktreeManifest": ".env.worktree",
  "worktreeServices": [{ "name": "client", "variable": "WORKTREE_PUBLIC_URL" }],
  "manifestEnv": "SHOP_TAILSCALE_ENV_FILE",
  "missingHint": "Run `pnpm dev up`."
}
```

The setup scripts themselves stay in each project, because which services to
expose differs, but they share `@devsports/devkit/tailscale`: finding the CLI
(`TAILSCALE_CLI`, PATH or the macOS app; `TAILSCALE_SOCKET` for a custom
daemon socket), reading the MagicDNS name and Serve status, choosing free HTTPS
ports, adding and removing only mappings that still point at this checkout,
a lock, and writing the manifest atomically with mode 600.

## Docker stack

Each project keeps its `compose.yaml` (every service needs a `mem_limit`) and
describes the rest in `devkit.config.json`:

```json
"stack": {
  "files": ["compose.yaml"],
  "secrets": { "folders": ["admin", "convex"] },
  "devHost": true,
  "tailscale": { "route": { "target": { "variable": "SHOP_PROXY_PORT", "default": 4288 },
                            "localPorts": [{ "variable": "SHOP_APP_PORT", "default": 4200 }] } },
  "print": ["App: http://localhost:${SHOP_APP_PORT:-4200}"]
}
```

```sh
pnpm start            # devkit stack up
pnpm docker logs -f   # devkit stack <any compose command>
pnpm docker down
```

`devkit stack up`:

1. Refuses `INFISICAL_ENV` other than `dev` and running as root; exports
   `<PREFIX>_UID` / `<PREFIX>_GID` for the image build.
2. Names the Compose project: the project name, or `<name>-<worktree id>` in a
   linked worktree when `worktreeProjects` is set.
3. Under a lock shared by every DevSports stack on this Docker daemon, checks
   the services' memory limits fit next to everything already running (with
   512 MiB headroom), then builds the `setup` service's image.
4. Exports secrets into `.env.compose/` (mode 700): the listed Infisical
   `folders` as `<folder>.json`, or the project's own `secrets.command`. Without
   a host Infisical login it does this inside the `auth` service instead
   (`pnpm docker login` logs that container in).
5. Runs `beforeUp`, then publishes the app with Tailscale Serve: either one
   HTTPS `route` to a proxy port (reusing its saved port, never replacing
   another route or a Funnel one), or the project's own `tailscale.command`.
   `devHost` exports `<PREFIX>_DEV_HOST`, the machine's MagicDNS name.
6. Runs `docker compose up` in the foreground, or for a linked worktree with
   `worktree.detach`, starts detached, runs `worktree.afterUp`, then follows
   `worktree.follow` logs.

`down` stops every profile and removes only this checkout's Tailscale route.

| Field | Meaning |
| --- | --- |
| `prefix` | Prefix for `_UID`, `_GID`, `_DEV_HOST` (default: the project name). |
| `files`, `worktreeFiles`, `profileFiles` | Compose files, extra ones in a linked worktree, and per active profile. |
| `worktreeProjects` | Give linked worktrees their own Compose project. |
| `envFile`, `profilesFile` | A generated `--env-file`, and a file holding the saved `COMPOSE_PROFILES`. |
| `setupService`, `authService`, `upArgs` | Defaults `setup`, `auth`, `[]` (e.g. `["--build"]`). |
| `secrets.folders` / `secrets.command` | What to export into `.env.compose/`. |
| `secrets.containerCommand` | The project's own way to run its export in the `auth` container (default: `secrets.command` with `/secrets`). |
| `beforeUp`, `worktree.afterUp` | Project commands, e.g. `["node", "scripts/compose/prepare.mjs"]`; `DEVKIT_STACK_ACTION` says whether it's `up` or `secrets`. |
| `tailscale.route` / `tailscale.command` | One Serve route to a proxy port, or the project's own setup (with `stopCommand`, optional `profile`, `worktreeManifest`). |
| `tailscale.beforeSecrets` | Set up Tailscale before exporting secrets, for exports that read its URLs. |
| `tailscale.manifestEnv` | Pass the Tailscale manifest's values to Compose, for compose files that read them. |
| `print` | Lines printed before start-up; `${VAR:-default}` is filled in from the environment, `envFile` and the Tailscale manifest, and a line with a missing `${VAR}` is skipped. |

## Convex cloud dev deployments

Each checkout (the primary one and every linked worktree) gets its own Convex
cloud **dev** deployment, which is what Convex recommends for worktrees. Running
Convex in the cloud saves each checkout the 2.5 GiB a local backend needs.
Add the project to `devkit.config.json`:

```json
"convex": { "team": "acme", "project": "shop", "region": "aws-eu-west-1" }
```

| Field | Meaning |
| --- | --- |
| `team`, `project` | Convex team and project slugs. |
| `region` | `aws-eu-west-1` (default), `aws-us-east-1`, `aws-ca-central-1` or `aws-ap-southeast-2`. |
| `worktreeDays` | Days a worktree deployment lives after its last `ensure` (1–14, default 14, the Professional plan's limit). |
| `token` | Where the team access token lives: `{ "folder": "convex", "key": "CONVEX_TEAM_TOKEN" }` by default. `CONVEX_TEAM_TOKEN` in the environment wins. |

```sh
devkit convex ensure --kind worktree --id 1a2b3c4d5e6f --key-file local-data/convex_deploy_key
devkit convex list                         # your devkit-managed deployments and expiry
devkit convex delete dev/<you>/worktree-1a2b3c4d5e6f
```

`ensure` creates `dev/<you>/<kind>-<id>`, or renews it if it exists:

- `primary` deployments never expire;
- `worktree` deployments expire `worktreeDays` after the last `ensure`, so a
  forgotten worktree's deployment deletes itself. Run `ensure` from the
  project's start-up command so active worktrees keep theirs.

`--key-file` keeps a deploy key scoped to that one deployment (mode 600). Put
it in `CONVEX_DEPLOY_KEY` for `convex dev`, `convex run` and the rest, or in the
Convex folder's `.env.local`, which is what Convex's own worktree recipe does.
`--json` prints the name, URLs (`url`, `siteUrl`), dashboard link, expiry and
whether it was just `created`, so the project knows to seed it.

Project scripts use the library directly:

```js
import { ensureDeployment, ensureDeployKeyFile, managementClient, resolveToken } from "@devsports/devkit/convex";
```

**The team token can manage every deployment in the team, production
included.** devkit only creates, renews or deletes non-default `dev`
deployments under `dev/<you>/`, and refuses anything else. Keep the token in
Infisical; never copy it into a deployment's environment variables (a script
that syncs a whole Infisical folder into Convex must skip it). One token works
for every project in the team. Create it in the Convex dashboard under Team
Settings → Access Tokens.

### Reaching local services from the cloud

A cloud deployment can't reach tailnet-only Serve URLs. Publish what its
functions call (search, a render worker) with **Tailscale Funnel**:

```js
import { addFunnelPath, findTailscaleCli, removeFunnelPath } from "@devsports/devkit/tailscale";
const url = addFunnelPath(findTailscaleCli(), { port: 8443, mount: "/shop-1a2b3c/search", target: "http://127.0.0.1:27861" });
```

Funnel only serves ports 443, 8443 and 10000, so checkouts share a port with
one path each; Tailscale strips the path before proxying, and unknown paths
return 404. Use `mount: "/"` when the caller needs a bare origin; that takes the
whole port for one checkout. `addFunnelPath` refuses a port used by tailnet-only
Serve and a path that points elsewhere; `removeFunnelPath` only removes a path
still pointing at your target. Funnel URLs are public: only publish services
that check a secret on every request. The tailnet policy must grant the node
the `funnel` attribute.

[Upgrading a project to cloud Convex](docs/upgrading-to-cloud-convex.md) walks
through the change ARC made.

## Watching files

```sh
devkit watch --path backend/packages/core/src --path backend/packages/core/package.json -- pnpm --filter core build
```

Runs the command, then again once files under the paths change and have
settled for one poll (`--interval`, default 1000 ms).

## Development

```sh
npm test
```
