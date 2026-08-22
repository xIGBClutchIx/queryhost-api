# QueryHost API

Portable Node.js service for hosted QueryHost game-server queries. It consumes the standalone `queryhost` package and exposes three routes with no version prefix:

```text
POST /query
GET  /games
GET  /health
```

The service owns short in-memory caching, identical-request coalescing, global and per-destination capacity limits, destination cooldowns, origin authentication, and structured operational logs. It contains no game protocols, Cloudflare runtime code, persistent cache, database, accounts, or billing system.

## Development

The repository contains a packed snapshot of the private library in `vendor/`. Refresh it from the sibling library after changing `queryhost`:

```bash
cd ../query
npm install
npm run verify

cd ../api
npm pack ../query --pack-destination vendor
npm install
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

The vendored tarball is the same package artifact produced by `npm pack` and the API imports only its package-root exports. Replace the tarball dependency with the published npm version when publishing the library becomes an explicit project decision. The web service calls this API through `api.railway.internal`; public caller limits stay at the web boundary.
