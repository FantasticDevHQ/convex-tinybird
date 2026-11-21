import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validatePullRequest } from "./pr-standard.mjs";
import {
  amendReleaseCommit,
  footer,
  marker,
  releaseBody,
  withTicketFooter,
} from "./release-pr-standard.mjs";

const title = "chore(main): release 0.4.2";
const notes =
  "## [0.4.2](https://github.com/FantasticDevHQ/convex-tinybird/compare/v0.4.1...v0.4.2) (2026-11-21)\n\n\n### Documentation\n\n* **community:** adopt organization community health defaults ([#35](https://github.com/FantasticDevHQ/convex-tinybird/issues/35))";
const generated = `:robot: I have created a release *beep* *boop*\n---\n\n\n${notes}\n\n---\nThis PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).`;
const runUrl = "https://github.com/FantasticDevHQ/convex-tinybird/actions/runs/123";
const commit = { sha: "c".repeat(40), message: `${title}\n\n${footer}\n` };

test("release body meets the standard and keeps Release Please's body intact", () => {
  const body = releaseBody({ body: generated, title, runId: "123", runUrl });
  assert.deepEqual(validatePullRequest({ title, body }, ["CHANGELOG.md", "package.json"], [commit]), []);
  assert.ok(body.startsWith(`${generated}\n\n${marker}\n## Summary`));
  assert.match(body, /^No ticket: automated release$/m);
  assert.match(body, /^UI changes: No$/m);
  assert.match(body, /^- Session\/thread ID: 123$/m);
  assert.ok(body.split("\n").includes(`- Run: ${runUrl}`));
  // Release Please's parser: the notes sit between the first and last standalone ---.
  const lines = body.split("\n");
  const content = lines.slice(lines.indexOf("---") + 1, lines.lastIndexOf("---")).join("\n");
  assert.equal(content.trim(), notes);
  assert.equal(body.split("\n").filter((line) => line === "---").length, 2);
});

test("release body is idempotent and refreshes the run identity", () => {
  const first = releaseBody({ body: generated, title, runId: "123", runUrl });
  const second = releaseBody({ body: first.replace(/\n/g, "\r\n"), title, runId: "124", runUrl: runUrl.replace("123", "124") });
  assert.equal((second.match(/^## Summary$/gm) ?? []).length, 1);
  assert.match(second, /Session\/thread ID: 124$/m);
  assert.doesNotMatch(second, /runs\/123/);
  assert.equal(releaseBody({ body: second, title, runId: "124", runUrl: runUrl.replace("123", "124") }), second);
});

test("a ticket in the release title is declared without status automation", () => {
  const ticketed = "chore(main): JIB-3163 release 0.2.9";
  const body = releaseBody({ body: generated, title: ticketed, runId: "1", runUrl });
  assert.match(body, /^Relates to JIB-3163$/m);
  assert.deepEqual(validatePullRequest({ title: ticketed, body }, [], [commit]), []);
});

test("release body refuses missing run identity, titles and delimiters", () => {
  assert.throws(() => releaseBody({ body: generated, title, runId: "", runUrl }));
  assert.throws(() => releaseBody({ body: generated, title: "chore: tidy", runId: "1", runUrl }));
  assert.throws(() => releaseBody({ body: "no delimiters", title, runId: "1", runUrl }));
});

test("the release commit fails without the footer and passes with it", () => {
  const body = releaseBody({ body: generated, title, runId: "123", runUrl });
  assert.match(validatePullRequest({ title, body }, [], [{ ...commit, message: title }]).join(), /has no ticket or issue reference/);
  assert.equal(withTicketFooter(title), `${title}\n\n${footer}\n`);
  assert.equal(withTicketFooter(commit.message), commit.message);
});

test("amend adds the footer once, keeps author and subject, and force-pushes with a lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "release-amend-"));
  const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    const remote = join(root, "remote.git");
    const dir = join(root, "work");
    const branch = "release-please--branches--main--components--@fantastic.dev/convex-tinybird";
    sh(root, "init", "-q", "--bare", remote);
    sh(root, "init", "-q", "-b", "main", dir);
    sh(dir, "config", "user.name", "Fixture");
    sh(dir, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-q", "-m", "docs: base");
    sh(dir, "checkout", "-q", "-b", branch);
    writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## 0.4.2\n");
    sh(dir, "add", ".");
    execFileSync("git", ["commit", "-q", "-m", title], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: "fantasticdev-npm-releases[bot]", GIT_AUTHOR_EMAIL: "1+bot@users.noreply.github.com", GIT_AUTHOR_DATE: "2026-11-21T07:11:46Z", GIT_COMMITTER_DATE: "2026-11-21T07:11:46Z" },
    });
    sh(dir, "remote", "add", "origin", remote);
    sh(dir, "push", "-q", "origin", branch);
    const before = sh(dir, "rev-parse", "HEAD");

    const result = await amendReleaseCommit({ dir, branch });
    assert.equal(result.amended, true);
    assert.equal(sh(remote, "rev-parse", `refs/heads/${branch}`), result.sha);
    assert.equal(sh(dir, "log", "-1", "--format=%B").trimEnd(), `${title}\n\n${footer}`);
    assert.equal(sh(dir, "log", "-1", "--format=%s"), title);
    assert.equal(sh(dir, "log", "-1", "--format=%an <%ae> %aI"), "fantasticdev-npm-releases[bot] <1+bot@users.noreply.github.com> 2026-11-21T07:11:46Z");
    assert.equal(sh(dir, "rev-parse", "HEAD~1"), sh(dir, "rev-parse", "main"));
    assert.equal(sh(dir, "rev-parse", "HEAD^{tree}"), sh(dir, "rev-parse", `${before}^{tree}`));

    const again = await amendReleaseCommit({ dir, branch });
    assert.deepEqual(again, { sha: result.sha, amended: false });

    // The lease refuses to overwrite a remote head that moved since the checkout,
    // for example when Release Please pushed a newer candidate meanwhile.
    sh(dir, "reset", "-q", "--hard", before);
    sh(dir, "commit", "-q", "--amend", "-m", "chore(main): release 0.4.3");
    const newer = sh(dir, "rev-parse", "HEAD");
    sh(dir, "push", "-q", "--force", "origin", `${newer}:refs/heads/${branch}`);
    sh(dir, "reset", "-q", "--hard", before);
    await assert.rejects(amendReleaseCommit({ dir, branch }), /stale info|rejected/);
    assert.equal(sh(remote, "rev-parse", `refs/heads/${branch}`), newer);

    await assert.rejects(amendReleaseCommit({ dir, branch: "main" }), /non-release branch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Release workflow runs the compliance step whenever Release Please creates or updates the PR", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const step = workflow.slice(workflow.indexOf("- name: Make the release PR meet the PR standard"));
  assert.match(step, /if: steps\.release-pr\.outputs\.prs_created == 'true'/);
  assert.match(step, /GH_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.match(step, /RELEASE_PR: \$\{\{ steps\.release-pr\.outputs\.pr \}\}/);
  assert.match(step, /node scripts\/release-pr-standard\.mjs \.release-pr/);
  assert.match(workflow, /ref: \$\{\{ fromJSON\(steps\.release-pr\.outputs\.pr\)\.headBranchName \}\}/);
});
