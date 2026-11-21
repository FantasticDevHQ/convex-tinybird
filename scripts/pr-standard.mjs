const sections = ["Summary", "What", "Why", "Evidence", "Agent"];
const titlePattern =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9./-]*\))?!?: \S.*$/;
const ticketPattern = /^[A-Z][A-Z0-9]+-[1-9]\d*$/;
// Linear's documented magic words: closing, non-closing and relation.
const magicWord =
  /^[ \t]*(?:[-*][ \t]*)?(close[sd]?|closing|fix(?:es|ed|ing)?|resolve[sd]?|resolving|complete[sd]?|completing|implement(?:s|ed|ing)?|linear issue|ref(?:s|erences)?|part of|contributes to|towards?|relate[sd] to)[ \t]+(.+?)[ \t]*$/i;

function meaningful(text) {
  return text.split("\n").some((line) => {
    const value = line
      .replace(/^\s*[-*+]\s*(\[[ xX]\])?/, "")
      .replace(/[`*_~]/g, "")
      .trim();
    return (
      /[a-z0-9]/i.test(value) &&
      !/^(tbd|todo|n\/?a|none|pending|not run|not applicable|no evidence|coming soon)[.!]?$/i.test(
        value,
      ) &&
      !/^(text|sh|bash|shell|console|log|md)$/i.test(value)
    );
  });
}

function parseSections(body) {
  const found = [];
  let current;
  let fence;
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    const heading = !fence && line.match(/^#{1,2}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      current =
        line.startsWith("## ") && sections.includes(heading[1])
          ? { name: heading[1], text: "" }
          : undefined;
      if (current) found.push(current);
    } else if (current) current.text += `${line}\n`;
    if (marker) {
      if (!fence) fence = marker[1];
      else if (
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        /^\s*(`+|~+)\s*$/.test(line)
      )
        fence = undefined;
    }
  }
  return found;
}

function hasProof(text) {
  const links = text.match(/https:\/\/[^\s<>\])]+/g) ?? [];
  const accessible = links.some((link) => {
    try {
      const { hostname } = new URL(link);
      return (
        hostname.includes(".") &&
        !/^(localhost|127\.|0\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
          hostname,
        ) &&
        !/(^|\.)(example\.(com|org|net)|local|localhost|invalid|test)$/.test(
          hostname,
        )
      );
    } catch {
      return false;
    }
  });
  const output = [
    ...text.matchAll(/^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\s*\1\s*$/gm),
  ].some((match) => meaningful(match[2]));
  return accessible || output;
}

