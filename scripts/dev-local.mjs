/**
 * Local development launcher.
 *
 * Diggo is two processes in development: `wrangler dev` serves the Worker (and therefore every
 * /api route) on :8787, and `vite` serves the React client on :5173 with /api, /media and
 * /webhooks proxied to :8787 (see vite.config.ts). This runs both in one terminal, prefixed and
 * shut down together, so `npm run dev:local` is the whole local setup.
 *
 * Dependency-free on purpose: a `concurrently`-style devDependency for this much child-process
 * plumbing would be the only reason to add one.
 *
 *   npm run dev:local             migrations, then Worker + client
 *   npm run dev:local -- --seed   the same, plus the local demo mines (scripts/dev-seed.sql)
 */
import { spawn } from "node:child_process";
import process from "node:process";

const wantsSeed = process.argv.slice(2).includes("--seed");
// The tools are launched as `node <entry point>` rather than through their bin shims or npm: on
// Windows a .cmd shim needs a shell, and going through npm would leave the real wrangler/vite
// process behind when this script exits.
const WRANGLER = "node_modules/wrangler/bin/wrangler.js";
const VITE = "node_modules/vite/bin/vite.js";
const children = [];
let shuttingDown = false;

/** Runs one tool to completion, forwarding its output, and resolves with the exit code. */
function once(label, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    pipe(child, label);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** Prefixes a child's output so two interleaved logs stay readable. */
function pipe(child, label) {
  for (const [stream, target] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    stream.setEncoding("utf8");
    let buffered = "";
    stream.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) target.write(`[${label}] ${line}\n`);
    });
  }
}

function launch(label, args) {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  pipe(child, label);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      process.stderr.write(`[${label}] exited with code ${code}\n`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    // The child is node itself, so a plain kill reaches the real process on every platform.
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 400);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (wantsSeed) {
  process.stdout.write("[setup] loading local demo mines (scripts/dev-seed.sql)\n");
  const code = await once("setup", [WRANGLER, "d1", "execute", "diggo-db", "--local", "--file=scripts/dev-seed.sql"]);
  if (code !== 0) {
    process.stderr.write("[setup] seeding failed; starting anyway\n");
  }
}

process.stdout.write(
  "[setup] Worker on http://localhost:8787, client on http://localhost:5173 (Ctrl-C stops both)\n",
);
launch("worker", [WRANGLER, "dev"]);
launch("client", [VITE]);
