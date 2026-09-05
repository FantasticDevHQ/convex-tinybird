/** Verify npm's actual pack list and the extracted artifact, without publishing. */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function filesBelow(root, directory) {
  const path = join(root, directory);
  if (!existsSync(path)) return [];
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(root.length + 1)
        .replaceAll("\\", "/"),
    );
}

/** Derive build counterparts from runtime source, never from possibly stale dist files. */
export function checkPackedFiles(root, packed) {
  root = resolve(root);
  const source = filesBelow(root, "src").filter(
    (path) =>
      /^src\/(?:client\/|browser\/|component\/|test\.ts$)/u.test(path) &&
      path.endsWith(".ts") &&
      !path.endsWith(".test.ts") &&
      !path
        .split("/")
        .some((part) => part.startsWith(".") || part === "tests" || part === "testing"),
  );
  const expected = new Set([
    "package.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    ...filesBelow(root, "docs").filter(
      (path) => path.endsWith(".md") && !path.split("/").some((part) => part.startsWith(".")),
    ),
    ...source,
    ...source.flatMap((path) => [
      path.replace(/^src\//u, "dist/").replace(/\.ts$/u, ".js"),
      path.replace(/^src\//u, "dist/").replace(/\.ts$/u, ".d.ts"),
    ]),
  ]);
  const failures = [];
  for (const path of expected)
    if (!packed.includes(path)) failures.push(`Missing packed file: ${path}`);
  const name = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
  for (const path of packed) {
    if (!expected.has(path)) {
      failures.push(`Unexpected packed file: ${path}`);
      continue;
    }
    const text = readFileSync(join(root, path), "utf8");
    // Allow this package's name and subpaths, but not another package sharing its prefix.
    const references = text.match(/@fantastic-dev\/[a-zA-Z0-9_.*-]+/gu) ?? [];
    if (references.some((reference) => reference !== name))
      failures.push(`Host reference in packed file: ${path}`);
  }
  return failures;
}

export async function checkPack(root) {
  root = resolve(root);
  const options = { cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 };
  // Build is a separate prerequisite. Avoid invoking prepack recursively here.
  const dry = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], options),
  )[0];
  const failures = checkPackedFiles(
    root,
    dry.files.map((file) => file.path),
  );
  if (failures.length) throw new Error(failures.join("\n"));
  const temp = mkdtempSync(join(tmpdir(), "tinybird-packed-"));
  try {
    const [tarball] = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", temp],
        options,
      ),
    );
    execFileSync("tar", ["-xzf", join(temp, tarball.filename), "-C", temp]);
    const unpacked = join(temp, "package");
    // Exercise artifact files. Dependencies come from the installed package; the full independent
    // consumer install and Convex execution are covered by the separate clean-consumer gate.
    symlinkSync(join(root, "node_modules"), join(unpacked, "node_modules"), "dir");
    const manifest = JSON.parse(readFileSync(join(unpacked, "package.json"), "utf8"));
    for (const key of [
      ".",
      "./browser",
      "./convex.config",
      "./convex.config.js",
      "./_generated/component.js",
      "./test",
    ]) {
      const targets =
        typeof manifest.exports[key] === "string"
          ? [manifest.exports[key]]
          : Object.values(manifest.exports[key] ?? {});
      if (
        !targets.length ||
        targets.some((target) => !target.startsWith("./") || !existsSync(join(unpacked, target)))
      )
        throw new Error(`Unresolved packed export: ${key}`);
    }
    const consumer = join(temp, "consumer");
    mkdirSync(join(consumer, "node_modules", dirname(manifest.name)), { recursive: true });
    symlinkSync(unpacked, join(consumer, "node_modules", manifest.name), "dir");
    const ts = await import("typescript");
    for (const suffix of [
      "",
      "/browser",
      "/convex.config",
      "/convex.config.js",
      "/_generated/component.js",
      "/test",
    ]) {
      const resolved = ts.resolveModuleName(
        manifest.name + suffix,
        join(consumer, "verify.mts"),
        {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
        },
        ts.sys,
      ).resolvedModule;
      if (
        !resolved ||
        !realpathSync(resolved.resolvedFileName).startsWith(realpathSync(unpacked) + "/")
      ) {
        throw new Error(`Types do not resolve from packed layout: ${suffix || "."}`);
      }
    }
    const script = `import { TinybirdDelivery } from ${JSON.stringify(manifest.name)};\nimport * as browser from ${JSON.stringify(manifest.name + "/browser")};\nif (typeof TinybirdDelivery !== 'function' || typeof browser.queryPipe !== 'function') throw new Error('Invalid runtime exports');\nconsole.log(import.meta.resolve(${JSON.stringify(manifest.name + "/test")}));`;
    writeFileSync(join(consumer, "verify.mjs"), script);
    execFileSync(process.execPath, [join(consumer, "verify.mjs")], options);
    // Convex configurations are bundled by Convex, not loaded natively by Node. Workpool's
    // nested component uses extensionless imports, which its bundler resolves legitimately.
    const { build } = await import("vite");
    await build({
      configFile: false,
      root: consumer,
      logLevel: "error",
      build: {
        write: false,
        minify: false,
        lib: { entry: join(unpacked, "dist/component/convex.config.js"), formats: ["es"] },
      },
    });
    return dry.files.length;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.stdout.write(
    `Pack verified: ${await checkPack(root)} files; ESM exports resolve from the extracted artifact.\n`,
  );
}
