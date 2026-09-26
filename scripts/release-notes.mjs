#!/usr/bin/env node
// Prints the CHANGELOG.md section for one version, or exits 1 when it has none.
//
// The release workflow uses it twice: as a guard (a tag can only publish a version the changelog
// describes) and to write the notes of a GitHub release created from a manual tag. Two heading
// shapes are accepted: Release Please's `## [0.2.1](compare-url) (date)` and the hand-written
// `## 0.2.0 — date` used before Release Please managed the file.
//
// Usage: node scripts/release-notes.mjs <version> [changelog path]

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseNotes(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^## (\\[${escaped}\\]|${escaped}(\\s|$))`);
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, path = "CHANGELOG.md"] = process.argv.slice(2);
  if (!version) {
    console.error("usage: release-notes.mjs <version> [changelog path]");
    process.exit(2);
  }
  const notes = releaseNotes(readFileSync(path, "utf8"), version);
  if (notes === null) {
    console.error(`${path} has no '## ${version}' or '## [${version}](…)' section`);
    process.exit(1);
  }
  console.log(notes);
}
