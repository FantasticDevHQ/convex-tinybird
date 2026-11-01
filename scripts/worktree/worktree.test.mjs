import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./cli.mjs", import.meta.url));
async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "worktree-test-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = join(dir, "registry");
  async function run(root, ...args) {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: root,
        env: { ...process.env, WORKTREE_REGISTRY_DIR: registry },
      });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      child.on("exit", (code) => resolve({ code, output }));
    });
  }
  async function root(name) {
    const path = join(dir, name);
    await mkdir(path);
    await writeFile(join(path, "convex.json"), "{}");
    return path;
  }
  return { dir, registry, run, root };
}

test("parallel setups reserve different ports, including stopped worktrees", async (t) => {
  const f = await fixture(t),
    a = await f.root("a"),
    b = await f.root("b");
  const results = await Promise.all([
    f.run(a, "setup", "--prepare-only"),
    f.run(b, "setup", "--prepare-only"),
  ]);
  assert.deepEqual(
    results.map((r) => r.code),
    [0, 0],
    results.map((r) => r.output).join("\n"),
  );
  const states = await Promise.all(
    [a, b].map((p) =>
      readFile(join(p, ".worktree/local.json"), "utf8").then(JSON.parse),
    ),
  );
  assert.equal(new Set(states.flatMap((s) => Object.values(s.ports))).size, 6);
});

test("repeated setup preserves identity, ports, auth secret and unrelated env", async (t) => {
  const f = await fixture(t),
    a = await f.root("a");
  await writeFile(
    join(a, ".env.local"),
    "CUSTOM=value\nCONVEX_DEPLOYMENT=prod:never-use\nCONVEX_DEPLOY_KEY=never-use\n",
  );
  assert.equal((await f.run(a, "setup", "--prepare-only")).code, 0);
  const before = await readFile(join(a, ".worktree/local.json"), "utf8");
  const secrets = await readFile(join(a, ".worktree/backend.env"), "utf8");
  assert.equal((await f.run(a, "setup", "--prepare-only")).code, 0);
  assert.equal(await readFile(join(a, ".worktree/local.json"), "utf8"), before);
  assert.equal(
    await readFile(join(a, ".worktree/backend.env"), "utf8"),
    secrets,
  );
  const env = await readFile(join(a, ".env.local"), "utf8");
  assert.match(env, /CUSTOM=value/);
  assert.doesNotMatch(env, /never-use/);
});

test("a busy reserved port fails without reallocating or stopping its owner", async (t) => {
  const f = await fixture(t),
    a = await f.root("a");
  assert.equal((await f.run(a, "setup", "--prepare-only")).code, 0);
  const state = JSON.parse(
    await readFile(join(a, ".worktree/local.json"), "utf8"),
  );
  const server = net.createServer();
  await new Promise((resolve) =>
    server.listen(state.ports.cloud, "127.0.0.1", resolve),
  );
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await f.run(a, "setup", "--prepare-only");
  assert.notEqual(result.code, 0);
  assert.match(result.output, /port.*busy/i);
  assert.equal(server.listening, true);
});

