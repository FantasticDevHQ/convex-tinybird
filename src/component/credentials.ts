import { env } from "./_generated/server";

/**
 * The single place the append token is read.
 *
 * Narrow on purpose. The secret gate allowlists this file and nothing else in the
 * component, so a credential read anywhere else fails the build rather than relying on
 * review to notice it. Keeping the surface to two functions is what makes that allowlist
 * meaningful; allowing a large module wholesale would let a future `return env.TINYBIRD_TOKEN`
 * pass the gate untouched.
 */

/** The append token, or an empty string when the component is unconfigured. */
export function readAppendToken(): string {
  return env.TINYBIRD_TOKEN ?? "";
}

/**
 * Whether a usable token is present. Blank counts as absent: `convex env set X ""` leaves
 * the variable present and empty, which would otherwise read as configured.
 */
export function hasAppendToken(): boolean {
  return readAppendToken().trim() !== "";
}
