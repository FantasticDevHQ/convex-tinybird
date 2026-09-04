import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkReadmeSamples } from "./check-readme-samples.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function copyPackage() {
  const dir = mkdtempSync(join(tmpdir(), "readme-samples-"));
  for (const entry of ["README.md", "example", "src"]) {
    cpSync(join(packageRoot, entry), join(dir, entry), {
      recursive: true,
      // `node_modules` holds a workspace symlink back to this package, so copying it recurses
      // until the path is too long for the filesystem. Excluding it is not an optimisation.
      filter: (source) => !source.split(sep).includes("node_modules"),
    });
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

test("sees a client the guide names something else", () => {
  const dir = copyPackage();
  try {
    // The hole that mattered most: the previous version tracked three hardcoded names, so a
    // sample calling `events.shipItRightNow(ctx)` was invisible. Client names are now derived
    // from `new TinybirdDelivery(...)` in the sample itself.
    const readme = join(dir, "README.md");
    writeFileSync(
      readme,
      `${readFileSync(readme, "utf8")}\n\`\`\`ts\nconst events = new TinybirdDelivery(components.x);\nawait events.shipItRightNow(ctx);\n\`\`\`\n`,
    );
    const failures = checkReadmeSamples(dir);
    assert.ok(
      failures.some((f) => /shipItRightNow/u.test(f)),
      failures.join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scans fences other than exactly ```ts", () => {
  // Matching one fence tag let a wrong sample through by being labelled ```typescript, and
  // again as ```js. A guide is written by whoever reaches for whichever tag comes to mind.
  for (const fence of ["typescript", "js", "javascript", "tsx"]) {
    const dir = copyPackage();
    try {
      const readme = join(dir, "README.md");
      writeFileSync(
        readme,
        `${readFileSync(readme, "utf8")}\n\`\`\`${fence}\nawait tinybird.neverExisted(ctx);\n\`\`\`\n`,
      );
      const failures = checkReadmeSamples(dir);
      assert.ok(
        failures.some((f) => /neverExisted/u.test(f)),
        `fence ${fence} was not scanned: ${failures.join("\n")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("still passes a sample that calls something real", () => {
  // The control. A gate that fails on everything is not a gate, and every case above would
  // pass under one.
  const dir = copyPackage();
  try {
    const readme = join(dir, "README.md");
    writeFileSync(
      readme,
      `${readFileSync(readme, "utf8")}\n\`\`\`ts\nawait productEvents.enqueue(ctx, {});\n\`\`\`\n`,
    );
    assert.deepEqual(checkReadmeSamples(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a name that is not on the client, however it is fenced or spelled", () => {
  // Verification's hole 2, and the one that defeated two earlier designs: existence was checked
  // against the EXAMPLE with an unanchored `.name(`, so a sample inventing a whole read API
  // passed on the strength of `ctx.db.query(`, `.first()`, `.take(` and `ctx.db.insert(`.
  // The oracle for "does it exist" is now the client class.
  const dir = copyPackage();
  try {
    const readme = join(dir, "README.md");
    writeFileSync(
      readme,
      `${readFileSync(readme, "utf8")}\n\`\`\`ts\nconst tinybird = new TinybirdDelivery(components.productEvents);\nconst failures = await tinybird.query(ctx, {});\nconst page = await tinybird.take(ctx, 20);\n\`\`\`\n`,
    );
    const failures = checkReadmeSamples(dir);
    assert.ok(
      failures.some((f) => /"query\("/u.test(f)),
      failures.join("\n"),
    );
    assert.ok(
      failures.some((f) => /"take\("/u.test(f)),
      failures.join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("separates 'exists' from 'is demonstrated'", () => {
  // A real client method the example does not show must fail check 2 and NOT check 1, because
  // the two answer different questions and conflating them was the original defect.
  const dir = copyPackage();
  try {
    const readme = join(dir, "README.md");
    writeFileSync(
      readme,
      `${readFileSync(readme, "utf8")}\n\`\`\`ts\nawait tinybird.reclaimOrphanedPayloads(ctx);\n\`\`\`\n`,
    );
    const failures = checkReadmeSamples(dir);
    assert.equal(failures.length, 1, failures.join("\n"));
    assert.match(failures[0], /no file under example\/convex calls it/u);
    assert.doesNotMatch(failures[0], /has no such method/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails loudly if the client oracle stops parsing", () => {
  // If `src/client/index.ts` is reshaped so no methods are found, check 1 silently accepts
  // everything. That is the control-that-cannot-fail shape, so it is an explicit failure.
  const dir = copyPackage();
  try {
    const client = join(dir, "src", "client", "index.ts");
    writeFileSync(
      client,
      readFileSync(client, "utf8").replace(/export class TinybirdDelivery/u, "class Renamed"),
    );
    const failures = checkReadmeSamples(dir);
    assert.ok(
      failures.some((f) => /no client methods parsed/u.test(f)),
      failures.join("\n"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catches a method attributed to the client in PROSE, not just in a sample", () => {
  // The one real error this guide shipped — `getStatus` described as a client call when it is a
  // component-side query — was written in a sentence. Checks 1 and 2 read fenced blocks and were
  // blind to it by construction, so widening the fence pattern did nothing for it.
  const dir = copyPackage();
  try {
    const readme = join(dir, "README.md");
    writeFileSync(
      readme,
      `${readFileSync(readme, "utf8")}\n\nOperators read one event with \`tinybird.getStatus(ctx, {})\` when triaging.\n`,
    );
    const failures = checkReadmeSamples(dir);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /prose attributes "getStatus\("/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not fire on prose naming a method the client really has", () => {
  // The leg that stops check 3 being satisfiable by rejecting everything. Without it, a prose
  // check that failed on every qualified span would look identical to one that works.
  const dir = copyPackage();
  try {
    const readme = join(dir, "README.md");
    writeFileSync(
      readme,
      `${readFileSync(readme, "utf8")}\n\nAn operator pauses a stream with \`tinybird.pause(ctx, {})\`.\n`,
    );
    assert.deepEqual(checkReadmeSamples(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
