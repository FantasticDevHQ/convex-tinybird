import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { releaseNotes } from "./release-notes.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// The shape Release Please prepends above the hand-written history.
const changelog = `# Changelog

## [0.2.1](https://github.com/FantasticDevHQ/convex-tinybird/compare/v0.2.0...v0.2.1) (2026-09-27)


### Bug Fixes

* retry a dropped batch ([#9](https://github.com/FantasticDevHQ/convex-tinybird/issues/9))

## 0.2.0 — 2026-09-26

- Renamed and published to npmjs.com.

## 0.1.0 — 2026-09-11

- First release.
`;

test("reads a Release Please section up to the next heading", () => {
  assert.equal(
    releaseNotes(changelog, "0.2.1"),
    "### Bug Fixes\n\n* retry a dropped batch ([#9](https://github.com/FantasticDevHQ/convex-tinybird/issues/9))",
  );
});

test("reads a hand-written section", () => {
  assert.equal(releaseNotes(changelog, "0.2.0"), "- Renamed and published to npmjs.com.");
  assert.equal(releaseNotes(changelog, "0.1.0"), "- First release.");
});

test("refuses a version the changelog does not describe", () => {
  assert.equal(releaseNotes(changelog, "0.3.0"), null);
});

test("does not match a version that merely shares a prefix or differs only at a dot", () => {
  assert.equal(releaseNotes(changelog, "0.2"), null);
  assert.equal(releaseNotes(changelog, "0.2.10"), null);
  assert.equal(releaseNotes("## 0x2y0 — 2026-09-26\n\n- no", "0.2.0"), null);
});

test("the current package version has a changelog section", () => {
  const { version } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const notes = releaseNotes(readFileSync(join(packageRoot, "CHANGELOG.md"), "utf8"), version);
  assert.ok(notes, `CHANGELOG.md has no section for ${version}`);
});
