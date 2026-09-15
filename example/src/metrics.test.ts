import {
  describeMode,
  fillHours,
  fillMinutes,
  formatAge,
  formatCount,
  formatSince,
  minuteTick,
  mountMode,
  orderShare,
  parseClickHouseUtc,
  SERIES_DARK,
  SERIES_LIGHT,
  skuColor,
  SKUS,
  stateLabel,
} from "./metrics";

describe("mountMode", () => {
  it("is inert without a token, whatever paused says", () => {
    expect(mountMode({ configured: false, paused: false })).toBe("inert");
    expect(mountMode({ configured: false, paused: true })).toBe("inert");
  });
  it("is paused before live", () => {
    expect(mountMode({ configured: true, paused: true })).toBe("paused");
    expect(mountMode({ configured: true, paused: false })).toBe("live");
  });
  it("explains inert in terms of the deployment, not a .env file", () => {
    expect(describeMode("inert")).toMatch(/TINYBIRD_TOKEN on this deployment/);
    expect(describeMode("inert")).toMatch(/re-pushed/);
  });
});

describe("formatAge", () => {
  it("rounds to whole seconds and rolls over units", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(2_499)).toBe("2s");
    expect(formatAge(125_000)).toBe("2m 05s");
    expect(formatAge(3_840_000)).toBe("1h 04m");
  });
  it("shows a dash when nothing is waiting", () => {
    expect(formatAge(null)).toBe("–");
    expect(formatAge(undefined)).toBe("–");
  });
  it("never goes negative on clock skew", () => {
    expect(formatAge(-5_000)).toBe("0s");
  });
});

describe("formatSince / stateLabel / formatCount", () => {
  it("says never until something delivered", () => {
    expect(formatSince(undefined, 1_000)).toBe("never");
    expect(formatSince(1_000, 13_000)).toBe("12s ago");
  });
  it("labels a missing status honestly", () => {
    expect(stateLabel(null)).toBe("not enqueued");
    expect(stateLabel("delivered")).toBe("delivered");
  });
  it("marks a capped count as a floor", () => {
    expect(formatCount({ count: 12, capped: false })).toBe("12");
    expect(formatCount({ count: 500, capped: true })).toBe("500+");
  });
});

describe("skuColor", () => {
  it("assigns colours by SKU identity in fixed order, not by rank", () => {
    expect(skuColor("mug-blue", false)).toBe(SERIES_LIGHT[0]);
    expect(skuColor("poster-a2", false)).toBe(SERIES_LIGHT[3]);
    expect(skuColor("poster-a2", true)).toBe(SERIES_DARK[3]);
    expect(SKUS.length).toBe(SERIES_LIGHT.length);
  });
  it("gives an unknown SKU a stable colour instead of throwing", () => {
    expect(skuColor("mystery", false)).toBe(SERIES_LIGHT[3]);
  });
});

describe("orderShare", () => {
  it("turns counts into percentages that sum to 100", () => {
    const share = orderShare([
      { sku: "a", orders: 3, units: 3 },
      { sku: "b", orders: 1, units: 1 },
    ]);
    expect(share.map((r) => r.share)).toEqual([75, 25]);
  });
  it("is empty rather than NaN with no orders", () => {
    expect(orderShare([])).toEqual([]);
    expect(orderShare([{ sku: "a", orders: 0, units: 0 }])).toEqual([]);
  });
});

describe("fillMinutes", () => {
  const now = Date.UTC(2026, 8, 15, 13, 45, 30);
  it("emits every minute of the window ending now, zeros where Tinybird had no row", () => {
    const filled = fillMinutes([{ minute: "2026-09-15 13:44:00", orders: 2 }], now, 3);
    expect(filled).toEqual([
      { minute: "2026-09-15 13:43:00", orders: 0 },
      { minute: "2026-09-15 13:44:00", orders: 2 },
      { minute: "2026-09-15 13:45:00", orders: 0 },
    ]);
  });
  it("drops rows outside the window instead of stretching it", () => {
    const filled = fillMinutes([{ minute: "2026-09-15 12:00:00", orders: 9 }], now, 2);
    expect(filled.every((r) => r.orders === 0)).toBe(true);
    expect(filled).toHaveLength(2);
  });
  it("reads ClickHouse timestamps as UTC", () => {
    expect(parseClickHouseUtc("2026-09-15 13:44:00")).toBe(Date.UTC(2026, 8, 15, 13, 44));
    expect(minuteTick("2026-09-15 13:44:00")).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("fillHours", () => {
  it("emits 24 hourly buckets ending at the current hour with units carried through", () => {
    const now = Date.UTC(2026, 8, 15, 13, 45, 30);
    const filled = fillHours([{ hour: "2026-09-15 12:00:00", orders: 3, units: 7 }], now);
    expect(filled).toHaveLength(24);
    expect(filled.at(-1)).toEqual({ bucket: "2026-09-15 13:00:00", orders: 0, units: 0 });
    expect(filled.at(-2)).toEqual({ bucket: "2026-09-15 12:00:00", orders: 3, units: 7 });
  });
});
