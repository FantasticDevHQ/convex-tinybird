import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical";

/**
 * Ties the component's output to the example datasource's columns.
 *
 * These two live in different languages and different directories, so nothing else notices when
 * they drift: a renamed column in the `.datasource` file, or a payload the component canonicalises
 * differently, would be found by Tinybird quarantining rows in production and nowhere earlier.
 *
 * This asserts the SHAPE agrees, not that a request succeeds — that is `tinybird/smoke.sh`, which
 * needs Docker and does not run in CI.
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

describe("what the component sends matches what the datasource declares", () => {
  it("produces a row whose keys are all declared columns", () => {
    const columns = declaredColumns();
    // Non-empty by assertion: a regex that silently matched nothing would make every check
    // below vacuously true.
    expect(columns.length).toBeGreaterThan(4);

    const row = JSON.parse(
      canonicalJson({
        event_id: "evt_1",
        event_type: "order_created",
        occurred_at: "2026-09-05 10:00:00.000",
        version: 1,
        payload: JSON.stringify({ sku: "SKU-1" }),
      }),
    ) as Record<string, unknown>;

    for (const key of Object.keys(row)) {
      expect(columns).toContain(key);
    }
  });

  it("declares event_id, which is the one column the component requires", () => {
    // The component's only demand on the host's schema. Everything else here is the host's
    // choice, and this is the line that stops a rename from being a silent contract break.
    expect(declaredColumns()).toContain("event_id");
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
    // Measured rather than assumed: smoke.sh has observed 2 raw rows returning a count of 1.
    // Without FINAL that query returns the raw count until merges happen to run.
    expect(pipe).toMatch(/FROM events FINAL/u);
  });
});
