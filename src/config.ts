import type { CachePolicy } from "./runtime/result-cache.js";

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

export interface CapacityConfig {
  readonly maxActive: number;
  readonly maxQueued: number;
  readonly maxPerDestination: number;
  readonly destinationCooldownMs: number;
}

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly originToken?: string;
  readonly maxBodyBytes: number;
  readonly capacity: CapacityConfig;
  readonly cache: CachePolicy;
}

function integerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function originToken(environment: NodeJS.ProcessEnv, host: string): string | undefined {
  const token = environment["QUERYHOST_ORIGIN_TOKEN"];
  if (token !== undefined) {
    if (token.length < 32 || token.length > 256) {
      throw new RangeError("QUERYHOST_ORIGIN_TOKEN must contain 32 through 256 characters.");
    }
    return token;
  }

  const localBypass = environment["QUERYHOST_ALLOW_UNAUTHENTICATED_LOCAL"] === "true";
  if (localBypass && LOCAL_HOSTS.has(host)) {
    return undefined;
  }

  throw new Error(
    "QUERYHOST_ORIGIN_TOKEN is required unless unauthenticated loopback development is explicitly enabled.",
  );
}

/** Reads and validates the complete portable runtime configuration. */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const host = environment["HOST"] ?? "127.0.0.1";
  const token = originToken(environment, host);

  return {
    host,
    port: integerEnvironment(environment, "PORT", 3_000, 1, 65_535),
    ...(token === undefined ? {} : { originToken: token }),
    maxBodyBytes: integerEnvironment(environment, "QUERYHOST_MAX_BODY_BYTES", 4_096, 256, 65_536),
    capacity: {
      maxActive: integerEnvironment(environment, "QUERYHOST_MAX_ACTIVE", 8, 1, 256),
      maxQueued: integerEnvironment(environment, "QUERYHOST_MAX_QUEUED", 32, 0, 4_096),
      maxPerDestination: integerEnvironment(environment, "QUERYHOST_MAX_PER_DESTINATION", 2, 1, 32),
      destinationCooldownMs: integerEnvironment(
        environment,
        "QUERYHOST_DESTINATION_COOLDOWN_MS",
        250,
        0,
        60_000,
      ),
    },
    cache: {
      maxEntries: integerEnvironment(environment, "QUERYHOST_CACHE_MAX_ENTRIES", 1_000, 1, 100_000),
      maxBytes: integerEnvironment(
        environment,
        "QUERYHOST_CACHE_MAX_BYTES",
        16 * 1_024 * 1_024,
        1_024,
        256 * 1_024 * 1_024,
      ),
      successTtlMs: integerEnvironment(
        environment,
        "QUERYHOST_CACHE_SUCCESS_TTL_MS",
        10_000,
        0,
        60_000,
      ),
      partialTtlMs: integerEnvironment(
        environment,
        "QUERYHOST_CACHE_PARTIAL_TTL_MS",
        5_000,
        0,
        60_000,
      ),
      offlineTtlMs: integerEnvironment(
        environment,
        "QUERYHOST_CACHE_OFFLINE_TTL_MS",
        2_000,
        0,
        60_000,
      ),
    },
  };
}
