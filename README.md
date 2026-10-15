# devkit

Shared development tooling for the DevSports projects (arc, dcbc, tsb,
blk-scl, mission-control), so a fix lands once instead of in every repo.

- **`devkit browser`**: [agent-browser](https://agent-browser.dev), pinned by
  version and SHA-256 digest, running headless Chrome. One copy per machine.
- **`devkit auth`**: signs a browser session in as a Clerk test user with the
  fixed test code. No passwords, secret keys or email.

This repository is public. Never commit secrets, hostnames or user data;
anything project-specific belongs in the project's `devkit.config.json`.

## Use it in a project

Add it to the workspace root, pinned to a release tag:

```sh
pnpm add -Dw github:DevSports/devkit#v0.1.0
```

Add the scripts the project's docs and agents use:

```json
"browser": "devkit browser",
"browser:install": "devkit browser install",
"auth": "devkit auth"
```

And a `devkit.config.json` at the root:

```json
{
  "name": "tsb",
  "app": { "url": "http://localhost:4287" },
  "auth": {
    "signInPath": "/login",
    "landingPath": "/home",
    "defaultUser": "staff",
    "users": {
      "staff": "priya.shah+clerk_test@example.com",
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
export AGENT_BROWSER_SESSION=tsb-my-task
pnpm auth --url "$APP_URL"                 # the default user
pnpm auth org-admin --url "$APP_URL"       # switch user in the same session
pnpm auth --list                           # users and addresses
pnpm auth --all --save --url "$APP_URL"    # save every user for test suites
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
  -d '{"user_id":"user_…","email_address":"coach+clerk_test@example.com","verified":true,"primary":false}'
```

The instance needs **Email verification code** turned on as a sign-in
option (Clerk dashboard → User & authentication).

## Development

```sh
npm test
```
