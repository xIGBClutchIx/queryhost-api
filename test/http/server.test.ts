import type { AddressInfo } from "node:net";

import type { QueryResult } from "queryhost";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ApiErrorResponse,
  GamesResponse,
  HealthResponse,
  HostedQueryResponse,
  QueryExecutor,
} from "../../src/contracts.js";
import { createApiServer, type ApiServer } from "../../src/http/server.js";
import { ORIGIN_TOKEN_HEADER } from "../../src/http/origin-auth.js";
import type { Logger, LogFields } from "../../src/logging.js";
import { deferred, successfulResult, testConfig, testStartRate } from "../helpers.js";

class SilentLogger implements Logger {
  public info(): void {}
  public error(): void {}
}

class CapturingLogger implements Logger {
  public readonly entries: string[] = [];

  public info(event: string, fields: LogFields = {}): void {
    this.entries.push(JSON.stringify({ event, ...fields }));
  }

  public error(event: string, fields: LogFields = {}): void {
    this.entries.push(JSON.stringify({ event, ...fields }));
  }
}

interface RunningApi {
  readonly api: ApiServer;
  readonly baseUrl: string;
}

const running: ApiServer[] = [];

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      (api) =>
        new Promise<void>((resolve) => {
          api.queries.close();
          api.server.closeAllConnections();
          api.server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function start(
  executor: QueryExecutor,
  config = testConfig(),
  logger: Logger = new SilentLogger(),
): Promise<RunningApi> {
  const api = createApiServer(config, executor, logger);
  await new Promise<void>((resolve) => {
    api.server.listen(0, "127.0.0.1", resolve);
  });
  running.push(api);
  const address = api.server.address() as AddressInfo;
  return { api, baseUrl: `http://127.0.0.1:${address.port}` };
}

function authorizedHeaders(): Readonly<Record<string, string>> {
  return {
    "content-type": "application/json",
    [ORIGIN_TOKEN_HEADER]: "a".repeat(32),
  };
}

async function parsed<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

describe("portable HTTP API", () => {
  it("serves health without authentication and protects other routes", async () => {
    const executor = vi.fn(() => Promise.resolve(successfulResult()));
    const { baseUrl } = await start(executor);

    const healthResponse = await fetch(`${baseUrl}/health`);
    expect(healthResponse.status).toBe(200);
    await expect(parsed<HealthResponse>(healthResponse)).resolves.toMatchObject({
      status: "ok",
      capacity: { active: 0, queued: 0, inFlight: 0 },
      cache: { entries: 0 },
    });

    const unauthorized = await fetch(`${baseUrl}/games`);
    expect(unauthorized.status).toBe(401);
    await expect(parsed<ApiErrorResponse>(unauthorized)).resolves.toEqual({
      error: {
        code: "ORIGIN_UNAUTHORIZED",
        message: "The request did not come from a trusted caller.",
      },
    });

    const unauthorizedQuery = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"game":"rust","host":"play.example.com"}',
    });
    expect(unauthorizedQuery.status).toBe(401);
    expect(executor).not.toHaveBeenCalled();
  });

  it("serves the library registry and rejects unsupported methods and paths", async () => {
    const { baseUrl } = await start(() => Promise.resolve(successfulResult()));
    const headers = authorizedHeaders();

    const gamesResponse = await fetch(`${baseUrl}/games`, { headers });
    const games = await parsed<GamesResponse>(gamesResponse);
    expect(games.games.map((game) => game.id)).toContain("minecraft-java");

    const wrongMethod = await fetch(`${baseUrl}/query`, { headers });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    const missing = await fetch(`${baseUrl}/v1/query`, { headers });
    expect(missing.status).toBe(404);
  });

  it("logs fixed route names instead of attacker-controlled paths", async () => {
    const logger = new CapturingLogger();
    const { baseUrl } = await start(
      () => Promise.resolve(successfulResult()),
      testConfig(),
      logger,
    );
    const secretPath = "target-private-name.example";

    const response = await fetch(`${baseUrl}/${secretPath}`, { headers: authorizedHeaders() });
    expect(response.status).toBe(404);
    await vi.waitFor(() => {
      expect(logger.entries).toHaveLength(1);
    });
    expect(logger.entries[0]).toContain('"route":"unmatched"');
    expect(logger.entries[0]).not.toContain(secretPath);
  });

  it("validates JSON before executing and exposes cache provenance", async () => {
    const executor = vi.fn(() => Promise.resolve(successfulResult()));
    const { baseUrl } = await start(executor);
    const headers = authorizedHeaders();

    const invalid = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers,
      body: '{"game":"rust","host":"https://bad.example"}',
    });
    expect(invalid.status).toBe(400);
    expect(executor).not.toHaveBeenCalled();

    const request = (): Promise<Response> =>
      fetch(`${baseUrl}/query`, {
        method: "POST",
        headers,
        body: '{"game":"rust","host":"play.example.com"}',
      });
    const first = await request();
    expect(first.status).toBe(200);
    expect(first.headers.get("x-queryhost-cache")).toBe("miss");
    await expect(parsed<HostedQueryResponse>(first)).resolves.toMatchObject({
      ok: true,
      game: "rust",
      cache: { status: "miss", ttlMs: 10_000 },
    });

    const second = await request();
    expect(second.headers.get("x-queryhost-cache")).toBe("hit");
    expect(executor).toHaveBeenCalledOnce();
  });

  it("rejects unsupported media types and oversized bodies before execution", async () => {
    const executor = vi.fn(() => Promise.resolve(successfulResult()));
    const { baseUrl } = await start(executor, testConfig({ maxBodyBytes: 256 }));

    const unsupported = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { [ORIGIN_TOKEN_HEADER]: "a".repeat(32) },
      body: "plain text",
    });
    expect(unsupported.status).toBe(415);

    const compressed = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { ...authorizedHeaders(), "content-encoding": "gzip" },
      body: '{"game":"rust","host":"play.example.com"}',
    });
    expect(compressed.status).toBe(415);

    const oversized = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ game: "rust", host: `${"a".repeat(300)}.example.com` }),
    });
    expect(oversized.status).toBe(413);
    expect(executor).not.toHaveBeenCalled();
  });

  it("returns 429 at full capacity without starting another query", async () => {
    const execution = deferred<QueryResult>();
    const executor = vi.fn(() => execution.promise);
    const { baseUrl } = await start(
      executor,
      testConfig({
        capacity: {
          maxActive: 1,
          maxQueued: 0,
          maxPerDestination: 1,
          destinationCooldownMs: 0,
          startRate: testStartRate(),
        },
      }),
    );
    const headers = authorizedHeaders();
    const first = fetch(`${baseUrl}/query`, {
      method: "POST",
      headers,
      body: '{"game":"rust","host":"one.example.com"}',
    });
    while (executor.mock.calls.length === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    const rejected = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers,
      body: '{"game":"rust","host":"two.example.com"}',
    });
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("1");
    expect(executor).toHaveBeenCalledOnce();

    execution.resolve(successfulResult());
    expect((await first).status).toBe(200);
  });

  it("returns the admission retry window before executing excess unique queries", async () => {
    const executor = vi.fn(() => Promise.resolve(successfulResult()));
    const { baseUrl } = await start(
      executor,
      testConfig({
        capacity: {
          maxActive: 2,
          maxQueued: 2,
          maxPerDestination: 1,
          destinationCooldownMs: 0,
          startRate: testStartRate({
            windowMs: 60_000,
            maxStarts: 1,
            maxStartsPerDestination: 1,
          }),
        },
      }),
    );
    const headers = authorizedHeaders();

    const accepted = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers,
      body: '{"game":"rust","host":"one.example.com"}',
    });
    expect(accepted.status).toBe(200);

    const rejected = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers,
      body: '{"game":"rust","host":"two.example.com"}',
    });
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe("60");
    expect(executor).toHaveBeenCalledOnce();
  });
});
