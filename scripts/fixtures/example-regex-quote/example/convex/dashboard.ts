// Legal host-app code: a regex containing a quote character.
export const RE = /["]/gu;
export const trimmed = (s: string) => s.replace(RE, "");
