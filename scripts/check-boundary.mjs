#!/usr/bin/env node
/**
 * check-boundary.mjs — keep the Tinybird component project-agnostic.
 *
 *   node packages/convex-tinybird/scripts/check-boundary.mjs [packageRoot]
 *
 * The component must be reusable in any Convex app, so nothing under `src/` may reach into the
 * Fantastic.dev monorepo (workspace packages, the backend, its generated types, Better Auth) or
 * escape the package through a relative path, and its runtime dependencies are an explicit
 * allowlist. This is a source-level check with Node built-ins only, so it runs anywhere
 * `check:scripts` runs — including CI with no install step for this package.
 *
 * Deliberately NOT covered: `devDependencies` (test tooling may be anything) and files under
 * `_generated` (machine-written; the generator decides their imports).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Runtime dependencies the component may declare, in `dependencies` or `peerDependencies`. */
export const ALLOWED_RUNTIME_DEPENDENCIES = new Set(["convex", "@convex-dev/workpool"]);

/** Import specifiers that mean the component reached into the host or the monorepo. */
export const FORBIDDEN_SPECIFIER_PATTERNS = [
  /^@fantastic-dev\//,
  /(^|\/)packages\/backend(\/|$)/,
  /^better-auth(\/|$)/,
  /^@convex-dev\/better-auth(\/|$)/,
  /^@better-auth\//,
];

const IMPORT_PATTERN =
  /(?:^|\n)\s*(?:import|export)\s[^'";]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map((name) => String(name).split(sep).join("/"))
    .filter((name) => /\.(ts|tsx|mts|js|mjs)$/.test(name))
    .filter((name) => !name.split("/").includes("_generated"))
    .filter((name) => !name.split("/").includes("node_modules"));
}

function specifiersIn(text) {
  const found = [];
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) found.push(specifier);
  }
  return found;
}

function escapesPackage(specifier, fileDir, packageRoot) {
  if (!specifier.startsWith(".")) return false;
  const target = resolve(fileDir, specifier);
  const rel = relative(packageRoot, target);
  return rel.startsWith("..") || rel === "";
}

/**
 * Returns one human-readable failure per violation; an empty array means the package is clean.
 * Pure over the filesystem so the self-test can point it at fixtures.
 */
export function checkBoundary(packageRoot) {
  const root = resolve(packageRoot);
  const failures = [];

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const field of ["dependencies", "peerDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (!ALLOWED_RUNTIME_DEPENDENCIES.has(name)) {
        failures.push(`package.json ${field}: "${name}" is not an allowed runtime dependency`);
      }
    }
  }

  const src = join(root, "src");
  for (const file of sourceFiles(src)) {
    const path = join(src, file);
    const text = readFileSync(path, "utf8");
    for (const specifier of specifiersIn(text)) {
      if (FORBIDDEN_SPECIFIER_PATTERNS.some((pattern) => pattern.test(specifier))) {
        failures.push(`src/${file}: forbidden import "${specifier}"`);
      } else if (escapesPackage(specifier, dirname(path), root)) {
        failures.push(`src/${file}: relative import "${specifier}" escapes the package`);
      }
    }
  }
  return failures;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const packageRoot = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const failures = checkBoundary(packageRoot);
  if (failures.length > 0) {
    process.stderr.write(
      `convex-tinybird boundary check failed:\n${failures.map((f) => `  ${f}`).join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `convex-tinybird boundary check passed (${relative(process.cwd(), resolve(packageRoot)) || "."}).\n`,
  );
}
