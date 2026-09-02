/** Tinybird's default API host; every region has its own, set via `TINYBIRD_HOST`. */
export const DEFAULT_TINYBIRD_HOST = "https://api.tinybird.co";

/**
 * Base URL for the Events API. Trailing slashes are dropped so callers can always
 * concatenate a rooted path. Validation of scheme and shape is hardened separately.
 */
export function resolveHost(configured: string | undefined): string {
  const value = (configured ?? "").trim();
  if (value === "") return DEFAULT_TINYBIRD_HOST;
  return value.replace(/\/+$/u, "");
}

/** The Events API endpoint for one datasource, waiting for the write to be acknowledged. */
export function eventsUrl(host: string, datasource: string): string {
  return `${host}/v0/events?name=${encodeURIComponent(datasource)}&wait=true`;
}
