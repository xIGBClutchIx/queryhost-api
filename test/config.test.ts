import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("runtime configuration", () => {
  it("requires origin authentication by default", () => {
    expect(() => loadConfig({})).toThrow("QUERYHOST_ORIGIN_TOKEN is required");
  });

  it("allows an explicit unauthenticated bypass only on loopback", () => {
    expect(
      loadConfig({
        QUERYHOST_ALLOW_UNAUTHENTICATED_LOCAL: "true",
      }),
    ).not.toHaveProperty("originToken");

    expect(() =>
      loadConfig({
        HOST: "0.0.0.0",
        QUERYHOST_ALLOW_UNAUTHENTICATED_LOCAL: "true",
      }),
    ).toThrow("QUERYHOST_ORIGIN_TOKEN is required");
  });

  it("loads bounded defaults and rejects values outside cost limits", () => {
    const config = loadConfig({ QUERYHOST_ORIGIN_TOKEN: "a".repeat(32) });
    expect(config).toMatchObject({
      maxBodyBytes: 4_096,
      capacity: {
        maxActive: 8,
        maxQueued: 32,
        maxPerDestination: 2,
        destinationCooldownMs: 250,
      },
      cache: { maxEntries: 1_000, maxBytes: 16 * 1_024 * 1_024 },
    });

    expect(() =>
      loadConfig({
        QUERYHOST_ORIGIN_TOKEN: "a".repeat(32),
        QUERYHOST_MAX_ACTIVE: "0",
      }),
    ).toThrow("QUERYHOST_MAX_ACTIVE");
  });
});
