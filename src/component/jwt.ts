export type ReadTokenScope = { pipe: string; fixedParams: Record<string, string> };
export type SignReadTokenArgs = {
  secret: string;
  workspaceId: string;
  name: string;
  expiresAt: number;
  scopes: ReadTokenScope[];
  rps?: number;
};

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Sign only the supplied read scopes. Authorization belongs to the mounting host. */
export async function signReadToken(args: SignReadTokenArgs): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = {
    workspace_id: args.workspaceId,
    name: args.name,
    exp: args.expiresAt,
    scopes: args.scopes.map(({ pipe, fixedParams }) => ({
      type: "PIPES:READ",
      resource: pipe,
      fixed_params: fixedParams,
    })),
    ...(args.rps === undefined ? {} : { limits: { rps: args.rps } }),
  };
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(args.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${body}`));
  return `${header}.${body}.${base64url(new Uint8Array(signature))}`;
}
