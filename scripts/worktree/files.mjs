import fs from "node:fs/promises";

import path from "node:path";

import { randomUUID } from "node:crypto";

import { root } from "./context.mjs";

export async function safe(file) {
  // Refuse links in every existing component before writes or recursive cleanup.
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error(`Refusing symlink: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export async function json(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporary, file);
}

export async function upsert(file, values, remove = []) {
  await safe(file);
  let content = await fs.readFile(file, "utf8").catch((e) => {
    if (e.code === "ENOENT") return "";
    throw e;
  });
  const keys = new Set([...Object.keys(values), ...remove]);
  content = content
    .split("\n")
    .filter(
      (line) =>
        !keys.has(line.match(/^\s*(?:export\s+)?([A-Z_0-9]+)\s*=/)?.[1]),
    )
    .join("\n")
    .trimEnd();
  await fs.writeFile(
    file,
    `${content}${content ? "\n" : ""}${Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  await fs.chmod(file, 0o600);
}
