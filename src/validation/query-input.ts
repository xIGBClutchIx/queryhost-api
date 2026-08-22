import {
  canonicalGameId,
  getGameDefinition,
  isGameInputId,
  type GameId,
  type GameInputId,
  type QueryMode,
} from "queryhost";

import type { HostedQueryInput } from "../contracts.js";

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "game",
  "host",
  "port",
  "queryPort",
  "mode",
  "timeoutMs",
]);
const MAX_HOST_LENGTH = 253;
const MAX_HOSTED_TIMEOUT_MS = 5_000;
const CACHE_SCHEMA = 1;

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject {
  readonly [key: string]: JsonValue;
}

export class QueryInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "QueryInputError";
  }
}

function parseJson(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    throw new QueryInputError("The request body must be valid JSON.");
  }
}

function jsonObject(value: JsonValue): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QueryInputError("The request body must be a JSON object.");
  }
  return value;
}

function rejectExtraFields(value: JsonObject): void {
  const extra = Object.keys(value).find((key) => !ALLOWED_FIELDS.has(key));
  if (extra !== undefined) {
    throw new QueryInputError(`Unsupported request field: ${extra}.`);
  }
}

function gameId(value: JsonValue | undefined): GameInputId {
  if (typeof value !== "string" || !isGameInputId(value)) {
    throw new QueryInputError("game must be a supported game ID or alias.");
  }
  return value;
}

function normalizedHost(value: JsonValue | undefined): string {
  if (typeof value !== "string") {
    throw new QueryInputError("host must be a hostname or IP literal string.");
  }

  const trimmed = value.trim();
  const host = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (
    host.length === 0 ||
    host.length > MAX_HOST_LENGTH ||
    /[\s/?#@]/u.test(host) ||
    host.includes("[") ||
    host.includes("]") ||
    host.includes("%")
  ) {
    throw new QueryInputError("host must be a plain hostname or IP literal without URL syntax.");
  }
  return host.toLowerCase();
}

function optionalInteger(
  value: JsonValue | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(value) ||
    typeof value !== "number" ||
    value < minimum ||
    value > maximum
  ) {
    throw new QueryInputError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function queryMode(value: JsonValue | undefined): QueryMode {
  if (value === undefined) {
    return "full";
  }
  if (value !== "summary" && value !== "full") {
    throw new QueryInputError("mode must be summary or full.");
  }
  return value;
}

function effectiveQueryPort(
  game: GameId,
  port: number,
  explicitQueryPort: number | undefined,
): number {
  if (explicitQueryPort !== undefined) {
    return explicitQueryPort;
  }
  const definition = getGameDefinition(game);
  const offset = (definition.defaultQueryPort ?? definition.defaultPort) - definition.defaultPort;
  const derived = port + offset;
  if (derived < 1 || derived > 65_535) {
    throw new QueryInputError("The derived query port is outside the valid port range.");
  }
  return derived;
}

/** Parses, validates, and canonicalizes one hosted query request. */
export function parseQueryInput(text: string): HostedQueryInput {
  const body = jsonObject(parseJson(text));
  rejectExtraFields(body);

  const game = canonicalGameId(gameId(body["game"]));
  const definition = getGameDefinition(game);
  const port = optionalInteger(body["port"], "port", 1, 65_535) ?? definition.defaultPort;
  const explicitQueryPort = optionalInteger(body["queryPort"], "queryPort", 1, 65_535);

  return {
    game,
    host: normalizedHost(body["host"]),
    port,
    queryPort: effectiveQueryPort(game, port, explicitQueryPort),
    mode: queryMode(body["mode"]),
    timeoutMs:
      optionalInteger(body["timeoutMs"], "timeoutMs", 1, MAX_HOSTED_TIMEOUT_MS) ??
      MAX_HOSTED_TIMEOUT_MS,
  };
}

/** Stable key containing every normalized field that can affect a hosted result. */
export function queryCacheKey(input: HostedQueryInput): string {
  return JSON.stringify([
    CACHE_SCHEMA,
    input.game,
    input.host,
    input.port,
    input.queryPort,
    input.mode,
    input.timeoutMs,
  ]);
}

/** Groups protocol work that reaches the same resolved game-query destination. */
export function queryDestinationKey(input: HostedQueryInput): string {
  return `${input.host}:${input.queryPort}`;
}
