import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "edge-runtime",
    // The component's guard, inherited on purpose: the example is a consumer, and a consumer
    // test that silently reaches the network is exactly as wrong there as in the component.
    setupFiles: ["../vitest.setup.ts"],
    server: { deps: { inline: ["convex-test"] } },
  },
});
