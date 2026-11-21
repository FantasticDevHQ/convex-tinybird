#!/usr/bin/env node
// Bring the generated Release Please PR up to the PR standard, with no
// validator exemption for bots. The Release workflow runs this after Release
// Please creates or updates the release PR. It:
//   1. appends the required PR sections after Release Please's generated body
//      with `gh pr edit`. The generated header, standalone `---` notes
//      delimiters and footer stay byte-for-byte intact, so Release Please still
//      parses the merged release PR;
//   2. amends the head release commit in the checked-out release branch so its
//      body ends with a `No-ticket: automated release` footer (skipped when the
//      footer is already there), keeping the author, dates and subject;
//   3. force-pushes it with a lease using the release App token, so CI runs on
//      the new head like any other App push. The body is edited first so every
//      check run on that head sees the compliant body.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validatePullRequest } from "./pr-standard.mjs";

const execute = promisify(execFile);

export const footer = "No-ticket: automated release";
export const marker =
  "<!-- release-pr-standard: maintained by the Release workflow; text below is replaced on every run -->";
const agent = "Release Please (fantasticdev-npm-releases GitHub App)";

export const hasTicketFooter = (message) =>
  /^No-ticket:[ \t]*\S/m.test(message ?? "");

/** The commit message with the footer appended as its last line. */
export function withTicketFooter(message) {
  if (hasTicketFooter(message)) return message;
  return `${message.replace(/\s+$/, "")}\n\n${footer}\n`;
}

function generatedPart(body) {
  const text = (body ?? "").replace(/\r\n?/g, "\n");
  const index = text.indexOf(marker);
  const generated = (index === -1 ? text : text.slice(0, index)).trimEnd();
  if (generated.split("\n").filter((line) => line === "---").length < 2)
    throw new Error(
      "The release PR body lacks Release Please's standalone --- notes delimiters.",
    );
  return generated;
}

/**
 * Release Please's generated body followed by the standard sections. Any
 * earlier copy of the sections (after the marker) is replaced, so the result is
 * the same however often it runs.
 */
export function releaseBody({ body, title, runId, runUrl, checklist = false }) {
  if (!/^\d+$/.test(runId ?? "") || !/^https:\/\/\S+\/actions\/runs\/\d+/.test(runUrl ?? ""))
    throw new Error("The Release workflow run ID and URL are required.");
  const version = title?.match(/release(?: \S+)? v?(\d+\.\d+\.\d+\S*)$/)?.[1];
  if (!version) throw new Error(`Unexpected release PR title: ${title}`);
  const ticket = title.match(/: ([A-Z][A-Z0-9]+-[1-9]\d*) /)?.[1];
  const sections = `${marker}
## Summary

Release Please candidate for version ${version}. Merging this PR is the release decision: the Release workflow then tags v${version}, creates the GitHub release and publishes to npm.

${ticket ? `Relates to ${ticket}` : "No ticket: automated release"}

## What

Release Please bumps \`package.json\`, \`.release-please-manifest.json\` and \`CHANGELOG.md\`. The generated notes between the \`---\` delimiters above list every change in this release.

## Why

Ship the changes merged to \`main\` since the last release through the standard release workflow.

## Evidence

UI changes: No

Release workflow run ${runUrl} generated this candidate from the Conventional Commit titles on \`main\` and added the \`${footer}\` commit footer. The required checks on this PR verify the release branch. This is not a publication claim.

## Agent

- Agent: ${agent}
- Session/thread ID: ${runId}
- Run: ${runUrl}
${
  checklist
    ? `
## Acceptance checklist

- [x] Release Please's generated notes, delimiters and footer are unchanged.
- [ ] Required checks pass on the release head before merge.
`
    : ""
}`;
  return `${generatedPart(body)}\n\n${sections}`;
}

const git = (cwd, env) => async (args) =>
  (await execute("git", args, { cwd, env: { ...process.env, ...env } })).stdout;

/**
 * Amend the head commit of the checked-out release branch so it ends with the
 * footer, then force-push it with a lease. Author, committer dates and subject
 * are kept, so a rerun produces the same commit. Returns the head SHA.
 */
export async function amendReleaseCommit({ dir, branch, remote = "origin", env = {} }) {
  if (!/^release-please--[\w@./-]+$/.test(branch ?? ""))
    throw new Error(`Refusing to amend a non-release branch: ${branch}`);
  const run = git(dir, env);
  const head = (await run(["rev-parse", "HEAD"])).trim();
  const message = await run(["log", "-1", "--format=%B", head]);
  if (hasTicketFooter(message)) return { sha: head, amended: false };
  const [name, email, authorDate, committerDate] = (
    await run(["log", "-1", "--format=%an%x00%ae%x00%aI%x00%cI", head])
  )
    .trim()
    .split("\0");
  const file = join(mkdtempSync(join(tmpdir(), "release-commit-")), "message");
  try {
    writeFileSync(file, withTicketFooter(message));
    await git(dir, {
      ...env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: authorDate,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: committerDate,
    })(["commit", "--amend", "--no-verify", "--allow-empty", "--cleanup=verbatim", "-F", file]);
  } finally {
    rmSync(join(file, ".."), { recursive: true, force: true });
  }
  const sha = (await run(["rev-parse", "HEAD"])).trim();
  await run([
    "push",
    `--force-with-lease=refs/heads/${branch}:${head}`,
    remote,
    `${sha}:refs/heads/${branch}`,
  ]);
  return { sha, amended: true };
}

const gh = async (args) => (await execute("gh", args)).stdout;

async function main() {
  const [dir] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY;
  const generated = JSON.parse(process.env.RELEASE_PR ?? "null");
  const token = process.env.GH_TOKEN;
  if (!dir || !repository || !token || !Number.isSafeInteger(generated?.number))
    throw new Error(
      "Usage: RELEASE_PR=<release-please pr output> GH_TOKEN=<app token> release-pr-standard.mjs <release branch checkout>",
    );
  const pr = JSON.parse(await gh(["api", `repos/${repository}/pulls/${generated.number}`]));
  if (
    pr.state !== "open" ||
    pr.base?.ref !== "main" ||
    pr.base.repo?.full_name !== repository ||
    pr.head?.repo?.full_name !== repository ||
    pr.head.ref !== generated.headBranchName
  )
    throw new Error("Refusing to change an unexpected release PR.");
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const body = releaseBody({ body: pr.body, title: pr.title, runId: process.env.GITHUB_RUN_ID, runUrl });
  const message = withTicketFooter(await git(dir)(["log", "-1", "--format=%B", "HEAD"]));
  const errors = validatePullRequest({ title: pr.title, body }, [], [{ sha: pr.head.sha, message }]);
  if (errors.length) throw new Error(`Release PR would still fail the PR standard:\n${errors.join("\n")}`);
  // Edit the body before pushing, so every check run on the final head
  // (including ones that read the event payload) sees the compliant body.
  const tmp = mkdtempSync(join(tmpdir(), "release-body-"));
  try {
    writeFileSync(join(tmp, "body.md"), body);
    await gh(["pr", "edit", String(pr.number), "--repo", repository, "--body-file", join(tmp, "body.md")]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`Release PR #${pr.number} body meets the PR standard.`);
  // The checkout dropped its credentials; pass the App token for this push only.
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const { sha, amended } = await amendReleaseCommit({
    dir,
    branch: pr.head.ref,
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    },
  });
  console.log(amended ? `Amended and pushed release commit ${sha}.` : `Release commit ${sha} already has the footer.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
