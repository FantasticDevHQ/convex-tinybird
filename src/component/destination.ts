/** Tinybird's default API host; every region has its own, set via `TINYBIRD_HOST`. */
export const DEFAULT_TINYBIRD_HOST = "https://api.tinybird.co";

/** Hostnames allowed to use plain http, because they never leave the machine. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A usable base URL, or the reason it was refused. Reasons never quote the input. */
export type ResolvedDestination = { ok: true; host: string } | { ok: false; reason: string };

/**
 * Validate `TINYBIRD_HOST` into a base URL.
 *
 * This is a credential boundary, not a formatting nicety. The append token is sent on every
 * request to whatever this resolves to, so a host with a path or query could redirect the
 * request somewhere unintended, embedded credentials could smuggle a second identity, and
 * plain http would put the token on the wire in clear. Tinybird Local is the one exception,
 * because loopback traffic never leaves the machine.
 *
 * A bad host pauses the destination rather than failing events: the rows are fine, the
 * configuration is not.
 */
export function resolveDestination(configured: string | undefined): ResolvedDestination {
  const value = (configured ?? "").trim();
  if (value === "") return { ok: true, host: DEFAULT_TINYBIRD_HOST };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "TINYBIRD_HOST is not a valid URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "TINYBIRD_HOST must use https" };
  }
  if (url.username !== "" || url.password !== "") {
    // Reported without the value: the credential is the whole problem.
    return { ok: false, reason: "TINYBIRD_HOST must not embed credentials" };
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    return { ok: false, reason: "TINYBIRD_HOST must use https except for a loopback address" };
  }
  // Only slashes is still a bare origin; anything else is a path we would concatenate onto.
  if (url.pathname.replaceAll("/", "") !== "") {
    return { ok: false, reason: "TINYBIRD_HOST must be a bare origin, with no path" };
  }
  if (url.search !== "") return { ok: false, reason: "TINYBIRD_HOST must not carry a query" };
  if (url.hash !== "") return { ok: false, reason: "TINYBIRD_HOST must not carry a fragment" };

  return { ok: true, host: url.origin };
}

/** The Events API endpoint for one datasource, waiting for the write to be acknowledged. */
export function eventsUrl(host: string, datasource: string): string {
  return `${host}/v0/events?name=${encodeURIComponent(datasource)}&wait=true`;
}
