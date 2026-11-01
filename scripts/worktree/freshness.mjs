import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { projectLock } from "./registry.mjs";
import { execFileSync } from "node:child_process";

function gitAt(root) {
  return (...args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Only fast-forward: user commits, edits and conflicts always remain intact.
export async function refreshCheckout(root, { refreshCurrent = true } = {}) {
  const git = gitAt(root);
  let common;
  try {
    common = git("rev-parse", "--git-common-dir");
  } catch {
    return; // Non-Git layout fixtures.
  }
  return projectLock(
    () => refreshUnlocked(root, refreshCurrent),
    `git:${path.resolve(root, common)}`,
  );
}

function selectedBranch(root, git) {
  const configPath = path.join(root, "scripts/worktree.config.json");
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  let branch = config.baseBranch;
  if (branch === undefined) {
    let advertised;
    try {
      advertised = git("ls-remote", "--symref", "origin", "HEAD");
    } catch {
      throw new Error("Could not discover/fetch origin's default branch. Check remote access or configure baseBranch.");
    }
    branch = advertised.match(/^ref: refs\/heads\/([^\r\n]+)\tHEAD$/m)?.[1];
    if (!branch)
      throw new Error("Origin did not advertise a default branch. Set baseBranch in scripts/worktree.config.json.");
  }
  if (typeof branch !== "string" || !branch || branch.startsWith("-") || branch === "HEAD")
    throw new Error("Invalid baseBranch; use a Git branch name such as develop.");
  try {
    git("check-ref-format", `refs/heads/${branch}`);
  } catch {
    throw new Error(`Invalid baseBranch: ${branch}`);
  }
  return branch;
}

function refreshUnlocked(root, refreshCurrent) {
  const git = gitAt(root);
  const branch = selectedBranch(root, git);
  const reference = `origin/${branch}`;
  const remoteRef = `refs/remotes/${reference}`;
  const localRef = `refs/heads/${branch}`;
  try {
    // Explicitly update this remote-tracking ref even in single-branch clones.
    // Local branches are updated separately, by safe fast-forward only.
    git("fetch", "origin", `+refs/heads/${branch}:${remoteRef}`);
  } catch {
    throw new Error(`Could not fetch ${reference}. Check remote access and rerun setup; no checkout changes were made.`);
  }
  if (git("status", "--porcelain"))
    throw new Error("Checkout has uncommitted/dirty files. Commit or move your changes before setup; no files were discarded.");
  const base = git("rev-parse", remoteRef);
  const ancestor = (a, b) => {
    try { git("merge-base", "--is-ancestor", a, b); return true; }
    catch { return false; }
  };
  if (refreshCurrent) {
    const head = git("rev-parse", "HEAD");
    if (head !== base && !ancestor(base, head)) {
      if (!ancestor(head, base))
        throw new Error(`Checkout diverged from ${reference}. Rebase or merge explicitly before setup; local commits were preserved.`);
      git("merge", "--ff-only", base);
    }
  }
  let local;
  try { local = git("rev-parse", "--verify", localRef); }
  catch { return base; }
  if (local === base) return base;
  if (!ancestor(local, base))
    throw new Error(`Local ${branch} has commits divergent from ${reference}. Resolve explicitly; the branch was preserved.`);
  const checked = git("worktree", "list", "--porcelain").split("\n\n")
    .find((block) => block.split("\n").includes(`branch ${localRef}`));
  if (checked) {
    const checkout = checked.split("\n")[0].slice("worktree ".length);
    const inBase = gitAt(checkout);
    if (inBase("status", "--porcelain"))
      throw new Error(`Local ${branch} checkout has dirty/uncommitted files. Preserve and resolve those changes there before setup.`);
    if (inBase("symbolic-ref", "HEAD") !== localRef)
      throw new Error("Base checkout changed branches during setup. Retry after other Git operations finish.");
    try { inBase("merge", "--ff-only", base); }
    catch {
      throw new Error("Could not safely fast-forward the base checkout. Resolve its state explicitly; no reset or stash was attempted.");
    }
  } else {
    git("update-ref", localRef, base, local);
  }
  return base;
}
