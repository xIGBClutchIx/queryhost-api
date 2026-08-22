# Operations

The deployment is one private Railway Node.js service. It has no public domain; the public QueryHost web service calls it over Railway private networking with the shared origin token.

## Private deployment baseline

1. Verify that `vendor/queryhost-0.0.0.tgz` was produced from the intended clean library commit with `npm run verify` followed by `npm pack`.
2. Create a private Railway project and attach the private API repository without generating a public domain.
3. Create a random shared `QUERYHOST_ORIGIN_TOKEN` of at least 32 characters.
4. Set `HOST=0.0.0.0` and `PORT=3000`. Configure the web service's server-only base URL as `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3000`.
5. Review `.railway/railway.ts` with `railway config plan` before applying it.
6. Set one replica with Railway's current minimum 0.5 vCPU and 0.5 GB replica limits. Raise a limit only when measured usage proves it is too small.
7. Configure a Railway compute email alert at $5 and the minimum $10 hard limit. The hard limit intentionally takes workloads offline instead of allowing an open-ended bill:

   ```bash
   railway usage limit set --target workspace --soft 5 --hard 10
   railway usage limit status --target workspace
   ```

Railway usage limits are workspace-wide. Revisit those dollar thresholds before another project shares the workspace.

The limits above apply to compute usage. Do not use Railway Agent as part of the API runtime or deployment workflow; its spending limit is separate from compute.

The first private production deployment completed successfully on August 21, 2026. Railway's `/health` check returned `200`, the process used about 0.04 GB of memory at idle, and the service had no Railway-generated or custom public domain. The workspace compute limits were verified at a $5 email alert and a $10 hard shutdown limit. Treat these values as the initial ceiling, not a capacity promise.

## Runtime cost ceilings

The default process permits at most eight active library queries, 16 queued unique queries, one active query per destination, and one new start per destination every two seconds. A rolling 60-second admission window permits at most 120 unique live-query admissions globally and six per destination while tracking no more than 1,000 destinations. Identical requests share one in-flight execution and do not consume extra queue positions or admission slots. A full queue or admission window returns `429` before sockets open.

The LRU stores at most 1,000 entries or 16 MiB of serialized results. Successful results live for 10 seconds, partial results for 5 seconds, and timeout/offline failures for 2 seconds. Invalid, blocked, malformed, aborted, and internal failures are not cached.

After a private load test, verify both the configured replica ceiling and observed usage:

```bash
railway usage projects --project queryhost
railway usage limit status --target workspace
```

Record the measured CPU and memory peaks before changing the initial replica limits. Replica limits bound worst-case service consumption; they do not reduce billing below actual usage.

## Logs and health

Logs are newline-delimited JSON containing event names, request IDs, a fixed route name, method, status, duration, canonical game ID, and cache status where applicable. Unknown paths are recorded only as `unmatched`. Logs intentionally omit target hosts, request bodies, player data, secrets, and exception contents.

Railway should check `GET /health`. Track active, queued, in-flight, rolling-start, and tracked-destination counts together with cache bytes and entries. A service that repeatedly reaches its admission, queue, or replica limits should reject traffic; do not add replicas or external cache infrastructure until measurements justify the cost.

## Shutdown

`SIGTERM` and `SIGINT` stop queue admission immediately, reject queued work, stop accepting connections, and give active requests 10 seconds to finish before connections are forced closed.
