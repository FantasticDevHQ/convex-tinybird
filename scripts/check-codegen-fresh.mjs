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
 * What it does NOT catch, stated so nobody assumes otherwise: a changed argument or return
 * validator on a function that is already listed. `tsc` covers that, and not by luck — the
 * client in `src/client/index.ts` consumes the generated component types, so a signature that
 * moves without regeneration is a type error there. That is how the `cursor` type change in
 * FTD-2500 surfaced. The two together are the gate; neither alone is.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Convex turns every `.ts` under the app directory into a module, except these. */
function isGeneratedModule(relativePath) {
  const base = relativePath.split("/").at(-1) ?? "";
  if (base === "schema") return false;
  if (base.endsWith(".config")) return false;
  if (base === "test" || base.endsWith(".test")) return false;
  return !relativePath.startsWith("_generated/");
}

function sourceModules(dir) {
  return readdirSync(dir, { recursive: true })
    .map((entry) => String(entry).split("\\").join("/"))
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => entry.slice(0, -3))
    .filter(isGeneratedModule)
    .sort();
}

/** Modules the generated `api.d.ts` actually declares, read from its `fullApi` block. */
function declaredModules(apiPath) {
  const text = readFileSync(apiPath, "utf8");
  const block = /declare const fullApi: ApiFromModules<\{([\s\S]*?)\}>/u.exec(text);
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
  const generated = readFileSync(join(componentDir, "_generated", "component.ts"), "utf8");
  for (const name of exportedFunctions(componentDir)) {
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
