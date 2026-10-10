# HTTP API

The API is JSON-only and has no `/v1` prefix. Except for `GET /health`, requests require the `x-queryhost-origin-token` header. The token is supplied by a trusted internal caller and is never returned or logged.

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

## `POST /detect`

Identifies which supported game a server runs with the library's `detect()`, then returns that game's query. Request fields:

| Field       | Type                | Required | Hosted policy                                  |
| ----------- | ------------------- | -------- | ---------------------------------------------- |
| `host`      | string              | yes      | Plain hostname or IP literal, never URL syntax |
| `port`      | integer             | no       | 1 through 65,535; game or query port           |
| `mode`      | `summary` or `full` | no       | Defaults to `full`                             |
| `timeoutMs` | integer             | no       | 1 through 5,000; defaults to 5,000             |

Callers cannot choose the probe budget: each detection probes at most `QUERYHOST_DETECT_MAX_PROBES` protocol and port pairs (default 4). An accepted detection returns HTTP `200` with the library's `DetectResult`, whether or not a game was identified. Detections are not cached or shared between requests and carry no `cache` field.

A detection is charged against the admission windows as one start per probe plus one for the detected game's query, so the default costs five of a destination's six starts. Its destination is the host alone, apart from query destinations. When either window cannot fit that cost, the API returns `429` with `Retry-After` before probing. A detection the library rejects with `TARGET_BLOCKED` returns its whole charge.

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
  },
  "detections": {
    "games": { "valheim": 2 },
    "failed": 1,
    "errors": { "NOT_DETECTED": 1 }
  }
}
```

`detections` counts admitted `POST /detect` runs by detected game ID, or by detection error code when none was identified. `live` counts executor runs (misses), with latency measured around the library call. Counters are keyed only by HTTP status, registry game ID, cache status, and library or detection error code; they never contain targets, callers, or results, and reset when the process restarts.

## HTTP errors

Request-layer failures use `{ "error": { "code", "message" } }`. Stable codes are `BAD_REQUEST`, `BODY_TOO_LARGE`, `INTERNAL_ERROR`, `METHOD_NOT_ALLOWED`, `NOT_FOUND`, `ORIGIN_UNAUTHORIZED`, `OVERLOADED`, and `UNSUPPORTED_MEDIA_TYPE`.
