import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("./cli.mjs", import.meta.url));
function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}
async function fixture(t, branch = "main") {
  const base = await mkdtemp(path.join(tmpdir(), "freshness-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const origin = path.join(base, "origin"),
    root = path.join(base, "checkout");
  await mkdir(origin);
  git(origin, "init", `--initial-branch=${branch}`);
  git(origin, "config", "user.email", "test@example.invalid");
  git(origin, "config", "user.name", "Test");
  await writeFile(path.join(origin, "convex.json"), "{}");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "initial");
  git(base, "clone", origin, root);
  return {
    base,
    origin,
    root,
    run: (...args) =>
      spawnSync(process.execPath, [script, "setup", ...args, "--prepare-only"], {
        cwd: root,
        env: {
          ...process.env,
          WORKTREE_REGISTRY_DIR: path.join(base, "registry"),
        },
        encoding: "utf8",
      }),
  };
}
test("setup refuses dirty tracked files without discarding changes", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "convex.json"), "changed");
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dirty|uncommitted/i);
  assert.equal(git(f.root, "diff", "--numstat").length > 0, true);
});

for (const branch of ["master", "masters", "develop", "release/base"]) {
  test(`setup discovers and refreshes the remote default ${branch}`, async (t) => {
    const f = await fixture(t, branch);
    await writeFile(path.join(f.origin, "fresh.txt"), "new base commit");
    git(f.origin, "add", ".");
    git(f.origin, "commit", "-m", "Advance base");
    const r = f.run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(f.root, "rev-parse", "HEAD"), git(f.origin, "rev-parse", "HEAD"));
    assert.equal(git(f.root, "rev-parse", `refs/heads/${branch}`), git(f.origin, "rev-parse", "HEAD"));
  });
}

test("setup discovers the live remote default instead of using stale origin/HEAD", async (t) => {
  const f = await fixture(t);
  git(f.origin, "switch", "-c", "develop");
  await writeFile(path.join(f.origin, "develop.txt"), "new default");
  git(f.origin, "add", ".");
  git(f.origin, "commit", "-m", "New default branch");
  assert.equal(git(f.root, "symbolic-ref", "refs/remotes/origin/HEAD"), "refs/remotes/origin/main");
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(f.root, "rev-parse", "HEAD"), git(f.origin, "rev-parse", "HEAD"));
});

test("configured develop creates a fresh worktree without advancing the caller's main", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.origin, "scripts"));
  await writeFile(path.join(f.origin, "scripts/worktree.config.json"), JSON.stringify({ baseBranch: "develop", backend: ".", frontend: "." }));
  git(f.origin, "add", ".");
  git(f.origin, "commit", "-m", "Configure development base");
  git(f.root, "pull", "--ff-only");
  const original = git(f.root, "rev-parse", "HEAD");
  git(f.origin, "switch", "-c", "develop");
  await writeFile(path.join(f.origin, "develop.txt"), "development only");
  git(f.origin, "add", ".");
  git(f.origin, "commit", "-m", "Advance development");
  const expected = git(f.origin, "rev-parse", "HEAD");
  git(f.origin, "switch", "main");
  git(f.root, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  const target = path.join(f.base, "configured-worktree");
  const r = f.run("--path", target, "--branch", "feature/from-develop");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(target, "rev-parse", "HEAD"), expected);
  assert.equal(git(f.root, "rev-parse", "HEAD"), original);
  assert.equal(git(f.root, "branch", "--show-current"), "main");
});

test("missing remote default requires an explicit base instead of assuming main", async (t) => {
  const f = await fixture(t);
  git(f.origin, "symbolic-ref", "HEAD", "refs/heads/missing");
  const original = git(f.root, "rev-parse", "HEAD");
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /default branch|baseBranch/i);
  assert.equal(git(f.root, "rev-parse", "HEAD"), original);
});

test("invalid configured base is rejected before fetching or modifying a checkout", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "scripts"));
  await writeFile(path.join(f.root, "scripts/worktree.config.json"), JSON.stringify({ baseBranch: "--upload-pack=unexpected" }));
  git(f.root, "config", "user.email", "test@example.invalid");
  git(f.root, "config", "user.name", "Test");
  git(f.root, "add", ".");
  git(f.root, "commit", "-m", "Invalid base fixture");
  const original = git(f.root, "rev-parse", "HEAD");
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid.*baseBranch/i);
  assert.equal(git(f.root, "rev-parse", "HEAD"), original);
});

test("a tag matching the remote shorthand cannot shadow new-worktree creation", async (t) => {
  const f = await fixture(t, "develop");
  git(f.root, "tag", "origin/develop");
  const target = path.join(f.base, "unambiguous-worktree");
  const r = f.run("--path", target, "--branch", "feature/from-base");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(target, "rev-parse", "HEAD"), git(f.origin, "rev-parse", "HEAD"));
});

