#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { root, script, read } from "./context.mjs";
import { refreshCheckout } from "./freshness.mjs";
import { main } from "./commands.mjs";
import { projectLock } from "./registry.mjs";
import { installDependencies } from "./dependencies.mjs";
try {
  const targetIndex = process.argv.indexOf("--path");
  if (process.argv[2] === "setup" && targetIndex >= 0) {
    await projectLock(async () => {
      const base = await refreshCheckout(root, { refreshCurrent: false });
      if (!base) throw new Error("Creating a new worktree requires a Git checkout.");
      const destination = process.argv[targetIndex + 1];
      const branchIndex = process.argv.indexOf("--branch");
      const branch = process.argv[branchIndex + 1];
      if (
        !destination ||
        destination.startsWith("-") ||
        branchIndex < 0 ||
        !branch ||
        branch.startsWith("-")
      )
        throw new Error(
          "New worktrees require --path <directory> --branch <name>.",
        );
      const target = path.resolve(root, destination);
      execFileSync(
        "git",
        ["-C", root, "worktree", "add", "-b", branch, target, base],
        { stdio: "inherit" },
      );
      const prepare = process.argv.includes("--prepare-only");
      if (!prepare) {
        const targetLayout = await read(path.join(target, "scripts/worktree.config.json"), {});
        installDependencies(target, { allowEmpty: targetLayout.convex === false });
      }
      execFileSync(
        process.execPath,
        [script, "setup", ...(prepare ? ["--prepare-only"] : [])],
        { cwd: target, stdio: "inherit" },
      );
    });
  } else if (
    ["setup", "start", "stop", "teardown", "cleanup"].includes(process.argv[2])
  )
    await projectLock(main);
  else await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
