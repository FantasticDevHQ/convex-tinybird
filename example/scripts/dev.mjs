/**
 * Start the demo: a local anonymous Convex backend first, Vite second.
 *
 * Order matters. `npx convex dev` provisions (or reuses) the local deployment, writes
 * VITE_CONVEX_URL into .env.local, pushes the functions and then keeps the backend running.
 * Vite reads .env.local at startup, so it must not start until that file exists and the
 * backend answers. No cloud account, no Tinybird credentials: without them the page shows the
 * Convex-side metrics and says delivery is inert.
 *
 * Usage: node scripts/dev.mjs            (both processes, until Ctrl-C)
 *        node scripts/dev.mjs --print-url (used by the Playwright config)
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const example = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(example, ".env.local");
const env = { ...process.env, CONVEX_AGENT_MODE: "anonymous" };

function convexUrl() {
  if (!existsSync(envFile)) return undefined;
  const line = readFileSync(envFile, "utf8")
    .split("\n")
    .find((l) => l.startsWith("VITE_CONVEX_URL="));
  return line?.slice("VITE_CONVEX_URL=".length).trim();
}

async function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = convexUrl();
    if (url) {
      try {
        const res = await fetch(`${url}/version`);
        if (res.ok) return url;
      } catch {
        // not up yet
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Convex backend did not come up within ${timeoutMs}ms (see ${envFile})`);
}

const children = [];
function run(command, args) {
  const child = spawn(command, args, { cwd: example, env, stdio: "inherit" });
  children.push(child);
  child.on("exit", (code) => {
    if (code !== null && code !== 0) {
      process.stderr.write(`${command} ${args.join(" ")} exited with ${code}\n`);
      shutdown(code);
    }
  });
  return child;
}
function shutdown(code = 0) {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("npx", ["--no-install", "convex", "dev"]);
const url = await waitForBackend(120_000);
process.stdout.write(`Convex backend ready at ${url}\n`);
run("npx", ["--no-install", "vite"]);
