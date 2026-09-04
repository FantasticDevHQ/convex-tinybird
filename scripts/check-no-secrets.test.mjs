import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkNoSecrets, TOKEN_ALLOWED_FILES } from "./check-no-secrets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, "fixtures", name);

test("the real package is clean", () => {
  assert.deepEqual(checkNoSecrets(join(here, "..")), []);
});

test("console logging is rejected, naming the file and line", () => {
  const failures = checkNoSecrets(fixture("logs-to-console"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /src\/component\/a\.ts:2/);
  assert.match(failures[0], /console/);
});

test("reading the token outside the files that may is rejected", () => {
  const failures = checkNoSecrets(fixture("reads-token"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /src\/component\/health\.ts/);
  assert.match(failures[0], /append token/);
});

test("aliasing console is rejected, since it prints just the same", () => {
  const failures = checkNoSecrets(fixture("aliases-console"));
  assert.ok(failures.length >= 1);
  assert.match(failures.join("\n"), /console/);
});

test("serializing the component env is rejected even though it names no secret", () => {
  const failures = checkNoSecrets(fixture("enumerates-env"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /enumerated, spread or serialized/);
});

test("the allowlist stays two files, so it cannot quietly widen again", () => {
  // The gate is only as good as this list. It began by exempting the largest source file
  // wholesale, which let any credential read inside it pass; asserting the contents is what
  // stops that being reintroduced without someone deciding to.
  assert.deepEqual([...TOKEN_ALLOWED_FILES].sort(), [
    "component/convex.config.ts",
    "component/credentials.ts",
  ]);
});

test("a committed credential file is rejected wherever it sits", () => {
  // The `.tinyb` this fixture holds is the shape that actually got in: Tinybird CLI state,
  // outside `src`, in a directory the gate never scanned. It carries an admin token and every
  // `tb deploy` rewrites it.
  const failures = checkNoSecrets(fixture("commits-credential"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /\.tinyb/u);
  assert.match(failures[0], /must not be committed/u);
});

test("an ignored, untracked credential file is NOT rejected", () => {
  // The rule is about COMMITTING a credential, not about having one. The example's README tells
  // a developer to create `.env.local`, and it is gitignored — a working-tree walk failed the
  // gate for following the instructions. Scanning the index is what makes the gate ask the
  // question it means to ask, and this is the leg that pins that: it fails if anyone
  // "simplifies" the scan back to a directory walk.
  const dir = fixture("commits-credential");
  const stray = join(dir, ".env.local");
  writeFileSync(stray, "TOKEN=local-only\n");
  try {
    const failures = checkNoSecrets(dir);
    assert.equal(
      failures.filter((line) => line.includes(".env.local")).length,
      0,
      "an untracked, ignored env file must not fail the gate",
    );
  } finally {
    rmSync(stray, { force: true });
  }
});
