#!/usr/bin/env node
import { auth } from "../lib/auth.mjs";
import { install, loadHostSettings, run, version } from "../lib/browser.mjs";
import { loadConfig } from "../lib/config.mjs";
import { secretsCommand } from "../lib/secrets.mjs";
import { stackCommand } from "../lib/stack.mjs";
import { urlsCommand } from "../lib/urls.mjs";
import { watchCommand } from "../lib/watch.mjs";

const usage = `devkit: shared development tooling for DevSports projects.

  devkit browser <agent-browser args>   Run the pinned agent-browser ${version}
  devkit browser install [--with-deps]  Install it (once per machine) and Chrome
  devkit auth [user] [--save]           Sign the browser session in as a Clerk test user
  devkit auth --help                    More on auth
  devkit secrets run <folders> -- <cmd> Run a command with Infisical development settings
  devkit secrets check [--startup]      Check every folder has its required settings
  devkit urls [--check] [--json] [--all] Print (and check) this checkout's Tailscale URLs
  devkit stack <up|down|logs|...>       Run this checkout's Docker Compose stack
  devkit watch --path <p> -- <cmd>      Rerun a command when files change (polling)

Settings come from devkit.config.json at the project root.`;

async function main([command, ...args]) {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(usage);
    return 0;
  }
  if (command === "browser" && args[0] === "install") return install(args.slice(1));
  if (command === "watch") return watchCommand(args);
  const config = loadConfig();
  // Browser host settings (proxies, sandbox flags) only apply to browser commands.
  if (command === "browser" || command === "auth") loadHostSettings(config);
  if (command === "browser") return run(config, args[0] === "--" ? args.slice(1) : args);
  if (command === "auth") return auth(config, args);
  if (command === "secrets") return secretsCommand(config, args);
  if (command === "urls") return urlsCommand(config, args);
  if (command === "stack") return stackCommand(config, args);
  console.error(`Unknown command: ${command}\n\n${usage}`);
  return 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
