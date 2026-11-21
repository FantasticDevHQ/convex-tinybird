import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePullRequest } from "./pr-standard.mjs";

const title = "ci(github): JIF-65 enforce PR standards";
const body = `## Summary
Require consistent pull requests.
Refs JIF-65
## What
Add a metadata validator and template.
## Why
Reviewers need context and reproducible verification.
## Evidence
UI changes: No
Validator regression tests passed: https://github.com/JibHQ/jib-factory/actions/runs/123
## Agent
- Agent: Codex
- Session/thread ID: 01a1862e-bdbc-7722-9688-8334e29f6c2f
`;

test("accepts conventional types, optional scopes and breaking-change markers", () => {
  for (const type of [
    "feat",
    "fix",
    "docs",
    "style",
    "refactor",
    "perf",
    "test",
    "build",
    "ci",
    "chore",
    "revert",
  ]) {
    for (const suffix of ["", "(github)", "!", "(github)!"]) {
      assert.deepEqual(
        validatePullRequest({
          title: `${type}${suffix}: JIF-65 enforce PR standards`,
          body,
        }),
        [],
      );
    }
  }
});

test("the ticket ID in the title is optional", () => {
  for (const valid of [
    "ci: enforce PR standards",
    "ci(github): enforce PR standards",
    "feat!: require authenticated requests",
  ])
    assert.deepEqual(
      validatePullRequest({ title: valid, body: body.replace("Refs JIF-65", "No ticket: tooling bootstrap") }),
      [],
      valid,
    );
});

test("rejects titles that are not conventional commits", () => {
  for (const invalid of [
    "Enforce PR standards",
    "CI: JIF-65 enforce PR standards",
    "other: JIF-65 enforce PR standards",
    "ci:",
    "ci:enforce",
  ]) {
    assert.ok(validatePullRequest({ title: invalid, body }).length, invalid);
  }
});

test("requires each section, in order, with visible non-placeholder content", () => {
  for (const section of ["Summary", "What", "Why", "Evidence", "Agent"]) {
    const start = body.indexOf(`## ${section}`);
    const end = body.indexOf("## ", start + 3);
    const prefix = body.slice(0, start);
    const suffix = end < 0 ? "" : body.slice(end);
    for (const content of [
      "",
      "<!-- Explain this -->",
      "TBD",
      "- [ ] TODO", // JIF-65: reject unchecked placeholder evidence.
      "N/A",
      "Pending",
      "Not run",
    ]) {
      assert.ok(
        validatePullRequest({
          title,
          body: `${prefix}## ${section}\n${content}\n${suffix}`,
        }).length,
        `${section}: ${content}`,
      );
    }
    assert.ok(validatePullRequest({ title, body: prefix + suffix }).length);
  }
  assert.ok(
    validatePullRequest({
      title,
      body: body
        .replace("## What", "## Why")
        .replace("## Why\nReviewers", "## What\nReviewers"),
    }).length,
  );
  assert.ok(
    validatePullRequest({ title, body: `${body}\n## What\nDuplicate section` })
      .length,
  );
});

test("ignores headings hidden in comments or fenced examples", () => {
  assert.ok(validatePullRequest({ title, body: `<!--\n${body}\n-->` }).length);
  for (const fence of ["```", "~~~~"]) {
    assert.ok(
      validatePullRequest({ title, body: `${fence}md\n${body}\n${fence}` })
        .length,
    );
  }
});

test("requires a reviewer-accessible proof link or pasted output", () => {
  const replaceEvidence = (evidence) =>
    body.replace(/Validator regression tests passed:[^\n]*/, evidence);
  for (const evidence of [
    "Tests passed.",
    "See /tmp/test.log",
    "[Log](file:///tmp/log)",
    "https://localhost:3000",
    "https://example.com/proof",
    "```text\nTBD\n```",
    "<!-- https://github.com/org/repo/actions/runs/123 -->",
  ]) {
    assert.ok(
      validatePullRequest({ title, body: replaceEvidence(evidence) }).length,
      evidence,
    );
  }
  assert.deepEqual(
    validatePullRequest({
      title,
      body: replaceEvidence(
        "Local validator result:\n```text\n12 tests passed, 0 failed\n```",
      ),
    }),
    [],
  );
  assert.deepEqual(
    validatePullRequest({
      title,
      body: `${body}\n## Acceptance checklist\n- [x] Verified`,
    }),
    [],
  );
});

test("handles absent metadata without throwing", () => {
  assert.ok(validatePullRequest({}).length);
});

