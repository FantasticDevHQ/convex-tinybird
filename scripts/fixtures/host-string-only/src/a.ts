// The false-positive direction. Naming the construct in an error message is legitimate —
// it is exactly how a host is told what to do instead — and a gate that rejects this gets
// switched off, which costs more than the hole it was covering.
export const GUIDANCE =
  "authorization is the host's job: call ctx.auth in your own function, not here";
export const HINT = "wrap this in a host mutation; do not call getUserIdentity in the component";
