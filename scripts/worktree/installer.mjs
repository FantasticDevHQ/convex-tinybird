import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function rejectSymlinks(root, relative) {
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
  }
}

export function installToolkit(sourceDirectory, targetDirectory) {
  const source = fs.realpathSync(sourceDirectory);
  const target = fs.realpathSync(targetDirectory);
  if (!fs.statSync(target).isDirectory())
    throw new Error("Target must be an existing directory.");
  rejectSymlinks(source, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
  if (!manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files))
    throw new Error("Invalid manifest files.");
  const pending = [];
  for (const [name, item] of Object.entries(manifest.files)) {
    const relative = item?.path;
    if (typeof relative !== "string" || relative.includes("\\") ||
        relative.split("/")[0] !== "scripts" ||
        relative.split("/").some((part) => !part || part === "." || part === ".."))
      throw new Error(`Invalid destination path: ${relative}`);
    const sourcePath = item.source ?? relative;
    if (typeof sourcePath !== "string" || sourcePath.includes("\\") ||
        sourcePath.split("/")[0] !== "scripts" ||
        sourcePath.split("/").some((part) => !part || part === "." || part === ".."))
      throw new Error(`Invalid source path: ${sourcePath}`);
    rejectSymlinks(source, sourcePath);
    const data = fs.readFileSync(path.join(source, sourcePath));
    const checksum = createHash("sha256").update(data).digest("hex");
    if (checksum !== item.sha256) throw new Error(`Checksum mismatch: ${name}`);
    rejectSymlinks(target, relative);
    const destination = path.join(target, relative);
    if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite: ${destination}`);
    pending.push({ destination, data });
  }
  // Validate all hashes and collisions before creating anything in the target.
  for (const { destination, data } of pending) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data, { flag: "wx" });
  }
  return pending.length;
}
