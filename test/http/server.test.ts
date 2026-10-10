import type { AddressInfo } from "node:net";

import type { QueryResult } from "queryhost";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ApiErrorResponse,
  DetectExecutor,
  GamesResponse,
  HealthResponse,
  HostedDetectResponse,
  HostedQueryResponse,
  QueryExecutor,
  QueryStreamLine,
} from "../../src/contracts.js";
import { createApiServer, type ApiServer } from "../../src/http/server.js";
import { ORIGIN_TOKEN_HEADER } from "../../src/http/origin-auth.js";
import type { Logger, LogFields } from "../../src/logging.js";
import {
  deferred,
  detectedResult,
  successfulResult,
  testConfig,
  testStartRate,
} from "../helpers.js";

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
  detector?: DetectExecutor,
): Promise<RunningApi> {
  const api = createApiServer(config, executor, logger, Date.now, detector);
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
    expect(games.games.find((game) => game.id === "v-rising")).toMatchObject({
      protocol: "a2s",
      defaultPort: 9876,
    });
    expect(games.games.find((game) => game.id === "eco")).toMatchObject({
      protocol: "eco",
      defaultPort: 3000,
      defaultQueryPort: 3001,
    });
    expect(games.games.find((game) => game.id === "vein")).toMatchObject({
      protocol: "a2s",
      defaultPort: 7777,
    });
    expect(games.games.find((game) => game.id === "avorion")).toMatchObject({
      protocol: "a2s",
      defaultPort: 27_000,
      defaultQueryPort: 27_020,
    });

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

  it("streams source progress as NDJSON when the caller asks for it", async () => {
    const execution = deferred<QueryResult>();
    const executor: QueryExecutor = (_input, onSource) => {
      onSource({ type: "started", source: "a2s-info" });
      onSource({ type: "completed", report: { source: "a2s-info", status: "ok", rttMs: 5 } });
      return execution.promise;
    };
    const { baseUrl } = await start(executor);
    const response = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { ...authorizedHeaders(), accept: "application/x-ndjson" },
      body: '{"game":"rust","host":"play.example.com"}',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    // Progress reaches the caller while the query is still running.
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
    const decoder = new TextDecoder();
    const firstChunk = await reader?.read();
    let text = decoder.decode(firstChunk?.value, { stream: true });
    expect(text).toContain('"type":"started"');
    execution.resolve(successfulResult());
    for (let chunk = await reader?.read(); chunk?.done === false; chunk = await reader?.read()) {
      text += decoder.decode(chunk.value, { stream: true });
    }

    expect(text.endsWith("\n")).toBe(true);
    const lines = text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as QueryStreamLine);
    expect(lines).toEqual([
      { type: "started", source: "a2s-info" },
      { type: "completed", report: { source: "a2s-info", status: "ok", rttMs: 5 } },
      {
        type: "result",
        result: { ...successfulResult(), cache: { status: "miss", ageMs: 0, ttlMs: 10_000 } },
      },
    ]);

    const cached = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { ...authorizedHeaders(), accept: "application/json, application/x-ndjson" },
      body: '{"game":"rust","host":"play.example.com"}',
    });
    const cachedLines = (await cached.text()).trimEnd().split("\n");
    expect(cachedLines).toHaveLength(1);
    expect(JSON.parse(cachedLines[0] ?? "")).toMatchObject({
      type: "result",
      result: { cache: { status: "hit" } },
    });
  });

  it("answers JSON unless NDJSON is accepted", async () => {
    const { baseUrl } = await start(() => Promise.resolve(successfulResult()));
    for (const accept of ["application/json", "application/x-ndjson;q=0", "*/*"]) {
      const response = await fetch(`${baseUrl}/query`, {
        method: "POST",
        headers: { ...authorizedHeaders(), accept },
        body: '{"game":"rust","host":"play.example.com"}',
      });
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      await response.text();
    }
  });

  it("reports host-free usage counters to trusted callers only", async () => {
    const { baseUrl } = await start(() => Promise.resolve(successfulResult()));
    const headers = authorizedHeaders();

    const unauthorized = await fetch(`${baseUrl}/stats`);
    expect(unauthorized.status).toBe(401);

    const request = (body: string): Promise<Response> =>
      fetch(`${baseUrl}/query`, { method: "POST", headers, body });
    await request('{"game":"rust","host":"private-target.example.com","timeoutMs":3000}');
    await request('{"game":"rust","host":"private-target.example.com"}');
    await request('{"game":"rust","host":"https://bad.example"}');

    const response = await fetch(`${baseUrl}/stats`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text();
    expect(text).not.toContain("private-target");
    expect(JSON.parse(text)).toMatchObject({
      responses: { "200": 2, "400": 1, "401": 1 },
      queries: { hit: 1, miss: 1, coalesced: 0 },
      games: { rust: 2 },
      live: { ok: 1, partial: 0, failed: 0, errors: {} },
    });

    const wrongMethod = await fetch(`${baseUrl}/stats`, { method: "POST", headers });
    expect(wrongMethod.status).toBe(405);
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

  it("refuses a streamed query at capacity with an ordinary JSON 429", async () => {
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
    const headers = { ...authorizedHeaders(), accept: "application/x-ndjson" };
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
    expect(rejected.headers.get("content-type")).toBe("application/json; charset=utf-8");
    await expect(parsed<ApiErrorResponse>(rejected)).resolves.toMatchObject({
      error: { code: "OVERLOADED" },
    });

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

  it("detects games with the configured probe budget and reports host-free counters", async () => {
    const detector = vi.fn<DetectExecutor>(() => Promise.resolve(detectedResult()));
    const logger = new CapturingLogger();
    const { baseUrl } = await start(
      () => Promise.resolve(successfulResult()),
      testConfig({ detectMaxProbes: 3 }),
      logger,
      detector,
    );
    const headers = authorizedHeaders();

    const response = await fetch(`${baseUrl}/detect`, {
      method: "POST",
      headers,
      body: '{"host":"private-target.example.com","port":28015,"timeoutMs":4000}',
    });
    expect(response.status).toBe(200);
    await expect(parsed<HostedDetectResponse>(response)).resolves.toMatchObject({
      ok: true,
      game: "rust",
      evidence: "advertised",
    });
    expect(detector).toHaveBeenCalledWith({
      host: "private-target.example.com",
      port: 28_015,
      mode: "full",
      timeoutMs: 4_000,
      maxProbes: 3,
    });

    const invalid = await fetch(`${baseUrl}/detect`, {
      method: "POST",
      headers,
      body: '{"host":"play.example.com","maxProbes":16}',
    });
    expect(invalid.status).toBe(400);
    const wrongMethod = await fetch(`${baseUrl}/detect`, { headers });
    expect(wrongMethod.status).toBe(405);
    const unauthorized = await fetch(`${baseUrl}/detect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"host":"play.example.com"}',
    });
    expect(unauthorized.status).toBe(401);
    expect(detector).toHaveBeenCalledOnce();

    const stats = await fetch(`${baseUrl}/stats`, { headers });
    const text = await stats.text();
    expect(text).not.toContain("private-target");
    expect(JSON.parse(text)).toMatchObject({
      detections: { games: { rust: 1 }, failed: 0, errors: {} },
    });
    expect(logger.entries.join("\n")).not.toContain("private-target");
    expect(logger.entries.some((entry) => entry.includes('"route":"/detect"'))).toBe(true);
  });

  it("rejects detections that exceed the start window before probing", async () => {
    const detector = vi.fn<DetectExecutor>(() => Promise.resolve(detectedResult()));
    const { baseUrl } = await start(
      () => Promise.resolve(successfulResult()),
      testConfig({
        capacity: {
          ...testConfig().capacity,
          startRate: testStartRate({ maxStarts: 7, maxStartsPerDestination: 5 }),
        },
      }),
      new SilentLogger(),
      detector,
    );
    const request = (): Promise<Response> =>
      fetch(`${baseUrl}/detect`, {
        method: "POST",
        headers: authorizedHeaders(),
        body: '{"host":"play.example.com"}',
      });

    expect((await request()).status).toBe(200);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(parsed<ApiErrorResponse>(limited)).resolves.toMatchObject({
      error: { code: "OVERLOADED" },
    });
    expect(detector).toHaveBeenCalledOnce();
  });
});
