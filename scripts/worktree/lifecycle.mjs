import fs from "node:fs/promises";
import { existsSync } from "node:fs";

import path from "node:path";

import { randomUUID, randomBytes } from "node:crypto";

import {
  root,
  backend,
  frontendEnv,
  dir,
  stateFile,
  configFile,
  read,
  layout,
} from "./context.mjs";
import { safe, json, upsert } from "./files.mjs";
import { locked, projectLock, available } from "./registry.mjs";
import {
  state,
  checkConfig,
  cli,
  convexArgs,
  assertBootstrapIsolation,
} from "./config.mjs";
import { run, ownedRunning, stopOnly } from "./processes.mjs";
import { refreshCheckout } from "./freshness.mjs";

export async function setup(prepareOnly) {
  await refreshCheckout(root);
  if (layout.convex === false) {
    await safe(dir);
    await safe(stateFile);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (existsSync(stateFile)) await state();
    else await json(stateFile, { version: 1, root, id: randomUUID(), mode: "none" });
    console.log("Worktree ready; no backend or frontend services configured.");
    return;
  }
  if (!existsSync(path.join(backend, "convex.json")))
    throw new Error("Run from the Convex project directory.");
  await safe(dir);
  await safe(configFile);
  await safe(frontendEnv);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(dir, "home"), { recursive: true, mode: 0o700 });
  let s = await read(stateFile, null);
  if (!s && existsSync(configFile))
    throw new Error(
      "Refusing unmanaged local backend state. Use a fresh checkout.",
    );
  if (s) {
    s = await state();
    await checkConfig(s);
  }
  // Serialize both per-checkout preparation and cross-repository allocations.
  s = await locked(async (leases) => {
    const existing = await read(stateFile, null);
    if (existing) s = existing;
    if (await ownedRunning(s))
      throw new Error("Backend already running. Stop it before setup.");
    if (s) {
      for (const port of Object.values(s.ports)) {
        const other = Object.entries(leases).find(
          ([p, v]) => p !== root && Object.values(v.ports).includes(port),
        );
        if (other || !(await available(port)))
          throw new Error(
            `Reserved port ${port} is busy; stop its owner or explicitly cleanup/reconfigure.`,
          );
      }
    } else {
      const used = new Set(
        Object.values(leases).flatMap((v) => Object.values(v.ports)),
      );
      const ports = [];
      for (let port = 18000; port < 48000 && ports.length < 3; port++) {
        if (!used.has(port) && (await available(port))) ports.push(port);
      }
      if (ports.length !== 3) throw new Error("No free worktree ports.");
      s = {
        version: 1,
        root,
        id: randomUUID(),
        ports: { web: ports[0], cloud: ports[1], site: ports[2] },
        deployment: null,
      };
      await json(stateFile, s);
    }
    leases[root] = { id: s.id, ports: s.ports };
    const cloud = `http://127.0.0.1:${s.ports.cloud}`,
      site = `http://127.0.0.1:${s.ports.site}`;
    const selection = `anonymous:${s.deployment || `anonymous-${path.basename(backend)}`}`;
    await upsert(path.join(dir, "convex.env"), {
      CONVEX_DEPLOYMENT: selection,
    });
    await upsert(
      frontendEnv,
      {
        CONVEX_DEPLOYMENT: selection,
        VITE_CONVEX_URL: cloud,
        NEXT_PUBLIC_CONVEX_URL: cloud,
        NEXT_PUBLIC_CONVEX_SITE_URL: site,
        NEXT_PUBLIC_SITE_URL: `http://localhost:${s.ports.web}`,
        PORT: s.ports.web,
      },
      [
        "CONVEX_DEPLOY_KEY",
        "CONVEX_DEPLOYMENT_TOKEN",
        "CONVEX_SELF_HOSTED_URL",
        "CONVEX_SELF_HOSTED_ADMIN_KEY",
        "CONVEX_AGENT_MODE",
        "CONVEX_URL",
        "CONVEX_SITE_URL",
      ],
    );
    await upsert(
      path.join(backend, ".env.local"),
      { CONVEX_DEPLOYMENT: selection },
      [
        "CONVEX_DEPLOY_KEY",
        "CONVEX_DEPLOYMENT_TOKEN",
        "CONVEX_SELF_HOSTED_URL",
        "CONVEX_SELF_HOSTED_ADMIN_KEY",
      ],
    );
    const backendEnv = path.join(dir, "backend.env");
    await safe(backendEnv);
    if (!existsSync(backendEnv)) {
      const config = await read(
        path.join(root, "scripts/worktree.config.json"),
        {},
      );
      const values = { ...config.env };
      for (const key of config.secretEnv || [])
        values[key] = randomBytes(32).toString("hex");
      for (const key of config.siteUrlEnv || [])
        values[key] = `http://localhost:${s.ports.web}`;
      await upsert(backendEnv, values);
    }
    return s;
  });
  if (!prepareOnly)
    await projectLock(async () => {
      // First run uses the documented non-TTY anonymous flow, which generates a unique
      // name rather than the agent-mode constant that can select legacy HOME state.
      if (!s.deployment) {
        await assertBootstrapIsolation(backend);
        await run(convexArgs(s, ["--once"]), s, {
          bootstrap: true,
        });
        const config = await read(configFile, null);
        if (
          !config?.deploymentName?.startsWith("anonymous-") ||
          config.ports?.cloud !== s.ports.cloud ||
          config.ports?.site !== s.ports.site
        ) {
          throw new Error(
            "Bootstrap did not create an isolated anonymous backend at the requested ports.",
          );
        }
        s.deployment = config.deploymentName;
        await json(stateFile, s);
        await upsert(path.join(dir, "convex.env"), {
          CONVEX_DEPLOYMENT: `anonymous:${s.deployment}`,
        });
        await upsert(frontendEnv, {
          CONVEX_DEPLOYMENT: `anonymous:${s.deployment}`,
        });
      }
      await checkConfig(s, true);
      await run(
        [
          cli(),
          "env",
          "set",
          "--env-file",
          path.join(dir, "convex.env"),
          "--from-file",
          path.join(dir, "backend.env"),
        ],
        s,
      );
      await run(convexArgs(s, ["--once"]), s);
      await checkConfig(s, true);
    }, "shared-convex-cache");
  console.log(
    `Worktree ${prepareOnly ? "prepared" : "ready"}: web=${s.ports.web} convex=${s.ports.cloud} site=${s.ports.site}`,
  );
}

