import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 15_000,
    // No integration tests exist yet as of Phase 1 scaffolding — an empty
    // suite shouldn't fail the CI job before Phase 3 lands them.
    passWithNoTests: true,
    // Serialized rather than parallel test files: they share one real
    // Postgres/Redis, and resetDbBetweenTests.ts's beforeEach truncates
    // every table — concurrent files would stomp on each other's fixtures.
    fileParallelism: false,
    globalSetup: ["./test/globalSetupIntegration.ts"],
    setupFiles: ["./test/resetDbBetweenTests.ts"],
  },
});
