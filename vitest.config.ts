import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = {
  "@sandbox-broker/contracts": fileURLToPath(
    new URL("./packages/contracts/src/index.ts", import.meta.url),
  ),
  "@sandbox-broker/client": fileURLToPath(
    new URL("./packages/client/src/index.ts", import.meta.url),
  ),
  "@sandbox-broker/server": fileURLToPath(
    new URL("./apps/server/src/index.ts", import.meta.url),
  ),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["{apps,packages}/*/src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/dist/**"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["{apps,packages}/*/src/**/*.integration.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          testTimeout: 300_000,
          hookTimeout: 300_000,
          // Real Docker resources are shared; keep integration files serialized.
          fileParallelism: false,
        },
      },
    ],
  },
});
