/**
 * Catch generated Convex code that has fallen behind its source.
 *
 * Regenerating would be the direct check, and it is not available here: a component's
 * `_generated` is written by pushing a HOST that mounts it, so `convex codegen --component-dir`
 * needs a real deployment and CI has none. So this derives what the generator would emit and
 * compares the SET, the same approach `scripts/convex-codegen-freshness.test.mjs` takes for the
 * backend after 80 modules went missing across 46 commits with a green typecheck throughout.
 *
 * What it catches: a module, or a PUBLIC Convex function, that exists in source and not in the
 * generated tree. Internal functions are excluded because `component.ts` is the host-facing API
 * and does not list them — `lifecycle.ts` and `deliver.ts` appear nowhere in it, correctly. That is the failure that has actually happened, and the one nothing else sees.
 *
 * What it does NOT catch: a changed argument or return validator on a function already listed.
 * `tsc` covers PART of that, and the part it misses was measured rather than guessed —
 * verification drifted four validators with the tree otherwise clean:
 *
 * | drift | tsc | this gate |
 * |---|---|---|
 * | new REQUIRED arg on `vEnqueueArgs` | fails | passes |
 * | `datasource` string -> number | fails | passes |
 * | new OPTIONAL arg on `vEnqueueArgs` | **passes** | passes |
 * | return union widened with a new literal | **passes** | passes |
 *
 * So NARROWING is caught and WIDENING is not, by either. A new optional argument and a wider
 * return union are ordinary changes, and they leave the generated file stale with nothing
 * complaining. An earlier version of this comment stated the whole class as covered, which was
 * an overclaim of exactly the kind this package has shipped before — a bound that is true at
 * the end you check and false at the end you do not.
 *
 * Closing it needs regeneration, which CI cannot do. Until then the honest mitigation is that
 * regeneration is part of the local `check` command and its output is committed, so the drift
 * window is one push rather than indefinite.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Whether Convex would turn this file into a module.
 *
 * Mirrors the bundler's real entry-point filter, not a guess at it. The previous version excluded
 * only `schema`, `*.config`, `test`/`*.test` and `_generated/`, and so DEMANDED modules the
 * generator is correct never to emit — a `.d.ts` file, or a helper with no top-level import or
 * export, each failed the gate on output that was perfectly fresh. A gate that fails on correct
 * work is the failure mode this whole script argues against, so the rules are enumerated here:
 *
 *  - more than one dot in the basename. NOT a `.test.ts` rule — `shims.d.ts`, `a.b.ts` and
 *    `foo.test.ts` are all skipped for the same reason, which is why matching on `.test` alone
 *    was both too narrow and misleading about why it worked.
 *  - dotfiles, `#`-prefixed editor tempfiles, and any name containing a space.
 *  - `schema`, `*.config`, and anything under `_generated/`.
 *  - a `.ts` file with no top-level `import` or `export`: Convex treats it as not a module.
 *
 * The sibling repo gate already guards the `.d.ts` case explicitly
 * (`scripts/convex-codegen-freshness.test.mjs`); this script had dropped that filter.
 */
function isGeneratedModule(relativePath, contents) {
  const base = relativePath.split("/").at(-1) ?? "";
  if (relativePath.startsWith("_generated/")) return false;
  if (base.startsWith(".") || base.startsWith("#") || base.includes(" ")) return false;
  // `base` has already had its `.ts` stripped, so ANY remaining dot means two in the filename.
  if (base.includes(".") && !base.endsWith(".config")) return false;
  if (base === "schema" || base.endsWith(".config")) return false;
  if (base === "test") return false;
  return /^\s*(?:import|export)\b/mu.test(contents);
}

function sourceModules(dir) {
  return readdirSync(dir, { recursive: true })
    .map((entry) => String(entry).split("\\").join("/"))
    .filter((entry) => entry.endsWith(".ts"))
    .filter((entry) =>
      isGeneratedModule(entry.slice(0, -3), readFileSync(join(dir, entry), "utf8")),
    )
    .map((entry) => entry.slice(0, -3))
    .sort();
}

/** Modules the generated `api.d.ts` actually declares, read from its `fullApi` block. */
function declaredModules(apiPath) {
  const text = readFileSync(apiPath, "utf8");
  // The app emits `declare const fullApi`; a component's own api.ts emits a bare
  // `const fullApi`. Matching only the former is why the component half never checked modules.
  const block = /(?:declare )?const fullApi: ApiFromModules<\{([\s\S]*?)\}>/u.exec(text);
  if (block === null) return null;
  return [...block[1].matchAll(/^\s*"?([\w/.-]+)"?:\s*typeof/gmu)].map((m) => m[1]).sort();
}

