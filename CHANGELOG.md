# Changelog

## [0.2.1](https://github.com/FantasticDevHQ/convex-tinybird/compare/v0.2.0...v0.2.1) (2026-09-26)


### Continuous Integration

* automate version bumps and npm releases with Release Please (FTD-2876) ([c30392e](https://github.com/FantasticDevHQ/convex-tinybird/commit/c30392eeba9d6eb7d424ae036a61937a9182169f))
* automate version bumps and npm releases with Release Please (FTD-2876) ([d9eae1a](https://github.com/FantasticDevHQ/convex-tinybird/commit/d9eae1a8eda1e335e74a1d5e97ae06db0ecea175))

## 0.2.0 — 2026-09-26

- **Renamed to `@fantastic.dev/convex-tinybird` and published publicly to npmjs.com.** Installing needs no registry token or `.npmrc` scope mapping. Replace the old `@fantasticdevhq`-scoped name with `@fantastic.dev/convex-tinybird` in `package.json` and imports, and drop the `@fantasticdevhq` registry line and GitHub Packages token from `.npmrc`; the API is unchanged. Releases publish through npm trusted publishing with provenance, so no long-lived npm token exists. `0.1.0` stays on GitHub Packages under the old name and receives no further releases.
- Docs: the consumer guide now states that `TINYBIRD_*` values live on the Convex deployment (`npx convex env set`), never in a local `.env`; Tinybird provisioning moved to `docs/tinybird-setup.md`; the monorepo-era "install in another app" framing and the maintainer-only test-failure record are gone.

## 0.1.0 — 2026-09-11

First release, published privately to GitHub Packages from the standalone `FantasticDevHQ/convex-tinybird` repository. The component was developed inside the `fantastic-dev` monorepo and extracted with its full history.

- Reusable Convex component with durable Tinybird delivery, retries, recovery and bounded operator controls.
- Scoped read-token signing, browser endpoint client and a Convex test registration helper.
- Compiled ESM and declaration exports with retained component source for Convex tooling.
