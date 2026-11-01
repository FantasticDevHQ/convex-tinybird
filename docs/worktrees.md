# Local worktrees

Installed using the Node installer from FantasticDevHQ/convex-worktrees commit 52c0b76d960a98afedd48607d6737bc14a954c1e. Its exported modules/tests and MIT license live under scripts/worktree; this repository retains Apache-2.0. The example/ backend mounts both Tinybird components. The layout adapter uses example/ for backend and Vite frontend; --frontend starts Vite with the reserved port and VITE_CONVEX_URL.

Run pnpm worktree:setup from a clean committed checkout, then pnpm worktree:start (add --frontend for Vite). No Convex login or cloud credentials are needed. External Tinybird delivery requires the separate Tinybird Local demo workflow; backend isolation tests use actual orders and component enqueues without an external provider.

Stop retains reservations and data; teardown releases reservations and retains data. cleanup --yes deletes only owned state. prune releases missing-checkout reservations only when their ports are free. Never kill by port or process name.

Setup discovers origin's advertised default unless baseBranch is explicitly configured, fetches that branch, and rejects dirty or unsafe divergent state without reset/stash. New worktrees use the immutable fetched commit. Adoption must reach the selected remote base before setup --path creates worktrees containing these scripts.

Upgrade by cloning upstream outside this repo, reading its Quick start and AGENTS.md and running node scripts/check.mjs under the shared host lock. Reconcile manifest exports while preserving the example/Vite adapter and application integration calls. Run pnpm test:standard and pnpm test:worktree:integration. Integration uses two disposable worktrees and verifies HTTP data isolation, stable restart, busy-port refusal and sibling-safe cleanup. CI uses Linux UbiCloud; local Mac compatibility requires separate verification.

For editor/agent hooks, use `pnpm worktree:setup` as the setup command and `pnpm worktree:teardown` before removing a checkout. Codex, T3 Code and Claude share these commands. On the shared VPS wrap setup and all verification in the advisory lock described in AGENTS.md. Synthetic Tinybird tokens are generated once and retained in owned backend.env; local hosts point to a closed loopback port so delivery cannot reach a cloud workspace.

Compared with LaunchHunt LCH-38 local-worktrees documentation and layout adapter: LaunchHunt separates packages/backend and apps/web under Turbo with Bun; this repository already separates a publishable component from a pnpm example and has no Turbo task graph. Both use the same modular lifecycle, explicit cloud/site ports, local HOME/state, stable registry, fetched-base checks and sibling-safe cleanup contract. The local comparison establishes layout differences; successful remote qualification must be checked separately.
