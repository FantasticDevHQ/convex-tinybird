/**
 * Host-side client for the Tinybird delivery component.
 *
 * Server-only: it runs inside the host's Convex functions and talks to the component
 * through `ctx.runQuery` / `ctx.runMutation`. Nothing here may be imported by a browser.
 */
import type { GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";

import type { ComponentApi } from "../component/_generated/component";
import {
  type EnqueueResult,
  type EventIdentity,
  type EventStatus,
  type Health,
  type Heartbeat,
  type PausedReason,
  type ResolvedTinybirdDeliveryOptions,
  type RetryConfig,
  type TinybirdDeliveryOptions,
  resolveTinybirdDeliveryOptions,
} from "../component/contract";

export {
  COUNT_CAP,
  DATASOURCE_NAME_PATTERN,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RETRY,
  ENVELOPE_VERSION,
  HARD_MAX_PAYLOAD_BYTES,
  MAX_EVENT_ID_LENGTH,
  REQUEST_TIMEOUT_RANGE_MS,
  RETRY_LIMITS,
  resolveTinybirdDeliveryOptions,
  retryConfigViolation,
  vBoundedCount,
  vDeliveryError,
  vEnqueueArgs,
  vEnqueueResult,
  vErrorCode,
  vEventIdentity,
  vEventState,
  vEventStatus,
  vFailureCategory,
  vHealth,
  vHeartbeat,
  vOperatorAction,
  vPausedReason,
  vRetryConfig,
} from "../component/contract";
export type {
  BoundedCount,
  DeliveryError,
  EnqueueArgs,
  EnqueueResult,
  ErrorCode,
  EventIdentity,
  EventState,
  EventStatus,
  FailureCategory,
  Health,
  Heartbeat,
  OperatorAction,
  PausedReason,
  ResolvedTinybirdDeliveryOptions,
  RetryConfig,
  TinybirdDeliveryOptions,
} from "../component/contract";

/** The subset of a Convex context the client needs: any query, mutation or action ctx. */
export type RunQueryCtx = { runQuery: GenericQueryCtx<GenericDataModel>["runQuery"] };
export type RunMutationCtx = { runMutation: GenericMutationCtx<GenericDataModel>["runMutation"] };

export type TinybirdComponent = ComponentApi;

export class TinybirdDelivery {
  readonly options: ResolvedTinybirdDeliveryOptions;

  /**
   * @param component `components.tinybird` from the host's `_generated/api` (one per mount).
   * @param options validated eagerly; see {@link TinybirdDeliveryOptions}.
   */
  constructor(
    readonly component: TinybirdComponent,
    options: TinybirdDeliveryOptions = {},
  ) {
    this.options = resolveTinybirdDeliveryOptions(options);
  }

  /**
   * Store an event for delivery, inside the caller's mutation so it commits or rolls back with
   * the caller's own writes. `payload` is a JSON object sent verbatim as one Tinybird row.
   * Throws `ConvexError` with a documented `code` before any write on invalid input.
   */
  async enqueue(
    ctx: RunMutationCtx,
    args: EventIdentity & { payload: unknown; retry?: Partial<RetryConfig> },
  ): Promise<EnqueueResult> {
    return ctx.runMutation(this.component.lib.enqueue, {
      datasource: args.datasource,
      eventId: args.eventId,
      payload: args.payload,
      maxPayloadBytes: this.options.maxPayloadBytes,
      requestTimeoutMs: this.options.requestTimeoutMs,
      retry: args.retry ? { ...this.options.retry, ...args.retry } : this.options.retry,
    });
  }

  /** Delivery state of one event, or `null` when unknown. Never includes the payload. */
  async status(ctx: RunQueryCtx, identity: EventIdentity): Promise<EventStatus | null> {
    return ctx.runQuery(this.component.lib.getStatus, identity);
  }

  /**
   * Stop delivering on purpose. The component does not authenticate anyone, so a host must
   * authorize the caller itself; `actor` is whatever opaque identifier it wants recorded.
   */
  async pause(
    ctx: RunMutationCtx,
    args: { reason?: PausedReason; actor?: string } = {},
  ): Promise<{ paused: boolean }> {
    return ctx.runMutation(this.component.lib.pause, args);
  }

  /**
   * Clear the pause and put waiting events back to work, a bounded batch at a time. A paused
   * destination can accumulate an arbitrary backlog, so call this until `requeued` is zero.
   */
  async resume(
    ctx: RunMutationCtx,
    args: { actor?: string; limit?: number } = {},
  ): Promise<{ paused: boolean; requeued: number }> {
    return ctx.runMutation(this.component.lib.resume, args);
  }

  /**
   * The cheap operator signals: configured, paused and why, how long the oldest event has
   * waited, last delivery and newest failure. Two document reads whatever is queued, so this
   * is what to alert on; `health` adds counts and costs more.
   */
  async heartbeat(ctx: RunQueryCtx): Promise<Heartbeat> {
    return ctx.runQuery(this.component.lib.heartbeat, {});
  }

  /**
   * Replay dead letters, a bounded batch at a time, least recently changed first — NOT
   * oldest first, so an event that is replayed and fails again goes to the back of the
   * queue rather than being picked again immediately. Identity and payload are preserved,
   * so a replayed event is the same event.
   *
   * There is no category filter, on purpose: replaying is what advances the scan, so a
   * filter that skipped rows would leave them parked at the front of the window and make
   * everything behind them unreachable. Use {@link replayEvent} to replay one event.
   *
   * `remaining` means dead letters exist right now, not that there are ones you have not
   * seen. If the cause was not really fixed, replayed events fail again and `remaining`
   * stays true, so bound the loop rather than spinning on it.
   */
  async replayFailed(
    ctx: RunMutationCtx,
    args: { limit?: number; actor?: string } = {},
  ): Promise<{ replayed: number; remaining: boolean }> {
    return ctx.runMutation(this.component.lib.replayFailed, args);
  }

  /** Replay one dead letter by its identity. */
  async replayEvent(
    ctx: RunMutationCtx,
    args: EventIdentity & { actor?: string },
  ): Promise<{ replayed: boolean }> {
    return ctx.runMutation(this.component.lib.replayEvent, args);
  }

  /** Delivery health: configuration, pause state and bounded backlog counts. */
  async health(ctx: RunQueryCtx): Promise<Health> {
    return ctx.runQuery(this.component.lib.health, {});
  }
}
