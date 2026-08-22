import { describe, expect, it } from "vitest";

import { JsonLogger } from "../src/logging.js";

describe("structured logger", () => {
  it("writes one stable JSON line without exception objects", () => {
    const lines: string[] = [];
    const logger = new JsonLogger(
      (line) => {
        lines.push(line);
      },
      (line) => {
        lines.push(line);
      },
      () => "2026-08-21T00:00:00.000Z",
    );

    logger.info("http.request", { requestId: "request-1", status: 200 });
    expect(lines).toEqual([
      '{"timestamp":"2026-08-21T00:00:00.000Z","level":"info","event":"http.request","requestId":"request-1","status":200}\n',
    ]);
  });
});
