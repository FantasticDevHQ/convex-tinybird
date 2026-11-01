import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const api = await import("./installer.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
const hash = (data) => createHash("sha256").update(data).digest("hex");

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "worktree-install-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, "kit"), target = path.join(base, "app");
  await mkdir(path.join(source, "scripts/worktree"), { recursive: true });
  await mkdir(target);
  const manifest = { files: {
    "entry.mjs": { path: "scripts/worktree/entry.mjs", sha256: hash("entry") },
    "config.json": { path: "scripts/worktree.config.json", sha256: hash("config") },
  } };
  await writeFile(path.join(source, "scripts/worktree/entry.mjs"), "entry");
  await writeFile(path.join(source, "scripts/worktree.config.json"), "config");
  const save = () => writeFile(path.join(source, "manifest.json"), JSON.stringify(manifest));
  await save();
  return { source, target, base, manifest, save };
}

test("Node installer restores verified files into an existing app without altering its files", async (t) => {
  assert.equal(typeof api.installToolkit, "function", "Node installer is missing");
  const f = await fixture(t);
  await writeFile(path.join(f.target, "package.json"), "keep");
  assert.equal(api.installToolkit(f.source, f.target), 2);
  assert.equal(await readFile(path.join(f.target, "scripts/worktree/entry.mjs"), "utf8"), "entry");
  assert.equal(await readFile(path.join(f.target, "package.json"), "utf8"), "keep");
});

test("installer preflights every destination before writing anything", async (t) => {
  assert.equal(typeof api.installToolkit, "function");
  const f = await fixture(t);
  await mkdir(path.join(f.target, "scripts"));
  await writeFile(path.join(f.target, "scripts/worktree.config.json"), "keep");
  assert.throws(() => api.installToolkit(f.source, f.target), /overwrite/i);
  assert.equal(await readFile(path.join(f.target, "scripts/worktree.config.json"), "utf8"), "keep");
  await assert.rejects(readFile(path.join(f.target, "scripts/worktree/entry.mjs")), { code: "ENOENT" });
});

test("tampered source hashes stop installation before any files are copied", async (t) => {
  assert.equal(typeof api.installToolkit, "function");
  const f = await fixture(t);
  await writeFile(path.join(f.source, "scripts/worktree.config.json"), "changed");
  assert.throws(() => api.installToolkit(f.source, f.target), /checksum/i);
  assert.deepEqual(await readdir(f.target), []);
});

test("manifest paths cannot escape the destination", async (t) => {
  assert.equal(typeof api.installToolkit, "function");
  const f = await fixture(t);
  for (const invalid of ["../escape", "/tmp/escape", "scripts/../escape", "scripts\\..\\escape"]) {
    f.manifest.files["entry.mjs"].path = invalid;
    await f.save();
    assert.throws(() => api.installToolkit(f.source, f.target), /invalid.*path|invalid.*destination/i);
    assert.deepEqual(await readdir(f.target), []);
  }
});

test("symlinked destination directories are refused", async (t) => {
  assert.equal(typeof api.installToolkit, "function");
  const f = await fixture(t), outside = path.join(f.base, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(f.target, "scripts"), "dir");
  assert.throws(() => api.installToolkit(f.source, f.target), /symlink/i);
  assert.deepEqual(await readdir(outside), []);
});

test("dangling destination symlinks are refused", async (t) => {
  assert.equal(typeof api.installToolkit, "function");
  const f = await fixture(t);
  await mkdir(path.join(f.target, "scripts/worktree"), { recursive: true });
  await symlink(path.join(f.base, "missing"), path.join(f.target, "scripts/worktree/entry.mjs"));
  assert.throws(() => api.installToolkit(f.source, f.target), /symlink|overwrite/i);
});

test("a mapped source installs app defaults instead of the toolkit's self configuration", async (t) => {
  const f = await fixture(t);
  const entry = f.manifest.files["config.json"];
  entry.source = "scripts/worktree.config.example.json";
  entry.sha256 = hash("app defaults");
  await writeFile(path.join(f.source, "scripts/worktree.config.json"), "self mode");
  await writeFile(path.join(f.source, entry.source), "app defaults");
  await f.save();
  assert.equal(api.installToolkit(f.source, f.target), 2);
  assert.equal(await readFile(path.join(f.target, entry.path), "utf8"), "app defaults");
});

test("mapped source paths cannot escape the toolkit", async (t) => {
  const f = await fixture(t);
  f.manifest.files["config.json"].source = "../private-file";
  await f.save();
  assert.throws(() => api.installToolkit(f.source, f.target), /invalid.*source|invalid.*path/i);
  assert.deepEqual(await readdir(f.target), []);
});
