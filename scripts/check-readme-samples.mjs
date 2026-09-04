/**
 * Keep the guide's claims true against the code, in two independent ways.
 *
 * A sample that lives only in prose rots silently: it keeps compiling in a reader's head long
 * after the method was renamed, and the first person to notice is someone whose code does not
 * work. So this checks two DIFFERENT things, and the separation matters:
 *
 *   1. Every client name the guide uses EXISTS on `TinybirdDelivery`. Oracle: the class itself.
 *   2. Every one of them is DEMONSTRATED in `example/convex`. Oracle: the example, which is
 *      compiled and tested on every run. This is what AC 2 asks for.
 *
 * An earlier version conflated the two and used the example as the oracle for both. That was
 * unsound in a way verification demonstrated: existence was `.name(` searched over the
 * concatenated example source, unanchored, so ANY `.foo(` satisfied `tinybird.foo(` — and the
 * example's vocabulary includes `.query(`, `.insert(`, `.first(`, `.take(` via `ctx.db`. A
 * sample inventing a whole read API on the client passed.
 *
 * The same version derived tracked names per code block from `new TinybirdDelivery(...)`. Most
 * samples do not construct a client, so that collected ONE name where the previous version
 * collected eight — and still returned no failures, so the weakening was invisible. That is the
 * shape of a control that stays green for every value: it shipped looking like a strengthening.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fences that hold TypeScript. Matching only ```ts was a hole — a wrong sample passed simply by
 * being labelled ```typescript, and again as ```js.
 */
const TS_FENCE = /```(?:ts|typescript|js|javascript|tsx|jsx)\n([\s\S]*?)```/gu;

/**
 * Names the guide gives a client. Constructor-derived names are unioned across the WHOLE file
 * rather than per block, plus the conventional ones, because a sample that opens straight into
 * `tinybird.heartbeat(ctx)` is the common case and must still be covered.
 */
const CONVENTIONAL = ["tinybird", "productEvents", "auditEvents"];

/** The public surface of `TinybirdDelivery`, read from the class rather than a hand list. */
function clientMethods(root) {
  const source = readFileSync(join(root, "src", "client", "index.ts"), "utf8");
  const body = source.slice(source.indexOf("export class TinybirdDelivery"));
  return new Set([...body.matchAll(/^ {2}async (\w+)\(/gmu)].map((match) => match[1]));
}

/**
 * Which method names the example calls at all.
 *
 * Deliberately NOT restricted to a list of client variable names. The example calls
 * `stream.requeueStuck(...)` inside `for (const stream of [productEvents, auditEvents])`, and
 * any list of names is a guess about how the example chooses to spell things.
 *
 * The laxness is safe ONLY because check 1 runs first. Verification's hole was that an
 * unanchored `.foo(` search let `tinybird.query(...)` pass on the strength of `ctx.db.query(`
 * — but `query` is not a `TinybirdDelivery` method, so check 1 rejects it before this runs.
 * This function is asked "is it demonstrated", never "does it exist"; conflating those two was
 * the original defect.
 */
function calledMethods(root) {
  const dir = join(root, "example", "convex");
  const found = new Set();
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = String(entry).split("\\").join("/");
    if (!file.endsWith(".ts") || file.startsWith("_generated/")) continue;
    for (const match of readFileSync(join(dir, file), "utf8").matchAll(/\.(\w+)\(/gu)) {
      found.add(match[1]);
    }
  }
  return found;
}

export function checkReadmeSamples(root) {
  const failures = [];
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const methods = clientMethods(root);
  if (methods.size === 0) {
    failures.push("src/client/index.ts: no client methods parsed — this check has no oracle");
    return failures;
  }

  const blocks = [...readme.matchAll(TS_FENCE)].map((match) => match[1]);
  if (blocks.length === 0) {
    failures.push(
      "README.md: no TypeScript samples found — the matcher is looking in the wrong place",
    );
  }

  const declared = [
    ...readme.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*new TinybirdDelivery\b/gu),
  ].map((match) => match[1]);
  const clientNames = new Set([...declared, ...CONVENTIONAL]);
  const escaped = [...clientNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const callPattern = new RegExp(`\\b(?:${escaped.join("|")})\\.(\\w+)\\(`, "gu");

  const used = new Set();
  for (const block of blocks) {
    for (const match of block.matchAll(callPattern)) used.add(match[1]);
  }
  if (used.size === 0) {
    failures.push(
      "README.md: no client calls found in any sample. Either the guide stopped showing how to " +
        "use the component, or this pattern no longer matches it — both are worth failing on.",
    );
  }

  // CHECK 1: the name exists on the client. This is the only one that catches a rename, and the
  // only one that would have caught `getStatus` — which is the component-side query name, not a
  // client method, and which shipped in this guide.
  for (const name of [...used].sort()) {
    if (!methods.has(name)) {
      failures.push(
        `README.md calls "${name}(" on a client, and TinybirdDelivery has no such method. ` +
          `Its surface is: ${[...methods].sort().join(", ")}.`,
      );
    }
  }

  // CHECK 2: the example demonstrates it. Separate oracle, separate failure.
  const demonstrated = calledMethods(root);
  for (const name of [...used].sort()) {
    if (methods.has(name) && !demonstrated.has(name)) {
      failures.push(
        `README.md shows "${name}(" and no file under example/convex calls it on a client. ` +
          `Either the sample is not lifted from the example, or the example should demonstrate it.`,
      );
    }
  }

  // CHECK 3: PROSE, on the same oracle as check 1.
  //
  // The one real error this guide has shipped — describing `getStatus` as something you call on
  // the client, when it is a component-side query — was written in a SENTENCE, not a sample.
  // Checks 1 and 2 read fenced blocks only and were blind to it by construction, so widening
  // fences did nothing for it. Most of this guide is the sentences between the samples.
  //
  // Only CLIENT-QUALIFIED spans are checked: `` `tinybird.foo(` ``. A bare `` `foo` `` is not,
  // and that is deliberate rather than an oversight — 58 identifier-shaped spans appear in this
  // prose and 47 of them are field names, states, error codes and env vars that have nothing to
  // do with the client surface. Checking those needs a hand-maintained allowlist that fails on
  // correct documentation the first time someone documents a new field, and a gate that fires on
  // correct work is a gate that gets switched off. So this catches "attributed to the client and
  // wrong", which is the shape of the bug that actually happened, and does NOT catch a bare
  // invented name in prose. That gap is real and stated rather than papered over.
  const prose = readme.replace(/```[\s\S]*?```/gu, "");
  const proseCalls = new Set();
  for (const span of prose.matchAll(/`([^`\n]+)`/gu)) {
    for (const call of span[1].matchAll(callPattern)) proseCalls.add(call[1]);
  }
  for (const name of [...proseCalls].sort()) {
    if (!methods.has(name)) {
      failures.push(
        `README.md prose attributes "${name}(" to a client, and TinybirdDelivery has no such ` +
          `method. Its surface is: ${[...methods].sort().join(", ")}.`,
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
  process.stdout.write("convex-tinybird README samples match the client and the example.\n");
}
