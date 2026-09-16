# Working in QueryHost API

This repository contains the portable hosted API. It consumes `queryhost` only through the library's package-root exports and contains no game protocol implementations.

## Boundaries

- Keep the runtime portable Node.js with no Cloudflare-specific APIs.
- Keep caching process-local and bounded; do not add Redis, databases, queues, accounts, billing, or persistent query history.
- Require origin authentication outside explicitly enabled loopback development.
- Reject excess work before calling the query executor.
- Never log target hosts, player data, secrets, request bodies, or arbitrary exceptions.
- Keep TypeScript strict and do not use explicit `any` or `unknown`.

## Finish gate

Run `npm run verify`. Add focused tests for contract, cache, coalescing, capacity, and lifecycle changes. Push, deploy, publish, or expose domains only when the current request authorizes that action. Prepare and verify the requested work first; ask once if authorization or the destination remains unresolved.

Keep this file operational. Put API contracts in `docs/API.md` and deployment procedures in `docs/Operations.md`.
