/**
 * Host-side client for the Tinybird delivery component.
 *
 * Server-only: it runs inside the host's Convex functions and talks to the component
 * through `ctx.runQuery` / `ctx.runMutation`. Nothing here may be imported by a browser.
 */
import type { GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";

import type { ComponentApi } from "../component/_generated/component";
import {
  type Health,
  type ResolvedTinybirdDeliveryOptions,
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

  /** Delivery health: configuration, pause state and bounded backlog counts. */
  async health(ctx: RunQueryCtx): Promise<Health> {
    return ctx.runQuery(this.component.lib.health, {});
  }
}
