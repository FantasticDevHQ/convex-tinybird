import fs from "node:fs/promises";
import { openSync, closeSync } from "node:fs";

import path from "node:path";

import { spawn, execFileSync } from "node:child_process";

import {
  root,
  layout,
  backend,
  frontend,
  script,
  dir,
  sleep,
  read,
} from "./context.mjs";
import { safe, json } from "./files.mjs";
import { alive, locked, available } from "./registry.mjs";
import { state, checkConfig, childEnv, convexArgs } from "./config.mjs";
import { packageBin } from "./dependencies.mjs";

export async function run(
  args,
  s,
  { bootstrap = false, input, timeout = 180000 } = {},
) {
  let failure;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: backend,
        env: childEnv(s, bootstrap),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (d) => {
        output += d;
        process.stdout.write(d);
      });
      child.stderr.on("data", (d) => {
        output += d;
        process.stderr.write(d);
      });
      const timer = setTimeout(() => child.kill("SIGINT"), timeout);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          const error = new Error(
            `Convex command failed (${code ?? "timeout/signal"}).`,
          );
          error.output = output;
          reject(error);
        }
      });
    });
  } catch (error) {
    failure = error;
  }
  // A normal --once run flushes cleanup; skip-push does not reliably do so.
  let stopped = false;
  for (let n = 0; n < 200; n++) {
    if ((await available(s.ports.cloud)) && (await available(s.ports.site))) {
      stopped = true;
      break;
    }
    await sleep(100);
  }
  if (!stopped)
    throw new Error("Convex command exited but local ports did not close.");
  if (failure) {
    const config = await read(
      path.join(root, "scripts/worktree.config.json"),
      {},
    );
    const expected =
      bootstrap &&
      (config.bootstrapMissingEnv || []).some((key) =>
        failure.output?.includes(`${key} is not set`),
      );
    if (!expected) throw failure;
    console.log(
      "Fresh backend configured; setting declared local environment before retrying the schema push.",
    );
  }
}

export async function ownedRunning(s) {
  if (!s) return false;
  const runtime = await read(path.join(dir, "runtime.json"), null);
  if (!runtime || !alive(runtime.pid)) return false;
  const command = execFileSync(
    "ps",
    ["-p", String(runtime.pid), "-o", "command="],
    { encoding: "utf8" },
  );
  if (!command.includes(script) || !command.includes(`--owner=${s.id}`)) {
    throw new Error(
      "Recorded PID belongs to another process; refusing to signal it.",
    );
  }
  return runtime;
}

export async function reserve(s) {
  await locked(async (leases) => {
    for (const [p, v] of Object.entries(leases)) {
      if (
        p !== root &&
        Object.values(v.ports).some((port) =>
          Object.values(s.ports).includes(port),
        )
      )
        throw new Error(
          "Worktree ports have been reassigned; run setup after resolving reservations.",
        );
    }
    for (const port of [s.ports.cloud, s.ports.site])
      if (!(await available(port)))
        throw new Error(`Reserved port ${port} is busy.`);
    leases[root] = { id: s.id, ports: s.ports };
  });
}

export async function serve(s, withFrontend = false) {
  await checkConfig(s, true);
  const backendArgs = convexArgs(s);
  const frontendBin = withFrontend ? packageBin(layout.frontendFramework === "vite" ? "vite" : "next", layout.frontendFramework === "vite" ? "vite" : "next", [frontend, root]) : null;
  await json(path.join(dir, "runtime.json"), { pid: process.pid, id: s.id });
  const children = [];
  let stopping = false;
  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGINT");
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null
          ? null
          : new Promise((resolve) => child.once("exit", resolve)),
      ),
    );
    await fs.rm(path.join(dir, "runtime.json"), { force: true });
    process.exit(code);
  }
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  const backendChild = spawn(process.execPath, backendArgs, {
    cwd: backend,
    env: childEnv(s),
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(backendChild);
  backendChild.on("error", (error) => {
    console.error(error.message);
    void stop(1);
  });
  backendChild.on("exit", (code) => {
    if (!stopping) void stop(code ?? 1);
  });
  if (withFrontend) {
    const web = spawn(
      process.execPath,
      [
        frontendBin,
        ...(layout.frontendFramework === "vite" ? ["--host", "127.0.0.1", "--strictPort"] : ["dev"]),
        "--port",
        String(s.ports.web),
      ],
      { cwd: frontend, env: childEnv(s), stdio: "inherit" },
    );
    children.push(web);
    web.on("exit", (code) => {
      if (!stopping) void stop(code ?? 1);
    });
  }
}

export async function start(withFrontend = false) {
  const s = await state();
  if (await ownedRunning(s)) {
    console.log("Already running.");
    return;
  }
  await checkConfig(s, true);
  convexArgs(s);
  if (withFrontend) packageBin(layout.frontendFramework === "vite" ? "vite" : "next", layout.frontendFramework === "vite" ? "vite" : "next", [frontend, root]);
  await reserve(s);
  await safe(path.join(dir, "backend.log"));
  const log = openSync(path.join(dir, "backend.log"), "w", 0o600);
  const child = spawn(
    process.execPath,
    [script, "_serve", `--owner=${s.id}`, ...(withFrontend ? ["--frontend"] : [])],
    {
      cwd: root,
      env: process.env,
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  child.unref();
  for (let n = 0; n < 1200; n++) {
    if (!alive(child.pid))
      throw new Error("Backend exited; inspect .worktree/backend.log.");
    const output = await fs.readFile(path.join(dir, "backend.log"), "utf8");
    if (output.includes("Convex functions ready")) {
      console.log(
        `Backend ready at http://127.0.0.1:${s.ports.cloud}${withFrontend ? `; frontend http://localhost:${s.ports.web}` : ""}`,
      );
      return;
    }
    await sleep(100);
  }
  await stopOnly(s);
  throw new Error(
    "Backend readiness timed out; inspect .worktree/backend.log.",
  );
}

export async function stopOnly(s) {
  const runtime = await ownedRunning(s);
  if (!runtime) return;
  process.kill(runtime.pid, "SIGTERM");
  for (let n = 0; n < 200; n++) {
    if (!alive(runtime.pid)) {
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await available(s.ports.cloud)) && (await available(s.ports.site)))
          return;
        await sleep(100);
      }
      throw new Error("Backend process exited but its ports have not closed.");
    }
    await sleep(100);
  }
  throw new Error("Owned process did not stop; ports remain reserved.");
}
