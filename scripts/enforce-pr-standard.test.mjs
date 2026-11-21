import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { enforcePullRequestStandard } from "./enforce-pr-standard.mjs";

test("metadata workflow grants the API permissions its enforcer requires", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/pr-standard.yml", import.meta.url),
    "utf8",
  );
  const permissions = workflow.match(
    /^permissions:\n((?: {2}\S[^\n]*\n)+)/m,
  )?.[1];
  assert.ok(permissions, "workflow must declare explicit token permissions");
  for (const permission of [
    "contents: read",
    "pull-requests: write",
    "issues: write",
    "statuses: write",
  ]) {
    assert.ok(permissions.split("\n").includes(`  ${permission}`), permission);
  }
  assert.doesNotMatch(
    workflow,
    /^\s+permissions:/m,
    "job permissions must not override the workflow contract",
  );
});

const valid = {
  title: "ci: JIF-65 enforce PR standards",
  body: "## Summary\nRequire PR context.\nRefs JIF-65\n## What\nValidate metadata.\n## Why\nReduce incomplete reviews.\n## Evidence\nUI changes: No\n```text\n6 tests passed\n```\n## Agent\n- Agent: Codex\n- Session/thread ID: session-123",
  state: "open",
  head: { sha: "abc123" },
};

const goodCommits = [
  { sha: "c1", commit: { message: "ci: validate metadata\n\nRefs JIF-65" }, parents: [{}] },
];

function fixture(pr, comments = [], commits = goodCommits) {
  const calls = [];
  const api = async (method, path, data) => {
    calls.push({ method, path, data });
    if (path === "/pulls/65") return pr;
    if (path.startsWith("/pulls/65/files?")) return [];
    if (path.startsWith("/pulls/65/commits?")) return commits;
    if (path.startsWith("/issues/65/comments?")) return comments;
    return {};
  };
  return {
    calls,
    run: () =>
      enforcePullRequestStandard({
        api,
        number: 65,
        runUrl: "https://github.com/JibHQ/jib-factory/actions/runs/123",
      }),
  };
}

test("invalid PR fails its own head status and receives actionable feedback", async () => {
  const { calls, run } = fixture({
    ...valid,
    title: "Missing ticket",
    body: "",
  });
  assert.equal(await run(), false);
  assert.equal(calls.at(-1).path, "/statuses/abc123");
  assert.equal(calls.at(-1).data.state, "failure");
  const comment = calls.find((call) => call.path === "/issues/65/comments");
  assert.match(comment.data.body, /Summary/);
  assert.match(comment.data.body, /type\(scope\): description/);
});

test("a commit without a Linear reference fails with actionable feedback", async () => {
  const { calls, run } = fixture(valid, [], [
    ...goodCommits,
    { sha: "deadbeef", commit: { message: "ci: tweak" }, parents: [{}] },
  ]);
  assert.equal(await run(), false);
  const comment = calls.find((call) => call.path === "/issues/65/comments");
  assert.match(comment.data.body, /Commit deadbee "ci: tweak" has no ticket or issue reference/);
});

test("merge commits are exempt from the commit rule", async () => {
  const { run } = fixture(valid, [], [
    ...goodCommits,
    { sha: "m1", commit: { message: "Merge branch 'main'" }, parents: [{}, {}] },
  ]);
  assert.equal(await run(), true);
});

test("corrected PR updates the bot comment and passes without comment spam", async () => {
  const { calls, run } = fixture(valid, [
    {
      id: 42,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: "<!-- jib-pr-standard -->\nOld failure",
    },
  ]);
  assert.equal(await run(), true);
  assert.match(
    calls.find((call) => call.method === "PATCH").data.body,
    /PR standard passed/,
  );
  assert.equal(calls.at(-1).data.state, "success");
  assert.equal(
    calls.filter((call) => call.path === "/issues/65/comments").length,
    0,
  );
});

test("does not trust a user-authored copy of the bot marker", async () => {
  const { calls, run } = fixture({ ...valid, body: "" }, [
    {
      id: 1,
      user: { login: "contributor", type: "User" },
      body: "<!-- jib-pr-standard -->",
    },
  ]);
  await run();
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0);
  assert.ok(calls.some((call) => call.path === "/issues/65/comments"));
});

test("valid PR needs no new comment; closed PRs receive no writes", async () => {
  const good = fixture(valid);
  assert.equal(await good.run(), true);
  assert.equal(good.calls.filter((call) => call.method === "POST").length, 2);
  const closed = fixture({ ...valid, state: "closed" });
  assert.equal(await closed.run(), true);
  assert.equal(closed.calls.length, 1);
});

test("API failure publishes failure instead of passing", async () => {
  const states = [];
  const api = async (method, path, data) => {
    if (path === "/pulls/65") return valid;
    if (path.startsWith("/pulls/65/files?")) return [];
    if (path.startsWith("/pulls/65/commits?")) return goodCommits;
    if (path.startsWith("/statuses/")) states.push(data.state);
    if (path.includes("comments")) throw new Error("GitHub unavailable");
  };
  await assert.rejects(
    enforcePullRequestStandard({
      api,
      number: 65,
      runUrl: "https://github.com/run",
    }),
    /GitHub unavailable/,
  );
  assert.deepEqual(states, ["pending", "failure"]);
});

for (const statusFails of [false, true]) {
  test(`API failures publish best-effort failure status and retain original error (${statusFails})`, async () => {
    const original = new Error("file listing unavailable");
    const statuses = [];
    await assert.rejects(
      enforcePullRequestStandard({
        number: 65,
        runUrl: "https://github.com/JibHQ/jib-factory/actions/runs/123",
        api: async (method, path, data) => {
          if (path === "/pulls/65") return valid;
          if (path.includes("/files?")) throw original;
          if (path.startsWith("/statuses/")) {
            statuses.push(data.state);
            if (statusFails && data.state === "failure")
              throw new Error("status unavailable");
          }
          return {};
        },
      }),
      (error) => error === original,
    );
    assert.deepEqual(statuses, ["pending", "failure"]);
  });
}
