import { ConvexError } from "convex/values";

import { canonicalJson, utf8Length } from "./canonical";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code?: string }).code;
    throw error;
  }
  return undefined;
}

describe("canonicalJson", () => {
  it("sorts object keys recursively and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it("keeps array order, unlike keys", () => {
    expect(canonicalJson({ a: [2, 1] })).toBe('{"a":[2,1]}');
  });

  it("treats key order as irrelevant to identity", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("rejects a non-object root", () => {
    expect(codeOf(() => canonicalJson("row"))).toBe("invalid_payload");
    expect(codeOf(() => canonicalJson(42))).toBe("invalid_payload");
    expect(codeOf(() => canonicalJson(null))).toBe("invalid_payload");
    expect(codeOf(() => canonicalJson([{ a: 1 }]))).toBe("invalid_payload");
  });

  it("rejects values JSON cannot carry faithfully", () => {
    expect(codeOf(() => canonicalJson({ a: undefined }))).toBe("invalid_payload");
    expect(codeOf(() => canonicalJson({ a: () => 1 }))).toBe("invalid_payload");
    expect(codeOf(() => canonicalJson({ a: 10n }))).toBe("invalid_payload");
    expect(codeOf(() => canonicalJson({ a: Number.NaN }))).toBe("invalid_payload");
    expect(codeOf(() => canonicalJson({ a: Number.POSITIVE_INFINITY }))).toBe("invalid_payload");
  });

  it("rejects nesting deeper than 32 levels", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 33; i += 1) deep = { deep };
    expect(codeOf(() => canonicalJson(deep))).toBe("invalid_payload");
  });

  it("names the reason in the error data", () => {
    try {
      canonicalJson({ a: undefined });
    } catch (error) {
      expect((error as ConvexError<{ reason: string }>).data.reason).toMatch(/undefined/);
      return;
    }
    throw new Error("expected canonicalJson to throw");
  });
});

describe("utf8Length", () => {
  it("counts bytes, not code units", () => {
    expect(utf8Length("abc")).toBe(3);
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("😀")).toBe(4);
  });
});
