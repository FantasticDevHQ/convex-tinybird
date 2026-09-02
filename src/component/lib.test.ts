import { convexTest } from "convex-test";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports an unconfigured, unpaused component with zero bounded counts", async () => {
    vi.stubEnv("TINYBIRD_TOKEN", "");
    const t = convexTest(schema, modules);

    const health = await t.query(api.lib.health, {});

    expect(health).toEqual({
      configured: false,
      paused: false,
      counts: {
        pending: { count: 0, capped: false },
        delivering: { count: 0, capped: false },
        failed: { count: 0, capped: false },
      },
    });
  });

  it("reports configured once the append token is present", async () => {
    vi.stubEnv("TINYBIRD_TOKEN", "p.append-token");
    const t = convexTest(schema, modules);

    const health = await t.query(api.lib.health, {});

    expect(health.configured).toBe(true);
  });

  it("treats a blank token as absent", async () => {
    vi.stubEnv("TINYBIRD_TOKEN", "   ");
    const t = convexTest(schema, modules);

    expect((await t.query(api.lib.health, {})).configured).toBe(false);
  });
});
