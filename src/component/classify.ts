/**
 * Turn a Tinybird Events API response into a delivery outcome.
 *
 * Pure, so the whole decision table is unit-testable without a network or a deployment.
 * See https://www.tinybird.co/docs/api-reference/events-api for the status codes.
 */
import type { FailureCategory } from "./contract";

/** What the caller should do with an event after one delivery attempt. */
export type ClassifiedResponse =
  | { kind: "delivered" }
  /** Terminal: the row will never be accepted as-is, so do not retry it. */
  | { kind: "failed"; category: FailureCategory; httpStatus: number; message: string }
  /**
   * Worth another attempt. The delivery action records it and throws, so the pool applies
   * the event's retry policy; the budget running out is what turns it into a dead letter.
   */
  | { kind: "retryable"; category: FailureCategory; httpStatus: number; message: string };

/** Statuses whose meaning is fixed regardless of the body. */
const TERMINAL_STATUSES: ReadonlyMap<number, FailureCategory> = new Map([
  [400, "invalid_request"],
  [404, "not_found"],
  [413, "payload_too_large"],
  [422, "invalid_request"],
]);

const ACCEPTED_STATUSES = new Set([200, 202]);

/** Statuses that mean "try again later" rather than "this row is wrong". */
const RETRYABLE_STATUSES: ReadonlyMap<number, FailureCategory> = new Map([
  [429, "rate_limited"],
  [500, "server_error"],
  [502, "server_error"],
  [503, "server_error"],
  [504, "server_error"],
]);

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * @param status HTTP status of the response.
 * @param body Parsed JSON body, or `null` when there was none or it did not parse.
 *
 * Messages never quote the response body: a Tinybird error body can echo the request,
 * and these strings are persisted on the event row and surfaced by `health`.
 */
export function classifyResponse(status: number, body: unknown): ClassifiedResponse {
  const terminal = TERMINAL_STATUSES.get(status);
  if (terminal !== undefined) {
    return {
      kind: "failed",
      category: terminal,
      httpStatus: status,
      message: `Tinybird rejected the row with HTTP ${status}`,
    };
  }

  if (ACCEPTED_STATUSES.has(status)) {
    const parsed = body as { successful_rows?: unknown; quarantined_rows?: unknown } | null;
    const successful = parsed?.successful_rows;
    const quarantined = parsed?.quarantined_rows;
    // Both counts must be readable before this response means anything.
    if (!isCount(successful) || !isCount(quarantined)) {
      // Accepted, but we cannot tell whether the row landed. Retrying is the only option
      // that neither loses the event nor dead-letters one that arrived; Tinybird
      // deduplicates on event_id, so a re-send costs nothing.
      return {
        kind: "retryable",
        category: "server_error",
        httpStatus: status,
        message: `Tinybird returned HTTP ${status} without readable row counts`,
      };
    }
    if (successful >= 1 && quarantined === 0) return { kind: "delivered" };
    return {
      kind: "failed",
      category: "quarantined",
      httpStatus: status,
      message: `Tinybird accepted ${successful} row(s) and quarantined ${quarantined}`,
    };
  }

  // Anything without a rule is read as an upstream problem rather than a bad row, so it
  // retries and then dead-letters. That is the reading that cannot silently drop an event.
  // Authorization failures are split out into a destination pause in a later layer.
  return {
    kind: "retryable",
    category: RETRYABLE_STATUSES.get(status) ?? "server_error",
    httpStatus: status,
    message: `Tinybird returned HTTP ${status}`,
  };
}
