// A mention of ctx.auth inside a comment must NOT trip the gate, or the gate cannot be
// documented in the code it guards.
export const note = "authorization belongs to the host";
