import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkCodegenFresh } from "./check-codegen-fresh.mjs";

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
    cpSync(join(packageRoot, entry), join(dir, entry), { recursive: true });
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
