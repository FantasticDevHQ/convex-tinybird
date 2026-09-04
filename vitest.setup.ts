import { beforeEach, vi } from "vitest";

/**
 * No test in this package may reach the network.
 *
 * The component's whole job is making HTTP requests, so a test that forgets to stub `fetch`
 * does not fail — it succeeds against the real internet, or hangs, or fails for a reason that
 * looks like a bug in the code under test. Any of those is worse than a clear refusal, and the
 * example app inherits this for the same reason.
 *
 * Installed per test rather than once: a test that stubs `fetch` and a test that does not must
 * not depend on which ran first.
 */
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    // REJECTS rather than throwing synchronously, because real `fetch` rejects. A guard that
    // throws changes control flow: code that handles a rejected request would take a different
    // path under test than in production, which is the sort of difference a harness must not
    // introduce — this package has already been bitten twice by a harness that behaved
    // differently from the real thing.
    vi.fn(() =>
      Promise.reject(
        new Error(
          "network disabled in tests: stub `fetch` with vi.stubGlobal before making a request",
        ),
      ),
    ),
  );
});
