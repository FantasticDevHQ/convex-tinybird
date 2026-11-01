import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./cli.mjs", import.meta.url));
function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function fixture(t, manifest = { private: true }) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "backend-free-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const origin = path.join(base, "origin"), root = path.join(base, "checkout");
  await mkdir(path.join(origin, "scripts"), { recursive: true });
  git(origin, "init", "--initial-branch=develop");
  git(origin, "config", "user.name", "Worktree Test");
  git(origin, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(origin, "scripts/worktree.config.json"), JSON.stringify({ convex: false, frontend: false }));
  await writeFile(path.join(origin, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(origin, ".gitignore"), ".worktree/\n.convex/\n.env.local\n");
  git(origin, "add", "."); git(origin, "commit", "-m", "Dependency-free toolkit");
  git(base, "clone", origin, root);
  const run = (checkout, ...args) => spawnSync(process.execPath, [script, ...args], {
    cwd: checkout, encoding: "utf8", timeout: 10000,
    env: { ...process.env, WORKTREE_REGISTRY_DIR: path.join(base, "registry") },
  });
  const ok = (checkout, ...args) => {
    const result = run(checkout, ...args);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result;
  };
  return { base, origin, root, run, ok };
}

test("backend-free setup refreshes its base and preserves identity without fake services", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.origin, "fresh.txt"), "new base");
  git(f.origin, "add", "."); git(f.origin, "commit", "-m", "Advance develop");
  f.ok(f.root, "setup");
  assert.equal(git(f.root, "rev-parse", "HEAD"), git(f.origin, "rev-parse", "HEAD"));
  const file = path.join(f.root, ".worktree/local.json");
  const before = await readFile(file, "utf8"), s = JSON.parse(before);
  assert.equal(s.mode, "none");
  assert.equal(s.root, f.root);
  assert.ok(s.id);
  assert.equal(s.ports, undefined);
  assert.deepEqual(await readdir(path.join(f.root, ".worktree")), ["local.json"]);
  for (const command of ["setup", "start", "stop", "teardown", "start", "stop", "teardown"])
    f.ok(f.root, command);
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal(git(f.root, "status", "--porcelain"), "");
  await assert.rejects(readFile(path.join(f.base, "registry/leases.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(f.root, ".env.local")), { code: "ENOENT" });
});

test("backend-free new worktrees need no lockfile when there are no application dependencies", async (t) => {
  const f = await fixture(t), target = path.join(f.base, "new checkout");
  f.ok(f.root, "setup", "--path", target, "--branch", "feature/tooling");
  assert.equal(git(target, "rev-parse", "HEAD"), git(f.origin, "rev-parse", "HEAD"));
  assert.equal(JSON.parse(await readFile(path.join(target, ".worktree/local.json"), "utf8")).mode, "none");
  f.ok(target, "start"); f.ok(target, "stop"); f.ok(target, "cleanup", "--yes");
  assert.equal(git(target, "status", "--porcelain"), "");
  await assert.rejects(readFile(path.join(target, ".worktree/local.json")), { code: "ENOENT" });
});

test("backend-free mode does not skip a dependency install merely because its lockfile is absent", async (t) => {
  const f = await fixture(t, { dependencies: { "some-dependency": "1.0.0" } });
  const result = f.run(f.root, "setup", "--path", path.join(f.base, "needs-deps"), "--branch", "feature/deps");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lockfile/);
});

test("backend-free cleanup is explicit, sibling-safe and preserves unrelated state", async (t) => {
  const f = await fixture(t), sibling = path.join(f.base, "sibling");
  f.ok(f.root, "setup");
  f.ok(f.root, "setup", "--path", sibling, "--branch", "feature/sibling");
  const siblingBefore = await readFile(path.join(sibling, ".worktree/local.json"), "utf8");
  await writeFile(path.join(f.root, ".worktree/unrelated.txt"), "keep");
  await writeFile(path.join(f.root, ".worktree/runtime.json"), JSON.stringify({ pid: process.pid, id: "foreign" }));
  await mkdir(path.join(f.root, ".convex/local/default"), { recursive: true });
  await writeFile(path.join(f.root, ".convex/local/default/data"), "foreign data");
  await writeFile(path.join(f.root, ".env.local"), "CUSTOM=keep\n");
  assert.notEqual(f.run(f.root, "cleanup").status, 0);
  f.ok(f.root, "teardown"); f.ok(f.root, "cleanup", "--yes"); f.ok(f.root, "cleanup", "--yes");
  assert.equal(await readFile(path.join(f.root, ".worktree/unrelated.txt"), "utf8"), "keep");
  assert.equal(await readFile(path.join(f.root, ".convex/local/default/data"), "utf8"), "foreign data");
  assert.equal(await readFile(path.join(f.root, ".env.local"), "utf8"), "CUSTOM=keep\n");
  assert.equal(await readFile(path.join(sibling, ".worktree/local.json"), "utf8"), siblingBefore);
  assert.equal(process.kill(process.pid, 0), true);
  assert.ok(await readFile(path.join(f.root, ".worktree/runtime.json"), "utf8"));
  f.ok(sibling, "prune");
});

test("backend-free cleanup refuses foreign identities and symlinked managed state", async (t) => {
  const f = await fixture(t);
  f.ok(f.root, "setup");
  const file = path.join(f.root, ".worktree/local.json"), original = await readFile(file, "utf8");
  await writeFile(file, JSON.stringify({ ...JSON.parse(original), root: f.base }));
  assert.notEqual(f.run(f.root, "cleanup", "--yes").status, 0);
  assert.ok(await readFile(file, "utf8"));
  await rm(file);
  const outside = path.join(f.base, "outside.json");
  await writeFile(outside, original); await symlink(outside, file);
  assert.notEqual(f.run(f.root, "cleanup", "--yes").status, 0);
  assert.equal(await readFile(outside, "utf8"), original);
});

test("changing between managed backend and backend-free modes requires explicit cleanup", async (t) => {
  const f = await fixture(t);
  f.ok(f.root, "setup");
  const file = path.join(f.root, ".worktree/local.json"), s = JSON.parse(await readFile(file, "utf8"));
  delete s.mode; s.ports = { cloud: 12345, site: 12346, web: 12347 };
  await writeFile(file, JSON.stringify(s));
  const result = f.run(f.root, "start");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mode/i);
});
