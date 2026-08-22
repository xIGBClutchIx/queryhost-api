import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";

export type BodyReadErrorCode = "BODY_TOO_LARGE" | "BAD_REQUEST";

export class BodyReadError extends Error {
  public readonly code: BodyReadErrorCode;

  public constructor(code: BodyReadErrorCode, message: string) {
    super(message);
    this.name = "BodyReadError";
    this.code = code;
  }
}

/** Reads an HTTP body without allowing the socket to exceed the configured byte budget. */
export function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return Promise.reject(new BodyReadError("BAD_REQUEST", "Content-Length is invalid."));
    }
    if (bytes > maxBytes) {
      request.resume();
      return Promise.reject(new BodyReadError("BODY_TOO_LARGE", "The request body is too large."));
    }
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const fail = (error: BodyReadError): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      request.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        fail(new BodyReadError("BODY_TOO_LARGE", "The request body is too large."));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, bytes).toString("utf8"));
    };
    const onError = (): void => {
      fail(new BodyReadError("BAD_REQUEST", "The request body could not be read."));
    };
    const onAborted = (): void => {
      fail(new BodyReadError("BAD_REQUEST", "The request was aborted before its body completed."));
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}
