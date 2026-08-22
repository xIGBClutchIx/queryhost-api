import { describe, expect, it } from "vitest";

import {
  QueryInputError,
  parseQueryInput,
  queryCacheKey,
  queryDestinationKey,
} from "../../src/validation/query-input.js";

describe("hosted query input", () => {
  it("canonicalizes aliases, hostnames, defaults, and derived query ports", () => {
    const input = parseQueryInput(
      JSON.stringify({ game: "zomboid", host: " PZ.Example.COM. ", mode: "summary" }),
    );

    expect(input).toEqual({
      game: "project-zomboid",
      host: "pz.example.com",
      port: 16_261,
      queryPort: 16_261,
      mode: "summary",
      timeoutMs: 5_000,
    });
  });

  it("preserves the Rust query-port offset for a custom game port", () => {
    expect(parseQueryInput('{"game":"rust","host":"203.0.113.10","port":29000}')).toMatchObject({
      port: 29_000,
      queryPort: 29_002,
    });
  });

  it("includes every result-affecting field in the stable cache key", () => {
    const base = parseQueryInput('{"game":"rust","host":"play.example.com"}');
    const equivalent = parseQueryInput(
      '{"game":"rust","host":" PLAY.EXAMPLE.COM. ","port":28015,"queryPort":28017,"mode":"full","timeoutMs":5000}',
    );
    const minecraftAlias = parseQueryInput('{"game":"mc","host":"mc.example.com"}');
    const minecraftCanonical = parseQueryInput('{"game":"minecraft-java","host":"mc.example.com"}');
    const summary = parseQueryInput('{"game":"rust","host":"play.example.com","mode":"summary"}');
    const shorter = parseQueryInput('{"game":"rust","host":"play.example.com","timeoutMs":1000}');

    expect(queryCacheKey(base)).toBe(queryCacheKey(equivalent));
    expect(queryCacheKey(minecraftAlias)).toBe(queryCacheKey(minecraftCanonical));
    expect(queryCacheKey(base)).not.toBe(queryCacheKey(summary));
    expect(queryCacheKey(base)).not.toBe(queryCacheKey(shorter));
    expect(queryDestinationKey(base)).toBe("play.example.com:28017");
  });

  it("rejects malformed JSON, arrays, extra fields, and URL syntax", () => {
    expect(() => parseQueryInput("{")).toThrow(QueryInputError);
    expect(() => parseQueryInput("[]")).toThrow("JSON object");
    expect(() =>
      parseQueryInput('{"game":"rust","host":"play.example.com","url":"https://bad"}'),
    ).toThrow("Unsupported request field");
    expect(() => parseQueryInput('{"game":"rust","host":"https://play.example.com"}')).toThrow(
      "without URL syntax",
    );
  });

  it("rejects unsupported games and values outside hosted budgets", () => {
    expect(() => parseQueryInput('{"game":"quake","host":"play.example.com"}')).toThrow(
      "supported game ID",
    );
    expect(() =>
      parseQueryInput('{"game":"rust","host":"play.example.com","timeoutMs":5001}'),
    ).toThrow("timeoutMs");
    expect(() => parseQueryInput('{"game":"rust","host":"play.example.com","port":0}')).toThrow(
      "port",
    );
  });
});
