/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      enqueue: FunctionReference<
        "mutation",
        "internal",
        {
          datasource: string;
          eventId: string;
          maxPayloadBytes?: number;
          payload: any;
          requestTimeoutMs?: number;
          retry?: {
            base: number;
            initialBackoffMs: number;
            maxAttempts: number;
          };
        },
        {
          eventId: string;
          outcome: "enqueued" | "duplicate";
          state: "pending" | "delivering" | "delivered" | "failed";
        },
        Name
      >;
      getStatus: FunctionReference<
        "query",
        "internal",
        { datasource: string; eventId: string },
        {
          attempts: number;
          createdAt: number;
          datasource: string;
          deliveredAt?: number;
          eventId: string;
          lastError?: {
            at: number;
            category:
              | "invalid_request"
              | "quarantined"
              | "not_found"
              | "payload_too_large"
              | "unauthorized"
              | "rate_limited"
              | "server_error"
              | "timeout"
              | "network"
              | "exhausted"
              | "stuck";
            httpStatus?: number;
            message: string;
          };
          previousErrors?: Array<{
            at: number;
            category:
              | "invalid_request"
              | "quarantined"
              | "not_found"
              | "payload_too_large"
              | "unauthorized"
              | "rate_limited"
              | "server_error"
              | "timeout"
              | "network"
              | "exhausted"
              | "stuck";
            httpStatus?: number;
            message: string;
          }>;
          state: "pending" | "delivering" | "delivered" | "failed";
        } | null,
        Name
      >;
      health: FunctionReference<
        "query",
        "internal",
        {},
        {
          configured: boolean;
          counts: {
            delivering: { capped: boolean; count: number };
            failed: { capped: boolean; count: number };
            pending: { capped: boolean; count: number };
          };
          lastDeliveredAt?: number;
          lastError?: {
            at: number;
            category:
              | "invalid_request"
              | "quarantined"
              | "not_found"
              | "payload_too_large"
              | "unauthorized"
              | "rate_limited"
              | "server_error"
              | "timeout"
              | "network"
              | "exhausted"
              | "stuck";
            httpStatus?: number;
            message: string;
          };
          lastOperatorAction?: {
            actor?: string;
            at: number;
            count?: number;
            kind: "pause" | "resume" | "replayFailed" | "replayEvent";
          };
          oldestPendingAgeMs: number | null;
          paused: boolean;
          pausedReason?: "unauthorized" | "invalid_host" | "operator";
        },
        Name
      >;
      heartbeat: FunctionReference<
        "query",
        "internal",
        {},
        {
          configured: boolean;
          lastDeliveredAt?: number;
          lastError?: {
            at: number;
            category:
              | "invalid_request"
              | "quarantined"
              | "not_found"
              | "payload_too_large"
              | "unauthorized"
              | "rate_limited"
              | "server_error"
              | "timeout"
              | "network"
              | "exhausted"
              | "stuck";
            httpStatus?: number;
            message: string;
          };
          lastOperatorAction?: {
            actor?: string;
            at: number;
            count?: number;
            kind: "pause" | "resume" | "replayFailed" | "replayEvent";
          };
          oldestPendingAgeMs: number | null;
          paused: boolean;
          pausedReason?: "unauthorized" | "invalid_host" | "operator";
        },
        Name
      >;
      pause: FunctionReference<
        "mutation",
        "internal",
        {
          actor?: string;
          reason?: "unauthorized" | "invalid_host" | "operator";
        },
        { paused: boolean },
        Name
      >;
      resume: FunctionReference<
        "mutation",
        "internal",
        { actor?: string; limit?: number },
        { paused: boolean; requeued: number },
        Name
      >;
    };
  };
