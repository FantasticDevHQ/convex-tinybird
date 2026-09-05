import { queryPipe } from "./index";

const args = {
  host: "https://api.us-east.tinybird.co",
  token: "synthetic.jwt",
  pipe: "summary",
  params: { start: "2026-01-01 00:00:00", limit: 10 },
};
afterEach(() => vi.unstubAllGlobals());

it("uses an encoded endpoint URL, bearer header and caller cancellation signal", async () => {
  const result = { data: [{ count: 3 }], meta: [{ name: "count", type: "UInt64" }], rows: 1 };
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)));
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  expect(await queryPipe<{ count: number }>({ ...args, signal })).toEqual(result);
  const [url, options] = fetcher.mock.calls[0] as [string, RequestInit];
  expect(new URL(url).pathname).toBe("/v0/pipes/summary.json");
  expect(new URL(url).searchParams.get("start")).toBe(args.params.start);
  expect(new URL(url).searchParams.get("limit")).toBe("10");
  expect(url).not.toContain(args.token);
  expect(options).toMatchObject({
    method: "GET",
    headers: { Authorization: `Bearer ${args.token}` },
    signal,
  });
});

it.each([
  [403, "token_expired_or_invalid"],
  [429, "rate_limited"],
  [400, "bad_request"],
  [404, "bad_request"],
  [500, "unavailable"],
  [503, "unavailable"],
])("classifies HTTP %s", async (status, code) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("provider details must not leak", { status: Number(status) }),
      ),
  );
  await expect(queryPipe(args)).rejects.toMatchObject({ code });
});

it("classifies network errors without returning transport details", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("transport details")));
  await expect(queryPipe(args)).rejects.toMatchObject({
    code: "unavailable",
    message: "unavailable",
  });
});

it("preserves cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(controller.signal.reason));
  await expect(queryPipe({ ...args, signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
});

it.each(["../tokens", "summary?token=wrong", "https://other.test"])(
  "rejects unsafe pipe %s before sending a JWT",
  async (pipe) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(queryPipe({ ...args, pipe })).rejects.toMatchObject({ code: "bad_request" });
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it("classifies a malformed response as unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not JSON")));
  await expect(queryPipe(args)).rejects.toMatchObject({ code: "unavailable" });
});
