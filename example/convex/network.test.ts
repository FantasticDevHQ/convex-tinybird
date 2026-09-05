import { expect, it } from "vitest";

it("inherits the component's no-network guard", async () => {
  await expect(fetch("https://api.tinybird.co/v0/events")).rejects.toThrow(
    /network disabled in tests/u,
  );
});
