import { utf8Length } from "./canonical.js";

/** Maximum UTF-8 bytes in a stored or reported error message, including the ellipsis. */
export const MAX_ERROR_MESSAGE_LENGTH = 200;

/**
 * Make a message safe to persist and to return from a query.
 *
 * Error text reaches the event row, `health` and the operator's logs, so it must never
 * carry the append token (which can appear in a provider error, a URL or a stack) and must
 * stay short enough that a hostile upstream cannot pad the database with it.
 */
export function sanitizeMessage(message: string, token?: string): string {
  let text = message.replace(/\s+/gu, " ").trim();
  if (token !== undefined && token.trim() !== "") {
    text = text.split(token).join("[redacted]");
  }
  // Upstream JavaScript errors can contain lone surrogates. Store their UTF-8
  // replacement character consistently, including messages that need no truncation.
  const encoded = new TextEncoder().encode(text);
  text = new TextDecoder().decode(encoded);
  if (encoded.length <= MAX_ERROR_MESSAGE_LENGTH) return text;

  const budget = MAX_ERROR_MESSAGE_LENGTH - utf8Length("…");
  let prefix = "";
  let bytes = 0;
  // Iteration yields whole Unicode code points, so the cut cannot split a surrogate pair.
  for (const character of text) {
    const size = utf8Length(character);
    if (bytes + size > budget) break;
    prefix += character;
    bytes += size;
  }
  return `${prefix}…`;
}
