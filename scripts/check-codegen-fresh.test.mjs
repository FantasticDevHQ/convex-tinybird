import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkCodegenInventory as checkCodegenFresh } from "./check-codegen-inventory.mjs";
import { checkCodegenFresh as regenerateAndCheck, copyForCodegen } from "./check-codegen-fresh.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A throwaway copy of the real package.
 *
 * Fixtures assembled by hand drift from the tree they stand for — this gate exists precisely
 * because generated output drifts — so the tests edit a copy of the actual package instead.
 * A change to the real layout then shows up here rather than silently making the gate vacuous.
 */
function copyPackage() {
  const dir = mkdtempSync(join(tmpdir(), "codegen-fresh-"));
  for (const entry of ["src", "example", "scripts", "package.json"]) {
    cpSync(join(packageRoot, entry), join(dir, entry), {
      recursive: true,
      filter: (source) =>
        !source
          .split(sep)
          .some((part) => part === "node_modules" || part === ".convex" || part.startsWith(".env")),
    });
  }
  return dir;
}

test("passes on the package as committed", () => {
  assert.deepEqual(checkCodegenFresh(packageRoot), []);
});

test("fails when the example's generated api drops a module", () => {
  const dir = copyPackage();
  try {
    const api = join(dir, "example", "convex", "_generated", "api.d.ts");
    const text = readFileSync(api, "utf8");
    // Exactly what a forgotten regeneration looks like: the module is gone from `fullApi`
    // while the source file it came from is still there.
    writeFileSync(api, text.replace(/^\s*orders: typeof orders;\n/mu, ""));

    const failures = checkCodegenFresh(dir);
    assert.equal(failures.length, 1, failures.join("\n"));
    assert.match(failures[0], /is stale: "orders"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails when a new public component function is not in the generated api", () => {
  const dir = copyPackage();
  try {
    const lib = join(dir, "src", "component", "lib.ts");
    writeFileSync(
      join(dir, "src", "component", "lib.ts"),
      `${readFileSync(lib, "utf8")}\nexport const brandNewSurface = query({\n  args: {},\n  returns: v.null(),\n  handler: async () => null,\n});\n`,
    );

    const failures = checkCodegenFresh(dir);
    assert.equal(failures.length, 1, failures.join("\n"));
    assert.match(failures[0], /brandNewSurface/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignores internal functions, which the host-facing api correctly omits", () => {
  const dir = copyPackage();
  try {
    const lifecycle = join(dir, "src", "component", "lifecycle.ts");
    writeFileSync(
      lifecycle,
      `${readFileSync(lifecycle, "utf8")}\nexport const brandNewInternal = internalMutation({\n  args: {},\n  returns: v.null(),\n  handler: async () => null,\n});\n`,
    );

    // The control for the rule above. Requiring internals would fail on correct generated
    // output, and a gate that fails on correct output gets turned off.
    assert.deepEqual(checkCodegenFresh(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new COMPONENT module absent from _generated/api.ts is caught", () => {
  // Hole 1. The component half checked only that each exported function had a
  // FunctionReference and never read `fullApi` at all, so an unregistered module passed — the
  // exact class of defect this script names as its reason for existing, unguarded on the half
  // of the package that actually gets bundled and pushed.
  const dir = copyPackage();
  try {
    writeFileSync(join(dir, "src", "component", "zzmodule.ts"), 'export const zz = "x";\n');
    const failures = checkCodegenFresh(dir);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /module "zzmodule" exists in source and is not declared/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a FunctionReference left behind by a deleted public function is caught", () => {
  // Hole 2. Source→generated only: turning a public function internal left its reference
  // standing, and a host kept typechecking against a function that no longer exists.
  const dir = copyPackage();
  try {
    const lib = join(dir, "src", "component", "lib.ts");
    writeFileSync(
      lib,
      readFileSync(lib, "utf8").replace(
        "export const resume = mutation(",
        "export const resume = internalMutation(",
      ),
    );
    const failures = checkCodegenFresh(dir);
    assert.ok(failures.some((line) => /declares "resume", which is no longer/u.test(line)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * One case per omission rule.
 *
 * These were a single test covering all five. It was adequate coverage and a poor diagnostic:
 * mutation testing showed a regression in the `#`-tempfile rule producing output identical to a
 * regression in the space rule, so the failure named the class and not the cause. Splitting costs
 * four lines and makes the next mutant self-describing.
 */
for (const [rule, file, contents] of [
  ["a .d.ts declaration file", "shims.d.ts", 'declare module "x";\n'],
  ["any basename with two dots", "a.b.ts", "export const ab = 1;\n"],
  ["a dotfile", ".hidden.ts", "export const h = 1;\n"],
  ["an editor tempfile", "#tmp.ts", "export const t = 1;\n"],
  ["a name containing a space", "has space.ts", "export const s = 1;\n"],
  ["a file with no top-level import or export", "helper.ts", "const helper = 1;\n"],
]) {
  test(`${rule} is not demanded as a module`, () => {
    // The false-positive direction, which is the failure mode this script argues hardest against:
    // demanding a module the generator is correct never to emit fails the gate on output that is
    // perfectly fresh.
    const dir = copyPackage();
    try {
      writeFileSync(join(dir, "example", "convex", file), contents);
      assert.deepEqual(checkCodegenFresh(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("an ordinary new module IS still demanded, so the omissions are not a blanket exemption", () => {
  // Without this leg, widening the exclusions until everything is quiet would pass every test
  // above — the obvious wrong way to make the false positives go away.
  const dir = copyPackage();
  try {
    writeFileSync(join(dir, "example", "convex", "refunds.ts"), "export const r = 1;\n");
    const failures = checkCodegenFresh(dir);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /"refunds" exists in source and is not declared/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regeneration detects validator drift and changed, missing, or extra generated files", () => {
  const dir = copyForCodegen(packageRoot);
  try {
    assert.deepEqual(regenerateAndCheck(dir), []);
    const api = join(dir, "src/component/_generated/component.ts");
    const original = readFileSync(api, "utf8");
    const changed = original.replace("datasource: string", "datasource: number");
    assert.notEqual(changed, original);
    writeFileSync(api, changed);
    rmSync(join(dir, "example/convex/_generated/api.js"));
    writeFileSync(join(dir, "example/convex/_generated/obsolete.ts"), "export {};\n");
    const failures = regenerateAndCheck(dir);
    assert.equal(failures.length, 3, failures.join("\n"));
    assert.ok(failures.some((failure) => failure.includes("component.ts")));
    assert.ok(failures.some((failure) => failure.includes("api.js")));
    assert.ok(failures.some((failure) => failure.includes("obsolete.ts")));
    assert.equal(readFileSync(api, "utf8"), changed, "the check must not rewrite committed files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regeneration detects an optional argument and a widened return union in source", () => {
  const dir = copyForCodegen(packageRoot);
  try {
    const contract = join(dir, "src/component/contract.ts");
    const original = readFileSync(contract, "utf8");
    const changed = original
      .replace(
        "export const vEnqueueArgs = v.object({",
        "export const vEnqueueArgs = v.object({ extra: v.optional(v.string()),",
      )
      .replace('v.literal("repaired")),', 'v.literal("repaired"), v.literal("future_outcome")),');
    assert.notEqual(changed, original);
    writeFileSync(contract, changed);
    assert.ok(regenerateAndCheck(dir).some((failure) => failure.includes("component.ts")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
