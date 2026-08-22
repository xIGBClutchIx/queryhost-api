# Railway configuration

`.railway/railway.ts` owns the private GitHub source, portable service settings, one-replica intent, healthcheck, and bounded runtime variables. It deliberately declares no database, volume, Redis service, custom domain, or public Railway domain.

Railway infrastructure-as-code is applied with the Railway CLI:

```bash
railway link
railway config plan
railway config apply
```

Do not apply the configuration until the vendored `queryhost` package artifact has been verified and the shared secret `QUERYHOST_ORIGIN_TOKEN` exists in the selected Railway environment. Always review the plan before applying it.

Replica CPU and memory limits are not represented by Railway's current infrastructure-as-code DSL. Configure the current 0.5 vCPU and 0.5 GB ceilings in the service settings. Configure and verify the $5 soft and $10 hard workspace compute limits with `railway usage limit`; the exact commands are in [docs/Operations.md](../docs/Operations.md).
