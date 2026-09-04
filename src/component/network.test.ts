import { describe, expect, it, vi } from "vitest";

/**
 * The guard in `vitest.setup.ts`, asserted rather than assumed.
 *
 * Without a test the guard is invisible: every existing test stubs `fetch`, so removing the
 * setup file changes nothing anyone would notice until a future test forgot to stub and
 * quietly reached the real internet. That is the failure mode this package cannot afford,
 * because its whole job is making HTTP requests.
 */
describe("the network is refused unless a test stubs it", () => {
  it("throws with a message that says what to do", async () => {
    // The setup file installed this. No test in this file stubs `fetch`, so this is the guard.
    await expect(fetch("https://api.tinybird.co/v0/events")).rejects.toThrow(
      /network disabled in tests/u,
    );
  });

  it("still lets a test replace it", async () => {
    const stubbed = new Response("{}", { status: 200 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stubbed));
    // If the guard were installed in a way a test could not override, every other test in this
    // package would fail — so this is the half that proves the guard is usable, not just loud.
    await expect(fetch("https://api.tinybird.co/v0/events")).resolves.toBe(stubbed);
    vi.unstubAllGlobals();
  });
});
