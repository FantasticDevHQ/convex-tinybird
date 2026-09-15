import { expect, test } from "@playwright/test";

/**
 * One order placed through the page must show up in three places the page derives from the
 * component and the host: the host-side order metrics, the per-mount delivery counts, and the
 * recent-orders table with each event's state. Without Tinybird credentials the events stay
 * `pending` and the page must say why.
 */
test("placing orders moves the host and delivery metrics", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "convex-tinybird demo" })).toBeVisible();

  const ordersTile = page.getByTestId("orders-count");
  const unitsTile = page.getByTestId("units-count");
  await expect(ordersTile).toHaveText(/^\d+$/);
  const before = Number(await ordersTile.textContent());
  const unitsBefore = Number(await unitsTile.textContent());

  await page.getByLabel("SKU").selectOption("mug-blue");
  await page.getByLabel("Quantity").fill("3");
  await page.getByRole("button", { name: "Place order" }).click();
  await page.getByLabel("SKU").selectOption("tee-black");
  await page.getByLabel("Quantity").fill("1");
  await page.getByRole("button", { name: "Place order" }).click();

  await expect(ordersTile).toHaveText(String(before + 2));
  await expect(unitsTile).toHaveText(String(unitsBefore + 4));
  await expect(page.getByTestId("sku-row-mug-blue")).toBeVisible();

  // Both mounts saw the same two orders, independently.
  for (const mount of ["productEvents", "auditEvents"]) {
    const card = page.getByTestId(`mount-${mount}`);
    await expect(card.getByTestId("mode")).toHaveText("inert");
    await expect(card.getByText(/no TINYBIRD_TOKEN on this deployment/)).toBeVisible();
    await expect(card.getByTestId("pending")).toHaveText(/^\d+$/);
    expect(Number(await card.getByTestId("pending").textContent())).toBeGreaterThanOrEqual(2);
    await expect(card.getByTestId("failed")).toHaveText("0");
  }

  // The newest order is first, with a state for each mount's event.
  const first = page.getByTestId("recent-order").first();
  await expect(first).toContainText("tee-black");
  await expect(first.getByTestId("product-state")).toHaveText("pending");
  await expect(first.getByTestId("audit-state")).toHaveText("pending");

  // Tinybird-side read is explicitly unavailable, not silently blank.
  await expect(page.getByTestId("tinybird-read")).toContainText(/read tokens are not configured/);

  await page.screenshot({ path: "e2e/output/demo.png", fullPage: true });
});
