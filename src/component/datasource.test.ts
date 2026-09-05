import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api";
import { canonicalJson } from "./canonical";
import { drain, installComponentTestHooks, jsonResponse, setup } from "../testing/fixtures";

installComponentTestHooks();

const datasource = readFileSync(
  new URL("../../tinybird/datasources/events.datasource", import.meta.url),
  "utf8",
);
const schema = /SCHEMA >([\s\S]*?)\n\n/u.exec(datasource)?.[1] ?? "";

describe("the generic Tinybird reference contract", () => {
  it("delivers the smoke fixture as canonical NDJSON matching the datasource", async () => {
    const sample = JSON.parse(
      readFileSync(new URL("../../tinybird/fixtures/event.ndjson", import.meta.url), "utf8"),
    ) as {
      event_id: string;
      event_type: string;
      occurred_at: string;
      version: number;
      payload: string;
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { successful_rows: 1, quarantined_rows: 0 }));
    vi.stubGlobal("fetch", fetchSpy);
    const t = setup();
    await t.mutation(api.lib.enqueue, {
      datasource: "events",
      eventId: sample.event_id,
      payload: sample,
    });
    await drain(t);
    const [url, request] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("name=events");
    expect(request.body).toBe(`${canonicalJson(sample)}\n`);
    if (typeof request.body !== "string") throw new Error("Expected canonical NDJSON body");
    const encoded = JSON.parse(request.body) as Record<string, unknown>;
    const columns = [...schema.matchAll(/^\s*`(\w+)`/gmu)].map((match) => match[1]);
    expect(Object.keys(encoded).sort()).toEqual(
      columns.filter((column) => column !== "received_at").sort(),
    );
    expect(encoded.event_id).toBe(sample.event_id);
    expect(encoded.payload).toBe(sample.payload);
    expect(request.body.trim().split("\n")).toHaveLength(1);
  });

  it("preserves the reference identity and millisecond timestamp types", () => {
    expect(schema).toMatch(/`event_id`\s+String/u);
    expect(schema).toMatch(/`occurred_at`\s+DateTime64\(3/u);
  });

  it("defaults fields omitted by a minimal sender", () => {
    expect(schema).toMatch(/`received_at`[^\n]*DEFAULT now64\(3\)/u);
    expect(schema).toMatch(/`version`[^\n]*DEFAULT 1/u);
  });

  it("keeps versioned replacement by identity", () => {
    expect(datasource).toMatch(/ENGINE\s+"ReplacingMergeTree"/u);
    expect(datasource).toMatch(/ENGINE_VER\s+"version"/u);
    expect(datasource).toMatch(/ENGINE_SORTING_KEY\s+"event_id"/u);
  });

  it("deduplicates at read time before counting", () => {
    const pipe = readFileSync(
      new URL("../../tinybird/pipes/events_by_type.pipe", import.meta.url),
      "utf8",
    );
    expect(pipe).toMatch(/FROM events FINAL/u);
  });
});
