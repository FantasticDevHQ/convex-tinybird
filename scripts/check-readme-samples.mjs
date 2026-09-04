/**
 * Every identifier a README code sample uses must exist in the example app.
 *
 * A sample that lives only in prose rots silently: it keeps compiling in a reader's head long
 * after the method was renamed, and the first person to notice is someone whose code does not
 * work. The example app is compiled and tested on every run, so pinning the samples to it is
 * the cheapest way to make the guide provably current.
 *
 * This checks IDENTIFIERS, not whole snippets. Samples are legitimately abridged — an import
 * line dropped, an argument elided — so requiring a literal substring match would force the
 * guide to be worse prose to satisfy a gate. What it will not tolerate is a name the example
 * does not have.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Client methods and component surfaces a sample may reference. */
const TRACKED = /\b(?:tinybird|productEvents|auditEvents)\.(\w+)\(/gu;

export function checkReadmeSamples(root) {
  const failures = [];
  const readme = readFileSync(join(root, "README.md"), "utf8");

  const exampleDir = join(root, "example", "convex");
  const exampleSource = readdirSync(exampleDir, { recursive: true })
    .map((entry) => String(entry).split("\\").join("/"))
    .filter((entry) => entry.endsWith(".ts") && !entry.startsWith("_generated/"))
    .map((entry) => readFileSync(join(exampleDir, entry), "utf8"))
    .join("\n");

  const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/gu)].map((match) => match[1]);
  if (blocks.length === 0) {
    failures.push(
      "README.md: no TypeScript samples found — the matcher is looking in the wrong place",
    );
  }

  const used = new Set();
  for (const block of blocks) {
    for (const match of block.matchAll(TRACKED)) used.add(match[1]);
  }
  if (used.size === 0) {
    failures.push(
      "README.md: no client calls found in any sample. Either the guide stopped showing how to " +
        "use the component, or this pattern no longer matches it — both are worth failing on.",
    );
  }

  for (const name of [...used].sort()) {
    if (!new RegExp(`\\.${name}\\(`, "u").test(exampleSource)) {
      failures.push(
        `README.md uses "${name}(" in a sample, and no file under example/convex calls it. ` +
          `Either the sample is stale, or the example should demonstrate it.`,
      );
    }
  }
  return failures;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("check-readme-samples.mjs");
if (invokedDirectly) {
  const packageRoot = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const failures = checkReadmeSamples(packageRoot);
  if (failures.length > 0) {
    process.stderr.write(
      `convex-tinybird README sample check failed:\n${failures.map((f) => `  ${f}`).join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write("convex-tinybird README samples match the example app.\n");
}
