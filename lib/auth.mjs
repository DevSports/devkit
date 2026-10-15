import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { capture } from "./browser.mjs";
import { developmentUrl } from "./config.mjs";

export const usage = `Usage: devkit auth [user] [--url <origin>] [--save | --state <file>]
       devkit auth --all --save [--url <origin>]
       devkit auth --list

Signs the agent-browser session (AGENT_BROWSER_SESSION) in as a Clerk test
user: the project's devkit.config.json maps each user to a +clerk_test
address, which signs in with a fixed code and no email or password. Only
localhost and Tailscale URLs, and only Clerk development keys, are accepted.

  user           One of the project's users (default: auth.defaultUser).
  --url          The app origin (default: $APP_URL, then app.url in the config).
  --save         Also save the session to <auth.stateDir>/<user>.json, for
                 test suites and \`pnpm browser --state\`.
  --state <file> Save it to this file instead.
  --all          Every user, each in its own temporary session (needs --save).
  --list         Print the users and their addresses.`;

export function parseAuthArgs(args, config) {
  if (!config.auth) throw new Error('This project has no "auth" section in devkit.config.json.');
  const { values, positionals } = parseArgs({
    args: args.filter((arg) => arg !== "--"),
    allowPositionals: true,
    options: {
      url: { type: "string" },
      save: { type: "boolean", default: false },
      state: { type: "string" },
      all: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (positionals.length > 1) throw new Error("Give at most one user.");
  const { users, defaultUser } = config.auth;
  if (values.all && positionals.length) throw new Error("Use either a user or --all.");
  if (values.all && !values.save) throw new Error("--all signs in throwaway sessions, so it needs --save.");
  if (values.all && values.state) throw new Error("--all saves each user to <auth.stateDir>/<user>.json; drop --state.");
  const selected = values.all ? Object.keys(users) : [positionals[0] ?? defaultUser];
  for (const user of selected) {
    if (!Object.hasOwn(users, user)) throw new Error(`Unknown user "${user}". Expected one of: ${Object.keys(users).join(", ")}.`);
  }
  const rawUrl = values.url ?? process.env.APP_URL ?? config.app.url;
  if (!values.help && !values.list && !rawUrl) {
    throw new Error("No app URL: pass --url, set APP_URL, or set app.url in devkit.config.json.");
  }
  return {
    help: values.help,
    list: values.list,
    all: values.all,
    url: rawUrl && developmentUrl(rawUrl),
    users: selected,
    statePath: (user) => {
      if (values.state) return path.resolve(values.state);
      if (values.save) return path.join(config.root, config.auth.stateDir, `${user}.json`);
      return undefined;
    },
  };
}

/** Runs in the page: signs in through the app's own Clerk with the test code. */
export function signInScript(email, code) {
  return `(async () => {
  const clerk = window.Clerk;
  if (!clerk?.loaded) return { error: "Clerk didn't load on this page." };
  const key = clerk.publishableKey ?? "";
  if (!key.startsWith("pk_test_")) return { error: "This app uses a Clerk production key. Test sign-in only works on development instances." };
  const email = ${JSON.stringify(email)};
  if (clerk.user) {
    if (clerk.user.emailAddresses.some((e) => e.emailAddress === email)) return { userId: clerk.user.id, already: true };
    await clerk.signOut();
  }
  const signIn = await clerk.client.signIn.create({ identifier: email });
  const factor = signIn.supportedFirstFactors?.find((f) => f.strategy === "email_code");
  if (!factor) {
    return { error: "Email code sign-in isn't enabled for this user. Turn on Email verification code in Clerk → User & authentication, and check the address exists." };
  }
  await signIn.prepareFirstFactor({ strategy: "email_code", emailAddressId: factor.emailAddressId });
  const result = await signIn.attemptFirstFactor({ strategy: "email_code", code: ${JSON.stringify(code)} });
  if (result.status !== "complete") return { error: "Clerk wants another step (" + result.status + "). Test users shouldn't need one." };
  await clerk.setActive({ session: result.createdSessionId });
  return { userId: clerk.user?.id };
})()`;
}

function check(result, what) {
  if (result.code !== 0) {
    throw new Error(`agent-browser ${what} failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
  }
  return result;
}

async function signInOne(config, options, user, session) {
  const email = config.auth.users[user];
  const run = (args, extra) => capture(config, args, { session, ...extra });
  check(await run(["open", options.url + config.auth.signInPath]), "open");
  check(await run(["wait", "--fn", "window.Clerk && window.Clerk.loaded"]), "waiting for Clerk");
  // Signing out (or the app reacting to a session) can navigate the page mid-script.
  // The script picks up where it left off, so run it again when that happens.
  let evaluated;
  for (let attempt = 1; ; attempt++) {
    evaluated = await run(["--json", "eval", "--stdin"], { input: signInScript(email, config.auth.code) });
    const navigated = /navigated or closed|context was destroyed/i.test(evaluated.stdout + evaluated.stderr);
    if (!navigated || attempt === 3) break;
    check(await run(["wait", "1500"]), "wait");
    check(await run(["wait", "--fn", "window.Clerk && window.Clerk.loaded"]), "waiting for Clerk");
  }
  check(evaluated, "sign-in");
  let outcome;
  try {
    outcome = JSON.parse(evaluated.stdout).data?.result;
  } catch {
    throw new Error("Couldn't read the sign-in result from agent-browser.");
  }
  if (!outcome || outcome.error) throw new Error(outcome?.error ?? "Sign-in returned nothing.");
  check(await run(["open", options.url + config.auth.landingPath]), "open");
  // Proves the session survives a page load, and leaves the app ready to use.
  const signedIn = `window.Clerk && window.Clerk.loaded && window.Clerk.user && window.Clerk.user.id === ${JSON.stringify(outcome.userId)}`;
  check(await run(["wait", "--fn", signedIn]), "checking the session after a reload");
  const statePath = options.statePath(user);
  if (statePath) {
    await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
    check(await run(["state", "save", statePath]), "state save");
    await chmod(statePath, 0o600);
  }
  return { userId: outcome.userId, statePath, session: evaluated.session };
}

export async function auth(config, args) {
  const options = parseAuthArgs(args, config);
  if (options.help) {
    console.log(usage);
    return 0;
  }
  if (options.list) {
    for (const [user, email] of Object.entries(config.auth.users)) {
      console.log(`${user}${user === config.auth.defaultUser ? " (default)" : ""}\t${email}`);
    }
    console.log(`Code: ${config.auth.code}`);
    return 0;
  }
  let failed = 0;
  for (const user of options.users) {
    // --all uses a throwaway session per user, so the caller's session is untouched.
    const session = options.all ? `${config.name}-auth-${user}-${process.pid}` : undefined;
    try {
      const { userId, statePath, session: used } = await signInOne(config, options, user, session);
      console.log(`Signed in as ${user} (${userId}) at ${options.url} in session ${used}.`);
      if (statePath) console.log(`Saved ${path.relative(process.cwd(), statePath) || statePath}. It's a credential: don't print, commit or copy it.`);
    } catch (error) {
      failed++;
      console.error(`Couldn't sign in as ${user}: ${error.message}`);
    } finally {
      if (session) await capture(config, ["close"], { session });
    }
  }
  return failed ? 1 : 0;
}
