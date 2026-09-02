import { DEFAULT_TINYBIRD_HOST, eventsUrl, resolveDestination } from "./destination";

describe("resolveDestination — accepted", () => {
  it("falls back to Tinybird's default host when none is configured", () => {
    for (const value of [undefined, "", "   "]) {
      expect(resolveDestination(value)).toEqual({ ok: true, host: DEFAULT_TINYBIRD_HOST });
    }
  });

  it("accepts a regional https host and strips trailing slashes", () => {
    expect(resolveDestination("https://api.eu-central-1.aws.tinybird.co")).toEqual({
      ok: true,
      host: "https://api.eu-central-1.aws.tinybird.co",
    });
    expect(resolveDestination("https://api.tinybird.co///")).toEqual({
      ok: true,
      host: "https://api.tinybird.co",
    });
  });

  it("returns a normalised origin rather than whatever was typed", () => {
    // Everything downstream concatenates onto this, so it has to be an origin and not the
    // operator's formatting: an uppercase scheme, a default port and a trailing path all
    // resolve to the same base URL.
    expect(resolveDestination("HTTPS://API.TINYBIRD.CO:443/")).toEqual({
      ok: true,
      host: "https://api.tinybird.co",
    });
  });

  it("accepts plain http only for a loopback address, which is Tinybird Local", () => {
    expect(resolveDestination("http://localhost:7181")).toEqual({
      ok: true,
      host: "http://localhost:7181",
    });
    expect(resolveDestination("http://127.0.0.1:7181")).toEqual({
      ok: true,
      host: "http://127.0.0.1:7181",
    });
  });
});

describe("resolveDestination — rejected", () => {
  it("refuses plain http to a real host, which would send the token in clear", () => {
    expect(resolveDestination("http://api.tinybird.co")).toMatchObject({ ok: false });
  });

  it.each([
    ["a path", "https://api.tinybird.co/v0"],
    ["a query string", "https://api.tinybird.co?token=leak"],
    ["a fragment", "https://api.tinybird.co#frag"],
    ["embedded credentials", "https://user:pass@api.tinybird.co"],
    ["a non-http scheme", "ftp://api.tinybird.co"],
    ["something that is not a URL", "api.tinybird.co"],
    ["an empty-looking URL", "https://"],
  ])("refuses %s", (_label, value) => {
    expect(resolveDestination(value)).toMatchObject({ ok: false });
  });

  it("never quotes the configured value back, since it can carry a credential", () => {
    const rejected = resolveDestination("https://user:p.secret-token@api.tinybird.co");
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("unreachable");
    expect(rejected.reason).not.toContain("p.secret-token");
    expect(rejected.reason).not.toContain("user");
  });
});

describe("eventsUrl", () => {
  it("targets the events endpoint for one datasource and waits for the write", () => {
    expect(eventsUrl("https://api.tinybird.co", "orders")).toBe(
      "https://api.tinybird.co/v0/events?name=orders&wait=true",
    );
  });

  it("encodes the datasource name rather than letting it shape the URL", () => {
    expect(eventsUrl("https://api.tinybird.co", "a b&c=d")).toBe(
      "https://api.tinybird.co/v0/events?name=a%20b%26c%3Dd&wait=true",
    );
  });
});
