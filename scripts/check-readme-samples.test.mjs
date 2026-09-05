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
      filter: (source) =>
        !source
          .split(sep)
          .some((part) => part === "node_modules" || part === ".convex" || part.startsWith(".env")),
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
    assert.equal(failures.length, 2, failures.join("\n"));
    assert.ok(failures.some((failure) => /replayFailed/u.test(failure)));
    assert.ok(failures.some((failure) => /excerpt does not match/u.test(failure)));
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

test("catches the BARE prose mention that actually shipped", () => {
  // This is the literal sentence from 3813a6178. The first version of check 3 required a
  // client-qualified span and cited this bug as its justification — and would not have caught it.
  // The regression this pins is not "prose is unchecked", it is "the check was scoped by a
  // justification that was false about its own example".
  const dir = copyPackage();
  try {
    const readme = join(dir, "README.md");
    writeFileSync(
      readme,
      `${readFileSync(readme, "utf8")}\n\n**The operator controls are mount-wide.** \`enqueue\` and \`getStatus\` take a datasource, but\n`,
    );
    const failures = checkReadmeSamples(dir);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /names "getStatus" bare/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not fire when the component-side call is qualified as one", () => {
  // The failure tells the author to write `components.<mount>.lib.getStatus`. If that form also
  // failed, the gate would be demanding something it rejects and there would be no way to pass it.
  const dir = copyPackage();
  try {
    const readme = join(dir, "README.md");
    writeFileSync(
      readme,
      `${readFileSync(readme, "utf8")}\n\nRead one event with \`components.productEvents.lib.getStatus\` when triaging.\n`,
    );
    assert.deepEqual(checkReadmeSamples(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not fire on bare field names, which is why the oracle is derived not listed", () => {
  // The reason check 3 does not use an allowlist: 47 of this guide's 58 identifier-shaped spans
  // are fields, states and error codes. They never enter the set because they are not exported
  // component functions — no list to maintain, and no failure on correct documentation.
  const dir = copyPackage();
  try {
    const readme = join(dir, "README.md");
    writeFileSync(
      readme,
      `${readFileSync(readme, "utf8")}\n\nThe \`payload\` and \`delivered\` fields are recorded per event.\n`,
    );
    assert.deepEqual(checkReadmeSamples(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("still catches a client-qualified call that names nothing at all", () => {
  // Bare-name coverage does not subsume this: `frobnicate` is on neither the client nor the
  // component, so it is not in the derived set and only the qualified check sees it.
  const dir = copyPackage();
  try {
    const readme = join(dir, "README.md");
    writeFileSync(
      readme,
      `${readFileSync(readme, "utf8")}\n\nOperators call \`tinybird.frobnicate(ctx)\` to triage.\n`,
    );
    const failures = checkReadmeSamples(dir);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /prose attributes "frobnicate\("/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the parsed client surface is exactly the 12 async methods", () => {
  // `clientMethods` slices from the class declaration to EOF, which is only correct while the
  // class is last in the file. A widened surface fails OPEN — check 1 stops rejecting names it
  // should reject — and that is invisible from the outside, because the gate still passes. This
  // pins the set so appending a second class below it fails here rather than nowhere.
  const dir = copyPackage();
  try {
    const src = readFileSync(join(dir, "src", "client", "index.ts"), "utf8");
    const body = src.slice(src.indexOf("export class TinybirdDelivery"));
    const parsed = [...body.matchAll(/^ {2}async (\w+)\(/gmu)].map((m) => m[1]).sort();
    assert.deepEqual(parsed, [
      "cleanup",
      "enqueue",
      "health",
      "heartbeat",
      "mintReadToken",
      "pause",
      "reclaimOrphanedPayloads",
      "replayEvent",
      "replayFailed",
      "requeueStuck",
      "resume",
      "status",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects nonexistent host function references and mount names", () => {
  for (const reference of [
    "internal.missing.maintain",
    "internal.maintenance.missing",
    "internal.orders.place",
    "components.missingMount",
  ]) {
    const dir = copyPackage();
    try {
      const readme = join(dir, "README.md");
      writeFileSync(readme, `${readFileSync(readme, "utf8")}\n\`\`\`ts\n${reference};\n\`\`\`\n`);
      assert.ok(
        checkReadmeSamples(dir).some((failure) => failure.includes(reference)),
        reference,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("rejects a host reference missing from the generated API", () => {
  const dir = copyPackage();
  try {
    const api = join(dir, "example/convex/_generated/api.d.ts");
    const original = readFileSync(api, "utf8");
    const changed = original.replace(/^\s*maintenance: typeof maintenance;\n/mu, "");
    assert.notEqual(changed, original);
    writeFileSync(api, changed);
    assert.ok(
      checkReadmeSamples(dir).some((failure) => failure.includes("internal.maintenance.maintain")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a source-linked excerpt whose arguments drift", () => {
  const dir = copyPackage();
  try {
    const readme = join(dir, "README.md");
    const original = readFileSync(readme, "utf8");
    const changed = original.replace('"tinybird maintenance"', '"changed schedule"');
    assert.notEqual(changed, original);
    writeFileSync(readme, changed);
    assert.ok(
      checkReadmeSamples(dir).some((failure) =>
        failure.includes("excerpt does not match example/convex/crons.ts"),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
