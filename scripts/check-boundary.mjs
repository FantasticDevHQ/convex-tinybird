#!/usr/bin/env node
/**
 * check-boundary.mjs — keep the Tinybird component project-agnostic.
 *
 *   node packages/convex-tinybird/scripts/check-boundary.mjs [packageRoot]
 *
 * The component must be reusable in any Convex app, so nothing under `src/` may reach into the
 * Fantastic.dev monorepo (workspace packages, the backend, its generated types, Better Auth) or
 * escape the package through a relative path, and its runtime dependencies are an explicit
 * allowlist. This is a source-level check with Node built-ins only, so it runs anywhere
 * `check:scripts` runs — including CI with no install step for this package.
 *
 * Deliberately NOT covered: `devDependencies` (test tooling may be anything) and files under
 * `_generated` (machine-written; the generator decides their imports).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Runtime dependencies the component may declare, in `dependencies` or `peerDependencies`. */
export const ALLOWED_RUNTIME_DEPENDENCIES = new Set(["convex", "@convex-dev/workpool"]);

/**
 * Source constructs that reach into the HOST rather than into a package, so no import
 * records them and `FORBIDDEN_SPECIFIER_PATTERNS` cannot see them.
 *
 * Reading the caller's identity is the whole reason this list exists. Authorization is the host's job: the
 * component takes an opaque `actor` string and authenticates nobody, so a component that
 * started reading the caller's identity would be making a policy decision on the host's
 * behalf while looking like ordinary code. It needs no import, so the import gate above
 * lets it straight through, and a grep proving it absent today proves nothing tomorrow.
 *
 * Two patterns, because one spelling is not the capability. An earlier version matched only
 * `ctx.auth` and was got past five ways out of six — destructuring, bracket access, an alias,
 * a parameter destructure (`handler: async ({ auth }) => …`, which is idiomatic Convex rather
 * than contrived), and a helper taking the context. `getUserIdentity` is what closes it, and
 * it closes it completely rather than merely more widely: Convex's `Auth` interface has
 * exactly one member (convex 1.44.0, `src/server/authentication.ts`), so there is no other
 * way to read caller identity from a function context. `ctx.auth` stays as the second
 * pattern because handing the auth object to something else is worth catching too.
 */
