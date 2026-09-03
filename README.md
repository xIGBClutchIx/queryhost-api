# QueryHost API

Portable Node.js service for hosted QueryHost game-server queries. It consumes the standalone `queryhost` package and exposes three routes with no version prefix:

```text
POST /query
GET  /games
GET  /health
```

Related public source repositories:

- [QueryHost web and WebMCP integration](https://github.com/xIGBClutchIx/queryhost-web)
- [QueryHost TypeScript library](https://github.com/xIGBClutchIx/queryhost)

The service owns short in-memory caching, identical-request coalescing, global and per-destination capacity limits, destination cooldowns, origin authentication, and structured operational logs. It contains no game protocols, Cloudflare runtime code, persistent cache, database, accounts, or billing system.

## Development

The API is pinned to the exact public `queryhost@1.0.0` registry release. Install dependencies and run the complete gate with:

```bash
cd ../api
npm install
npm run verify
```

Start a loopback-only development service without origin authentication:

```powershell
$env:QUERYHOST_ALLOW_UNAUTHENTICATED_LOCAL = "true"
npm run dev
```

Or exercise the production authentication path with a token containing at least 32 characters:

```powershell
$env:QUERYHOST_ORIGIN_TOKEN = "replace-with-a-long-random-secret"
npm run dev
```

Run the complete local gate with:

```bash
npm run verify
```

## Query response

`POST /query` accepts only `game`, `host`, `port`, `queryPort`, `mode`, and `timeoutMs`. The response preserves the library's discriminated `QueryResult` and adds hosted cache metadata:

```json
{
  "ok": true,
  "game": "rust",
  "server": {},
  "data": {},
  "sources": [],
  "partial": false,
  "warnings": [],
  "durationMs": 42,
  "cache": {
    "status": "miss",
    "ageMs": 0,
    "ttlMs": 10000
  }
}
```

See [docs/API.md](docs/API.md) for the HTTP contract and [docs/Operations.md](docs/Operations.md) for Railway and cost controls.

## Deployment status

The private Railway deployment is healthy with one 0.5 vCPU, 0.5 GB replica, no public domain, and workspace compute limits at a $5 alert and $10 hard shutdown. Browser traffic reaches it only through the public web service's validated and throttled server route.

The API imports only the public package-root exports from exact `queryhost@1.0.0`. The web service calls this API through `api.railway.internal`; public caller limits stay at the web boundary.
