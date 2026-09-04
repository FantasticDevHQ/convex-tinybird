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
  // Slicing to END OF FILE is safe only because the class is currently the last thing in it.
  // Anything appended below with a two-space-indented `async foo(` — a second class, a helper
  // object literal — silently JOINS the surface, and a widened surface fails OPEN: check 1 stops
  // rejecting a name it should reject. That is the dangerous direction, and nothing else here
  // would notice, so the self-test pins the parsed set's size rather than trusting the slice.
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
/**
 * Public component functions that have no client method — the names a consumer guide can mention
 * bare and mislead with. Derived, never hand-listed: see check 3 for why an allowlist of
 * legitimate words is the wrong shape here.
 */
function componentOnlyNames(root, methods) {
  const lib = readFileSync(join(root, "src", "component", "lib.ts"), "utf8");
  const exported = new Set(
    [...lib.matchAll(/^export const (\w+) = (?:mutation|query|action)\(/gmu)].map((m) => m[1]),
  );
  return new Set([...exported].filter((name) => !methods.has(name)));
}

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

  // CHECK 3: PROSE.
  //
  // The one real error this guide has shipped — `getStatus` presented alongside `enqueue` as
  // though both were things a consumer calls, when `getStatus` is a component-side query with no
  // client method — was written in a SENTENCE, with BARE spans and no receiver:
  //
  //     **The operator controls are mount-wide.** `enqueue` and `getStatus` take a datasource
  //
  // The first version of this check required a client-qualified span, `` `tinybird.getStatus(` ``,
  // and justified that scope by naming this very bug. It would not have caught it. That is worth
  // recording: the comment asserted its own motivating case and was wrong about it, which is
  // exactly the failure this gate exists to prevent, committed inside the gate.
  //
  // The oracle for bare names is NOT an allowlist of legitimate words. 58 identifier-shaped spans
  // appear in this prose and 47 are fields, states, error codes and env vars; hand-listing those
  // fails on correct documentation the first time someone documents a new field. Instead it is a
  // set the repo can derive: names that are PUBLIC FUNCTIONS ON THE COMPONENT and NOT methods on
  // the client. Today that is exactly `getStatus`. A field name never enters the set because it is
  // not an exported function, and the set empties itself if `getStatus` ever gains a client
  // method — no list to maintain, and nothing to keep in sync by hand.
  //
  // Naming one in a consumer guide is not automatically wrong, so the failure says what to do:
  // qualify it as a component-side call, or give it a client method.
  const componentOnly = componentOnlyNames(root, methods);
  const prose = readme.replace(/```[\s\S]*?```/gu, "");
  const proseSpans = [...prose.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1]);

  for (const name of [...componentOnly].sort()) {
    if (proseSpans.includes(name)) {
      failures.push(
        `README.md prose names "${name}" bare, and it is a component function with no ` +
          `TinybirdDelivery method — a reader takes it for something they can call. Write it as a ` +
          `component-side call (\`components.<mount>.lib.${name}\`) or give the client a method.`,
      );
    }
  }

  // Still checked, and still worth it: a client-QUALIFIED span naming a method that does not
  // exist. Bare-name coverage above does not subsume it — `tinybird.frobnicate(` names nothing on
  // either side and would otherwise pass.
  const callPatternProse = new RegExp(`\\b(?:${escaped.join("|")})\\.(\\w+)\\(`, "gu");
  const proseCalls = new Set();
  for (const span of proseSpans) {
    for (const call of span.matchAll(callPatternProse)) proseCalls.add(call[1]);
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
