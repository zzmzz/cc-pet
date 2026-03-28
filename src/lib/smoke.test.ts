import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("runs in jsdom", () => {
    expect(typeof window).toBe("object");
  });
});