/**
 * Convex functions exported from the component's source.
 *
 * Matched on the DECLARATION rather than a name list, so adding a function is enough to be
 * required here — the point is to notice code nobody remembered to regenerate for.
 */
function exportedFunctions(dir) {
  const names = new Set();
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = String(entry).split("\\").join("/");
    if (!file.endsWith(".ts") || file.includes(".test.") || file.startsWith("_generated/")) {
      continue;
    }
    const text = readFileSync(join(dir, file), "utf8");
    for (const match of text.matchAll(
      // PUBLIC functions only. `component.ts` is the component's host-facing API, so a module
      // holding nothing but `internalMutation`/`internalAction` — `lifecycle.ts`, `deliver.ts` —
      // legitimately does not appear there. Requiring internals would fail on correct output,
      // which is worse than missing a case: a gate that cries wolf gets disabled.
      /^export const (\w+) = (?:mutation|query|action)\(/gmu,
    )) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

export function checkCodegenFresh(root) {
  const failures = [];

  const exampleConvex = join(root, "example", "convex");
  const expected = sourceModules(exampleConvex);
  const declared = declaredModules(join(exampleConvex, "_generated", "api.d.ts"));
  if (declared === null) {
    failures.push("example/convex/_generated/api.d.ts: no fullApi block — regenerate it");
  } else {
    for (const name of expected) {
      if (!declared.includes(name)) {
        failures.push(
          `example/convex/_generated/api.d.ts is stale: "${name}" exists in source and is not ` +
            `declared. Run: CONVEX_AGENT_MODE=anonymous convex dev --once in example/`,
        );
      }
    }
    for (const name of declared) {
      if (!expected.includes(name)) {
        failures.push(
          `example/convex/_generated/api.d.ts declares "${name}", which no longer exists in ` +
            `source. Regenerate to drop it.`,
        );
      }
    }
  }

  const componentDir = join(root, "src", "component");

  // MODULES, not just function names. The component half checked only that each exported
  // function had a FunctionReference, and never read `_generated/api.ts`'s `fullApi` block at
  // all — so a new component module that nobody registered passed the gate. That is precisely
  // the class of defect this script cites as its reason for existing, and it was unguarded on
  // the half of the package that gets bundled and pushed.
  const componentExpected = sourceModules(componentDir);
  const componentDeclared = declaredModules(join(componentDir, "_generated", "api.ts"));
  if (componentDeclared === null) {
    failures.push("src/component/_generated/api.ts: no fullApi block — regenerate it");
  } else {
    for (const name of componentExpected) {
      if (!componentDeclared.includes(name)) {
        failures.push(
          `src/component/_generated/api.ts is stale: module "${name}" exists in source and is ` +
            `not declared. Regenerate through a host that mounts the component.`,
        );
      }
    }
    for (const name of componentDeclared) {
      if (!componentExpected.includes(name)) {
        failures.push(
          `src/component/_generated/api.ts declares module "${name}", which no longer exists ` +
            `in source. Regenerate to drop it.`,
        );
      }
    }
  }

  const generated = readFileSync(join(componentDir, "_generated", "component.ts"), "utf8");
  const componentFunctions = exportedFunctions(componentDir);

  // BOTH directions. This half checked source→generated only, so deleting a public function or
  // turning it internal left a stale `FunctionReference` standing in `component.ts` and the gate
  // stayed green — a host would keep typechecking against a function that no longer exists. The
  // example half has always checked both ways; this one checked neither.
  for (const name of [...generated.matchAll(/^\s*(\w+):\s*FunctionReference/gmu)].map(
    (m) => m[1],
  )) {
    if (!componentFunctions.includes(name)) {
      failures.push(
        `src/component/_generated/component.ts declares "${name}", which is no longer an ` +
          `exported Convex function. Regenerate to drop it.`,
      );
    }
  }

  for (const name of componentFunctions) {
    // Word-bounded: a substring match would let `enqueue` satisfy a missing `enqueueBatch`.
    if (!new RegExp(`\\b${name}:\\s*FunctionReference`, "u").test(generated)) {
      failures.push(
        `src/component/_generated/component.ts is stale: "${name}" is an exported Convex ` +
          `function with no FunctionReference. Regenerate through a host that mounts the ` +
          `component (the example app will do it).`,
      );
    }
  }

  return failures;
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("check-codegen-fresh.mjs");
if (invokedDirectly) {
  const packageRoot = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const failures = checkCodegenFresh(packageRoot);
  if (failures.length > 0) {
    // `process.stderr`, not `console` — the repository runs a zero-console policy and the
    // sibling boundary gate reports the same way.
    process.stderr.write(
      `convex-tinybird codegen freshness check failed:\n${failures.map((f) => `  ${f}`).join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write("convex-tinybird codegen is fresh.\n");
}
