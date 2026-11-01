// Optional real-backend isolation test for a consuming app with the example probe functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import net from "node:net";
import { existsSync } from "node:fs";
import { installDependencies } from "./dependencies.mjs";

const source = await realpath(process.cwd());
const layout = JSON.parse(await readFile(path.join(source, "scripts/worktree.config.json"), "utf8"));
const backendPath = layout.backend || ".";
const hasApp = existsSync(path.join(source, backendPath, "convex/convex.config.ts"));
function run(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/worktree/cli.mjs", ...args], {
      cwd,
      env: { ...process.env, CI: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}
async function ok(cwd, ...args) {
  const r = await run(cwd, args);
  assert.equal(r.code, 0, r.output.slice(-8000));
  return r;
}
async function rpc(s, kind, fn, args = {}) {
  const response = await fetch(
    `http://127.0.0.1:${s.ports.cloud}/api/${kind}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fn, args, format: "json" }),
      signal: AbortSignal.timeout(10000),
    },
  );
  const result = await response.json();
  assert.equal(result.status, "success", JSON.stringify(result));
  return result.value;
}

test(
  "two real worktrees: isolated databases, concurrent backends, stable restart, safe teardown and cleanup",
  { timeout: 600000, skip: hasApp ? false : "Run from a consuming Convex app with examples/probe.ts installed" },
  async (t) => {
    const base = await realpath(
      await mkdtemp(path.join(tmpdir(), "convex-worktree-e2e-")),
    );
    const roots = ["alpha", "beta"].map((name) => path.join(base, name));
    t.after(async () => {
      let safeToRemove = true;
      for (const root of roots) {
        if (!existsSync(root)) continue;
        const result = await run(root, ["teardown"]).catch((error) => ({
          code: 1,
          output: error.message,
        }));
        if (result.code) {
          safeToRemove = false;
          console.error("Cleanup limitation; temporary checkout preserved:", root, result.output);
        }
        else
          execFileSync("git", ["worktree", "remove", "--force", root], {
            cwd: source,
            stdio: "ignore",
          });
      }
      execFileSync("git", ["worktree", "prune"], { cwd: source });
      if (safeToRemove) await rm(base, { recursive: true, force: true });
    });
    for (const root of roots) {
      execFileSync("git", ["worktree", "add", "--detach", root, "HEAD"], {
        cwd: source,
        stdio: "ignore",
      });
      installDependencies(root);
    }
    const setups = await Promise.allSettled(
      roots.map((root) => ok(root, "setup")),
    );
    for (const result of setups)
      if (result.status === "rejected") throw result.reason;
    const states = await Promise.all(
      roots.map((root) =>
        readFile(path.join(root, ".worktree/local.json"), "utf8").then(
          JSON.parse,
        ),
      ),
    );
    assert.notEqual(states[0].id, states[1].id);
    const configs = await Promise.all(
      roots.map((root) =>
        readFile(
          path.join(root, path.join(backendPath, ".convex/local/default/config.json")),
          "utf8",
        ).then(JSON.parse),
      ),
    );
    assert.notEqual(configs[0].adminKey, configs[1].adminKey);
    assert.equal(
      new Set(states.flatMap((s) => Object.values(s.ports))).size,
      6,
    );
    console.log(
      "PASS: parallel setup, distinct deployment identities, six distinct reserved ports",
    );
    await Promise.all(roots.map((root) => ok(root, "start")));
    await rpc(
      states[0],
      "mutation",
      "orders:place",
      { sku: "alpha", quantity: 1 },
    );
    await rpc(
      states[1],
      "mutation",
      "orders:place",
      { sku: "beta", quantity: 1 },
    );
    const entries = await Promise.all(
      states.map((s) =>
        rpc(s, "query", "dashboard:recentOrders"),
      ),
    );
    assert.deepEqual(
      entries.map((rows) => rows.map((r) => r.sku)),
      [["alpha"], ["beta"]],
    );
    console.log(
      "PASS: two simultaneous backends return different isolated database rows",
    );
    for (const root of roots)
      assert.equal(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        "",
        "Development must leave tracked and untracked source files untouched",
      );
    const before = await readFile(
      path.join(roots[0], ".worktree/backend.env"),
      "utf8",
    );
    await ok(roots[0], "stop");
    await ok(roots[0], "setup");
    await ok(roots[0], "start");
    assert.equal(
      await readFile(path.join(roots[0], ".worktree/backend.env"), "utf8"),
      before,
    );
    assert.equal(
      (
        await rpc(states[0], "query", "dashboard:recentOrders")
      )[0].sku,
      "alpha",
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(roots[0], ".worktree/local.json"), "utf8"),
      ),
      states[0],
    );
    console.log(
      "PASS: repeated setup/restart preserves database, identity, ports and generated configuration",
    );
    await ok(roots[0], "teardown");
    assert.equal(
      (
        await rpc(states[1], "query", "dashboard:recentOrders")
      )[0].sku,
      "beta",
    );
    await ok(roots[0], "start");
    assert.equal(
      (
        await rpc(states[0], "query", "dashboard:recentOrders")
      )[0].sku,
      "alpha",
    );
    console.log(
      "PASS: teardown preserves data, leaves sibling backend running, restart reacquires ports",
    );
    await ok(roots[0], "stop");
    const blocker = net.createServer();
    await new Promise((resolve) =>
      blocker.listen(states[0].ports.cloud, "127.0.0.1", resolve),
    );
    try {
      const r = await run(roots[0], ["start"]);
      assert.notEqual(r.code, 0);
      assert.match(r.output, /busy/);
      assert.equal(blocker.listening, true);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
    console.log(
      "PASS: occupied port causes explicit failure without killing its owner",
    );
    await ok(roots[0], "cleanup", "--yes");
    await assert.rejects(
      readFile(
        path.join(
          roots[0],
          path.join(backendPath, ".convex/local/default/config.json"),
        ),
      ),
      { code: "ENOENT" },
    );
    await ok(roots[0], "cleanup", "--yes");
    assert.equal(
      (
        await rpc(states[1], "query", "dashboard:recentOrders")
      )[0].sku,
      "beta",
    );
    console.log(
      "PASS: explicit cleanup removes only the owned database and is repeatable",
    );
  },
);
