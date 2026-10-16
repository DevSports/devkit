// `devkit watch`: reruns a command when watched files change, by polling
// sizes and modification times. Native watchers (fanotify, inotify) don't work
// on Docker Desktop's macOS file sharing, so stacks poll instead.
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

export const usage = `Usage: devkit watch --path <file-or-dir> [--path ...] [--interval <ms>] -- <command> [args...]

Runs the command once, then again whenever a watched file changes (after the
change has settled for one poll). A run that's still going finishes first.`;

/** Paths, sizes and modification times of every file under the paths, as one string. */
export function fingerprint(paths, ignore = new Set(["node_modules", ".git"])) {
  const entries = [];
  const visit = (file) => {
    let stats;
    try {
      stats = statSync(file);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      for (const name of readdirSync(file).sort()) if (!ignore.has(name)) visit(path.join(file, name));
    } else {
      entries.push(`${file}:${stats.size}:${stats.mtimeMs}`);
    }
  };
  for (const watched of paths) visit(watched);
  return entries.join("\n");
}

export function parseWatchArgs(args) {
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1) throw new Error(usage);
  const { values } = parseArgs({
    args: args.slice(0, separator),
    options: { path: { type: "string", multiple: true }, interval: { type: "string", default: "1000" } },
  });
  const interval = Number(values.interval);
  if (!values.path?.length || !Number.isInteger(interval) || interval < 100) throw new Error(usage);
  return { paths: values.path.map((p) => path.resolve(p)), interval, command: args.slice(separator + 1) };
}

export function watchCommand(args) {
  const { paths, interval, command } = parseWatchArgs(args);
  let previous = fingerprint(paths);
  let built;
  let child;
  let stopping = false;
  const start = () => {
    built = previous;
    child = spawn(command[0], command.slice(1), { stdio: "inherit" });
    child.on("error", (error) => console.error(error.message));
    child.on("close", (code) => {
      child = undefined;
      if (!stopping) console.log(code === 0 ? "Done; watching for changes." : `Exited with ${code}; watching for changes.`);
    });
  };
  start();
  const timer = setInterval(() => {
    const current = fingerprint(paths);
    const settled = current === previous;
    previous = current;
    if (!child && settled && current !== built) start();
  }, interval);
  return new Promise((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        stopping = true;
        clearInterval(timer);
        child?.kill(signal);
        resolve(0);
      });
    }
  });
}
