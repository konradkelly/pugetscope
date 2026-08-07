import { describe, expect, it } from "vitest";

// Proves the Vitest runner/config is wired up correctly — real coverage
// starts arriving in Phase 2 (unit tests).
describe("vitest scaffolding", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
