#!/usr/bin/env node
/**
 * check-no-secrets.mjs — keep credentials and logging out of the component's sources.
 *
 *   node packages/convex-tinybird/scripts/check-no-secrets.mjs [packageRoot]
 *
 * Two rules, both about things that are invisible in a passing test suite.
 *
 * `console.*` because the component runs inside someone else's deployment: anything it
 * prints lands in their logs, where a payload or a credential would sit indefinitely. The
 * repository has a no-console gate for its own code; this extends it to the package.
 *
 * The append token because it is the one value that must never be interpolated into a
 * string. Reading `env.TINYBIRD_TOKEN` is legitimate in exactly one place, the delivery
 * action that builds the Authorization header, and in the sanitizer that redacts it.
 * Anywhere else is either a leak or a step towards one.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Files allowed to touch the token, and why. */
export const TOKEN_ALLOWED_FILES = new Set([
  "component/convex.config.ts", // declares the variable; declaring is not reading
  "component/deliver.ts", // builds the Authorization header
  "component/lib.ts", // passes it to the sanitizer for redaction
]);

const CONSOLE_PATTERN = /(^|[^\w.])console\s*\.\s*\w+/u;
const TOKEN_PATTERN = /TINYBIRD_TOKEN/u;

function sourceFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map((name) => String(name).split(sep).join("/"))
    .filter((name) => /\.(ts|tsx|mts)$/.test(name))
    .filter((name) => !name.split("/").includes("_generated"))
    .filter((name) => !name.endsWith(".test.ts"));
}

/** One failure per violation; an empty array means the package is clean. */
export function checkNoSecrets(packageRoot) {
  const src = join(resolve(packageRoot), "src");
  const failures = [];
  for (const file of sourceFiles(src)) {
    const text = readFileSync(join(src, file), "utf8");
    text.split("\n").forEach((line, index) => {
      const where = `src/${file}:${index + 1}`;
      if (CONSOLE_PATTERN.test(line)) {
        failures.push(`${where}: console logging is not allowed inside the component`);
      }
      if (TOKEN_PATTERN.test(line) && !TOKEN_ALLOWED_FILES.has(file)) {
        failures.push(`${where}: the append token must not be referenced here`);
      }
    });
  }
  return failures;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const packageRoot = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const failures = checkNoSecrets(packageRoot);
  if (failures.length > 0) {
    process.stderr.write(
      `convex-tinybird secret check failed:\n${failures.map((f) => `  ${f}`).join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `convex-tinybird secret check passed (${relative(process.cwd(), resolve(packageRoot)) || "."}).\n`,
  );
}
