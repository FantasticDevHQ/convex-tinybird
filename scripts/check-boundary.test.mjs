import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { checkBoundary } from "./check-boundary.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, "fixtures", name);
const packageRoot = join(here, "..");

test("a clean package passes", () => {
  assert.deepEqual(checkBoundary(fixture("clean")), []);
});

test("an @fantastic-dev import is rejected with its file and specifier", () => {
  const failures = checkBoundary(fixture("forbidden-import"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /src\/a\.ts/);
  assert.match(failures[0], /@fantastic-dev\/shared/);
});

test("a relative import that escapes the package is rejected", () => {
  const failures = checkBoundary(fixture("escaping-import"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /\.\.\/\.\.\/backend\/convex\/runs\/model/);
});

test("a runtime dependency outside the allowlist is rejected", () => {
  const failures = checkBoundary(fixture("bad-dependency"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /better-auth/);
});

test("the real package passes its own boundary", () => {
  assert.deepEqual(checkBoundary(packageRoot), []);
});
