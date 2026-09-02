import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkNoSecrets } from "./check-no-secrets.mjs";

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