export const FORBIDDEN_SOURCE_PATTERNS = [
  {
    // `.paginate()` is only supported in the app, never inside a component: the backend
    // bails with `PaginationUnsupportedInComponents`
    // (crates/isolate/src/environment/udf/async_syscall.rs:1773). This package is a
    // component by construction, so a paginate here is dead code on every call in
    // production.
    //
    // It is checked HERE because nothing else can. convex-test implements paginate in plain
    // JavaScript with no component check, so it certified this call while the real backend
    // refused it — 228 tests green against a surface that was 100% dead. The harness cannot
    // see component-scoped restrictions at all. Page with a manual cursor over
    // `_creationTime` instead; `by_creation_time` is built in on every table.
    pattern: /\.paginate\s*\(/u,
    why: "paginate() is only supported in the app; page with a _creationTime cursor instead",
  },

  {
    pattern: /\bgetUserIdentity\b/u,
    why: "reads the caller's identity; authorization is the host's job",
  },
  {
    pattern: /\bctx\s*\.\s*auth\b/u,
    why: "hands the caller's identity around; authorization is the host's job",
  },
];

/** Import specifiers that mean the component reached into the host or the monorepo. */
export const FORBIDDEN_SPECIFIER_PATTERNS = [
  /^@tinybirdco\/sdk(?:\/|$)/, // Host-only definition/deployment SDK, never component runtime.
  /^@fantastic-dev\//,
  /(^|\/)packages\/backend(\/|$)/,
  /^better-auth(\/|$)/,
  /^@convex-dev\/better-auth(\/|$)/,
  /^@better-auth\//,
];

const IMPORT_PATTERN =
  /(?:^|\n)\s*(?:import|export)\s[^'";]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Everything that is not executable code, blanked out.
 *
 * The source patterns must see code and only code, in BOTH directions. A comment explaining
 * why a construct is banned must not trip the ban — this package documents the rule in the
 * files it guards — and neither must a string literal, so an error message may name
 * `ctx.auth` in its text. A gate that rejects legitimate code gets switched off, which
 * costs more than the hole it was covering.
 *
 * This is a scanner rather than a pair of regular expressions because the naive version has
 * a real bypass: stripping `//` to end of line first blinds every line containing `//`
 * inside a string, and `destination.ts` begins with `"https://api.tinybird.co"`. Any
 * identity read joined onto such a line would have passed clean.
 *
 * Quotes are replaced with empty content rather than deleted so that string boundaries
 * cannot fuse two identifiers into one.
 *
 * A quoted string ends at a newline, because one cannot legally span a line. That rule is
 * load-bearing rather than tidy: a SINGLE stray quote -- from a regex literal, say -- runs to
 * end of file and is reported either way, but a PAIR would otherwise cancel across the lines
 * between them and swallow whatever sits in the gap with no report at all, which is the one
 * outcome worse than a false positive.
 *
 * Known residual: a pair of stray BACKTICKS still cancels. Template literals legitimately
 * span lines, so the same rule cannot apply to them, and two regex literals each containing a
 * backtick, in one file, with an identity read between them, reads clean. A single stray
 * backtick always reports, because it leaves the file's count odd. That shape is deliberate
 * construction rather than a slip, which is the line this gate draws: it detects drift, and
 * it does not pretend to stop an author who is trying.
 */
function codeOnly(text) {
  const stack = [];
  const top = () => (stack.length === 0 ? undefined : stack[stack.length - 1]);
  let out = "";
  let unterminated = null;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    const two = text.slice(i, i + 2);

    // Inside a template literal's TEXT: not code, but `${` returns to code.
    if (top()?.kind === "template") {
      if (c === "\\") {
        i += 2;
      } else if (two === "${") {
        stack.push({ kind: "substitution", depth: 0 });
        i += 2;
      } else if (c === "`") {
        stack.pop();
        i += 1;
      } else {
        i += 1;
      }
      continue;
    }

    if (two === "//") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === "`") {
      stack.push({ kind: "template" });
      out += "``";
      i += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      // Quotes are replaced with empty content rather than deleted, so string boundaries
      // cannot fuse two identifiers into one.
      out += c + c;
      i += 1;
      let closed = false;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        // A quoted string cannot span a line, so a newline means this was never a string.
        if (text[i] === "\n") break;
        if (text[i] === c) {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) unterminated ??= c;
      continue;
    }
    // Braces are tracked only inside a substitution, so an object literal or a block within
    // one does not close it early.
    if (c === "{" && top()?.kind === "substitution") {
      top().depth += 1;
    } else if (c === "}" && top()?.kind === "substitution") {
      if (top().depth === 0) {
        stack.pop();
        i += 1;
        continue;
      }
      top().depth -= 1;
    }
    out += c;
    i += 1;
  }

  if (unterminated === null && stack.length > 0) unterminated = "`";
  return { code: out, unterminated };
}

function sourceFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map((name) => String(name).split(sep).join("/"))
    .filter((name) => /\.(ts|tsx|mts|js|mjs)$/.test(name))
    .filter((name) => !name.split("/").includes("_generated"))
    .filter((name) => !name.split("/").includes("node_modules"));
}

function specifiersIn(text) {
  const found = [];
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier) found.push(specifier);
  }
  return found;
}

function escapesPackage(specifier, fileDir, packageRoot) {
  if (!specifier.startsWith(".")) return false;
  const target = resolve(fileDir, specifier);
  const rel = relative(packageRoot, target);
  return rel.startsWith("..") || rel === "";
}

/**
 * The trees this gate reads, and which rules each one is subject to.
 *
 * Exported so the self-test can assert the example is actually among them. It was not checkable
 * before: renaming `example/convex` made the gate skip it and pass, silently, because a missing
 * root is legitimately not a violation for the fixtures. A gate that cannot say which trees it
 * read cannot be trusted when it says they were clean.
 */
export function scanRootsFor(root) {
  return [
    // The component. Every rule applies here: this is the tree that gets bundled and pushed as
    // a component, where the constructs below are dead code or a boundary break.
    { label: "src", dir: join(root, "src"), sourcePatterns: FORBIDDEN_SOURCE_PATTERNS },

    // The example is a HOST APP, and the source constructs forbidden inside a component are all
    // perfectly legal in the app that mounts one. Applying them here produced an error message
    // that contradicted itself — `paginate() is only supported in the app` fired ON the app —
    // and it forbade writing the paginated dashboard query a consumer example most wants to
    // show. Authorization is the same: a real host DOES call `ctx.auth` to guard its operator
    // wrappers, which is exactly what the component refuses to do for it.
    //
    // So the example is scanned for IMPORTS only. That is the claim it exists to support: the
    // component is portable, and the one app demonstrating it reaches for nothing a consumer
    // outside this monorepo could not. It may import the component — that is the entire point —
    // but nothing else under `@fantastic-dev/`, narrowed to this exact package rather than the
    // scope so an example reaching for `@fantastic-dev/backend` still fails.
    {
      label: "example/convex",
      dir: join(root, "example", "convex"),
      selfImportAllowed: /^@fantastic-dev\/convex-tinybird(\/|$)/,
      sourcePatterns: [],
    },
  ];
}

