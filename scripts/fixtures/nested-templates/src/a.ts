// Templates inside template substitutions, and an object literal inside one. The scanner has
// to track both or it reports a phantom unterminated string on ordinary code — which is what
// this package's own canonical.ts does.
export const encode = (path: string, index: number): string =>
  `[${[1].map((item) => `${path}[${item}${index}]`).join(",")}]`;
export const wrap = (value: unknown): string =>
  `{${JSON.stringify({ a: 1, b: { c: 2 } })}${String(value)}}`;

// The reason substitution braces are counted rather than matched to the first `}`: an
// object literal inside a substitution closes with a brace that is NOT the substitution's.
// Popping there would make everything after it template text — unscanned — so an identity
// read placed here is what tells a counted scanner from a naive one.
export const leak = async (ctx: {
  auth: { getUserIdentity: () => Promise<unknown> };
}): Promise<string> => `${JSON.stringify({ a: 1 }) + String(await ctx.auth.getUserIdentity())}`;
