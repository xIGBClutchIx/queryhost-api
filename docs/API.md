# HTTP API

The API is JSON-only and has no `/v1` prefix. Except for `GET /health`, requests require the `x-queryhost-origin-token` header. The token is supplied by a trusted internal caller and is never returned or logged.

## `POST /query`

Request fields:

| Field       | Type                | Required | Hosted policy                                  |
| ----------- | ------------------- | -------- | ---------------------------------------------- |
| `game`      | string              | yes      | Canonical game ID or library alias             |
| `host`      | string              | yes      | Plain hostname or IP literal, never URL syntax |
| `port`      | integer             | no       | 1 through 65,535                               |
| `queryPort` | integer             | no       | 1 through 65,535                               |
| `mode`      | `summary` or `full` | no       | Defaults to `full`                             |
| `timeoutMs` | integer             | no       | 1 through 5,000; defaults to 5,000             |

Unknown fields, compressed bodies, non-JSON bodies, and bodies over the configured byte limit are rejected before query execution. A structurally accepted query returns HTTP `200` with the library result, including normal query failures. Hosted metadata appears in `cache` and in the `x-queryhost-cache` and `Age` headers.

Cache statuses are:

- `miss`: this request admitted the live query
- `coalesced`: this request shared an identical live query
- `hit`: the result came from the process-local LRU

When the live-work queue is full, the API returns HTTP `429` with `Retry-After: 1` before invoking the library.

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

## HTTP errors

Request-layer failures use `{ "error": { "code", "message" } }`. Stable codes are `BAD_REQUEST`, `BODY_TOO_LARGE`, `INTERNAL_ERROR`, `METHOD_NOT_ALLOWED`, `NOT_FOUND`, `ORIGIN_UNAUTHORIZED`, `OVERLOADED`, and `UNSUPPORTED_MEDIA_TYPE`.
