/**
 * Start the demo so that its metrics come from Tinybird, with nothing to configure by hand.
 *
 *   1. Provision the anonymous local Convex deployment (writes VITE_CONVEX_URL to .env.local).
 *   2. Resolve a Tinybird destination:
 *      - if the deployment already has PRODUCT_TINYBIRD_HOST pointing at a cloud workspace,
 *        leave it alone (deploy example/tinybird there yourself with `tb deploy`);
 *      - otherwise start Tinybird Local in Docker, deploy example/tinybird into it with `tb`,
 *        and put its host, append token, signing key and workspace id on BOTH mounts of the
 *        Convex deployment with `convex env set`.
 *   3. Start `convex dev` (pushes the functions with that environment and keeps the backend up).
 *   4. Start Vite.
 *
 * Prerequisites for the Local path: Docker running and the Tinybird CLI (`tb`) on PATH
 * (`pipx install tinybird` or `uv tool install tinybird`). Nothing else. Re-running is safe.
 *
 * Usage: node scripts/dev.mjs
 * Env:   DEMO_PORT (Vite port, default 5173), TINYBIRD_LOCAL_PORT (default 7181)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const example = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(example, ".env.local");
const env = { ...process.env, CONVEX_AGENT_MODE: "anonymous" };
const localPort = Number(process.env.TINYBIRD_LOCAL_PORT ?? 7181);
const localHost = `http://127.0.0.1:${localPort}`;
const container = "convex-tinybird-demo";

const log = (line) => process.stdout.write(`[demo] ${line}\n`);

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: example, env, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}
const convex = (args) => sh("npx", ["--no-install", "convex", ...args]);

async function ok(url, headers = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}
async function waitFor(what, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} did not become ready within ${timeoutMs / 1000}s`);
}

// ---------------------------------------------------------------- 1. Convex deployment

function convexUrl() {
  if (!existsSync(envFile)) return undefined;
  return readFileSync(envFile, "utf8")
    .split("\n")
    .find((l) => l.startsWith("VITE_CONVEX_URL="))
    ?.slice("VITE_CONVEX_URL=".length)
    .trim();
}

// A second `pnpm dev` (or the Playwright run next to a live demo) must not fight the first one
// for the local backend: `convex dev --once` refuses while a backend is running. Reuse it.
const existingBackend = convexUrl();
const backendAlreadyUp = Boolean(existingBackend && (await ok(`${existingBackend}/version`)));
if (backendAlreadyUp) {
  log(`reusing the Convex backend already running at ${existingBackend}`);
} else {
  log("provisioning the local Convex deployment");
  convex(["dev", "--once", "--typecheck", "disable"]);
}

function envGet(name) {
  const result = spawnSync("npx", ["--no-install", "convex", "env", "get", name], {
    cwd: example,
    env,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

// ---------------------------------------------------------------- 2. Tinybird destination

const currentHost = envGet("PRODUCT_TINYBIRD_HOST");
const isLoopback = (host) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(host);

if (currentHost && !isLoopback(currentHost)) {
  log(`deployment already points at ${currentHost}; leaving its Tinybird configuration alone`);
  log("(deploy example/tinybird there with `tb deploy` if you have not yet)");
} else {
  // Tinybird Local. Reuse a running instance on the port, else start our container.
  if (!(await ok(`${localHost}/tokens`))) {
    const docker = spawnSync("docker", ["info"], { encoding: "utf8" });
    if (docker.status !== 0)
      throw new Error(
        "Docker is not running, and Tinybird Local needs it. Start Docker Desktop (or set the " +
          "deployment's PRODUCT_TINYBIRD_* variables to a cloud workspace) and re-run.",
      );
    spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" });
    log(`starting Tinybird Local in Docker on :${localPort}`);
    sh("docker", [
      "run", "-d", "--name", container, "-p", `${localPort}:7181`, "tinybirdco/tinybird-local:latest",
    ]);
  } else {
    log(`Tinybird Local already answering on :${localPort}; reusing it`);
  }
  const tokens = await waitFor(
    "Tinybird Local",
    async () => (await ok(`${localHost}/tokens`))?.json(),
    180_000,
  );
  const token = tokens.workspace_admin_token;
  const auth = { Authorization: `Bearer ${token}` };
  const workspace = await waitFor(
    "Tinybird Local workspace API",
    async () => (await ok(`${localHost}/v1/workspace`, auth))?.json(),
    180_000,
  );
  // The JWT signing key is the workspace's ADMIN-scoped token; on Local that is the same token.
  const keys = await (await ok(`${localHost}/v0/tokens`, auth)).json();
  const signingKey = keys.tokens.find((k) => k.scopes.some((s) => s.type === "ADMIN"))?.token;
  if (!signingKey) throw new Error("Tinybird Local exposes no ADMIN-scoped token to sign with");

  if (spawnSync("tb", ["--version"], { encoding: "utf8" }).status !== 0)
    throw new Error("The Tinybird CLI `tb` is not on PATH. Install it: `pipx install tinybird`.");
  log("deploying example/tinybird (datasources + pipes) into Tinybird Local");
  sh("tb", ["--host", localHost, "--token", token, "deploy"], {
    cwd: join(example, "tinybird"),
    env: { ...env, TB_VERSION_WARNING: "0" },
  });

  log("seeding sample rows into Tinybird Local so the charts have a shape before the first click");
  sh(process.execPath, [join(example, "scripts/seed-tinybird.mjs"), localHost, token]);

  const wanted = { HOST: localHost, TOKEN: token, ADMIN_TOKEN: signingKey, WORKSPACE_ID: workspace.id };
  const changed = ["PRODUCT", "AUDIT"].some((mount) =>
    Object.entries(wanted).some(([key, value]) => envGet(`${mount}_TINYBIRD_${key}`) !== value),
  );
  if (changed) {
    log("putting the destination on both mounts of the Convex deployment (convex env set)");
    for (const mount of ["PRODUCT", "AUDIT"])
      for (const [key, value] of Object.entries(wanted)) convex(["env", "set", `${mount}_TINYBIRD_${key}`, value]);
    if (backendAlreadyUp)
      log("NOTE: the running `convex dev` keeps its old environment until it pushes again; restart it to pick these up");
  } else {
    log("deployment already carries this destination on both mounts");
  }
  log(`Tinybird Local ready: workspace ${workspace.name} (${workspace.id})`);
}

// ---------------------------------------------------------------- 3 + 4. backend, then Vite

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

if (!backendAlreadyUp) run("npx", ["--no-install", "convex", "dev"]);
const url = await waitFor(
  "Convex backend",
  async () => {
    const u = convexUrl();
    return u && (await ok(`${u}/version`)) ? u : null;
  },
  120_000,
);
log(`Convex backend ready at ${url}`);
// Anything enqueued while the mounts had no destination was stored but never scheduled.
const resumed = convex(["run", "dashboard:resumeDelivery", "{}"]);
log(`resumed delivery: ${resumed.trim()}`);
run("npx", ["--no-install", "vite"]);
