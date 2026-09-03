// A URL in a string puts `//` on the line. A gate that strips `//` to end of line first
// goes blind from there, and this package's own destination.ts opens with such a line.
export const BASE = "https://api.tinybird.co";
export const whoami = async (ctx: { auth: { getUserIdentity: () => Promise<unknown> } }) =>
  ctx.auth.getUserIdentity();
