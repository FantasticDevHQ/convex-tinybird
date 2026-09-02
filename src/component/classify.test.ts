import { classifyResponse } from "./classify";

describe("classifyResponse — accepted", () => {
  it.each([200, 202])(
    "treats %i with one successful row and no quarantine as delivered",
    (status) => {
      expect(classifyResponse(status, { successful_rows: 1, quarantined_rows: 0 })).toEqual({
        kind: "delivered",
      });
    },
  );

  it("accepts more than one successful row", () => {
    expect(classifyResponse(200, { successful_rows: 5, quarantined_rows: 0 })).toEqual({
      kind: "delivered",
    });
  });
});

describe("classifyResponse — quarantined", () => {
  it("fails when Tinybird quarantined the row even though the request succeeded", () => {
    const result = classifyResponse(200, { successful_rows: 0, quarantined_rows: 1 });
    expect(result).toMatchObject({ kind: "failed", category: "quarantined", httpStatus: 200 });
  });

  it("fails when a row was accepted and another quarantined", () => {
    expect(classifyResponse(202, { successful_rows: 1, quarantined_rows: 1 })).toMatchObject({
      kind: "failed",
      category: "quarantined",
    });
  });

  it("fails when nothing was accepted and nothing was quarantined", () => {
    expect(classifyResponse(200, { successful_rows: 0, quarantined_rows: 0 })).toMatchObject({
      kind: "failed",
      category: "quarantined",
    });
  });
});

describe("classifyResponse — terminal client errors", () => {
  it.each([
    [400, "invalid_request"],
    [422, "invalid_request"],
    [404, "not_found"],
    [413, "payload_too_large"],
  ])("maps %i to a terminal %s failure", (status, category) => {
    const result = classifyResponse(status, null);
    expect(result).toMatchObject({ kind: "failed", category, httpStatus: status });
  });

  it("never puts a response body into the message", () => {
    const result = classifyResponse(400, { error: "token p.abcdef is invalid" });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.message).not.toContain("p.abcdef");
  });
});

describe("classifyResponse — retryable", () => {
  it("treats a rate limit as retryable so the budget absorbs a burst", () => {
    expect(classifyResponse(429, null)).toMatchObject({
      kind: "retryable",
      category: "rate_limited",
      httpStatus: 429,
    });
  });

  it.each([500, 502, 503, 504])("treats %i as a retryable server error", (status) => {
    expect(classifyResponse(status, null)).toMatchObject({
      kind: "retryable",
      category: "server_error",
      httpStatus: status,
    });
  });

  it("retries an accepted status with an unreadable body rather than guessing", () => {
    // Tinybird said 200 but we cannot tell whether the row landed or was quarantined.
    // Claiming delivered would silently lose an event; claiming quarantined would
    // dead-letter one that arrived. Re-sending is safe because Tinybird dedupes on event_id.
    expect(classifyResponse(200, null)).toMatchObject({ kind: "retryable", httpStatus: 200 });
    expect(classifyResponse(200, { successful_rows: "1" })).toMatchObject({ kind: "retryable" });
    expect(classifyResponse(202, {})).toMatchObject({ kind: "retryable" });
  });

  it("retries a status it has no rule for, rather than silently dropping the event", () => {
    // 401 and 403 become a destination pause in a later layer; until then the safe reading
    // of an unknown status is "upstream problem", which retries and then dead-letters
    // rather than discarding the row.
    for (const status of [401, 403, 418]) {
      expect(classifyResponse(status, null)).toMatchObject({
        kind: "retryable",
        httpStatus: status,
      });
    }
  });

  it("never quotes a response body in a retryable message either", () => {
    const result = classifyResponse(503, { error: "upstream said p.token-leak" });
    expect(result.kind).toBe("retryable");
    if (result.kind !== "retryable") throw new Error("unreachable");
    expect(result.message).not.toContain("p.token-leak");
  });
});
