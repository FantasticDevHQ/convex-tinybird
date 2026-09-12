/**
 * Pure presentation helpers for the demo page. Kept free of React and Convex so they can be
 * unit-tested with the rest of the example's Vitest suite.
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

/** "3s", "2m 05s", "1h 04m"; null when nothing is waiting. */
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
