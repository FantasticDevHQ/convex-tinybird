// Two stray quotes that CANCEL. Each regex literal contributes one quote character, so a
// scanner that lets a string run past a newline pairs them up, swallows everything between
// as string content, and reports nothing at all. The identity read below sits in that gap.
//
// This is the case that makes the newline rule load-bearing rather than tidy: a single stray
// quote is caught either way, because it runs to end of file. Only a pair is silent.
const OPEN = /"/gu;
export const whoami = async (ctx: { auth: { getUserIdentity: () => Promise<unknown> } }) =>
  ctx.auth.getUserIdentity();
const CLOSE = /["]/gu;
export const used = [OPEN, CLOSE];