test("teardown preserves database state and releases only its own reservations", async (t) => {
  const f = await fixture(t),
    a = await f.root("a"),
    b = await f.root("b");
  await f.run(a, "setup", "--prepare-only");
  await f.run(b, "setup", "--prepare-only");
  await mkdir(join(a, ".convex/local/default"), { recursive: true });
  await writeFile(join(a, ".convex/local/default/data"), "keep");
  assert.equal((await f.run(a, "teardown")).code, 0);
  assert.equal(
    await readFile(join(a, ".convex/local/default/data"), "utf8"),
    "keep",
  );
  const registry = JSON.parse(
    await readFile(join(f.registry, "leases.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(registry), [b]);
  assert.equal((await f.run(a, "teardown")).code, 0);
});

test("cleanup requires explicit confirmation and refuses foreign state", async (t) => {
  const f = await fixture(t),
    a = await f.root("a");
  await f.run(a, "setup", "--prepare-only");
  assert.notEqual((await f.run(a, "cleanup")).code, 0);
  await mkdir(join(a, ".convex/local/default"), { recursive: true });
  await writeFile(
    join(a, ".convex/local/default/config.json"),
    JSON.stringify({
      deploymentName: "anonymous-foreign",
      ports: { cloud: 1, site: 2 },
    }),
  );
  assert.notEqual((await f.run(a, "cleanup", "--yes")).code, 0);
  assert.match(
    await readFile(join(a, ".convex/local/default/config.json"), "utf8"),
    /anonymous-foreign/,
  );
});

test("setup refuses symlinked env files and unmanaged local backend state", async (t) => {
  const f = await fixture(t),
    a = await f.root("a");
  const outside = join(f.dir, "outside");
  await writeFile(outside, "CUSTOM=untouched\n");
  await symlink(outside, join(a, ".env.local"));
  assert.notEqual((await f.run(a, "setup", "--prepare-only")).code, 0);
  assert.equal(await readFile(outside, "utf8"), "CUSTOM=untouched\n");
  await rm(join(a, ".env.local"));
  await mkdir(join(a, ".convex/local/default"), { recursive: true });
  await writeFile(join(a, ".convex/local/default/config.json"), "{}");
  assert.notEqual((await f.run(a, "setup", "--prepare-only")).code, 0);
});

test("simultaneous setup in the same checkout preserves one identity", async (t) => {
  const f = await fixture(t),
    a = await f.root("a");
  const results = await Promise.all([
    f.run(a, "setup", "--prepare-only"),
    f.run(a, "setup", "--prepare-only"),
  ]);
  assert.deepEqual(
    results.map((r) => r.code),
    [0, 0],
    results.map((r) => r.output).join("\n"),
  );
  const state = JSON.parse(
    await readFile(join(a, ".worktree/local.json"), "utf8"),
  );
  const registry = JSON.parse(
    await readFile(join(f.registry, "leases.json"), "utf8"),
  );
  assert.equal(registry[a].id, state.id);
});

test("teardown refuses a reused PID and leaves the unrelated process alive", async (t) => {
  const f = await fixture(t),
    a = await f.root("a");
  await f.run(a, "setup", "--prepare-only");
  await writeFile(
    join(a, ".worktree/runtime.json"),
    JSON.stringify({ pid: process.pid }),
  );
  const result = await f.run(a, "teardown");
  assert.notEqual(result.code, 0);
  assert.match(result.output, /another process/);
  assert.equal(process.kill(process.pid, 0), true);
});

test("cleanup deletes owned state and preserves unrelated env and files", async (t) => {
  const f = await fixture(t),
    a = await f.root("a");
  await writeFile(join(a, ".env.local"), "CUSTOM=keep\n");
  await f.run(a, "setup", "--prepare-only");
  await writeFile(join(a, "product.txt"), "keep");
  assert.equal((await f.run(a, "cleanup", "--yes")).code, 0);
  assert.equal(await readFile(join(a, "product.txt"), "utf8"), "keep");
  assert.match(await readFile(join(a, ".env.local"), "utf8"), /CUSTOM=keep/);
  await assert.rejects(readFile(join(a, ".worktree/local.json")), {
    code: "ENOENT",
  });
  assert.equal((await f.run(a, "cleanup", "--yes")).code, 0);
});

test("prune releases removed checkouts while preserving existing worktree reservations", async (t) => {
  const f = await fixture(t),
    a = await f.root("a"),
    b = await f.root("b");
  await f.run(a, "setup", "--prepare-only");
  await f.run(b, "setup", "--prepare-only");
  await rm(a, { recursive: true, force: true });
  const result = await f.run(b, "prune");
  assert.equal(result.code, 0, result.output);
  const registry = JSON.parse(
    await readFile(join(f.registry, "leases.json"), "utf8"),
  );
  assert.deepEqual(Object.keys(registry), [b]);
});

test("bootstrap rejects matching legacy HOME state before starting Convex", async (t) => {
  const f = await fixture(t),
    a = await f.root("a");
  const legacy = join(
    f.dir,
    "home/.convex/anonymous-convex-backend-state/anonymous-a",
  );
  await mkdir(legacy, { recursive: true });
  const lifecycleApi = await import("./config.mjs");
  assert.equal(typeof lifecycleApi.assertBootstrapIsolation, "function");
  await assert.rejects(
    lifecycleApi.assertBootstrapIsolation(a, join(f.dir, "home")),
    /legacy.*different worktree directory/i,
  );
});

test("interrupted bootstrap can recover and cleanup exact owned config", async (t) => {
  const f = await fixture(t),
    a = await f.root("a");
  await f.run(a, "setup", "--prepare-only");
  const file = join(a, ".worktree/local.json");
  const s = JSON.parse(await readFile(file, "utf8"));
  await mkdir(join(a, ".convex/local/default"), { recursive: true });
  await writeFile(
    join(a, ".convex/local/default/config.json"),
    JSON.stringify({
      deploymentName: "anonymous-a",
      ports: { cloud: s.ports.cloud, site: s.ports.site },
    }),
  );
  const result = await f.run(a, "setup", "--prepare-only");
  assert.equal(result.code, 0, result.output);
  assert.equal(
    JSON.parse(await readFile(file, "utf8")).deployment,
    "anonymous-a",
  );
  assert.equal((await f.run(a, "cleanup", "--yes")).code, 0);
});

test("interrupted bootstrap refuses a different deployment even on its reserved ports", async (t) => {
  const f = await fixture(t),
    a = await f.root("a");
  await f.run(a, "setup", "--prepare-only");
  const s = JSON.parse(await readFile(join(a, ".worktree/local.json"), "utf8"));
  await mkdir(join(a, ".convex/local/default"), { recursive: true });
  await writeFile(
    join(a, ".convex/local/default/config.json"),
    JSON.stringify({
      deploymentName: "anonymous-foreign",
      ports: { cloud: s.ports.cloud, site: s.ports.site },
    }),
  );
  const result = await f.run(a, "setup", "--prepare-only");
  assert.notEqual(result.code, 0);
  assert.match(result.output, /foreign/);
});

async function managedBackend(f, root) {
  assert.equal((await f.run(root, "setup", "--prepare-only")).code, 0);
  const s = JSON.parse(await readFile(join(root, ".worktree/local.json"), "utf8"));
  await mkdir(join(root, ".convex/local/default"), { recursive: true });
  await writeFile(join(root, ".convex/local/default/config.json"), JSON.stringify({
    deploymentName: `anonymous-${root.split("/").at(-1)}`,
    ports: { cloud: s.ports.cloud, site: s.ports.site },
  }));
  return s;
}

test("a missing backend CLI cannot leave a recorded supervisor", async (t) => {
  const f = await fixture(t), root = await f.root("no-cli");
  const s = await managedBackend(f, root);
  const result = await f.run(root, "_serve", `--owner=${s.id}`);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /install.*dependenc/i);
  await assert.rejects(readFile(join(root, ".worktree/runtime.json")), { code: "ENOENT" });
});

test("a missing frontend CLI fails before starting the backend", async (t) => {
  const f = await fixture(t), root = await f.root("no-frontend");
  const s = await managedBackend(f, root);
  await mkdir(join(root, "node_modules/convex"), { recursive: true });
  await writeFile(join(root, "node_modules/convex/package.json"), JSON.stringify({
    name: "convex", bin: { convex: "cli.cjs" },
  }));
  await writeFile(join(root, "node_modules/convex/cli.cjs"), `
    require("node:fs").writeFileSync("backend-started", "unexpected");
    console.log("Convex functions ready");
    setTimeout(() => process.exit(0), 500);
  `);
  const result = await f.run(root, "_serve", `--owner=${s.id}`, "--frontend");
  assert.match(result.output, /install.*dependenc/i);
  await assert.rejects(readFile(join(root, "backend-started")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, ".worktree/runtime.json")), { code: "ENOENT" });
});
