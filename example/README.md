# Example app

A minimal Convex app that mounts **two named instances** of the Tinybird component and exercises
the public API end to end. It is the developer sandbox and the portability proof at once.

## What it is proving

The component has to work in an application that knows nothing about it. So this app has an
ordinary domain schema (`orders`), imports `convex` and `@fantastic-dev/convex-tinybird` and
nothing else, and mounts the component twice under different names.

Two mounts rather than one is deliberate. The component's own test suite registers a single
instance, so it cannot see state leaking between mounts — a shared settings row, or one pause
switch stopping both streams, would pass there and fail here.

## What is enforced, and by what

- **Runtime dependencies** are enforced by `scripts/check-boundary.mjs`, which scans
  `example/convex` as well as `src`. It permits `@fantastic-dev/convex-tinybird` and rejects
  every other `@fantastic-dev/` package, `packages/backend`, Better Auth, and any read of the
  caller's identity.
- **The tsconfig extends the repository's base**, and that is not a hole in the claim: it is a
  build setting, not a dependency, and a real consumer writes their own. The dependency claim
  lives in `package.json` and in the boundary script, both of which are checked.

## Running it

```bash
pnpm --filter @fantastic-dev/convex-tinybird-example run test       # convex-test, no network
pnpm --filter @fantastic-dev/convex-tinybird-example run typecheck
CONVEX_AGENT_MODE=anonymous pnpm --filter @fantastic-dev/convex-tinybird-example exec convex dev --once
```

**Credentials must be set on the DEPLOYMENT, not in your shell.** The `process.env.…` reads in
`convex.config.ts` are evaluated by the backend inside an isolate, so they resolve against the
deployment's environment — a shell variable and a `.env.local` both leave the mounts
unconfigured, and the component is _inert_ when unconfigured: enqueue still stores events,
nothing is scheduled, and no request leaves. There is no error anywhere. Verification reproduced
all three legs; only this works:

```bash
cd packages/convex-tinybird/example

# FIRST. `convex env set` writes to a deployment, so there has to be one — on a fresh clone this
# line is the difference between the block working and `✖ No CONVEX_DEPLOYMENT set`. It is the
# same command as the last line; it appears twice because the first call PROVISIONS and the last
# call re-pushes so the mounts re-read their env.
CONVEX_AGENT_MODE=anonymous npx convex dev --once

CONVEX_AGENT_MODE=anonymous npx convex env set PRODUCT_TINYBIRD_TOKEN p.your_token
CONVEX_AGENT_MODE=anonymous npx convex env set AUDIT_TINYBIRD_TOKEN   p.your_token

CONVEX_AGENT_MODE=anonymous npx convex dev --once     # re-push so the mounts pick them up
```

Check it took: `health.configured` must be `true` on both mounts. If it is `false`, the tokens
did not reach the deployment and every enqueue will sit there silently.

Note that `pnpm codegen` in this package's `package.json` is **not** the command to run: app-level
`convex codegen` needs a deployment and fails with `No CONVEX_DEPLOYMENT set` on a fresh clone.
Use the `convex dev --once` line above, which provisions one and generates.

The last command provisions a local deployment and regenerates `convex/_generated`, which is
committed. It also rewrites the component's own `_generated`, because a component's generated
code is produced by pushing a host that mounts it — `convex codegen --component-dir` needs a real
deployment and cannot do it standalone.

## Files

| Path                      | Why it exists                                                       |
| ------------------------- | ------------------------------------------------------------------- |
| `convex/convex.config.ts` | Mounts both instances with separate credentials                     |
| `convex/schema.ts`        | An unrelated domain table — the component requires nothing of it    |
| `convex/orders.ts`        | Enqueue inside the caller's transaction; status and health queries  |
| `convex/maintenance.ts`   | The cron work a host owns: rescue stuck rows, then sweep            |
| `convex/orders.test.ts`   | Delivery, transactional rollback, mount isolation, conflict, replay |

`maintenance.ts` is not called `crons.ts` because Convex reserves that filename for a module
whose default export is a Crons object.
