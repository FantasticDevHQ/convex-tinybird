import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Gitmap } from "@/components/ui/gitmap";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "../convex/_generated/api";
import {
  contributionLevels,
  describeMode,
  fillHours,
  HEATMAP_DARK,
  HEATMAP_LIGHT,
  fillMinutes,
  formatAge,
  formatCount,
  formatSince,
  hourTick,
  minuteTick,
  mountMode,
  orderShare,
  SKUS,
  stateLabel,
  type MountHealth,
} from "./metrics";
import { describeReadError, readSnapshot, tokenIsFresh, type ReadToken, type Snapshot } from "./tinybird";

const POLL_MS = 2000;

/** One chart slot per SKU, in SKUS order: colour follows the entity, never its rank. */
const skuConfig = Object.fromEntries(
  SKUS.map((sku, i) => [sku, { label: sku, color: `var(--chart-${i + 1})` }]),
) satisfies ChartConfig;
const trendConfig = {
  orders: { label: "Orders", color: "var(--chart-1)" },
  units: { label: "Units", color: "var(--chart-3)" },
} satisfies ChartConfig;
const auditConfig = { events: { label: "Events", color: "var(--chart-5)" } } satisfies ChartConfig;

export function App() {
  const recent = useQuery(api.dashboard.recentOrders);
  const health = useQuery(api.orders.health);
  const place = useMutation(api.orders.place);
  const [sku, setSku] = useState<string>(SKUS[0]);
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  async function placeOrders(orders: Array<{ sku: string; quantity: number }>) {
    setBusy(true);
    try {
      for (const order of orders) await place(order);
    } finally {
      setBusy(false);
    }
  }
  function onPlace(event: FormEvent) {
    event.preventDefault();
    void placeOrders([{ sku, quantity }]);
  }

  const product = health?.product as MountHealth | undefined;
  const readTokensConfigured = Boolean(product?.readTokensConfigured);
  const tinybird = useTinybird(readTokensConfigured);
  const dark = usePrefersDark();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 pb-16 space-y-8">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">convex-tinybird demo</h1>
        <p className="text-muted-foreground max-w-3xl">
          Place orders in a plain Convex app. Each order enqueues an event on two independent
          mounts inside the same transaction; the component delivers them to Tinybird, and every
          number and chart under <strong className="text-foreground">Metrics</strong> is read back
          from Tinybird, not from Convex.
        </p>
      </header>

      <form className="flex flex-wrap items-end gap-3" onSubmit={onPlace}>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">SKU</span>
          <Select value={sku} onValueChange={(v) => v && setSku(String(v))}>
            <SelectTrigger aria-label="SKU" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SKUS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Quantity</span>
          <Input
            aria-label="Quantity"
            type="number"
            min={1}
            max={99}
            className="w-24"
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
          />
        </label>
        <Button type="submit" disabled={busy}>
          Place order
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void placeOrders(
              Array.from({ length: 10 }, (_, i) => ({ sku: SKUS[i % SKUS.length], quantity: 1 + (i % 3) })),
            )
          }
        >
          Place 10
        </Button>
      </form>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Pipeline</h2>
          <p className="text-sm text-muted-foreground">
            Read from Convex, and deliberately not a metric: is each mount configured, and what is
            still on its way.
          </p>
        </div>
        {health ? (
          <div className="grid gap-3 md:grid-cols-2">
            <MountCard name="productEvents" health={health.product as MountHealth} now={now} />
            <MountCard name="auditEvents" health={health.audit as MountHealth} now={now} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Loading health…</p>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Metrics</h2>
          <p className="text-sm text-muted-foreground">
            Read from Tinybird every {POLL_MS / 1000}s through the package's browser entry with a
            JWT the host mints through the component. The 24-hour trend includes seeded sample
            traffic; everything you place lands here once it is delivered.
          </p>
        </div>
        {!readTokensConfigured ? (
          <Card data-testid="tinybird-read">
            <CardContent className="text-sm text-muted-foreground">
              This deployment has no Tinybird signing key or workspace ID, so there is nothing to
              read. Start the demo with <code>pnpm --dir example run dev</code>, which boots
              Tinybird Local, deploys <code>example/tinybird</code> and configures the deployment,
              or set <code>PRODUCT_TINYBIRD_*</code> on the deployment for a cloud workspace.
            </CardContent>
          </Card>
        ) : (
          <TinybirdPanel state={tinybird} now={now} dark={dark} />
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Recent orders</h2>
          <p className="text-sm text-muted-foreground">
            From Convex: the newest orders and what the component reports for each event via{" "}
            <code>status()</code>. Watch an order go pending → delivered, then appear above.
          </p>
        </div>
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Placed</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>productEvents</TableHead>
                <TableHead>auditEvents</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(recent ?? []).map((row) => (
                <TableRow key={row.orderId} data-testid="recent-order">
                  <TableCell className="text-muted-foreground">{formatSince(row.placedAt, now)}</TableCell>
                  <TableCell>{row.sku}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.quantity}</TableCell>
                  <TableCell>
                    <StateBadge state={row.product} testId="product-state" />
                  </TableCell>
                  <TableCell>
                    <StateBadge state={row.audit} testId="audit-state" />
                  </TableCell>
                </TableRow>
              ))}
              {recent && recent.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    No orders placed on this page yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </section>

      <footer className="text-xs text-muted-foreground">
        Endpoints: <code>orders_summary</code>, <code>orders_by_sku</code>,{" "}
        <code>orders_per_hour</code>, <code>orders_per_minute</code>, <code>orders_per_day</code>,{" "}
        <code>audit_actions</code>{" "}
        (deployed from <code>example/tinybird</code>). Pipeline state from <code>health()</code>,
        per-event state from <code>status()</code>.
      </footer>
    </main>
  );
}

function StateBadge({ state, testId }: { state: string | null; testId: string }) {
  const variant = state === "delivered" ? "secondary" : state === "failed" ? "destructive" : "outline";
  return (
    <Badge variant={variant} data-testid={testId}>
      {stateLabel(state)}
    </Badge>
  );
}

// ---------------------------------------------------------------------------- Tinybird reads

type TinybirdState =
  | { kind: "loading" }
  | { kind: "ready"; snapshot: Snapshot; stale: string | null }
  | { kind: "error"; message: string };

/** Poll the endpoints, renewing the JWT through the host before it expires. */
function useTinybird(enabled: boolean): TinybirdState {
  const mint = useMutation(api.dashboard.demoReadToken);
  const [state, setState] = useState<TinybirdState>({ kind: "loading" });
  const tokenRef = useRef<ReadToken | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);

  const tick = useCallback(
    async (signal: AbortSignal) => {
      try {
        if (!tokenIsFresh(tokenRef.current, Date.now())) {
          const minted = await mint({});
          if (!minted) throw new Error("the host refused to mint a read token");
          tokenRef.current = minted;
        }
        const snapshot = await readSnapshot(tokenRef.current!, signal);
        if (signal.aborted) return;
        snapshotRef.current = snapshot;
        setState({ kind: "ready", snapshot, stale: null });
      } catch (error) {
        if (signal.aborted) return;
        const message = describeReadError(error);
        if (snapshotRef.current) setState({ kind: "ready", snapshot: snapshotRef.current, stale: message });
        else setState({ kind: "error", message });
        if (error instanceof Error && /token/.test(error.message)) tokenRef.current = null;
      }
    },
    [mint],
  );

  useEffect(() => {
    if (!enabled) return;
    let controller = new AbortController();
    void tick(controller.signal);
    const timer = setInterval(() => {
      controller.abort();
      controller = new AbortController();
      void tick(controller.signal);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [enabled, tick]);

  return state;
}

function Stat({ label, value, testId, hint }: { label: string; value: string | number; testId?: string; hint?: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums" data-testid={testId}>
          {value}
        </CardTitle>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardHeader>
    </Card>
  );
}

function TinybirdPanel({ state, now, dark }: { state: TinybirdState; now: number; dark: boolean }) {
  if (state.kind === "loading")
    return (
      <Card data-testid="tinybird-read">
        <CardContent className="text-sm text-muted-foreground">Reading from Tinybird…</CardContent>
      </Card>
    );
  if (state.kind === "error")
    return (
      <Card data-testid="tinybird-read">
        <CardContent className="text-sm text-destructive">{state.message}</CardContent>
      </Card>
    );
  const { snapshot, stale } = state;
  const share = orderShare(snapshot.bySku);
  const hours = fillHours(snapshot.perHour, now);
  const minutes = fillMinutes(snapshot.perMinute, now);
  const unitsBySku = [...snapshot.bySku].sort((a, b) => b.units - a.units);

  return (
    <div className="space-y-4" data-testid="tinybird-read">
      {stale && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Showing the last successful read. {stale}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Orders" value={snapshot.summary.orders} testId="tb-orders" />
        <Stat label="Units" value={snapshot.summary.units} testId="tb-units" />
        <Stat label="Distinct SKUs" value={snapshot.summary.skus} testId="tb-skus" />
        <Stat label="Last read" value={formatSince(snapshot.readAt, now)} hint={`every ${POLL_MS / 1000}s`} />
      </div>

      <Card data-testid="chart-activity">
        <CardHeader>
          <CardTitle>Order activity</CardTitle>
          <CardDescription>Orders per day over the last year, darker is busier</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto pt-2">
          <Gitmap
            contributions={contributionLevels(snapshot.perDay)}
            from={new Date(now - 364 * 86_400_000)}
            to={new Date(now)}
            colors={dark ? HEATMAP_DARK : HEATMAP_LIGHT}
            showMonths
            showDays
            cellSize={11}
            cellGap={3}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card data-testid="chart-per-hour">
          <CardHeader>
            <CardTitle>Orders and units per hour</CardTitle>
            <CardDescription>Last 24 hours, each order counted once</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={trendConfig} className="h-[220px] w-full">
              <LineChart accessibilityLayer data={hours} margin={{ left: 0, right: 12 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="bucket" tickFormatter={hourTick} tickLine={false} axisLine={false} tickMargin={8} interval={3} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
                <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => hourTick(String(v))} />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Line type="monotone" dataKey="orders" stroke="var(--color-orders)" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="units" stroke="var(--color-units)" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card data-testid="chart-per-minute">
          <CardHeader>
            <CardTitle>Orders per minute</CardTitle>
            <CardDescription>Last 15 minutes: what you place shows up here first</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={trendConfig} className="h-[220px] w-full">
              <BarChart accessibilityLayer data={minutes} margin={{ left: 0, right: 12 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="minute" tickFormatter={minuteTick} tickLine={false} axisLine={false} tickMargin={8} interval={4} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
                <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => minuteTick(String(v))} />} />
                <Bar dataKey="orders" fill="var(--color-orders)" radius={4} isAnimationActive={false} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card data-testid="chart-share">
          <CardHeader>
            <CardTitle>Share of orders by SKU</CardTitle>
            <CardDescription>Part-to-whole; the table below carries the exact numbers</CardDescription>
          </CardHeader>
          <CardContent>
            {share.length === 0 ? (
              <p className="text-sm text-muted-foreground">No orders in Tinybird yet.</p>
            ) : (
              <ChartContainer config={skuConfig} className="mx-auto h-[220px] w-full">
                <PieChart accessibilityLayer>
                  <ChartTooltip content={<ChartTooltipContent nameKey="sku" hideLabel />} />
                  <Pie data={share} dataKey="orders" nameKey="sku" innerRadius={52} outerRadius={84} paddingAngle={2} isAnimationActive={false} label={({ name, value }) => `${name} ${value}`} labelLine={false}>
                    {share.map((row) => (
                      <Cell key={row.sku} fill={`var(--color-${row.sku})`} />
                    ))}
                  </Pie>
                  <ChartLegend content={<ChartLegendContent nameKey="sku" />} />
                </PieChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card data-testid="chart-units">
          <CardHeader>
            <CardTitle>Units by SKU</CardTitle>
            <CardDescription>Quantity summed per SKU</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={skuConfig} className="h-[220px] w-full">
              <BarChart accessibilityLayer data={unitsBySku} layout="vertical" margin={{ left: 8, right: 24 }} barCategoryGap={6}>
                <CartesianGrid horizontal={false} />
                <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="sku" tickLine={false} axisLine={false} width={80} />
                <ChartTooltip content={<ChartTooltipContent nameKey="sku" hideLabel />} />
                <Bar dataKey="units" radius={4} isAnimationActive={false}>
                  {unitsBySku.map((row) => (
                    <Cell key={row.sku} fill={`var(--color-${row.sku})`} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card data-testid="chart-audit" className="md:col-span-2">
          <CardHeader>
            <CardTitle>Audit actions</CardTitle>
            <CardDescription>What the second mount delivered, counted once per order and action</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={auditConfig} className="h-[180px] w-full">
              <BarChart accessibilityLayer data={snapshot.audit} margin={{ left: 0, right: 12 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="action" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="events" fill="var(--color-events)" radius={4} isAnimationActive={false} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SKU</TableHead>
              <TableHead className="text-right">Orders</TableHead>
              <TableHead className="text-right">Share</TableHead>
              <TableHead className="text-right">Units</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {share.map((row) => (
              <TableRow key={row.sku} data-testid={`sku-row-${row.sku}`}>
                <TableCell>
                  <span className="mr-2 inline-block size-2.5 rounded-sm align-middle" style={{ background: `var(--chart-${SKUS.indexOf(row.sku as (typeof SKUS)[number]) + 1})` }} />
                  {row.sku}
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.orders}</TableCell>
                <TableCell className="text-right tabular-nums">{row.share}%</TableCell>
                <TableCell className="text-right tabular-nums">{row.units}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------- pipeline

function MountCard({ name, health, now }: { name: string; health: MountHealth; now: number }) {
  const mode = mountMode(health);
  return (
    <Card size="sm" data-testid={`mount-${name}`}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="font-mono text-sm">{name}</CardTitle>
        <Badge variant={mode === "live" ? "secondary" : "outline"} data-testid="mode">
          {mode}
        </Badge>
      </CardHeader>
      <CardContent className="grid grid-cols-4 gap-2 text-sm">
        <Metric label="Pending" value={formatCount(health.counts.pending)} testId="pending" hint={`oldest ${formatAge(health.oldestPendingAgeMs)}`} />
        <Metric label="Delivering" value={formatCount(health.counts.delivering)} testId="delivering" />
        <Metric label="Failed" value={formatCount(health.counts.failed)} testId="failed" />
        <Metric label="Last delivered" value={formatSince(health.lastDeliveredAt, now)} testId="last-delivered" small />
        {mode !== "live" && <p className="col-span-4 text-xs text-muted-foreground">{describeMode(mode)}</p>}
        {health.lastError && (
          <p className="col-span-4 text-xs text-destructive">
            Last error: {health.lastError.category ?? "unknown"}
            {health.lastError.message ? ` – ${health.lastError.message}` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, testId, hint, small }: { label: string; value: string; testId: string; hint?: string; small?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={small ? "text-sm" : "text-xl tabular-nums"} data-testid={testId}>
        {value}
      </div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return dark;
}
