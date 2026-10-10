# HTTP API

The API speaks JSON, plus an opt-in NDJSON stream for `POST /query` progress, and has no `/v1` prefix. Except for `GET /health`, requests require the `x-queryhost-origin-token` header. The token is supplied by a trusted internal caller and is never returned or logged.

## `POST /query`

Request fields:

| Field       | Type                | Required | Hosted policy                                  |
| ----------- | ------------------- | -------- | ---------------------------------------------- |
| `game`      | string              | yes      | Canonical game ID or library alias             |
| `host`      | string              | yes      | Plain hostname or IP literal, never URL syntax |
| `port`      | integer             | no*      | 1 through 65,535                               |
| `queryPort` | integer             | no       | 1 through 65,535                               |
| `mode`      | `summary` or `full` | no       | Defaults to `full`                             |
| `timeoutMs` | integer             | no       | 1 through 5,000; defaults to 5,000             |

`port` is required when `game` is `a2s`. For that generic profile it is the actual A2S query destination and `queryPort` must be omitted. Named profiles keep their registry defaults and separate query-port conventions.

Unknown fields, compressed bodies, non-JSON bodies, and bodies over the configured byte limit are rejected before query execution. A structurally accepted query returns HTTP `200` with the library result, including normal query failures. Hosted metadata appears in `cache` and in the `x-queryhost-cache` and `Age` headers.

Cache statuses are:

- `miss`: this request admitted the live query
- `coalesced`: this request shared an identical live query
- `hit`: the result came from the process-local LRU

`timeoutMs` is not part of the cache key. A cached success serves any deadline; a cached timeout or offline failure serves only requests whose `timeoutMs` is no greater than the one that produced it. A request shares in-flight work only when that run has at least the request's `timeoutMs` and should finish before the request's own deadline.

When the live-work queue is full, the API returns HTTP `429` with `Retry-After: 1` before invoking the library.

### Streaming progress

Send `Accept: application/x-ndjson` to receive the query's per-source progress as it runs. A `200` stream has `Content-Type: application/x-ndjson; charset=utf-8` and one JSON object per line:

```ndjson
{"type":"started","source":"a2s-info"}
{"type":"completed","report":{"source":"a2s-info","status":"ok","rttMs":31}}
{"type":"result","result":{"ok":true,"game":"rust","cache":{"status":"miss","ageMs":0,"ttlMs":10000}}}
```

`started` and `completed` lines are the library's `QuerySourceEvent` values. Exactly one `result` line ends the stream with the same body the JSON response carries; result bodies are abbreviated above. Cache metadata appears only in that line, not in `x-queryhost-cache` or `Age`. A coalesced request first receives the shared run's earlier events, and a cache hit streams only the `result` line.

Validation, authentication, and capacity failures happen before any line is written and keep their ordinary JSON error responses and statuses. Without that `Accept` value, or with `q=0`, the response is the JSON described above.

## `GET /games`

Returns `{ "games": [...] }` from the library's exported registry. The API does not maintain another game list.

## `GET /health`

Returns minimal liveness and bounded operational counters without authentication:

```json
{
  "status": "ok",
  "uptimeSeconds": 10,
  "capacity": {
    "active": 0,
    "queued": 0,
    "inFlight": 0,
    "startsInWindow": 0,
    "maxStartsInWindow": 120,
    "trackedDestinations": 0,
    "maxTrackedDestinations": 1000
  },
  "cache": { "entries": 0, "bytes": 0, "maxEntries": 1000, "maxBytes": 16777216 }
}
```

Health does not expose targets, results, secrets, or query history.

## `GET /stats`

Returns aggregate usage counters since process start for trusted callers:

```json
{
  "startedAt": "2026-10-08T00:00:00.000Z",
  "responses": { "200": 12, "429": 1 },
  "queries": { "hit": 7, "miss": 4, "coalesced": 1 },
  "games": { "minecraft-java": 9, "rust": 3 },
  "live": {
    "ok": 3,
    "partial": 0,
    "failed": 1,
    "errors": { "TIMEOUT": 1 },
    "latencyMs": [
      { "le": 100, "count": 1 },
      { "le": 250, "count": 2 },
      { "le": 500, "count": 0 },
      { "le": 1000, "count": 0 },
      { "le": 2500, "count": 0 },
      { "le": 5000, "count": 1 },
      { "le": null, "count": 0 }
    ]
  }
}
```

`live` counts executor runs (misses), with latency measured around the library call. Counters are keyed only by HTTP status, registry game ID, cache status, and library error code; they never contain targets, callers, or results, and reset when the process restarts.

## HTTP errors

Request-layer failures use `{ "error": { "code", "message" } }`. Stable codes are `BAD_REQUEST`, `BODY_TOO_LARGE`, `INTERNAL_ERROR`, `METHOD_NOT_ALLOWED`, `NOT_FOUND`, `ORIGIN_UNAUTHORIZED`, `OVERLOADED`, and `UNSUPPORTED_MEDIA_TYPE`.
