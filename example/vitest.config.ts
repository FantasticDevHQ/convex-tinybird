import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
