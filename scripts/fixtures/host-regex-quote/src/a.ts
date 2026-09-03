// A regex literal containing a quote opens a string the scanner never sees closed. It must
// say so rather than guess: guessing is wrong in both directions at once — the identity read
// below would be swallowed as string content, and on another file a legitimate mention inside
// a later string would be emitted as code and rejected.
const QUOTE = /"/gu;
export const whoami = async (ctx: { auth: { getUserIdentity: () => Promise<unknown> } }) =>
  ctx.auth.getUserIdentity();
export const used = QUOTE;
