/** Regenerate both APIs in an isolated anonymous deployment and compare every file. */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const generatedDirectories = ["src/component/_generated", "example/convex/_generated"];
const require = createRequire(import.meta.url);

/** Keep relative tsconfig paths intact, but never copy deployment state or credentials. */
export function copyForCodegen(root) {
  const directory = mkdtempSync(join(dirname(resolve(root)), ".tinybird-codegen-"));
  try {
    for (const entry of [
      "src",
      "package.json",
      "tsconfig.json",
      "example/convex",
      "example/package.json",
      "example/tsconfig.json",
    ]) {
      cpSync(join(root, entry), join(directory, entry), { recursive: true });
    }
    symlinkSync(resolve(root, "node_modules"), join(directory, "node_modules"), "dir");
    const name = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
    const self = join(directory, "example/node_modules", name);
    mkdirSync(dirname(self), { recursive: true });
    symlinkSync(directory, self, "dir");
    return directory;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function generatedFiles(root) {
  const files = new Map();
  for (const directory of generatedDirectories) {
    const absolute = join(root, directory);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      files.set(path.slice(root.length + 1), readFileSync(path, "utf8"));
    }
  }
  return files;
}

export function checkCodegenFresh(packageRoot) {
  const root = resolve(packageRoot);
  // Convex 1.44 can reuse legacy state even in agent mode. Fail closed instead of
  // modifying an existing developer deployment under this fixed legacy name.
  if (existsSync(join(homedir(), ".convex/anonymous-convex-backend-state/anonymous-agent"))) {
    throw new Error(
      "Codegen isolation requires no legacy anonymous-agent deployment. Migrate that deployment to project-local state before running this check.",
    );
  }
  const directory = copyForCodegen(root);
  try {
    for (const generated of generatedDirectories) {
      rmSync(join(directory, generated), { recursive: true, force: true });
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/CONVEX|TINYBIRD/u.test(key)),
    );
    env.CONVEX_AGENT_MODE = "anonymous";
    const cli = join(
      dirname(require.resolve("convex/package.json", { paths: [root] })),
      "bin/main.js",
    );
    const result = spawnSync(process.execPath, [cli, "dev", "--once", "--typecheck", "disable"], {
      cwd: join(directory, "example"),
      env,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `Anonymous Convex codegen failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
      );
    }
    const committed = generatedFiles(root);
    const regenerated = generatedFiles(directory);
    const paths = new Set([...committed.keys(), ...regenerated.keys()]);
    return [...paths]
      .sort()
      .filter((path) => committed.get(path) !== regenerated.get(path))
      .map(
        (path) =>
          `${path} is stale: regenerate through example/ with CONVEX_AGENT_MODE=anonymous convex dev --once`,
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const failures = checkCodegenFresh(
      process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."),
    );
    if (failures.length) throw new Error(failures.join("\n"));
    process.stdout.write("convex-tinybird codegen is fresh (isolated regeneration).\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
