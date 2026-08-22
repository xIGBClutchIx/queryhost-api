import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { listGames } from "queryhost";

import type { ApiConfig } from "../config.js";
import type {
  ApiErrorCode,
  ApiErrorResponse,
  GamesResponse,
  HealthResponse,
  HostedQueryResponse,
  QueryExecutor,
} from "../contracts.js";
import type { Logger } from "../logging.js";
import { CapacityRejectedError } from "../runtime/capacity-gate.js";
import { QueryService } from "../runtime/query-service.js";
import { QueryInputError, parseQueryInput } from "../validation/query-input.js";
import { BodyReadError, readBoundedBody } from "./body.js";
import { isOriginAuthorized } from "./origin-auth.js";

type Clock = () => number;
type JsonPayload = ApiErrorResponse | GamesResponse | HealthResponse | HostedQueryResponse;
type RouteName = "/games" | "/health" | "/query" | "unmatched";

interface RequestOutcome {
  readonly status: number;
  readonly cache?: string;
  readonly game?: string;
}

export interface ApiServer {
  readonly server: Server;
  readonly queries: QueryService;
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
  if (pathname === "/games" || pathname === "/health" || pathname === "/query") {
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

async function queryRoute(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  config: ApiConfig,
  queries: QueryService,
): Promise<RequestOutcome> {
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
        "POST /query requires an uncompressed application/json body.",
      ),
      requestId,
    );
    return { status: 415 };
  }

  let text: string;
  try {
    text = await readBoundedBody(request, config.maxBodyBytes);
  } catch (error) {
    if (error instanceof BodyReadError) {
      const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
      sendJson(response, status, errorResponse(error.code, error.message), requestId);
      return { status };
    }
    throw error;
  }

  let input;
  try {
    input = parseQueryInput(text);
  } catch (error) {
    if (error instanceof QueryInputError) {
      sendJson(response, 400, errorResponse("BAD_REQUEST", error.message), requestId);
      return { status: 400 };
    }
    throw error;
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
      sendJson(
        response,
        429,
        errorResponse("OVERLOADED", "The query service is at capacity. Try again later."),
        requestId,
        { "retry-after": error.retryAfterSeconds.toString() },
      );
      return { status: 429, game: input.game };
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

  if (url.pathname === "/query") {
    if (request.method !== "POST") {
      return methodNotAllowed(response, requestId, "POST");
    }
    return queryRoute(request, response, requestId, config, queries);
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
): ApiServer {
  const queries = new QueryService(config, executor, now);
  const startedAt = now();
  const server = createServer((request, response) => {
    const requestId = randomUUID();
    const requestStartedAt = now();
    void routeRequest(request, response, requestId, config, queries, startedAt, now)
      .then((outcome) => {
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
  return { server, queries };
}
