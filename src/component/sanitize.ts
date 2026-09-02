/** Longest error message stored on an event row or reported by `health`. */
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
  return text.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
    : text;
}
