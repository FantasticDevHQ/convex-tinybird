#!/usr/bin/env node
// Compatibility entry point for existing editor integrations.
import path from "node:path";
import { fileURLToPath } from "node:url";
export { assertBootstrapIsolation } from "./worktree/config.mjs";
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url))
  await import("./worktree/cli.mjs");
