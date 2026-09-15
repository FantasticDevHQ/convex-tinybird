/**
 * Seed sample rows straight into Tinybird so the charts have a shape before the first click.
 *
 * Deterministic on purpose: ids are `seed-orders-0001…`, timestamps are laid out over the last
 * 24 hours relative to now, so re-running the launcher writes the same identities again and the
 * ReplacingMergeTree collapses them. These rows never pass through the Convex component; they
 * stand in for yesterday's traffic. Orders placed on the page go through the component.
 *
 * Usage: node scripts/seed-tinybird.mjs <host> <appendToken>
 */
const [host, token] = process.argv.slice(2);
if (!host || !token) throw new Error("usage: seed-tinybird.mjs <host> <token>");

const SKUS = ["mug-blue", "mug-red", "tee-black", "poster-a2"];
// Not uniform: a daytime bump makes the hourly trend legible, and skewed SKU weights give the
// share chart unequal slices instead of four identical ones.
const WEIGHTS = [5, 3, 4, 1];
const ORDERS = 240;

function pick(n) {
  const total = WEIGHTS.reduce((a, b) => a + b, 0);
  let x = (n * 7919) % total; // deterministic spread
  for (let i = 0; i < SKUS.length; i += 1) {
    x -= WEIGHTS[i];
    if (x < 0) return SKUS[i];
  }
  return SKUS[0];
}
function stamp(ms) {
  return new Date(ms).toISOString().slice(0, 23).replace("T", " ");
}
const now = Date.now();
const dayStart = now - 24 * 3600_000;
const orders = [];
const audit = [];
for (let i = 0; i < ORDERS; i += 1) {
  // Denser in "business hours" of the seeded day: hours 8–20 get three times the weight.
  const fraction = ((i * 0.618033988) % 1);
  const hour = Math.floor(fraction * 24);
  const busy = hour >= 8 && hour <= 20;
  if (!busy && i % 3 !== 0) continue;
  const at = dayStart + hour * 3600_000 + ((i * 104729) % 3600_000);
  if (at > now - 60_000) continue; // leave the live minute to real clicks
  const id = `seed-orders-${String(i).padStart(4, "0")}`;
  const sku = pick(i);
  const quantity = 1 + ((i * 31) % 3);
  orders.push({ order_id: id, sku, quantity, received_at: stamp(at) });
  audit.push({ order_id: id, action: "order.placed", received_at: stamp(at) });
  if (i % 9 === 0) audit.push({ order_id: id, action: "order.reviewed", received_at: stamp(at + 120_000) });
}

async function send(name, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  const res = await fetch(`${host}/v0/events?name=${name}&wait=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-ndjson" },
    body,
  });
  if (!res.ok) throw new Error(`seeding ${name} failed: ${res.status} ${await res.text()}`);
  const result = await res.json();
  if (result.quarantined_rows) throw new Error(`seeding ${name}: ${result.quarantined_rows} rows quarantined`);
  return result.successful_rows;
}
const a = await send("orders", orders);
const b = await send("audit", audit);
process.stdout.write(`seeded ${a} orders and ${b} audit rows into ${host}\n`);
