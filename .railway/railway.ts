import { defineRailway, github, project, service } from "railway/iac";

export default defineRailway((context) => {
  const api = service("api", {
    source: github("xIGBClutchIx/queryhost-api", { branch: "main" }),
    build: "npm run build",
    start: "npm start",
    healthcheck: "/health",
    healthcheckTimeout: 10,
    replicas: 1,
    env: {
      NODE_ENV: "production",
      HOST: "0.0.0.0",
      QUERYHOST_ORIGIN_TOKEN: context.shared.QUERYHOST_ORIGIN_TOKEN,
      QUERYHOST_MAX_BODY_BYTES: "4096",
      QUERYHOST_MAX_ACTIVE: "8",
      QUERYHOST_MAX_QUEUED: "32",
      QUERYHOST_MAX_PER_DESTINATION: "2",
      QUERYHOST_DESTINATION_COOLDOWN_MS: "250",
      QUERYHOST_CACHE_MAX_ENTRIES: "1000",
      QUERYHOST_CACHE_MAX_BYTES: "16777216",
      QUERYHOST_CACHE_SUCCESS_TTL_MS: "10000",
      QUERYHOST_CACHE_PARTIAL_TTL_MS: "5000",
      QUERYHOST_CACHE_OFFLINE_TTL_MS: "2000",
    },
  });

  return project("queryhost-api", { resources: [api] });
});
