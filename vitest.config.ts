import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Refuses unstubbed network access. See vitest.setup.ts.
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    // Same worker model as packages/backend: threads keep isolated workers without the
    // fork-pool teardown hang Convex's module transform can trigger on macOS.
    pool: "threads",
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    coverage: {
      exclude: [...coverageConfigDefaults.exclude, "src/component/_generated/**"],
    },
  },
});
