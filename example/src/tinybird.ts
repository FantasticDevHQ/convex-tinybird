/**
 * Browser-side reads from Tinybird for the demo page.
 *
 * The page never holds a static Tinybird credential. It asks the host (dashboard.demoReadToken)
 * for a short-lived JWT scoped to the demo's endpoints, keeps it in memory, and renews it before
 * expiry. Every read goes through the package's `./browser` entry.
 */
import { queryPipe, TinybirdQueryError } from "@fantasticdevhq/convex-tinybird/browser";

export type ReadToken = { token: string; expiresAt: number; host: string };

/** Renew when less than a fifth of the lifetime is left. `expiresAt` is Unix seconds. */
export function tokenIsFresh(token: ReadToken | null, nowMs: number, ttlSeconds = 300): boolean {
  if (!token) return false;
  return token.expiresAt * 1000 - nowMs > ttlSeconds * 1000 * 0.2;
}

export type Summary = { orders: number; units: number; skus: number };
export type SkuRow = { sku: string; orders: number; units: number };
export type MinuteRow = { minute: string; orders: number };
export type HourRow = { hour: string; orders: number; units: number };
export type AuditRow = { action: string; events: number };
export type Snapshot = {
  summary: Summary;
  bySku: SkuRow[];
  perMinute: MinuteRow[];
  perHour: HourRow[];
  audit: AuditRow[];
  readAt: number;
};

/** One round trip per endpoint, in parallel, sharing the signal. */
export async function readSnapshot(token: ReadToken, signal: AbortSignal): Promise<Snapshot> {
  const read = <T,>(pipe: string) =>
    queryPipe<T>({ host: token.host, token: token.token, pipe, params: {}, signal });
  const [summary, bySku, perMinute, perHour, audit] = await Promise.all([
    read<Summary>("orders_summary"),
    read<SkuRow>("orders_by_sku"),
    read<MinuteRow>("orders_per_minute"),
    read<HourRow>("orders_per_hour"),
    read<AuditRow>("audit_actions"),
  ]);
  return {
    summary: summary.data[0] ?? { orders: 0, units: 0, skus: 0 },
    bySku: bySku.data,
    perMinute: perMinute.data,
    perHour: perHour.data,
    audit: audit.data,
    readAt: Date.now(),
  };
}

export function describeReadError(error: unknown): string {
  if (error instanceof TinybirdQueryError) {
    switch (error.code) {
      case "token_expired_or_invalid":
        return "Tinybird rejected the read token; it will be renewed on the next tick.";
      case "rate_limited":
        return "Tinybird rate-limited the page; backing off.";
      case "bad_request":
        return "Tinybird rejected the request. Are the demo pipes deployed to this workspace?";
      case "unavailable":
        return "Tinybird did not answer. Is Tinybird Local still running?";
    }
  }
  return String(error);
}
