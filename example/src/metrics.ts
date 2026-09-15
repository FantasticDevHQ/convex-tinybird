/**
 * Pure presentation helpers for the demo page. Kept free of React, Convex and Tinybird so they
 * can be unit-tested with the rest of the example's Vitest suite.
 */

export type BoundedCount = { count: number; capped: boolean };

export type MountHealth = {
  configured: boolean;
  readTokensConfigured: boolean;
  paused: boolean;
  pausedReason?: unknown;
  counts: { pending: BoundedCount; delivering: BoundedCount; failed: BoundedCount };
  oldestPendingAgeMs: number | null;
  lastDeliveredAt?: number;
  lastError?: { category?: string; message?: string } | undefined;
};

export type MountMode = "inert" | "paused" | "live";

/** Whether a mount would actually send anything right now, and why not if not. */
export function mountMode(health: Pick<MountHealth, "configured" | "paused">): MountMode {
  if (!health.configured) return "inert";
  if (health.paused) return "paused";
  return "live";
}

export function describeMode(mode: MountMode): string {
  switch (mode) {
    case "inert":
      return "Delivery is inert: no TINYBIRD_TOKEN on this deployment. Events are stored and will go out once the deployment has a token and is re-pushed.";
    case "paused":
      return "Delivery is paused. Resume it from the operator surface once the destination is fixed.";
    case "live":
      return "Delivery is live.";
  }
}

/** "3s", "2m 05s", "1h 04m"; a dash when nothing is waiting. */
export function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Relative wall-clock, for "last delivered 12s ago". */
export function formatSince(at: number | undefined, now: number): string {
  if (at === undefined) return "never";
  return `${formatAge(now - at)} ago`;
}

/** Turn a delivery state into the word the page shows; unknown states pass through. */
export function stateLabel(state: string | null): string {
  if (state === null) return "not enqueued";
  return state;
}

/** "12" or "500+" when the component stopped counting at its cap. */
export function formatCount(count: BoundedCount): string {
  return count.capped ? `${count.count}+` : String(count.count);
}

// ------------------------------------------------------------------------ chart shaping

/**
 * The SKUs the form offers, in the fixed order their colours are assigned. Colour follows the
 * entity, never its rank: `mug-blue` is slot 1 whether it is the top seller or absent.
 */
export const SKUS = ["mug-blue", "mug-red", "tee-black", "poster-a2"] as const;
export type Sku = (typeof SKUS)[number];

/** Validated 4-slot categorical palette (light / dark), one slot per SKU in SKUS order. */
export const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"] as const;
export const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500"] as const;

export function skuColor(sku: string, dark: boolean): string {
  const index = (SKUS as readonly string[]).indexOf(sku);
  const palette = dark ? SERIES_DARK : SERIES_LIGHT;
  // An unknown SKU (someone edited the data) still gets a stable, visible colour: the last slot.
  return palette[index === -1 ? palette.length - 1 : index];
}

export type SkuRow = { sku: string; orders: number; units: number };

/** Share of orders per SKU as a percentage, summing to ~100; empty input stays empty. */
export function orderShare(rows: SkuRow[]): Array<SkuRow & { share: number }> {
  const total = rows.reduce((sum, r) => sum + r.orders, 0);
  if (total === 0) return [];
  return rows.map((r) => ({ ...r, share: Math.round((r.orders / total) * 1000) / 10 }));
}

export type BucketRow = { bucket: string; orders: number; units?: number };

/**
 * Tinybird returns only the buckets that had rows. A trend chart needs every bucket of the
 * window, zeros included, or a quiet stretch reads as a straight ramp between two busy ones.
 * Bucket labels are ClickHouse DateTime strings ("2026-09-15 13:41:00"), treated as UTC.
 */
export function fillBuckets(
  rows: Array<{ bucket: string; orders: number; units?: number }>,
  now: number,
  count: number,
  stepMs: number,
): BucketRow[] {
  const byBucket = new Map<number, { orders: number; units?: number }>();
  for (const row of rows) byBucket.set(parseClickHouseUtc(row.bucket), row);
  const end = Math.floor(now / stepMs) * stepMs;
  const out: BucketRow[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const at = end - i * stepMs;
    const hit = byBucket.get(at);
    out.push({ bucket: formatClickHouseUtc(at), orders: hit?.orders ?? 0, units: hit?.units ?? 0 });
  }
  return out;
}

export type MinuteRow = { minute: string; orders: number };
export function fillMinutes(rows: MinuteRow[], now: number, windowMinutes = 15): MinuteRow[] {
  return fillBuckets(
    rows.map((r) => ({ bucket: r.minute, orders: r.orders })),
    now,
    windowMinutes,
    60_000,
  ).map((r) => ({ minute: r.bucket, orders: r.orders }));
}

export type HourRow = { hour: string; orders: number; units: number };
export function fillHours(rows: HourRow[], now: number, windowHours = 24): BucketRow[] {
  return fillBuckets(
    rows.map((r) => ({ bucket: r.hour, orders: r.orders, units: r.units })),
    now,
    windowHours,
    3_600_000,
  );
}

export function parseClickHouseUtc(value: string): number {
  return Date.parse(value.replace(" ", "T") + "Z");
}
function formatClickHouseUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** "13:41" local time for an axis tick, from a ClickHouse DateTime string. */
export function minuteTick(value: string): string {
  const d = new Date(parseClickHouseUtc(value));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
/** "13:00" local time for an hourly tick. */
export const hourTick = minuteTick;

// ------------------------------------------------------------------------ activity heatmap

export type DayRow = { day: string; orders: number; units: number };
export type ContributionDay = { date: string; count: number; level: 0 | 1 | 2 | 3 | 4 };

/**
 * GitHub-style levels: 0 for no orders, then quartiles of the non-zero days so the scale adapts
 * to the data instead of a fixed threshold. A single busy day should not make every other day
 * look empty, and a quiet year should still show gradation.
 */
export function contributionLevels(rows: DayRow[]): ContributionDay[] {
  const counts = rows.map((r) => r.orders).filter((n) => n > 0).sort((a, b) => a - b);
  const quantile = (q: number) => counts[Math.min(counts.length - 1, Math.floor(q * counts.length))] ?? 0;
  const cut = [quantile(0.25), quantile(0.5), quantile(0.75)];
  return rows.map((r) => {
    let level: ContributionDay["level"] = 0;
    if (r.orders > 0) level = r.orders <= cut[0] ? 1 : r.orders <= cut[1] ? 2 : r.orders <= cut[2] ? 3 : 4;
    return { date: r.day, count: r.orders, level };
  });
}

/** Sequential single-hue ramp for the heatmap (blue 100 → 550, light; 250 → 600 on dark). */
export const HEATMAP_LIGHT = { empty: "#f0efec", level1: "#cde2fb", level2: "#86b6ef", level3: "#3987e5", level4: "#1c5cab" };
export const HEATMAP_DARK = { empty: "#383835", level1: "#184f95", level2: "#256abf", level3: "#3987e5", level4: "#86b6ef" };
