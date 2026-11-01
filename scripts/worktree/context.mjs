import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requested = await fs.realpath(process.cwd());
let root = requested;
while (
  !existsSync(path.join(root, "scripts/worktree.config.json")) &&
  path.dirname(root) !== root
)
  root = path.dirname(root);
if (!existsSync(path.join(root, "scripts/worktree.config.json")))
  root = requested;
const layout = await fs
  .readFile(path.join(root, "scripts/worktree.config.json"), "utf8")
  .then(JSON.parse)
  .catch((e) => {
    if (e.code === "ENOENT") return {};
    throw e;
  });
const backend = path.join(root, layout.backend || ".");
const frontend = path.join(root, layout.frontend || ".");
const frontendEnv = path.join(frontend, ".env.local");
const script = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const dir = path.join(root, ".worktree");
const stateFile = path.join(dir, "local.json");
const configFile = path.join(backend, ".convex/local/default/config.json");
const registry =
  process.env.WORKTREE_REGISTRY_DIR ||
  path.join(homedir(), ".local/state/convex-worktrees");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
};

export {
  root,
  backend,
  frontend,
  frontendEnv,
  script,
  dir,
  stateFile,
  configFile,
  registry,
  sleep,
  read,
  layout,
};
