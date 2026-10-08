# Game-support staging

The initial game-support test deployed the API to the `staging` environment using a package packed from library commit `c33e128`. The API now consumes the exact public `queryhost` 1.4.2 release for staging and production.

The service is `api-staging`. It has no public domain. `HOST=::` supports Railway private networking, `PORT=3000`, and a fresh staging-only `QUERYHOST_ORIGIN_TOKEN` authenticates the staging web service. Production source, variables, and domains remain separate.

Run `npm ci` and `npm run verify`, then upload this branch's worktree with:

```bash
railway up . --path-as-root --project b3ce842c-00b1-4322-a160-74d7c04fe696 --environment b5a25f67-54b8-40df-a05f-acf2e308dfa3 --service f94451c8-c99c-418a-af78-559a8ef902bd --detach
```

The packed library includes RedM, Palworld, Satisfactory, Vintage Story, DayZ, Don't Starve Together, and Valheim. Factorio remains a documented support boundary rather than a registered profile. API input normalization honors the registry's fixed query-port strategy for Palworld and Don't Starve Together.