test("a tag matching the local base cannot prevent its sibling checkout fast-forward", async (t) => {
  const f = await fixture(t, "develop");
  git(f.root, "tag", "develop");
  const sibling = path.join(f.base, "sibling");
  git(f.root, "worktree", "add", "--detach", sibling, "HEAD");
  await writeFile(path.join(f.origin, "fresh.txt"), "fresh");
  git(f.origin, "add", ".");
  git(f.origin, "commit", "-m", "Advance base");
  const r = spawnSync(process.execPath, [script, "setup", "--prepare-only"], {
    cwd: sibling,
    env: { ...process.env, WORKTREE_REGISTRY_DIR: path.join(f.base, "registry") },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(f.root, "rev-parse", "HEAD"), git(f.origin, "rev-parse", "HEAD"));
});
test("setup fetches and fast-forwards stale checkout and local main", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.origin, "new.txt"), "fresh");
  git(f.origin, "add", ".");
  git(f.origin, "commit", "-m", "fresh");
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    git(f.root, "rev-parse", "HEAD"),
    git(f.origin, "rev-parse", "HEAD"),
  );
});
test("setup fails clearly when fetch fails", async (t) => {
  const f = await fixture(t);
  git(f.root, "remote", "set-url", "origin", path.join(f.base, "missing"));
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /fetch/i);
});
test("setup preserves topic commits already based on fetched main", async (t) => {
  const f = await fixture(t);
  git(f.root, "switch", "-c", "topic");
  git(f.root, "config", "user.email", "test@example.invalid");
  git(f.root, "config", "user.name", "Test");
  await writeFile(path.join(f.root, "topic.txt"), "keep");
  git(f.root, "add", ".");
  git(f.root, "commit", "-m", "topic");
  const head = git(f.root, "rev-parse", "HEAD");
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(f.root, "rev-parse", "HEAD"), head);
});
test("setup refuses diverged topic commits without changing HEAD", async (t) => {
  const f = await fixture(t);
  git(f.root, "switch", "-c", "topic");
  git(f.root, "config", "user.email", "test@example.invalid");
  git(f.root, "config", "user.name", "Test");
  await writeFile(path.join(f.root, "topic.txt"), "keep");
  git(f.root, "add", ".");
  git(f.root, "commit", "-m", "topic");
  const head = git(f.root, "rev-parse", "HEAD");
  await writeFile(path.join(f.origin, "upstream.txt"), "fresh");
  git(f.origin, "add", ".");
  git(f.origin, "commit", "-m", "upstream");
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /diverged/i);
  assert.equal(git(f.root, "rev-parse", "HEAD"), head);
});
test("setup can create a new worktree from freshly fetched origin/main", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.origin, "new.txt"), "fresh");
  git(f.origin, "add", ".");
  git(f.origin, "commit", "-m", "fresh");
  const target = path.join(f.base, "new-checkout");
  const r = spawnSync(
    process.execPath,
    [
      script,
      "setup",
      "--path",
      target,
      "--branch",
      "new-topic",
      "--prepare-only",
    ],
    {
      cwd: f.root,
      env: {
        ...process.env,
        WORKTREE_REGISTRY_DIR: path.join(f.base, "registry"),
      },
      encoding: "utf8",
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    git(target, "rev-parse", "HEAD"),
    git(f.origin, "rev-parse", "HEAD"),
  );
});

test("setup fast-forwards clean main checked out in a sibling", async (t) => {
  const f = await fixture(t);
  const sibling = path.join(f.base, "sibling");
  git(f.root, "worktree", "add", "--detach", sibling, "HEAD");
  await writeFile(path.join(f.origin, "fresh.txt"), "fresh");
  git(f.origin, "add", ".");
  git(f.origin, "commit", "-m", "fresh");
  const r = spawnSync(process.execPath, [script, "setup", "--prepare-only"], {
    cwd: sibling,
    env: {
      ...process.env,
      WORKTREE_REGISTRY_DIR: path.join(f.base, "registry"),
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    git(f.root, "rev-parse", "HEAD"),
    git(f.origin, "rev-parse", "HEAD"),
  );
  assert.equal(
    git(sibling, "rev-parse", "HEAD"),
    git(f.origin, "rev-parse", "HEAD"),
  );
});

test("setup preserves dirty files in a stale sibling main checkout", async (t) => {
  const f = await fixture(t),
    sibling = path.join(f.base, "sibling");
  git(f.root, "worktree", "add", "--detach", sibling, "HEAD");
  await writeFile(path.join(f.origin, "fresh.txt"), "fresh");
  git(f.origin, "add", ".");
  git(f.origin, "commit", "-m", "fresh");
  await writeFile(path.join(f.root, "convex.json"), "keep edits");
  const main = git(f.root, "rev-parse", "HEAD");
  const r = spawnSync(process.execPath, [script, "setup", "--prepare-only"], {
    cwd: sibling,
    env: {
      ...process.env,
      WORKTREE_REGISTRY_DIR: path.join(f.base, "registry"),
    },
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dirty|uncommitted/);
  assert.equal(git(f.root, "rev-parse", "HEAD"), main);
  assert.match(git(f.root, "diff"), /keep edits/);
});
