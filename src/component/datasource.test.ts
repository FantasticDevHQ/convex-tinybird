import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Pins the invariants of the reference datasource in `tinybird/`.
 *
 * It does NOT tie the component's output to these columns, and an earlier version of this
 * docstring claimed that it did. The component sends the host's `payload` object verbatim as one
 * canonical NDJSON line — it constructs no columns of its own — so "the component's output" is
 * whatever the host passes, and the example passes `{order_id, sku, quantity}`, which is not this
 * schema at all. The two are independent: `tinybird/` is a reference a host can copy, the example
 * is a different stream that never reaches it.
 *
 * The old first test made the false claim look checked. It built a row literal BY HAND to match
 * these columns and asserted its keys were declared here — but `canonicalJson` only sorts keys,
 * so `Object.keys(JSON.parse(canonicalJson(literal)))` is just the literal's own key names. It
 * compared a hand-typed list against the file, with the component nowhere in the loop; swapping
 * `canonicalJson` for `JSON.stringify` left it green. Every mutant it appeared to kill was killed
 * by the key-name list.
 *
 * So what is left is what is actually true and worth holding: the one column the component
 * requires exists and has the type it needs, and the columns a minimal sender omits still carry
 * their defaults. Both are properties of this file, which is what this test can see.
 *
 * Whether a request SUCCEEDS is `tinybird/smoke.sh`, which needs Docker and does not run in CI.
 */
const datasource = readFileSync(
  new URL("../../tinybird/datasources/events.datasource", import.meta.url),
  "utf8",
);

/** Column names the datasource declares, in declaration order. */
function declaredColumns(): string[] {
  const schema = /SCHEMA >([\s\S]*?)\n\n/u.exec(datasource);
  expect(schema).not.toBeNull();
  return [...(schema?.[1] ?? "").matchAll(/^\s*`(\w+)`/gmu)].map((match) => match[1]);
}

describe("the reference datasource keeps the guarantees the component depends on", () => {
  it("declares event_id as a String, which is the one column the component requires", () => {
    // The component's only demand on the host's schema. Everything else here is the host's
    // choice, and this is the line that stops a rename from being a silent contract break.
    // Two checks, and they are not redundant even though the regex below is stricter about the
    // type. `declaredColumns()` parses the SCHEMA block, so it answers "is this column DECLARED";
    // the regex reads raw file text and would be satisfied by the same words in a comment or in
    // a different section. Keeping both means moving `event_id` out of SCHEMA fails here, and
    // retyping it fails below.
    expect(declaredColumns()).toContain("event_id");

    // The TYPE, not just the name. Convex ids are strings, so a schema declaring `event_id` as
    // anything numeric quarantines every row the component sends — and presence alone could not
    // see that: changing `String` to `UInt64` here left the previous version of this file green.
    expect(datasource).toMatch(/`event_id`\s+String/u);
  });

  it("declares occurred_at with sub-second precision", () => {
    // `DateTime` instead of `DateTime64(3)` truncates to whole seconds, which silently collapses
    // the ordering of events enqueued in the same second rather than failing. Also invisible to
    // a name-only check.
    expect(datasource).toMatch(/`occurred_at`\s+DateTime64\(3/u);
  });

  it("declares the columns the datasource can default, so a minimal row is still valid", () => {
    // `received_at` and `version` have DEFAULTs, which is what lets a sender omit them. If a
    // future edit drops the default, a minimal row starts being quarantined in production and
    // nothing before this test would say so.
    expect(datasource).toMatch(/`received_at`[^\n]*DEFAULT now64\(3\)/u);
    expect(datasource).toMatch(/`version`[^\n]*DEFAULT 1/u);
  });

  it("keeps the engine that makes re-delivery harmless", () => {
    // The component delivers at least once, so this engine is part of the contract rather than
    // a tuning choice. Changing it to a plain MergeTree would make every retry a duplicate row
    // that no query removes.
    expect(datasource).toMatch(/ENGINE\s+"ReplacingMergeTree"/u);
    expect(datasource).toMatch(/ENGINE_VER\s+"version"/u);
    expect(datasource).toMatch(/ENGINE_SORTING_KEY\s+"event_id"/u);
  });

  it("reads with FINAL, because dedupe does not happen on ingest", () => {
    const pipe = readFileSync(
      new URL("../../tinybird/pipes/events_by_type.pipe", import.meta.url),
      "utf8",
    );
    // Measured rather than assumed: smoke.sh observes 3 raw rows returning a count of 1, and
    // the same query without FINAL returning 3 at the same instant on the same data.
    //
    // This line said "2 raw rows" until re-verification caught it. Everywhere else in this change
    // the 2 is framed as a misreading — it was a partially ingested table, not a merge — but here
    // the repudiated number was still standing as the live evidence for the assertion below. A
    // correction that misses one site leaves the wrong number in the one place that reads like
    // proof.
    expect(pipe).toMatch(/FROM events FINAL/u);
  });
});
