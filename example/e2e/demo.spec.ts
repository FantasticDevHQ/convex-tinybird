import { expect, test } from "@playwright/test";

/**
 * The claim the demo makes: an order placed in Convex shows up in metrics read back FROM
 * TINYBIRD. So the assertions on the tiles and charts wait for Tinybird's numbers to move,
 * which only happens once the component has delivered the events. The Convex-side pipeline
 * strip is checked too, but as pipeline state (live, nothing failed), not as a metric.
 *
 * `scripts/dev.mjs` (the Playwright webServer) boots Tinybird Local in Docker, deploys the
 * example's datasources and pipes, configures the local Convex deployment, then starts Vite.
 */
test("orders placed on the page arrive in Tinybird and move its metrics and charts", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "convex-tinybird demo" })).toBeVisible();

  // Both mounts are configured by the launcher; nothing is inert.
  for (const mount of ["productEvents", "auditEvents"]) {
    const card = page.getByTestId(`mount-${mount}`);
    await expect(card.getByTestId("mode")).toHaveText("live");
  }

  // Tinybird answers before any order: the tiles render numbers, not an error.
  const orders = page.getByTestId("tb-orders");
  const units = page.getByTestId("tb-units");
  await expect(orders).toHaveText(/^\d+$/, { timeout: 30_000 });
  const ordersBefore = Number(await orders.textContent());
  const unitsBefore = Number(await units.textContent());

  // The SKU control is a Base UI select: open it, pick the option by its accessible name.
  async function placeOrder(sku: string, quantity: string) {
    await page.getByRole("combobox", { name: "SKU" }).click();
    await page.getByRole("option", { name: sku }).click();
    await page.getByLabel("Quantity").fill(quantity);
    await page.getByRole("button", { name: "Place order", exact: true }).click();
  }
  await placeOrder("mug-blue", "3");
  await placeOrder("tee-black", "1");

  // Convex knows about the orders immediately; Tinybird knows once delivery succeeded.
  const first = page.getByTestId("recent-order").first();
  await expect(first).toContainText("tee-black");
  await expect(first.getByTestId("product-state")).toHaveText("delivered", { timeout: 60_000 });
  await expect(first.getByTestId("audit-state")).toHaveText("delivered", { timeout: 60_000 });

  await expect(orders).toHaveText(String(ordersBefore + 2), { timeout: 60_000 });
  await expect(units).toHaveText(String(unitsBefore + 4), { timeout: 60_000 });

  // The charts are drawn from the same Tinybird reads: an SVG per figure, and the share table
  // (the accessible twin of the pie) lists both SKUs we just ordered.
  for (const chart of ["chart-per-hour", "chart-per-minute", "chart-share", "chart-units", "chart-audit"]) {
    await expect(page.getByTestId(chart).locator("svg").first()).toBeVisible();
  }
  await expect(page.getByTestId("sku-row-mug-blue")).toBeVisible();
  await expect(page.getByTestId("sku-row-tee-black")).toBeVisible();
  await expect(page.getByTestId("chart-audit").locator("text", { hasText: "order.placed" })).toBeVisible();

  // Nothing failed on the way.
  for (const mount of ["productEvents", "auditEvents"]) {
    await expect(page.getByTestId(`mount-${mount}`).getByTestId("failed")).toHaveText("0");
  }

  await page.screenshot({ path: "e2e/output/demo.png", fullPage: true });
});
