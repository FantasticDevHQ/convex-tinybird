import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { checkBoundary, scanRootsFor } from "./check-boundary.mjs";

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

test("reading ctx.auth is rejected even though it imports nothing forbidden", () => {
  // Trips BOTH patterns: it names `ctx.auth` and calls `getUserIdentity`. Asserting two
  // failures rather than one is the point — if either pattern regressed this would say so.
  const failures = checkBoundary(fixture("host-auth"));
  assert.equal(failures.length, 2);
  assert.ok(failures.every((failure) => failure.includes("src/a.ts")));
  assert.ok(failures.some((failure) => failure.includes("getUserIdentity")));
  assert.ok(failures.some((failure) => failure.includes("ctx")));
});

test("getUserIdentity is rejected when reached without naming ctx.auth", () => {
  // The bypass that beat the first version of this gate: `handler: async ({ auth }) => …`
  // is idiomatic Convex and contains no `ctx.auth` for a spelling-based pattern to find.
  // This fixture is the positive control for the getUserIdentity pattern ALONE — it must
  // trip exactly one, or the two patterns are not independently pinned.
  const failures = checkBoundary(fixture("host-identity"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /getUserIdentity/);
});

test("handing ctx.auth to something else is rejected on its own", () => {
  // The positive control for the ctx.auth pattern ALONE: it never calls getUserIdentity,
  // so only the second pattern can catch it.
  const failures = checkBoundary(fixture("host-auth-only"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /hands the caller's identity around/);
});
test("ctx.auth named in a comment does not trip the gate", () => {
  // src/b.ts mentions it in prose only. Without comment stripping the gate would be
  // unusable: this very package documents the rule in the files it guards.
  const failures = checkBoundary(fixture("host-auth"));
  assert.equal(failures.filter((failure) => failure.includes("src/b.ts")).length, 0);
});

test("a URL in a string does not blind the gate for the rest of the line", () => {
  // The bypass a naive comment stripper leaves: `"https://…"` contains `//`, so stripping
  // comments by regex first erases everything after it. `destination.ts` opens with exactly
  // such a line, so this is one careless line-join away from real.
  const failures = checkBoundary(fixture("host-url-string"));
  assert.ok(failures.length > 0);
  assert.ok(failures.some((failure) => failure.includes("getUserIdentity")));
});

test("naming the construct inside a string literal is allowed", () => {
  // The other direction, and the one that matters more: a gate with false positives gets
  // switched off. Telling a host "call ctx.auth in your own function" is legitimate text.
  assert.deepEqual(checkBoundary(fixture("host-string-only")), []);
});

test("a file the scanner cannot read is reported, not guessed at", () => {
  // A regex literal containing a quote opens a string that never closes, and from there the
  // scanner reads code as string and string as code. That breaks the gate in BOTH
  // directions, so the answer is to refuse rather than to guess. Lexing regex literals
  // correctly needs previous-token context and is its own corner-case farm.
  const failures = checkBoundary(fixture("host-regex-quote"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /unterminated/);
  assert.match(failures[0], /src\/a\.ts/);
});

test("substitution braces are counted, not matched to the first close", () => {
  // Two claims in one fixture. It must not report a phantom unterminated string on ordinary
  // nested templates — this package's own canonical.ts nests them — and it must still see
  // code that sits after an object literal INSIDE a substitution. A scanner that popped at
  // the first `}` would treat that code as template text and miss the identity read.
  const failures = checkBoundary(fixture("nested-templates"));
  assert.ok(!failures.some((failure) => failure.includes("unterminated")));
  // `ctx.auth` is written ONLY inside that substitution, after the object literal, so it is
  // the half of this that a first-close scanner loses. `getUserIdentity` also appears in the
  // parameter's type annotation, which is plain code either way, so it proves nothing here.
  assert.ok(failures.some((failure) => failure.includes("ctx")));
  assert.equal(failures.length, 2);
});

test("a pair of stray quotes cannot cancel and hide the code between them", () => {
  // A quoted string cannot span a line, so the scanner ends one at a newline. Without that
  // rule two stray quotes -- one per regex literal -- pair up across the lines between them
  // and the identity read in the gap is swallowed with NO report at all, which is the one
  // outcome worse than a false positive. A single stray quote is caught either way, because
  // it runs to end of file; only a pair is silent, so a pair is what this fixture holds.
  const failures = checkBoundary(fixture("host-cancelling-quotes"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /unterminated/);
});

test("the real package passes its own boundary", () => {
  assert.deepEqual(checkBoundary(packageRoot), []);
});

test("the example app is among the trees actually scanned", () => {
  // Without this, renaming or deleting `example/convex` makes the gate skip it and pass in
  // silence — a missing root is legitimately not a violation, because the fixtures are component
  // trees with no example. That exemption is load-bearing for the fixtures and a blind spot for
  // the real package, and nothing distinguished the two. This is the line that does.
  const roots = scanRootsFor(join(here, ".."));
  const example = roots.find((root) => root.label === "example/convex");
  assert.ok(example, "example/convex must be a declared scan root");
  assert.ok(existsSync(example.dir), `example root must exist on disk: ${example.dir}`);
});

test("component-only rules do not apply to the example, which is a host app", () => {
  // `.paginate()` and `ctx.auth` are forbidden INSIDE the component and entirely legal in the
  // app that mounts it. Applying them to the example made the gate reject a paginated dashboard
  // query with the message "paginate() is only supported in the app" — fired on the app.
  const roots = scanRootsFor(join(here, ".."));
  const src = roots.find((root) => root.label === "src");
  const example = roots.find((root) => root.label === "example/convex");
  assert.ok(src.sourcePatterns.length > 0, "the component must still be subject to them");
  assert.deepEqual(example.sourcePatterns, [], "the host app must not be");
});
