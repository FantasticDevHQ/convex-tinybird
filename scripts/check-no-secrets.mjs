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
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Files allowed to touch the token, and why. */
export const TOKEN_ALLOWED_FILES = new Set([
  "component/convex.config.ts", // declares the variable; declaring is not reading
  "component/credentials.ts", // the one reader, deliberately two functions long
]);

// A bare `console` identifier, not only `console.log`. Aliasing it (`const c = console`),
// reaching it through a global (`globalThis.console`) or indexing it (`console["log"]`) all
// print just the same, and a component that never logs has no reason to name it at all.
const CONSOLE_PATTERN = /\bconsole\b/u;
const TOKEN_PATTERN = /TINYBIRD_TOKEN/u;
/**
 * Forms that carry the token without naming it. Enumerating or spreading the component's
 * env hands every declared secret to whatever consumes the result, which is the leak a
 * name-based rule cannot see.
 */
const ENV_BULK_PATTERN =
  /Object\s*\.\s*(?:entries|keys|values|assign)\s*\(\s*env\b|JSON\s*\.\s*stringify\s*\(\s*env\b|\.\.\.\s*env\b/u;

function sourceFiles(dir) {
  return (
    readdirSync(dir, { recursive: true })
      .map((name) => String(name).split(sep).join("/"))
      .filter((name) => /\.(ts|tsx|mts)$/.test(name))
      .filter((name) => !name.split("/").includes("_generated"))
      // Test files and their shared harness legitimately name the variable in order to stub
      // it; the rules here are about the shipped component, not about how it is exercised.
      .filter((name) => !name.endsWith(".test.ts") && !name.startsWith("testing/"))
  );
}

/**
 * Files that are credentials by nature and must never be COMMITTED, wherever they appear.
 *
 * `.tinyb` is the Tinybird CLI's state file. It holds an admin token, `tb deploy` rewrites it,
 * and nothing here needs it — `smoke.sh` discovers its own token from the local container. It
 * WAS committed once in this package and the gate said nothing, because the gate only ever
 * looked at `src/**\/*.ts`. The one that got in was a throwaway local token; the next one would
 * not necessarily be.
 */
const FORBIDDEN_FILENAMES = new Set([".tinyb", ".env", ".env.local", ".env.production"]);

/**
 * TRACKED files only, which is the whole point: the hazard is committing a credential, not
 * having one on your machine. A working-tree walk flags the `.env.local` that every developer
 * running the example is told to create, and it is gitignored, so the gate would fail for
 * doing the documented thing. `git ls-files` asks the question the rule is actually about.
 */
function trackedFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z", "--", "."], {
    cwd: root,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

/** One failure per violation; an empty array means the package is clean. */
export function checkNoSecrets(packageRoot) {
  const root = resolve(packageRoot);
  const src = join(root, "src");
  const failures = [];

  for (const file of trackedFiles(root)) {
    // The gate's own fixtures are deliberate violations — one of them is a tracked `.tinyb`,
    // which is the only way to prove the check can fail. Scanning them would make the real
    // package permanently dirty. The exclusion is a fixed path rather than a name pattern so a
    // genuine credential cannot land somewhere that merely looks like a fixture.
    if (file.startsWith("scripts/fixtures/")) continue;
    if (FORBIDDEN_FILENAMES.has(file.split("/").at(-1) ?? "")) {
      failures.push(
        `${file}: credential state must not be committed. Add it to .gitignore and remove it ` +
          `from the index with \`git rm --cached\`.`,
      );
    }
  }

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
      if (ENV_BULK_PATTERN.test(line)) {
        failures.push(`${where}: the component env must not be enumerated, spread or serialized`);
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