test("requires a magic-word declaration for the title ticket in Summary", () => {
  for (const declaration of [
    "Fixes JIF-65",
    "Refs JIF-65",
    "Relates to JIF-65",
    "Closes JIF-65",
    "Implements JIF-65",
    "References JIF-65",
    "Part of JIF-65",
    "Contributes to JIF-65",
    "Towards JIF-65",
    "Related to JIF-65",
    "Refs https://linear.app/dojoco/issue/JIF-65/require-pr-standards",
    "Fixes JIF-64, JIF-65 and JIF-66",
  ]) {
    assert.deepEqual(
      validatePullRequest({ title, body: body.replace("Refs JIF-65", declaration) }),
      [],
      declaration,
    );
  }
  for (const declaration of [
    "",
    "JIF-65",
    "[JIF-65](https://linear.app/dojoco/issue/JIF-65)",
    "Refs JIF-650",
    "Fixes JIF-66",
    "Refs https://example.com/issue/JIF-65",
    "Refs https://linear.app/dojoco/issue/JIF-66/wrong-ticket",
    "Refs JIF-65 soon",
    "`Refs JIF-65`",
    "<!-- Refs JIF-65 -->",
    "```text\nRefs JIF-65\n```",
    "No ticket: n/a",
  ]) {
    assert.ok(
      validatePullRequest({ title, body: body.replace("Refs JIF-65", declaration) }).some((error) =>
        error.includes("Summary"),
      ),
      declaration,
    );
  }
});

test("a PR without tickets states No ticket with a reason", () => {
  const noTitleTicket = "ci: enforce PR standards";
  assert.deepEqual(
    validatePullRequest({ title: noTitleTicket, body: body.replace("Refs JIF-65", "No ticket: repository bootstrap") }),
    [],
  );
  for (const declaration of ["", "No ticket:", "No ticket: TBD"])
    assert.ok(
      validatePullRequest({ title: noTitleTicket, body: body.replace("Refs JIF-65", declaration) }).some((error) =>
        error.includes("No ticket"),
      ),
      declaration,
    );
});

const commit = (message, extra = {}) => ({ sha: "0123456789abcdef", message, ...extra });

test("every non-merge commit needs a magic-word ticket or a No-ticket footer", () => {
  assert.deepEqual(
    validatePullRequest({ title, body }, [], [
      commit("ci: add validator\n\nRefs JIF-65"),
      commit("docs: typo\n\nNo-ticket: comment-only fix"),
      commit("Merge branch 'main'", { merge: true }),
    ]),
    [],
  );
  for (const message of ["ci: add validator", "ci: add validator\n\nJIF-65", "ci: x\n\n#42", "ci: x\n\nFixes #0", "ci: x\n\nFixes https://github.com/o/r/pull/4", "ci: x\n\nNo-ticket:", "ci: x\n\nNo-ticket: TBD"])
    assert.ok(
      validatePullRequest({ title, body }, [], [commit(message)]).some((error) =>
        error.includes("has no ticket or issue reference"),
      ),
      message,
    );
});

test("Summary must declare every ticket referenced by commits", () => {
  const errors = validatePullRequest({ title, body }, [], [
    commit("ci: add validator\n\nRefs JIF-65"),
    commit("ci: add enforcer\n\nFixes JIF-70"),
  ]);
  assert.ok(errors.some((error) => error.includes("missing JIF-70")), errors.join("\n"));
  assert.deepEqual(
    validatePullRequest({ title, body: body.replace("Refs JIF-65", "Refs JIF-65\nFixes JIF-70") }, [], [
      commit("ci: add validator\n\nRefs JIF-65"),
      commit("ci: add enforcer\n\nFixes JIF-70"),
    ]),
    [],
  );
});

test("requires the Agent section and identifies its agent and session", () => {
  assert.ok(
    validatePullRequest({ title, body: body.split("## Agent")[0] }).some(
      (error) => error.includes("Agent"),
    ),
  );
  for (const agent of [
    "Codex submitted this PR.",
    "- Agent: Codex",
    "- Session/thread ID: session-123",
    "- Agent: TBD\n- Session/thread ID: session-123",
    "- Agent: Codex\n- Session/thread ID: N/A",
    "- Agent:\n- Session/thread ID: session-123",
    "- Agent: Codex\n- Session/thread ID:\n- Session link: unavailable",
    "```text\n- Agent: Codex\n- Session/thread ID: session-123\n```",
    "<!-- - Agent: Codex\n- Session/thread ID: session-123 -->",
  ]) {
    assert.ok(
      validatePullRequest({
        title,
        body: `${body.split("## Agent")[0]}## Agent\n${agent}`,
      }).length,
      agent,
    );
  }
  assert.ok(
    validatePullRequest({
      title,
      body: body
        .replace("## Evidence", "## Agent")
        .replace("## Agent\n- Agent", "## Evidence\n- Agent"),
    }).some((error) => error.includes("Order")),
  );
});