function outsideFences(text) {
  let fence;
  return text
    .split("\n")
    .filter((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker && !fence) {
        fence = marker[1];
        return false;
      }
      if (
        fence &&
        marker?.[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        /^ {0,3}(`+|~+)[ \t]*$/.test(line)
      ) {
        fence = undefined;
        return false;
      }
      return !fence;
    })
    .join("\n");
}

function agentErrors(text) {
  text = outsideFences(text);
  const errors = [];
  for (const field of ["Agent", "Session/thread ID"]) {
    const value = text.match(
      new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?${field}:[ \\t]*([^\\n]+)$`, "m"),
    )?.[1];
    if (!value || !meaningful(value))
      errors.push(
        `In \`## Agent\`, provide \`${field}:\` with the actual agent identity or session/thread ID.`,
      );
  }
  return errors;
}

function ticketFrom(token) {
  token = token.replace(/^<|[>.,;:]+$/g, "");
  if (ticketPattern.test(token)) return token;
  try {
    const url = new URL(token);
    if (url.protocol !== "https:" || url.hostname !== "linear.app") return;
    return url.pathname.match(
      /^\/[^/]+\/issue\/([A-Z][A-Z0-9]+-[1-9]\d*)(?:\/|$)/,
    )?.[1];
  } catch {
    return undefined;
  }
}

// GitHub issue references for contributors without Linear access:
// `#42`, `owner/repo#42` or a full github.com issue URL.
function issueFrom(token) {
  token = token.replace(/^<|[>.,;:]+$/g, "");
  if (/^(?:[\w.-]+\/[\w.-]+)?#[1-9]\d*$/.test(token)) return token;
  try {
    const url = new URL(token);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return;
    return /^\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*\/?$/.test(url.pathname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

// References declared with a magic word, one or more per line:
// `Fixes ENG-1`, `Refs ENG-2, ENG-3 and DES-4`, full Linear issue URLs, or
// GitHub issues such as `Fixes #42`. Every target on a line must be valid.
export function declaredReferences(text) {
  const tickets = new Set();
  const issues = new Set();
  for (const line of outsideFences(text).split("\n")) {
    const targets = line.match(magicWord)?.[2];
    if (!targets) continue;
    const tokens = targets.split(/[\s,]+/).filter((token) => token && !/^and$/i.test(token));
    const found = tokens.map((token) => {
      const ticket = ticketFrom(token);
      if (ticket) return { ticket };
      const issue = issueFrom(token);
      return issue ? { issue } : undefined;
    });
    if (!found.length || !found.every(Boolean)) continue;
    for (const ref of found) {
      if (ref.ticket) tickets.add(ref.ticket);
      else issues.add(ref.issue);
    }
  }
  return { tickets, issues };
}

// Linear tickets declared with a magic word.
export const declaredTickets = (text) => declaredReferences(text).tickets;

const noTicket = (text, pattern) =>
  outsideFences(text)
    .split("\n")
    .some((line) => {
      const reason = line.match(pattern)?.[1];
      return !!reason && meaningful(reason);
    });

function linkageErrors(text, title, commitTickets) {
  const { tickets: declared, issues } = declaredReferences(text);
  const required = new Set(commitTickets);
  const titleTicket = title.match(/: ([A-Z][A-Z0-9]+-[1-9]\d*) /)?.[1];
  if (titleTicket) required.add(titleTicket);
  const errors = [];
  const missing = [...required].filter((id) => !declared.has(id)).sort();
  if (missing.length)
    errors.push(
      `In \`## Summary\`, declare every ticket this PR works on with a Linear magic word: missing ${missing.join(", ")}. Use \`Fixes ${missing[0]}\` only for completed work, \`Refs ${missing[0]}\` for partial work, or \`Relates to ${missing[0]}\` for a relation without status automation. Several IDs may follow one word, e.g. \`Fixes ${missing.join(", ")}\`. Linear does not re-detect tickets from earlier merges into a feature branch, so list them here.`,
    );
  if (
    !declared.size &&
    !issues.size &&
    !required.size &&
    !noTicket(text, /^[ \t]*(?:[-*][ \t]*)?No ticket:[ \t]*(.+)$/i)
  )
    errors.push(
      "In `## Summary`, link the Linear ticket(s) or GitHub issue(s) with a magic word (`Fixes ENG-123`, `Refs ENG-123`, `Fixes #123`) or state `No ticket: <reason>`.",
    );
  return errors;
}

// Every non-merge commit names its Linear ticket or GitHub issue with a magic
// word, or carries a `No-ticket: <reason>` footer. Returns the errors and the
// Linear tickets referenced.
export function commitErrors(commits = []) {
  const errors = [];
  const tickets = new Set();
  for (const commit of commits) {
    if (commit.merge) continue;
    const message = commit.message ?? "";
    const found = declaredReferences(message);
    found.tickets.forEach((id) => tickets.add(id));
    if (!found.tickets.size && !found.issues.size && !noTicket(message, /^No-ticket:[ \t]*(.+)$/im))
      errors.push(
        `Commit ${String(commit.sha ?? "").slice(0, 7) || "(unknown)"} "${message.split("\n")[0]}" has no ticket or issue reference. Add a body line such as \`Fixes ENG-123\`, \`Refs ENG-123\` or \`Fixes #123\`, or a \`No-ticket: <reason>\` footer, then reword the commit and push.`,
      );
  }
  return { errors, tickets };
}

function uiEvidenceErrors(text, files) {
  text = outsideFences(text);
  const errors = [];
  const declared = text.match(
    /^\s*(?:[-*]\s*)?UI changes:\s*(Yes|No)\s*$/im,
  )?.[1];
  if (!declared)
    errors.push(
      "In `## Evidence`, declare `UI changes: Yes` or `UI changes: No`.",
    );
  const uiFiles = files.some(
    (path) =>
      !/(^|\/)(tests?|__tests__|fixtures)(\/|$)|\.(test|spec)\./i.test(path) &&
      /\.(tsx|jsx|css|scss|sass|less|html|vue|svelte|svg|png|jpe?g|webp|gif)$/i.test(
        path,
      ),
  );
  if (declared?.toLowerCase() !== "yes" && !uiFiles) return errors;
  const screenshot = text.match(
    /^\s*(?:[-*]\s*)?Screenshot:\s*!\[[^\]\n]*\]\((https:\/\/[^\s)]+)\)/im,
  )?.[1];
  const video = text.match(
    /^\s*(?:[-*]\s*)?Video:[^\n]*?(https:\/\/[^\s)<>]+)/im,
  )?.[1];
  // GitHub attachment uploads, or GitHub Actions artifacts (for example
  // recordings from an end-to-end job), which headless agents can produce.
  const uploaded = (url) =>
    !!url &&
    (/^https:\/\/(github\.com\/user-attachments\/assets\/|(?:user-images|private-user-images)\.githubusercontent\.com\/)[^\s]+$/.test(
      url,
    ) ||
      /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+\/artifacts\/\d+$/.test(
        url,
      ));
  if (!uploaded(screenshot) && !uploaded(video))
    errors.push(
      "UI changes require screenshots and/or video uploaded through GitHub attachments, or a GitHub Actions artifact. In Evidence, include `Screenshot: ![description](https://github.com/user-attachments/assets/...)` and/or `Video: https://github.com/user-attachments/assets/...` (or `Video: https://github.com/<owner>/<repo>/actions/runs/<run>/artifacts/<id>`). At least one is required.",
    );
  return errors;
}

export function validatePullRequest(
  { title = "", body = "" },
  files = [],
  commits = [],
) {
  title ??= "";
  const errors = [];
  if (!titlePattern.test(title.trim()))
    errors.push(
      "Use `type(scope): description` or `type: description`. A ticket ID is optional. Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert. Example: `fix(auth): correct session expiry`.",
    );
  const commitCheck = commitErrors(commits);
  errors.push(...commitCheck.errors);
  const found = parseSections((body ?? "").replace(/<!--[\s\S]*?(-->|$)/g, ""));
  for (const name of sections) {
    const matches = found.filter((section) => section.name === name);
    if (matches.length !== 1)
      errors.push(`Include exactly one \`## ${name}\` section.`);
    else if (!meaningful(matches[0].text))
      errors.push(
        `Fill in \`## ${name}\` with meaningful content; empty sections and placeholders do not count.`,
      );
    else if (name === "Evidence" && !hasProof(matches[0].text))
      errors.push(
        "In `## Evidence`, include an HTTPS proof link accessible to reviewers or fenced test/log/API output, with the result and what it demonstrates. Local paths and promises to verify later do not count.",
      );
    if (matches.length === 1 && name === "Agent")
      errors.push(...agentErrors(matches[0].text));
    if (matches.length === 1 && name === "Summary")
      errors.push(...linkageErrors(matches[0].text, title, commitCheck.tickets));
    if (matches.length === 1 && name === "Evidence")
      errors.push(...uiEvidenceErrors(matches[0].text, files));
  }
  if (
    found.length === sections.length &&
    found.map((section) => section.name).join() !== sections.join()
  )
    errors.push("Order the sections: Summary, What, Why, Evidence, Agent.");
  return errors;
}
