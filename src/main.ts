import { query } from "queryhost";

import { loadConfig } from "./config.js";
import type { QueryExecutor } from "./contracts.js";
import { createApiServer } from "./http/server.js";
import { JsonLogger } from "./logging.js";

const SHUTDOWN_GRACE_MS = 10_000;
const config = loadConfig();
const logger = new JsonLogger();
const executor: QueryExecutor = (input) => query(input);
const api = createApiServer(config, executor, logger);

api.server.listen(config.port, config.host, () => {
  logger.info("server.listening", { host: config.host, port: config.port });
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info("server.shutdown_started", { signal });
  api.queries.close();

  const forced = setTimeout(() => {
    logger.error("server.shutdown_forced");
    api.server.closeAllConnections();
  }, SHUTDOWN_GRACE_MS);
  forced.unref();

  api.server.close(() => {
    clearTimeout(forced);
    logger.info("server.shutdown_complete");
  });
}

process.once("SIGINT", () => {
  shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});
