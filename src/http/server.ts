import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { listGames } from "queryhost";

import type { ApiConfig } from "../config.js";
import type {
  ApiErrorCode,
  ApiErrorResponse,
  GamesResponse,
  DetectExecutor,
  HealthResponse,
  HostedDetectResponse,
  HostedQueryResponse,
  QueryExecutor,
} from "../contracts.js";
import type { Logger } from "../logging.js";
import { CapacityRejectedError } from "../runtime/capacity-gate.js";
import { QueryService } from "../runtime/query-service.js";
import { UsageStats, type UsageSnapshot } from "../runtime/usage-stats.js";
import { QueryInputError, parseDetectInput, parseQueryInput } from "../validation/query-input.js";
import { BodyReadError, readBoundedBody } from "./body.js";
import { isOriginAuthorized } from "./origin-auth.js";

type Clock = () => number;
type JsonPayload =
  | ApiErrorResponse
  | GamesResponse
  | HealthResponse
  | HostedDetectResponse
  | HostedQueryResponse
  | UsageSnapshot;
type RouteName = "/detect" | "/games" | "/health" | "/query" | "/stats" | "unmatched";
type JsonRoute = "/detect" | "/query";

interface RequestOutcome {
  readonly status: number;
  readonly cache?: string;
  readonly game?: string;
}

export interface ApiServer {
  readonly server: Server;
  readonly queries: QueryService;
  readonly usage: UsageStats;
}

function errorResponse(code: ApiErrorCode, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: JsonPayload,
  requestId: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString(),
    "x-content-type-options": "nosniff",
    "x-queryhost-request-id": requestId,
    ...extraHeaders,
  });
  response.end(body);
}

function mediaType(request: IncomingMessage): string {
  return request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function routeName(request: IncomingMessage): RouteName {
  const pathname = new URL(request.url ?? "/", "http://queryhost.invalid").pathname;
  if (
    pathname === "/detect" ||
    pathname === "/games" ||
    pathname === "/health" ||
    pathname === "/query" ||
    pathname === "/stats"
  ) {
    return pathname;
  }
  return "unmatched";
}

function methodNotAllowed(
  response: ServerResponse,
  requestId: string,
  allow: string,
): RequestOutcome {
  sendJson(
    response,
    405,
    errorResponse("METHOD_NOT_ALLOWED", "The route does not support this HTTP method."),
    requestId,
    { allow },
  );
  return { status: 405 };
}

function overloaded(
  response: ServerResponse,
  requestId: string,
  error: CapacityRejectedError,
): void {
  sendJson(
    response,
    429,
    errorResponse("OVERLOADED", "The query service is at capacity. Try again later."),
    requestId,
    { "retry-after": error.retryAfterSeconds.toString() },
  );
}

/** Reads a bounded JSON body, or answers the request and returns its outcome instead. */
async function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  config: ApiConfig,
  route: JsonRoute,
): Promise<string | RequestOutcome> {
  const contentEncoding = request.headers["content-encoding"]?.toLowerCase();
  if (
    mediaType(request) !== "application/json" ||
    (contentEncoding !== undefined && contentEncoding !== "identity")
  ) {
    sendJson(
      response,
      415,
      errorResponse(
        "UNSUPPORTED_MEDIA_TYPE",
        `POST ${route} requires an uncompressed application/json body.`,
      ),
      requestId,
    );
    return { status: 415 };
  }

  try {
    return await readBoundedBody(request, config.maxBodyBytes);
  } catch (error) {
    if (error instanceof BodyReadError) {
      const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
      sendJson(response, status, errorResponse(error.code, error.message), requestId);
      return { status };
    }
    throw error;
  }
}

/** Parses validated input, or answers 400 and returns the outcome instead. */
function parseBody<T>(
  response: ServerResponse,
  requestId: string,
  parse: () => T,
): T | RequestOutcome {
  try {
    return parse();
  } catch (error) {
    if (error instanceof QueryInputError) {
      sendJson(response, 400, errorResponse("BAD_REQUEST", error.message), requestId);
      return { status: 400 };
    }
    throw error;
  }
}

async function queryRoute(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  config: ApiConfig,
  queries: QueryService,
): Promise<RequestOutcome> {
  const text = await readJsonBody(request, response, requestId, config, "/query");
  if (typeof text !== "string") {
    return text;
  }
  const input = parseBody(response, requestId, () => parseQueryInput(text));
  if ("status" in input) {
    return input;
  }

  try {
    const result = await queries.execute(input);
    sendJson(response, 200, result, requestId, {
      "x-queryhost-cache": result.cache.status,
      age: Math.floor(result.cache.ageMs / 1_000).toString(),
    });
    return { status: 200, cache: result.cache.status, game: input.game };
  } catch (error) {
    if (error instanceof CapacityRejectedError) {
      overloaded(response, requestId, error);
      return { status: 429, game: input.game };
    }
    throw error;
  }
}

