import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    include: [
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
    passWithNoTests: true,
    // Integration tests spawn child processes — allow up to 30s per test.
    testTimeout: 30000,
    // Subdivide via custom pools or just accept shared timeout.
    // The unit tests finish in ms; the timeout only matters for integration.
  },
});
