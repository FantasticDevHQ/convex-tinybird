import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkReadmeSamples } from "./check-readme-samples.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function copyPackage() {
  const dir = mkdtempSync(join(tmpdir(), "readme-samples-"));
  for (const entry of ["README.md", "example"]) {
    cpSync(join(packageRoot, entry), join(dir, entry), { recursive: true });
  }
  return dir;
}

test("passes on the guide as committed", () => {
  assert.deepEqual(checkReadmeSamples(packageRoot), []);
});

test("fails when a sample calls something the example does not", () => {
  const dir = copyPackage();
  try {
    const readme = join(dir, "README.md");
    writeFileSync(
      readme,
      `${readFileSync(readme, "utf8")}\n\`\`\`ts\nawait tinybird.methodThatNeverExisted(ctx);\n\`\`\`\n`,
    );
    const failures = checkReadmeSamples(dir);
    assert.equal(failures.length, 1, failures.join("\n"));
    assert.match(failures[0], /methodThatNeverExisted/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails when the example stops demonstrating a documented operation", () => {
  const dir = copyPackage();
  try {
    // The direction that actually happens: the guide is fine and the example drifts away from
    // it, which is how a sample becomes stale without anyone editing the sample.
    const ops = join(dir, "example", "convex", "operations.ts");
    writeFileSync(ops, readFileSync(ops, "utf8").replace(/\.replayFailed\(/u, ".notReplayFailed("));

    const failures = checkReadmeSamples(dir);
    assert.equal(failures.length, 1, failures.join("\n"));
    assert.match(failures[0], /replayFailed/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notices if it stops matching anything at all", () => {
  const dir = copyPackage();
  try {
    // A gate that silently matches nothing passes for ever. Stripping every sample must be
    // loud, not green.
    writeFileSync(join(dir, "README.md"), "# guide\n\nNo samples here.\n");
    const failures = checkReadmeSamples(dir);
    // TWO failures, not one: "no samples" and "no client calls" are separate observations and
    // both are true of an empty guide. Asserting exactly one would pin my guess about the
    // implementation rather than the behaviour.
    assert.equal(failures.length, 2, failures.join("\n"));
    assert.ok(
      failures.some((f) => /no TypeScript samples/u.test(f)),
      failures.join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
