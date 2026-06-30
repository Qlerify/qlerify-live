import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    pool: "forks",
    // Run the whole suite serially in a single reused child process. In Vitest 4
    // `poolOptions.forks.singleFork` was removed in favour of maxWorkers/minWorkers.
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
  },
});
