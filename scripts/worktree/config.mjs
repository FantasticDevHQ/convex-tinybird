import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { root, backend, dir, stateFile, configFile, read, layout } from "./context.mjs";
import { safe, json } from "./files.mjs";
import { packageBin } from "./dependencies.mjs";

export async function state() {
  await safe(stateFile);
  const s = await read(stateFile, null);
  if (!s || s.root !== root || s.version !== 1 || !s.id)
    throw new Error("Run worktree:setup in this checkout first.");
  if ((layout.convex === false) !== (s.mode === "none") ||
      (s.mode === "none" && (s.ports !== undefined || s.deployment !== undefined)))
    throw new Error("Worktree mode changed. Restore its original configuration and explicitly cleanup before changing modes.");
  return s;
}

export async function checkConfig(s, required = false) {
  await safe(configFile);
  const config = await read(configFile, null);
  if (!config && !required) return;
  if (
    config &&
    !s.deployment &&
    config.deploymentName === `anonymous-${path.basename(backend)}` &&
    config.ports?.cloud === s.ports.cloud &&
    config.ports?.site === s.ports.site
  ) {
    // A first push may fail after creating config. Recover only the exact
    // name and ports our checked bootstrap would have created in this checkout.
    s.deployment = config.deploymentName;
    await json(stateFile, s);
  }
  if (
    !config ||
    !s.deployment ||
    config.deploymentName !== s.deployment ||
    config.ports?.cloud !== s.ports.cloud ||
    config.ports?.site !== s.ports.site
  ) {
    throw new Error(
      "Refusing foreign or changed local backend state; expected this worktree deployment and ports.",
    );
  }
}

export function childEnv(s, bootstrap = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CONVEX_") || key.startsWith("NEXT_PUBLIC_CONVEX_") || key.startsWith("VITE_CONVEX_"))
      delete env[key];
  }
  return {
    ...env,
    CONVEX_AGENT_MODE: bootstrap ? "" : "anonymous",
    PORT: String(s.ports.web),
    DEMO_PORT: String(s.ports.web),
    VITE_CONVEX_URL: `http://127.0.0.1:${s.ports.cloud}`,
    HOME: path.join(dir, "home"),
    XDG_CACHE_HOME: path.join(dir, "cache"),
  };
}

export function cli() {
  return packageBin("convex", "convex", [backend, root]);
}

export function convexArgs(s, extra = []) {
  return [
    cli(),
    "dev",
    "--env-file",
    path.join(dir, "convex.env"),
    "--local-cloud-port",
    String(s.ports.cloud),
    "--local-site-port",
    String(s.ports.site),
    ...extra,
  ];
}

export async function assertBootstrapIsolation(
  projectRoot,
  userHome = homedir(),
) {
  const name = `anonymous-${path.basename(projectRoot)}`;
  const legacy = path.join(
    userHome,
    ".convex/anonymous-convex-backend-state",
    name,
  );
  if (existsSync(legacy))
    throw new Error(
      "Matching legacy Convex state exists. Use a different worktree directory name; legacy data was not touched.",
    );
}