async function detectRoute(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  config: ApiConfig,
  queries: QueryService,
): Promise<RequestOutcome> {
  const text = await readJsonBody(request, response, requestId, config, "/detect");
  if (typeof text !== "string") {
    return text;
  }
  const input = parseBody(response, requestId, () =>
    parseDetectInput(text, config.detectMaxProbes),
  );
  if ("status" in input) {
    return input;
  }

  try {
    const result = await queries.detect(input);
    sendJson(response, 200, result, requestId);
    return result.ok ? { status: 200, game: result.game } : { status: 200 };
  } catch (error) {
    if (error instanceof CapacityRejectedError) {
      overloaded(response, requestId, error);
      return { status: 429 };
    }
    throw error;
  }
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  config: ApiConfig,
  queries: QueryService,
  usage: UsageStats,
  startedAt: number,
  now: Clock,
): Promise<RequestOutcome> {
  const url = new URL(request.url ?? "/", "http://queryhost.invalid");

  if (url.pathname === "/health") {
    if (request.method !== "GET") {
      return methodNotAllowed(response, requestId, "GET");
    }
    const snapshot = queries.snapshot();
    const health: HealthResponse = {
      status: "ok",
      uptimeSeconds: Math.max(0, (now() - startedAt) / 1_000),
      capacity: {
        active: snapshot.capacity.active,
        queued: snapshot.capacity.queued,
        inFlight: snapshot.inFlight,
        startsInWindow: snapshot.capacity.rate.startsInWindow,
        maxStartsInWindow: snapshot.capacity.rate.maxStarts,
        trackedDestinations: snapshot.capacity.rate.trackedDestinations,
        maxTrackedDestinations: snapshot.capacity.rate.maxTrackedDestinations,
      },
      cache: snapshot.cache,
    };
    sendJson(response, 200, health, requestId);
    return { status: 200 };
  }

  if (!isOriginAuthorized(request, config.originToken)) {
    sendJson(
      response,
      401,
      errorResponse("ORIGIN_UNAUTHORIZED", "The request did not come from a trusted caller."),
      requestId,
    );
    return { status: 401 };
  }

  if (url.pathname === "/games") {
    if (request.method !== "GET") {
      return methodNotAllowed(response, requestId, "GET");
    }
    sendJson(response, 200, { games: listGames() }, requestId);
    return { status: 200 };
  }

  if (url.pathname === "/stats") {
    if (request.method !== "GET") {
      return methodNotAllowed(response, requestId, "GET");
    }
    sendJson(response, 200, usage.snapshot(), requestId);
    return { status: 200 };
  }

  if (url.pathname === "/query") {
    if (request.method !== "POST") {
      return methodNotAllowed(response, requestId, "POST");
    }
    return queryRoute(request, response, requestId, config, queries);
  }

  if (url.pathname === "/detect") {
    if (request.method !== "POST") {
      return methodNotAllowed(response, requestId, "POST");
    }
    return detectRoute(request, response, requestId, config, queries);
  }

  sendJson(
    response,
    404,
    errorResponse("NOT_FOUND", "The requested route does not exist."),
    requestId,
  );
  return { status: 404 };
}

/** Creates the portable Node.js HTTP service without binding a socket. */
export function createApiServer(
  config: ApiConfig,
  executor: QueryExecutor,
  logger: Logger,
  now: Clock = Date.now,
  detector?: DetectExecutor,
): ApiServer {
  const usage = new UsageStats(now);
  const queries = new QueryService(config, executor, now, usage, detector);
  const startedAt = now();
  const server = createServer((request, response) => {
    const requestId = randomUUID();
    const requestStartedAt = now();
    void routeRequest(request, response, requestId, config, queries, usage, startedAt, now)
      .then((outcome) => {
        usage.recordResponse(outcome.status);
        logger.info("http.request", {
          requestId,
          method: request.method ?? "",
          route: routeName(request),
          status: outcome.status,
          durationMs: Math.max(0, now() - requestStartedAt),
          ...(outcome.cache === undefined ? {} : { cache: outcome.cache }),
          ...(outcome.game === undefined ? {} : { game: outcome.game }),
        });
      })
      .catch(() => {
        logger.error("http.internal_error", { requestId });
        usage.recordResponse(500);
        if (!response.headersSent) {
          sendJson(
            response,
            500,
            errorResponse("INTERNAL_ERROR", "The API failed unexpectedly."),
            requestId,
          );
        } else {
          response.destroy();
        }
      });
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  return { server, queries, usage };
}
