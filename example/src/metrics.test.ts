import { describeMode, formatAge, formatCount, formatSince, mountMode, stateLabel } from "./metrics";

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

describe("formatSince / stateLabel", () => {
  it("says never until something delivered", () => {
    expect(formatSince(undefined, 1_000)).toBe("never");
    expect(formatSince(1_000, 13_000)).toBe("12s ago");
  });
  it("labels a missing status honestly", () => {
    expect(stateLabel(null)).toBe("not enqueued");
    expect(stateLabel("delivered")).toBe("delivered");
  });
});

describe("formatCount", () => {
  it("marks a capped count as a floor", () => {
    expect(formatCount({ count: 12, capped: false })).toBe("12");
    expect(formatCount({ count: 500, capped: true })).toBe("500+");
  });
});
