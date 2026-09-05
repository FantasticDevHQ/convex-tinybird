/** Validate generated host references and source-linked excerpts in the consumer guide. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function unindent(source) {
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export function checkExampleReferences(root, readme, blocks) {
  const failures = [];
  const example = join(root, "example/convex");
  const generated = readFileSync(join(example, "_generated/api.d.ts"), "utf8");
  const config = readFileSync(join(example, "convex.config.ts"), "utf8");
  const generatedModules = new Set(
    [...generated.matchAll(/^\s*"?([\w/.-]+)"?:\s*typeof/gmu)].map((match) => match[1]),
  );
  const mounts = new Set([...config.matchAll(/name:\s*"(\w+)"/gu)].map((match) => match[1]));
  for (const block of blocks) {
    for (const match of block.matchAll(/\b(internal|api)\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)/gu)) {
      const reference = match[0];
      const parts = match[2].split(".");
      const name = parts.pop();
      const module = parts.join("/");
      const sourcePath = join(example, `${module}.ts`);
      if (!existsSync(sourcePath) || !generatedModules.has(module)) {
        failures.push(
          `README.md references ${reference}, but its module is absent from the example or generated API.`,
        );
        continue;
      }
      const source = readFileSync(sourcePath, "utf8");
      const exported = new RegExp(
        `export const ${name} = (internalMutation|internalQuery|internalAction|mutation|query|action)\\(`,
        "u",
      ).exec(source);
      if (!exported || exported[1].startsWith("internal") !== (match[1] === "internal")) {
        failures.push(
          `README.md references ${reference}, but that function is not exported with the matching visibility.`,
        );
      }
    }
    for (const match of block.matchAll(/\bcomponents\.(\w+)/gu)) {
      if (!mounts.has(match[1]) || !new RegExp(`\\b${match[1]}:`, "u").test(generated)) {
        failures.push(
          `README.md references ${match[0]}, but that mount is absent from the example or generated API.`,
        );
      }
    }
  }
  for (const match of readme.matchAll(
    /<!-- example: (example\/convex\/[\w/.-]+\.ts) -->\s*```(?:ts|typescript|js|javascript|tsx|jsx)\n([\s\S]*?)```/gu,
  )) {
    const [path, excerpt] = [match[1], match[2].trim()];
    if (
      path.split("/").includes("..") ||
      !existsSync(join(root, path)) ||
      !unindent(readFileSync(join(root, path), "utf8")).includes(unindent(excerpt))
    ) {
      failures.push(`README.md excerpt does not match ${path}; copy the current tested example.`);
    }
  }
  return failures;
}
