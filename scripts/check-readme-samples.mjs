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

/**
 * Fences that hold TypeScript. Matching only ```ts was a hole: verification passed a wrong
 * sample through simply by fencing it as ```typescript, and again as ```js. A guide is written
 * by people who reach for whichever tag comes to mind.
 */
const TS_FENCE = /```(?:ts|typescript|js|javascript|tsx|jsx)\n([\s\S]*?)```/gu;

/**
 * Which variables in a sample are component clients.
 *
 * DERIVED from the sample, not hardcoded. The previous version tracked three names it happened
 * to know, so a sample calling `events.shipItRightNow(ctx)` was invisible — verification showed
 * exactly that passing. Anything constructed with `new TinybirdDelivery(...)` is a client, plus
 * the names the guide conventionally uses, so a sample that shows only the call still counts.
 */
const CONVENTIONAL = ["tinybird", "productEvents", "auditEvents"];

function clientNames(block) {
  const declared = [
    ...block.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*new TinybirdDelivery\b/gu),
  ].map((match) => match[1]);
  return new Set([...declared, ...CONVENTIONAL]);
}

export function checkReadmeSamples(root) {
  const failures = [];
  const readme = readFileSync(join(root, "README.md"), "utf8");

  const exampleDir = join(root, "example", "convex");
  const exampleSource = readdirSync(exampleDir, { recursive: true })
    .map((entry) => String(entry).split("\\").join("/"))
    .filter((entry) => entry.endsWith(".ts") && !entry.startsWith("_generated/"))
    .map((entry) => readFileSync(join(exampleDir, entry), "utf8"))
    .join("\n");

  const blocks = [...readme.matchAll(TS_FENCE)].map((match) => match[1]);
  if (blocks.length === 0) {
    failures.push(
      "README.md: no TypeScript samples found — the matcher is looking in the wrong place",
    );
  }

  const used = new Set();
  for (const block of blocks) {
    const names = [...clientNames(block)].map((n) => n.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
    const pattern = new RegExp(`\\b(?:${names.join("|")})\\.(\\w+)\\(`, "gu");
    for (const match of block.matchAll(pattern)) used.add(match[1]);
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
