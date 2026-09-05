import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkPackedFiles } from "./check-pack.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tinybird-pack-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    "package.json": JSON.stringify({
      name: "@fantastic-dev/convex-tinybird",
      version: "0.0.0",
      files: ["src", "dist", "CHANGELOG.md"],
    }),
    "README.md": "guide",
    LICENSE: "license",
    "CHANGELOG.md": "Unreleased",
    "src/client/index.ts": "export const value = 1;",
    "dist/client/index.js": "export const value = 1;",
    "dist/client/index.d.ts": "export declare const value: number;",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, paths: Object.keys(files) };
}
test("accepts exactly the intended source and build files", (t) => {
  const { root, paths } = fixture(t);
  assert.deepEqual(checkPackedFiles(root, paths), []);
});
test("rejects stray packed files", (t) => {
  const { root, paths } = fixture(t);
  writeFileSync(join(root, "stray.txt"), "stray");
  assert.match(checkPackedFiles(root, [...paths, "stray.txt"]).join("\n"), /Unexpected.*stray/);
});
test("rejects missing declarations", (t) => {
  const { root, paths } = fixture(t);
  assert.match(
    checkPackedFiles(
      root,
      paths.filter((p) => !p.endsWith(".d.ts")),
    ).join("\n"),
    /Missing.*index.d.ts/,
  );
});
test("rejects tests and environment files even inside allowed roots", (t) => {
  const { root, paths } = fixture(t);
  for (const path of ["src/client/index.test.ts", "src/.env.local"]) {
    writeFileSync(join(root, path), "unsafe");
    assert.match(checkPackedFiles(root, [...paths, path]).join("\n"), /Unexpected/);
  }
});
test("rejects host references but permits the exact package name", (t) => {
  const { root, paths } = fixture(t);
  writeFileSync(
    join(root, "README.md"),
    "@fantastic-dev/convex-tinybird @fantastic-dev/convex-tinybird/test",
  );
  assert.deepEqual(checkPackedFiles(root, paths), []);
  writeFileSync(join(root, "README.md"), "@fantastic-dev/backend");
  assert.match(checkPackedFiles(root, paths).join("\n"), /Host reference/);
  writeFileSync(join(root, "README.md"), "@fantastic-dev/convex-tinybird-extra");
  assert.match(checkPackedFiles(root, paths).join("\n"), /Host reference/);
});

test("checks npm's real dry-run list and rejects a leaked dist file", (t) => {
  const { root } = fixture(t);
  const packed = () =>
    JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30000,
      }),
    )[0].files.map((file) => file.path);
  assert.deepEqual(checkPackedFiles(root, packed()), []);
  writeFileSync(join(root, "dist", "stray.txt"), "must not ship");
  assert.match(
    checkPackedFiles(root, packed()).join("\n"),
    /Unexpected packed file: dist\/stray.txt/,
  );
});
