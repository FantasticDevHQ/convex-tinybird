/** Install the real artifact outside the workspace and exercise a different host app. */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/CONVEX|TINYBIRD/u.test(key)),
);
environment.CONVEX_AGENT_MODE = "anonymous";

function run(command, args, cwd, timeout = 180000) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} ${args[0]} failed: ${result.error?.message ?? [result.stderr, result.stdout].filter(Boolean).join("\n")}`,
    );
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}

function installedVersion(name) {
  return JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version;
}

if (existsSync(join(homedir(), ".convex/anonymous-convex-backend-state/anonymous-agent"))) {
  throw new Error(
    "Migrate the legacy anonymous-agent deployment to project-local state before running this isolated check.",
  );
}
const temp = mkdtempSync(join(tmpdir(), "tinybird-clean-consumer-"));
try {
  process.stdout.write(`Clean consumer: ${temp}\n`);
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", temp], root));
  const tarball = join(temp, packed[0].filename);
  const consumer = join(temp, "app");
  mkdirSync(consumer);
  const fixture = join(root, "scripts/clean-consumer");
  // Templates have no generated bindings in the repository. Materialize them only in the
  // independent app, where real codegen and tsc validate every import without aliases.
  for (const entry of readdirSync(fixture, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = join(entry.parentPath, entry.name);
    const destination = join(consumer, relative(fixture, source).replace(/\.template$/u, ""));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  const name = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
  const manifest = {
    name: "helpdesk-portability-check",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: { [name]: `file:${tarball}`, convex: installedVersion("convex") },
    devDependencies: Object.fromEntries(
      ["typescript", "vitest", "vite", "convex-test", "@types/node"].map((name) => [
        name,
        installedVersion(name),
      ]),
    ),
  };
  writeFileSync(join(consumer, "package.json"), JSON.stringify(manifest, null, 2));
  run("npm", ["install", "--no-audit", "--no-fund"], consumer, 300000);
  const installed = realpathSync(join(consumer, "node_modules", name));
  if (!installed.startsWith(realpathSync(consumer) + "/"))
    throw new Error("Component resolved outside the independent consumer");
  const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
  if (lock.packages[`node_modules/${name}`]?.link)
    throw new Error("Consumer used a workspace link instead of the tarball");
  process.stdout.write(
    "Installed tarball and Convex as the only direct runtime dependencies; no workspace links.\n",
  );

  // First initialize a disposable anonymous local backend, then explicitly exercise codegen.
  // The environment has no cloud deployment selector or Tinybird credential. No cloud push occurs.
  process.stdout.write(
    run("npx", ["--no-install", "convex", "dev", "--once", "--typecheck", "disable"], consumer),
  );
  process.stdout.write(run("npx", ["--no-install", "convex", "codegen"], consumer));
  process.stdout.write(run("npx", ["--no-install", "tsc", "--noEmit"], consumer));
  process.stdout.write(run("npx", ["--no-install", "vitest", "run"], consumer));
  process.stdout.write(
    "Clean consumer passed: anonymous codegen, typecheck, stubbed delivery and host tenancy.\n",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
