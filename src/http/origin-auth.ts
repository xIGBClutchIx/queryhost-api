import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const ORIGIN_TOKEN_HEADER = "x-queryhost-origin-token";

/** Compares the edge secret without leaking a useful prefix timing signal. */
export function isOriginAuthorized(
  request: IncomingMessage,
  expected: string | undefined,
): boolean {
  if (expected === undefined) {
    return true;
  }

  const provided = request.headers[ORIGIN_TOKEN_HEADER];
  if (typeof provided !== "string") {
    return false;
  }

  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.byteLength === providedBytes.byteLength &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}