export async function teardown(cleanup = false) {
  if (!existsSync(stateFile)) {
    console.log("No managed worktree state.");
    return;
  }
  const s = await state();
  if (cleanup && !process.argv.includes("--yes"))
    throw new Error(
      s.mode === "none"
        ? "Cleanup deletes managed worktree state. Pass --yes explicitly."
        : "Cleanup deletes this worktree database. Pass --yes explicitly.",
    );
  if (s.mode === "none") {
    if (cleanup) {
      await safe(dir);
      await fs.rm(stateFile);
      // Only remove our own identity file. A user may keep unrelated files in
      // .worktree; an empty directory can be removed without recursive deletion.
      try { await fs.rmdir(dir); }
      catch (error) { if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error; }
    }
    console.log(cleanup ? "Managed worktree state cleaned." : "No managed services; worktree state preserved.");
    return;
  }
  if (cleanup) await checkConfig(s);
  await stopOnly(s);
  await locked(async (leases) => {
    if (leases[root]?.id === s.id) delete leases[root];
    if (cleanup) {
      await safe(path.join(backend, ".convex/local/default"));
      await fs.rm(path.join(backend, ".convex/local/default"), {
        recursive: true,
        force: true,
      });
      await upsert(frontendEnv, {}, [
        "CONVEX_DEPLOYMENT",
        "CONVEX_URL",
        "CONVEX_SITE_URL",
        "NEXT_PUBLIC_CONVEX_URL",
        "NEXT_PUBLIC_CONVEX_SITE_URL",
        "NEXT_PUBLIC_SITE_URL",
        "PORT",
      ]);
      await upsert(path.join(backend, ".env.local"), {}, ["CONVEX_DEPLOYMENT"]);
      await safe(dir);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  console.log(
    cleanup
      ? "Local database and managed config cleaned."
      : "Stopped; reservations released; database preserved.",
  );
}

export async function prune() {
  let count = 0;
  await locked(async (leases) => {
    for (const [checkout, lease] of Object.entries(leases)) {
      if (existsSync(path.join(checkout, ".worktree/local.json"))) continue;
      let free = true;
      for (const port of Object.values(lease.ports))
        if (!(await available(port))) free = false;
      if (free) {
        delete leases[checkout];
        count++;
      }
    }
  });
  console.log(`Released ${count} removed-checkout reservation(s).`);
}