/**
 * Returns one human-readable failure per violation; an empty array means the package is clean.
 * Pure over the filesystem so the self-test can point it at fixtures.
 */
export function checkBoundary(packageRoot) {
  const root = resolve(packageRoot);
  const failures = [];

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const field of ["dependencies", "peerDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (!ALLOWED_RUNTIME_DEPENDENCIES.has(name)) {
        failures.push(`package.json ${field}: "${name}" is not an allowed runtime dependency`);
      }
    }
  }

  // Both the component AND the example app. The example is the portability proof: it mounts the
  // component in an app with an unrelated schema and may import `convex` and the component and
  // nothing else. Scanning only `src/` would clear a component that is portable in principle
  // while the one app demonstrating it quietly reached for a host package.
  //
  // `_generated` is excluded by `sourceFiles`; the example's generated code is written by
  // Convex and is not ours to constrain.
  const scanRoots = scanRootsFor(root);
  for (const { label, dir, selfImportAllowed, sourcePatterns } of scanRoots) {
    // A root that does not exist is not a violation. The self-test's fixtures are component
    // trees with no example app, and treating their absence as a failure would make every
    // fixture fail for a reason none of them is about.
    if (!existsSync(dir)) continue;
    for (const file of sourceFiles(dir)) {
      const path = join(dir, file);
      const text = readFileSync(path, "utf8");
      const { code, unterminated } = codeOnly(text);
      const browserRoot = join(root, "src", "browser");
      const browserFile = path.startsWith(`${browserRoot}${sep}`);
      if (browserFile) {
        if (
          /\bprocess\b|\bimport\s*\.\s*meta\s*\.\s*env\b|\brequire\s*\(|\bimport\s*\(/u.test(code)
        ) {
          failures.push(
            `${label}/${file}: browser code cannot read environment variables or load modules dynamically`,
          );
        }
        for (const specifier of specifiersIn(text)) {
          if (!specifier.startsWith(".") || escapesPackage(specifier, dirname(path), browserRoot)) {
            failures.push(
              `${label}/${file}: browser import "${specifier}" must stay within src/browser`,
            );
          }
        }
      }
      // Only where the scanner's output is actually CONSUMED. A root with no source patterns
      // never looks at `code`, so refusing to read the file protects nothing there — it just
      // rejects legal host-app code (`const RE = /["]/gu;`) and tells the author to restructure a
      // regex to help a scanner that is not scanning that tree. Same shape as applying
      // `.paginate` to the example: a component-scoped mechanism escaping its scope.
      if (unterminated !== null && sourcePatterns.length > 0) {
        // The scanner does not lex regular expressions, so a quote character inside one --
        // `/"/gu`, or an apostrophe in a character class -- opens a string that never closes.
        // From there it reads code as string and string as code, which breaks the gate in
        // BOTH directions: an identity read after such a line is swallowed, and a legitimate
        // mention inside a later string is emitted as code and rejected. Every such misread
        // ends the file still inside a string and nothing legitimate does, so this turns a
        // silent wrong answer into a loud one. Lexing regex literals correctly needs
        // previous-token context and is its own corner-case farm; refusing to guess is better.
        failures.push(
          `${label}/${file}: unterminated ${unterminated} string — the boundary scanner cannot read ` +
            `this file, so it cannot be cleared. A regular expression containing a quote is the ` +
            `usual cause; assign it via a name the scanner can see, or split the line.`,
        );
        continue;
      }
      for (const { pattern, why } of sourcePatterns) {
        if (pattern.test(code)) {
          failures.push(`${label}/${file}: forbidden construct ${pattern.source} — ${why}`);
        }
      }
      for (const specifier of specifiersIn(text)) {
        if (selfImportAllowed !== undefined && selfImportAllowed.test(specifier)) {
          continue;
        }
        if (FORBIDDEN_SPECIFIER_PATTERNS.some((pattern) => pattern.test(specifier))) {
          failures.push(`${label}/${file}: forbidden import "${specifier}"`);
        } else if (escapesPackage(specifier, dirname(path), root)) {
          failures.push(`${label}/${file}: relative import "${specifier}" escapes the package`);
        }
      }
    }
  }
  return failures;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const packageRoot = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const failures = checkBoundary(packageRoot);
  if (failures.length > 0) {
    process.stderr.write(
      `convex-tinybird boundary check failed:\n${failures.map((f) => `  ${f}`).join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `convex-tinybird boundary check passed (${relative(process.cwd(), resolve(packageRoot)) || "."}).\n`,
  );
}
