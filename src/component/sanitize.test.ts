import { MAX_ERROR_MESSAGE_LENGTH, sanitizeMessage } from "./sanitize";

describe("sanitizeMessage", () => {
  it("redacts the append token wherever it appears", () => {
    expect(sanitizeMessage("auth failed for Bearer p.secret-token", "p.secret-token")).toBe(
      "auth failed for Bearer [redacted]",
    );
  });

  it("redacts every occurrence, not only the first", () => {
    const result = sanitizeMessage("p.tok then p.tok again", "p.tok");
    expect(result).not.toContain("p.tok");
    expect(result.split("[redacted]")).toHaveLength(3);
  });

  it("leaves the message alone when there is no token configured", () => {
    expect(sanitizeMessage("plain failure", undefined)).toBe("plain failure");
    expect(sanitizeMessage("plain failure", "   ")).toBe("plain failure");
  });

  it("collapses newlines and surrounding whitespace so one error stays one line", () => {
    expect(sanitizeMessage("  first\n\tsecond   third  ")).toBe("first second third");
  });

  it("truncates a hostile upstream message and marks the cut", () => {
    const result = sanitizeMessage("x".repeat(5_000));
    expect(result).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
    expect(result.endsWith("…")).toBe(true);
  });

  it("redacts before truncating, so a token near the end cannot survive", () => {
    const message = `${"x".repeat(MAX_ERROR_MESSAGE_LENGTH - 5)} p.secret`;
    expect(sanitizeMessage(message, "p.secret")).not.toContain("p.secret");
  });
});
