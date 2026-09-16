import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/stdioProtocol.smoke.ts"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
});
