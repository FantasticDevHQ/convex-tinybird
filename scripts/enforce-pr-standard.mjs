import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validatePullRequest } from "./pr-standard.mjs";

const marker = "<!-- jib-pr-standard -->";

export async function enforcePullRequestStandard({ api, number, runUrl }) {
  // Read current metadata, including on reruns of an older event.
  const pr = await api("GET", `/pulls/${number}`);
  if (pr.state !== "open") return true;
  const status = (state, description) =>
    api("POST", `/statuses/${pr.head.sha}`, {
      state,
      context: "PR standard",
      description,
      target_url: runUrl,
    });
  try {
    await status("pending", "Checking PR title, sections and commit ticket links");
    const files = [];
    for (let page = 1; ; page++) {
      const batch = await api(
        "GET",
        `/pulls/${number}/files?per_page=100&page=${page}`,
      );
      files.push(...batch.map((file) => file.filename));
      if (batch.length < 100) break;
      // GitHub exposes at most 3,000 changed files. Do not silently miss UI changes.
      if (page === 30)
        throw new Error(
          "PR file listing reached GitHub's 3,000-file limit; split the PR before validation",
        );
    }
    const commits = [];
    for (let page = 1; ; page++) {
      const batch = await api(
        "GET",
        `/pulls/${number}/commits?per_page=100&page=${page}`,
      );
      commits.push(
        ...batch.map((item) => ({
          sha: item.sha,
          message: item.commit?.message ?? "",
          merge: (item.parents?.length ?? 0) > 1,
        })),
      );
      if (batch.length < 100) break;
      // GitHub lists at most 250 commits for a PR. Do not silently skip any.
      if (page === 3)
        throw new Error(
          "PR commit listing reached GitHub's 250-commit limit; split the PR before validation",
        );
    }
    const errors = validatePullRequest(pr, files, commits);
    let previous;
    for (let page = 1; ; page++) {
      const comments = await api(
        "GET",
        `/issues/${number}/comments?per_page=100&page=${page}`,
      );
      previous = comments.find(
        (comment) =>
          comment.user?.login === "github-actions[bot]" &&
          comment.user?.type === "Bot" &&
          comment.body?.startsWith(marker),
      );
      if (previous || comments.length < 100) break;
    }
    const body = errors.length
      ? `${marker}\n## PR standard failed\n\nThis PR is blocked until these items are corrected:\n\n${errors.map((error) => `- ${error}`).join("\n")}\n\nEdit the PR title/description, or reword and push commits, to rerun this check. See \`docs/pull-request-standard.md\` in this repository. Evidence must describe actual verification; reviewers assess whether it proves the change.\n\n[Check run](${runUrl})`
      : `${marker}\n## PR standard passed\n\nThe title, the Summary, What, Why, Evidence, and Agent sections, and every commit's Linear reference meet the required format. UI changes include screenshot and/or video attachment references when required. Reviewers still assess correctness and evidence quality.\n\n[Check run](${runUrl})`;
    if (previous && previous.body !== body)
      await api("PATCH", `/issues/comments/${previous.id}`, { body });
    else if (!previous && errors.length)
      await api("POST", `/issues/${number}/comments`, { body });
    await status(
      errors.length ? "failure" : "success",
      errors.length
        ? "Fix the PR metadata or commits; see the bot comment"
        : "PR title, sections and commits meet the standard",
    );
    return errors.length === 0;
  } catch (error) {
    try {
      await status(
        "failure",
        "PR metadata validation failed; inspect the workflow log",
      );
    } catch {
      /* Preserve the original API or validation failure. */
    }
    throw error;
  }
}

async function main() {
  const event = JSON.parse(
    await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  const number = Number(
    event.pull_request?.number ?? event.inputs?.pull_request_number,
  );
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error("A positive PR number is required");
  const root = `${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}`;
  const api = async (method, path, data) => {
    const options = {
      method,
      headers: {
        authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
    if (data) options.body = JSON.stringify(data);
    const response = await fetch(`${root}${path}`, options);
    if (!response.ok)
      throw new Error(`GitHub ${method} ${path} failed: ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  };
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  if (!(await enforcePullRequestStandard({ api, number, runUrl })))
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
