# Changelog

## Unreleased

- Docs: the consumer guide now states that `TINYBIRD_*` values live on the Convex deployment (`npx convex env set`), never in a local `.env`; Tinybird provisioning moved to `docs/tinybird-setup.md`; the monorepo-era "install in another app" framing and the maintainer-only test-failure record are gone.

## 0.1.0 — 2026-09-11

First release, published privately to GitHub Packages from the standalone `FantasticDevHQ/convex-tinybird` repository. The component was developed inside the `fantastic-dev` monorepo and extracted with its full history.

- Reusable Convex component with durable Tinybird delivery, retries, recovery and bounded operator controls.
- Scoped read-token signing, browser endpoint client and a Convex test registration helper.
- Compiled ESM and declaration exports with retained component source for Convex tooling.