test("requires a UI declaration and uploaded screenshot or video for UI changes", () => {
  const screenshot =
    "- Screenshot: ![Updated flow](https://github.com/user-attachments/assets/screenshot-123)";
  const video = "- Video: https://github.com/user-attachments/assets/video-456";
  const uiBody = body.replace("UI changes: No", "UI changes: Yes");
  const proof = (text) =>
    text.replace("## Agent", `${screenshot}\n${video}\n## Agent`);
  assert.ok(
    validatePullRequest({ title, body: body.replace("UI changes: No", "") })
      .length,
  );
  assert.ok(validatePullRequest({ title, body: uiBody }).length);
  assert.ok(
    validatePullRequest({
      title,
      body: uiBody.replace(
        "## Agent",
        `\`\`\`markdown\n${screenshot}\n${video}\n\`\`\`\n## Agent`,
      ),
    }).length,
  );
  assert.deepEqual(
    validatePullRequest({
      title,
      body: proof(uiBody).replace(`${video}\n`, ""),
    }),
    [],
  );
  assert.deepEqual(
    validatePullRequest({
      title,
      body: proof(uiBody).replace(`${screenshot}\n`, ""),
    }),
    [],
  );
  assert.deepEqual(
    validatePullRequest({
      title,
      body: proof(uiBody).replace("video-456", "screenshot-123"),
    }),
    [],
  );
  assert.ok(
    validatePullRequest({
      title,
      body: proof(uiBody).replaceAll(
        "https://github.com/user-attachments/assets/",
        "https://example.org/",
      ),
    }).length,
  );
  assert.deepEqual(validatePullRequest({ title, body: proof(uiBody) }), []);
  for (const path of [
    "packages/factory-console/src/App.tsx",
    "apps/web/styles.css",
    "apps/web/logo.svg",
  ]) {
    assert.ok(validatePullRequest({ title, body }, [path]).length, path);
    assert.deepEqual(
      validatePullRequest({ title, body: proof(body) }, [path]),
      [],
    );
  }
  assert.deepEqual(
    validatePullRequest({ title, body }, ["apps/factory/tests/ui.test.tsx"]),
    [],
  );
});

for (const newline of ["\n", "\r\n", "\r"]) {
  test(`valid and invalid metadata with ${JSON.stringify(newline)} line endings`, () => {
    assert.deepEqual(
      validatePullRequest({ title, body: body.replaceAll("\n", newline) }),
      [],
    );
    assert.ok(
      validatePullRequest({
        title: "invalid",
        body: body.replaceAll("\n", newline),
      }).length,
    );
  });
}

test("accepts a GitHub Actions artifact as UI video evidence", () => {
  const uiBody = body.replace("UI changes: No", "UI changes: Yes");
  const withVideo = (url) =>
    uiBody.replace("## Agent", `- Video: ${url}\n## Agent`);
  assert.deepEqual(
    validatePullRequest({
      title,
      body: withVideo("https://github.com/acme/app/actions/runs/123456/artifacts/7890"),
    }),
    [],
  );
  for (const url of [
    "https://github.com/acme/app/actions/runs/123456",
    "https://example.com/acme/app/actions/runs/1/artifacts/2",
    "https://github.com/acme/app/actions/runs/abc/artifacts/2",
  ])
    assert.ok(
      validatePullRequest({ title, body: withVideo(url) }).some((error) =>
        error.includes("UI changes require"),
      ),
      url,
    );
});

test("outside contributors can reference GitHub issues instead of Linear tickets", () => {
  const noTitleTicket = "fix(cli): handle missing config file";
  for (const declaration of [
    "Fixes #42",
    "- Refs #42",
    "Closes FantasticDevHQ/finch#42",
    "Resolves https://github.com/FantasticDevHQ/finch/issues/42",
    "Fixes #42, #43 and JIF-65",
  ]) {
    const summary = body.replace("Refs JIF-65", declaration);
    const commits = [commit(`fix(cli): handle missing config\n\n${declaration}`)];
    const errors = validatePullRequest({ title: noTitleTicket, body: summary }, [], commits);
    assert.deepEqual(
      errors.filter((error) => !error.includes("missing JIF-65")),
      [],
      declaration,
    );
  }
  for (const declaration of ["#42", "Fixes #0", "Fixes https://github.com/o/r/pull/42", "Fixes #42 later"])
    assert.ok(
      validatePullRequest({ title: noTitleTicket, body: body.replace("Refs JIF-65", declaration) }).some((error) =>
        error.includes("No ticket"),
      ),
      declaration,
    );
});

test("GitHub issue references do not replace required Linear declarations", () => {
  const errors = validatePullRequest(
    { title, body: body.replace("Refs JIF-65", "Fixes #42") },
    [],
    [commit("ci: add validator\n\nRefs JIF-65")],
  );
  assert.ok(errors.some((error) => error.includes("missing JIF-65")), errors.join("\n"));
});
