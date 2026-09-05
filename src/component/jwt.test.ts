import { createHmac } from "node:crypto";
import { signReadToken } from "./jwt";

describe("Tinybird HS256 read tokens", () => {
  it.each(["a", "ab", "abc", "租户🦜\u0000ÿ"])(
    "matches independent HMAC and UTF-8 encoding for %s",
    async (name) => {
      const secret = "synthetic-signing-key";
      const payload = {
        workspace_id: "workspace-test",
        name,
        exp: 1800000000,
        scopes: [
          {
            type: "PIPES:READ",
            resource: "summary",
            fixed_params: { resource_id: name, project_id: "" },
          },
        ],
        limits: { rps: 10 },
      };
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
        "base64url",
      );
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signature = createHmac("sha256", secret)
        .update(`${header}.${body}`)
        .digest("base64url");
      const actual = await signReadToken({
        secret,
        workspaceId: payload.workspace_id,
        name,
        expiresAt: payload.exp,
        scopes: [{ pipe: "summary", fixedParams: payload.scopes[0].fixed_params }],
        rps: 10,
      });
      expect(actual).toBe(`${header}.${body}.${signature}`);
      expect(actual).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    },
  );

  it("omits limits when the host does not request a rate limit", async () => {
    const token = await signReadToken({
      secret: "synthetic-key",
      workspaceId: "workspace",
      name: "reader",
      expiresAt: 1800000000,
      scopes: [{ pipe: "summary", fixedParams: {} }],
    });
    expect(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())).not.toHaveProperty(
      "limits",
    );
  });
});
