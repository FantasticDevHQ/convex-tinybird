import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const api = await import("./dependencies.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});

async function fixture(t, manifest = {}, files = []) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "worktree-dependencies-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  for (const file of files) await writeFile(path.join(root, file), "fixture");
  return root;
}

for (const [manager, lock, command] of [
  ["bun", "bun.lock", ["bun", "install", "--frozen-lockfile"]],
  ["pnpm", "pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["npm", "package-lock.json", ["npm", "ci"]],
]) {
  test(`${manager}: metadata chooses the manager and a frozen install`, async (t) => {
    assert.equal(typeof api.installCommand, "function", "Package-manager support is missing");
    const root = await fixture(t, { packageManager: `${manager}@1.2.3` }, [lock]);
    assert.equal(api.packageManager(root), manager);
    assert.deepEqual(api.installCommand(root), command);
  });
  test(`${manager}: detects its lockfile without packageManager metadata`, async (t) => {
    assert.equal(typeof api.packageManager, "function", "Package-manager detection is missing");
    const root = await fixture(t, {}, [lock]);
    assert.equal(api.packageManager(root), manager);
  });
}

test("explicit metadata takes precedence over stale lockfiles", async (t) => {
  assert.equal(typeof api.packageManager, "function");
  const root = await fixture(t, { packageManager: "pnpm@10.0.0+sha512.abc" }, ["pnpm-lock.yaml", "package-lock.json"]);
  assert.equal(api.packageManager(root), "pnpm");
});

test("legacy Bun and npm shrinkwrap lockfiles are supported", async (t) => {
  assert.equal(typeof api.installCommand, "function");
  assert.deepEqual(api.installCommand(await fixture(t, {}, ["bun.lockb"])), ["bun", "install", "--frozen-lockfile"]);
  assert.deepEqual(api.installCommand(await fixture(t, {}, ["npm-shrinkwrap.json"])), ["npm", "ci"]);
});

test("conflicting managers require an explicit packageManager choice", async (t) => {
  assert.equal(typeof api.packageManager, "function");
  const root = await fixture(t, {}, ["bun.lock", "package-lock.json"]);
  assert.throws(() => api.packageManager(root), /multiple|ambiguous/i);
});

test("unsupported metadata is not silently replaced by another manager", async (t) => {
  assert.equal(typeof api.packageManager, "function");
  const root = await fixture(t, { packageManager: "yarn@4.0.0" }, ["package-lock.json"]);
  assert.throws(() => api.packageManager(root), /unsupported.*yarn/i);
});

test("installation requires the selected manager's committed lockfile", async (t) => {
  assert.equal(typeof api.installCommand, "function");
  const root = await fixture(t, { packageManager: "pnpm@10.0.0" }, ["package-lock.json"]);
  assert.throws(() => api.installCommand(root), /pnpm-lock.yaml/);
  const empty = await fixture(t);
  assert.throws(() => api.installCommand(empty), /lockfile/);
});

async function installedPackage(root, directory, name, options = {}) {
  const dir = path.join(root, directory);
  await mkdir(path.join(dir, "bin"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    name, main: "index.js", bin: { [name]: "bin/cli.js" }, ...options,
  }));
  await writeFile(path.join(dir, "index.js"), "module.exports = {};\n");
  await writeFile(path.join(dir, "bin/cli.js"), "console.log('installed fixture');\n");
  return path.join(dir, "bin/cli.js");
}

test("resolves a hoisted installed CLI without invoking a package downloader", async (t) => {
  assert.equal(typeof api.packageBin, "function");
  const root = await fixture(t);
  const bin = await installedPackage(root, "node_modules/convex", "convex");
  assert.equal(api.packageBin("convex", "convex", [path.join(root, "packages/backend"), root]), bin);
});

test("resolves a pnpm-style workspace dependency whose manifest export is blocked", async (t) => {
  assert.equal(typeof api.packageBin, "function");
  const root = await fixture(t);
  const backend = path.join(root, "packages/backend");
  await mkdir(path.join(backend, "node_modules"), { recursive: true });
  const bin = await installedPackage(root, "node_modules/.pnpm/convex@1.0.0/node_modules/convex", "convex", { exports: { ".": "./index.js" } });
  await symlink(path.dirname(path.dirname(bin)), path.join(backend, "node_modules/convex"), "dir");
  await installedPackage(root, "node_modules/convex", "convex");
  assert.equal(api.packageBin("convex", "convex", [backend, root]), bin);
});

test("resolves a frontend-local Next.js CLI", async (t) => {
  assert.equal(typeof api.packageBin, "function");
  const root = await fixture(t);
  const bin = await installedPackage(root, "apps/web/node_modules/next", "next");
  assert.equal(api.packageBin("next", "next", [path.join(root, "apps/web"), root]), bin);
});

test("missing dependencies fail with an installation hint", async (t) => {
  assert.equal(typeof api.packageBin, "function");
  const root = await fixture(t);
  assert.throws(() => api.packageBin("convex", "convex", [root]), /install.*dependenc/i);
});

test("a missing checkout dependency cannot resolve another checkout's ancestor install", async (t) => {
  const parent = await fixture(t);
  await installedPackage(parent, "node_modules/convex", "convex");
  const checkout = path.join(parent, "checkout");
  await mkdir(checkout);
  assert.throws(() => api.packageBin("convex", "convex", [checkout]), /install.*dependenc/i);
});

test("an explicit checkout dependency symlink may use an external pnpm store", async (t) => {
  const parent = await fixture(t);
  const bin = await installedPackage(parent, "external-store/convex", "convex", { exports: { ".": "./index.js" } });
  const checkout = path.join(parent, "checkout");
  await mkdir(path.join(checkout, "node_modules"), { recursive: true });
  await symlink(path.dirname(path.dirname(bin)), path.join(checkout, "node_modules/convex"), "dir");
  assert.equal(api.packageBin("convex", "convex", [checkout]), bin);
});

test("backend-free install skips only an explicitly allowed dependency-free project", async (t) => {
  const root = await fixture(t);
  assert.doesNotThrow(() => api.installDependencies(root, { allowEmpty: true }));
  assert.throws(() => api.installDependencies(root), /lockfile/);
});

test("backend-free install still requires a lockfile for dependencies and workspaces", async (t) => {
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const root = await fixture(t, { [field]: { dependency: "1.0.0" } });
    assert.throws(() => api.installDependencies(root, { allowEmpty: true }), /lockfile/);
  }
  const npmWorkspace = await fixture(t, { workspaces: ["packages/*"] });
  assert.throws(() => api.installDependencies(npmWorkspace, { allowEmpty: true }), /lockfile/);
  const pnpmWorkspace = await fixture(t, {}, ["pnpm-workspace.yaml"]);
  assert.throws(() => api.installDependencies(pnpmWorkspace, { allowEmpty: true }), /lockfile/);
});
