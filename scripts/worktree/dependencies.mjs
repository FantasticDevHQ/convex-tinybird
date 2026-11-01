import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const lockfiles = {
  bun: ["bun.lock", "bun.lockb"],
  pnpm: ["pnpm-lock.yaml"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
};

export function packageManager(root) {
  const manifestPath = path.join(root, "package.json");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : {};
  if (manifest.packageManager !== undefined) {
    const match = /^(bun|pnpm|npm)(?:@.+)?$/.exec(manifest.packageManager);
    if (!match)
      throw new Error(`Unsupported packageManager ${manifest.packageManager}; use bun, pnpm or npm.`);
    return match[1];
  }
  const detected = Object.keys(lockfiles).filter((manager) =>
    lockfiles[manager].some((file) => existsSync(path.join(root, file))),
  );
  if (detected.length > 1)
    throw new Error("Multiple package-manager lockfiles found; set packageManager in package.json.");
  return detected[0] || "npm";
}

export function installCommand(root) {
  const manager = packageManager(root);
  if (!lockfiles[manager].some((file) => existsSync(path.join(root, file))))
    throw new Error(`Commit a ${manager} lockfile before setup: ${lockfiles[manager].join(" or ")}.`);
  return manager === "npm"
    ? ["npm", "ci"]
    : [manager, "install", "--frozen-lockfile"];
}

export function installDependencies(root, { allowEmpty = false } = {}) {
  if (allowEmpty) {
    const file = path.join(root, "package.json");
    const manifest = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const hasDependencies = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
      .some((field) => Object.keys(manifest[field] || {}).length > 0);
    if (!hasDependencies && !manifest.workspaces && !existsSync(path.join(root, "pnpm-workspace.yaml"))) {
      console.log("No application dependencies; dependency installation skipped.");
      return;
    }
  }
  const [command, ...args] = installCommand(root);
  try {
    execFileSync(command, args, { cwd: root, stdio: "inherit" });
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(`Install ${command} and make it available on PATH before setup.`);
    throw error;
  }
}

export function packageBin(name, executable, directories) {
  const root = path.resolve(directories.at(-1));
  for (const directory of directories) {
    const lookup = createRequire(path.resolve(directory, "package.json"));
    const modules = lookup.resolve.paths(name)?.find((candidate) => {
      const relative = path.relative(root, candidate);
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        && existsSync(path.join(candidate, name, "package.json"));
    });
    if (!modules) continue;
    // Bound lexical lookup to this checkout, while allowing its explicit pnpm
    // dependency symlinks to point at an external store.
    const require = createRequire(path.join(path.dirname(modules), "package.json"));
    let manifestPath;
    try {
      manifestPath = require.resolve(`${name}/package.json`);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND" && error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
      // Some packages hide package.json through exports. Locate it from their
      // resolved entry point, which also follows pnpm workspace/store symlinks.
      let entry;
      try {
        entry = require.resolve(name);
      } catch (error) {
        if (error.code !== "MODULE_NOT_FOUND" && error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
        continue;
      }
      for (let parent = path.dirname(entry); ; parent = path.dirname(parent)) {
        const candidate = path.join(parent, "package.json");
        if (existsSync(candidate) && JSON.parse(readFileSync(candidate, "utf8")).name === name) {
          manifestPath = candidate;
          break;
        }
        if (path.dirname(parent) === parent) break;
      }
    }
    if (!manifestPath) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const relative = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[executable];
    if (relative) {
      const bin = path.resolve(path.dirname(manifestPath), relative);
      if (existsSync(bin)) return bin;
    }
    throw new Error(`Installed ${name} has no usable ${executable} CLI; reinstall dependencies.`);
  }
  throw new Error(`Install dependencies first: ${name} was not found in its workspace or repository root.`);
}
