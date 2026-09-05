export type PipeErrorCode =
  "token_expired_or_invalid" | "rate_limited" | "bad_request" | "unavailable";
export class TinybirdQueryError extends Error {
  constructor(readonly code: PipeErrorCode) {
    super(code);
    this.name = "TinybirdQueryError";
  }
}
export type PipeParams = Record<string, string | number | boolean>;
export type PipeResult<T> = { data: T[]; meta: unknown; rows: number };

function endpointUrl(host: string, pipe: string, params: PipeParams): URL {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pipe)) throw new TinybirdQueryError("bad_request");
  try {
    const url = new URL(host);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    url.pathname = `/v0/pipes/${pipe}.json`;
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url;
  } catch {
    throw new TinybirdQueryError("bad_request");
  }
}

/** Browser-only HTTP transport. The host application supplies an authorized, short-lived JWT. */
export async function queryPipe<T>(args: {
  host: string;
  token: string;
  pipe: string;
  params: PipeParams;
  signal?: AbortSignal;
}): Promise<PipeResult<T>> {
  const url = endpointUrl(args.host, args.pipe, args.params);
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${args.token}` },
      signal: args.signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok) {
      const code =
        response.status === 403
          ? "token_expired_or_invalid"
          : response.status === 429
            ? "rate_limited"
            : response.status >= 400 && response.status < 500
              ? "bad_request"
              : "unavailable";
      throw new TinybirdQueryError(code);
    }
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("data" in result) ||
      !Array.isArray(result.data) ||
      !("rows" in result) ||
      typeof result.rows !== "number" ||
      !("meta" in result)
    )
      throw new TinybirdQueryError("unavailable");
    return { data: result.data as T[], meta: result.meta, rows: result.rows };
  } catch (error) {
    if (args.signal?.aborted) throw args.signal.reason;
    if (error instanceof TinybirdQueryError) throw error;
    throw new TinybirdQueryError("unavailable");
  }
}
