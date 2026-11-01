# Repository development

Use pnpm pinned in package.json, preserving the lockfile and build policy. The component is src/component; the consuming app is example/convex. This is not a Turborepo.

Read docs/pull-request-standard.md before opening PRs. Identify the owning issue and actual creating agent/session. Metadata automation executes trusted base code only. All Actions compute uses UbiCloud Linux.

Use pnpm worktree:setup/start/stop/teardown/cleanup/prune. Setup requires safe clean Git state and fetches the selected live origin base. Never reset, stash user changes, copy production credentials or kill by port. See docs/worktrees.md.

On the shared agents host, all Node suites/checks, installs, codegen and backend integration must hold /home/cloudagent/.cache/fantastic-heavy.lock using flock -w 3600. Use NODE_OPTIONS=--max-old-space-size=512 and one worker. Do not nest this lock. Full builds/typechecks/lint belong in UbiCloud CI. Stop only owned test services.
