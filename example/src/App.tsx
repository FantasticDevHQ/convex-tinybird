import { queryPipe, TinybirdQueryError } from "@fantasticdevhq/convex-tinybird/browser";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState, type FormEvent } from "react";

import { api } from "../convex/_generated/api";
import {
  describeMode,
  formatAge,
  formatCount,
  formatSince,
  mountMode,
  stateLabel,
  type MountHealth,
} from "./metrics";

const SKUS = ["mug-blue", "mug-red", "tee-black", "poster-a2"];

export function App() {
  const summary = useQuery(api.dashboard.orderSummary);
  const recent = useQuery(api.dashboard.recentOrders);
  const health = useQuery(api.orders.health);
  const place = useMutation(api.orders.place);
  const [sku, setSku] = useState(SKUS[0]);
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function onPlace(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await place({ sku, quantity });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <h1>convex-tinybird demo</h1>
      <p className="lede">
        Place orders in a plain Convex app. Each one enqueues an event on two independent mounts
        inside the same transaction; the tiles below are read straight from the host tables and
        the component's health and status queries.
      </p>

      <form className="place" onSubmit={onPlace}>
        <label>
          SKU{" "}
          <select value={sku} onChange={(e) => setSku(e.target.value)}>
            {SKUS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Quantity{" "}
          <input
            type="number"
            min={1}
            max={99}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <button type="submit" disabled={busy}>
          Place order
        </button>
      </form>

      <h2>Orders (host tables)</h2>
      <div className="tiles">
        <div className="tile">
          <div className="label">Orders</div>
          <div className="value" data-testid="orders-count">
            {summary ? summary.orders : "…"}
          </div>
          {summary?.truncated && <div className="sub">newest 200 only</div>}
        </div>
        <div className="tile">
          <div className="label">Units</div>
          <div className="value" data-testid="units-count">
            {summary ? summary.units : "…"}
          </div>
        </div>
        <div className="tile">
          <div className="label">Top SKU</div>
          <div className="value">{summary?.bySku[0]?.sku ?? "–"}</div>
          <div className="sub">
            {summary?.bySku[0] ? `${summary.bySku[0].orders} orders` : "no orders yet"}
          </div>
        </div>
      </div>
      {summary && summary.bySku.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Orders</th>
              <th>Units</th>
            </tr>
          </thead>
          <tbody>
            {summary.bySku.map((row) => (
              <tr key={row.sku} data-testid={`sku-row-${row.sku}`}>
                <td>{row.sku}</td>
                <td className="num">{row.orders}</td>
                <td className="num">{row.units}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Delivery (component health, per mount)</h2>
      {health ? (
        <>
          <Mount name="productEvents" health={health.product as MountHealth} now={now} />
          <Mount name="auditEvents" health={health.audit as MountHealth} now={now} />
        </>
      ) : (
        <p className="notice muted">Loading health…</p>
      )}

      <h2>Recent orders</h2>
      <table>
        <thead>
          <tr>
            <th>Placed</th>
            <th>SKU</th>
            <th>Qty</th>
            <th>productEvents</th>
            <th>auditEvents</th>
          </tr>
        </thead>
        <tbody>
          {(recent ?? []).map((row) => (
            <tr key={row.orderId} data-testid="recent-order">
              <td>{formatSince(row.placedAt, now)}</td>
              <td>{row.sku}</td>
              <td className="num">{row.quantity}</td>
              <td>
                <span className={`state ${row.product ?? ""}`} data-testid="product-state">
                  {stateLabel(row.product)}
                </span>
              </td>
              <td>
                <span className={`state ${row.audit ?? ""}`} data-testid="audit-state">
                  {stateLabel(row.audit)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Tinybird side</h2>
      <TinybirdRead configured={Boolean((health?.product as MountHealth | undefined)?.readTokensConfigured)} />

      <footer>
        Delivery counts come from <code>health()</code>, per-order states from <code>status()</code>
        , both bounded queries the component exposes; everything else is this app's own data.
      </footer>
    </main>
  );
}

function Mount({ name, health, now }: { name: string; health: MountHealth; now: number }) {
  const mode = mountMode(health);
  return (
    <section className="mount" data-testid={`mount-${name}`}>
      <header>
        <h3>{name}</h3>
        <span className={`badge ${mode}`} data-testid="mode">
          {mode}
        </span>
      </header>
      <div className="tiles">
        <div className="tile">
          <div className="label">Pending</div>
          <div className="value" data-testid="pending">
            {formatCount(health.counts.pending)}
          </div>
          <div className="sub">oldest {formatAge(health.oldestPendingAgeMs)}</div>
        </div>
        <div className="tile">
          <div className="label">Delivering</div>
          <div className="value" data-testid="delivering">
            {formatCount(health.counts.delivering)}
          </div>
        </div>
        <div className="tile">
          <div className="label">Failed</div>
          <div className="value" data-testid="failed">
            {formatCount(health.counts.failed)}
          </div>
        </div>
        <div className="tile">
          <div className="label">Last delivered</div>
          <div className="value" style={{ fontSize: "1rem" }}>
            {formatSince(health.lastDeliveredAt, now)}
          </div>
        </div>
      </div>
      <p className={`notice ${mode === "live" ? "muted" : ""}`}>{describeMode(mode)}</p>
      {health.lastError && (
        <p className="notice error">
          Last error: {health.lastError.category ?? "unknown"}
          {health.lastError.message ? ` – ${health.lastError.message}` : ""}
        </p>
      )}
    </section>
  );
}

type SkuRow = { sku: string; orders: number; units: number };

/**
 * The same numbers from the other side, once events have actually landed in Tinybird. Needs a
 * signing secret and workspace ID on the product mount (see docs/tinybird-setup.md) and the
 * example's `orders_by_sku` pipe deployed. Otherwise it says so rather than showing nothing.
 */
function TinybirdRead({ configured }: { configured: boolean }) {
  const mint = useMutation(api.dashboard.demoReadToken);
  const [rows, setRows] = useState<SkuRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const token = await mint({});
      if (!token) {
        setError("read tokens are not configured on this deployment");
        return;
      }
      const result = await queryPipe<SkuRow>({
        host: token.host,
        token: token.token,
        pipe: "orders_by_sku",
        params: {},
      });
      setRows(result.data);
    } catch (e) {
      setError(e instanceof TinybirdQueryError ? `${e.code}: ${e.message}` : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mount" data-testid="tinybird-read">
      {configured ? (
        <>
          <button type="button" onClick={load} disabled={loading}>
            {loading ? "Reading…" : "Read orders_by_sku from Tinybird"}
          </button>
          {rows && (
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Orders</th>
                  <th>Units</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.sku}>
                    <td>{r.sku}</td>
                    <td className="num">{r.orders}</td>
                    <td className="num">{r.units}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {error && <p className="notice error">{error}</p>}
        </>
      ) : (
        <p className="notice muted">
          Tinybird read tokens are not configured on this deployment, so there is nothing to read
          back yet. Set <code>PRODUCT_TINYBIRD_ADMIN_TOKEN</code> and{" "}
          <code>PRODUCT_TINYBIRD_WORKSPACE_ID</code> on the deployment and deploy
          <code> example/tinybird</code> to enable it.
        </p>
      )}
    </section>
  );
}
