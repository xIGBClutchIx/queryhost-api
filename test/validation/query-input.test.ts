import { listGames } from "queryhost";
import { describe, expect, it } from "vitest";

import {
  QueryInputError,
  parseQueryInput,
  queryCacheKey,
  queryDestinationKey,
} from "../../src/validation/query-input.js";

describe("hosted query input", () => {
  it("requires and preserves the generic A2S query port", () => {
    expect(parseQueryInput('{"game":"a2s","host":"play.example.com","port":27016}')).toMatchObject({
      game: "a2s",
      port: 27_016,
      queryPort: 27_016,
    });
    expect(() => parseQueryInput('{"game":"a2s","host":"play.example.com"}')).toThrow(
      "port is required for generic A2S",
    );
    expect(() =>
      parseQueryInput('{"game":"a2s","host":"play.example.com","port":27016,"queryPort":27017}'),
    ).toThrow("Use port as the query destination");
  });

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

  it.each([
    ["palworld", 27_015],
    ["dst", 27_016],
  ])("keeps %s's independent query port when the game port changes", (game, queryPort) => {
    const input = parseQueryInput(JSON.stringify({ game, host: "play.example.com", port: 65_535 }));
    expect(input.queryPort).toBe(queryPort);
    expect(queryDestinationKey(input)).toBe(`play.example.com:${queryPort}`);
    expect(
      parseQueryInput(
        JSON.stringify({ game, host: "play.example.com", port: 9000, queryPort: 29000 }),
      ).queryPort,
    ).toBe(29_000);
  });

  it.each([
    ["dayz", 3],
    ["valheim", 1],
  ])("preserves %s's query-port offset", (game, offset) => {
    expect(
      parseQueryInput(JSON.stringify({ game, host: "play.example.com", port: 9000 })).queryPort,
    ).toBe(9000 + Number(offset));
    expect(() =>
      parseQueryInput(JSON.stringify({ game, host: "play.example.com", port: 65_535 })),
    ).toThrow("derived query port");
  });

  it.each([
    ["reforger", "arma-reforger", 2001, 17_777],
    ["starbound", "starbound", 21_025, 21_025],
    ["spaceengineers", "space-engineers", 27_016, 27_016],
    ["humanitz", "humanitz", 7777, 27_015],
    ["vrising", "v-rising", 9876, 9877],
  ])("resolves %s to the 1.5.0 %s defaults", (alias, game, port, queryPort) => {
    expect(
      parseQueryInput(JSON.stringify({ game: alias, host: "play.example.com" })),
    ).toMatchObject({ game, port, queryPort });
  });

  it.each([
    ["eco", 3000, 3001],
    ["vein", 7777, 7778],
    ["avorion", 27_000, 27_020],
  ])("resolves %s to the 1.6.0 defaults", (game, port, queryPort) => {
    expect(parseQueryInput(JSON.stringify({ game, host: "play.example.com" }))).toMatchObject({
      game,
      port,
      queryPort,
    });
  });

  // Covers every game a new pinned release adds without a hand-written case per game.
  it.each(listGames().filter((game) => game.defaultPort !== undefined))(
    "resolves $id to its registry defaults",
    ({ id, defaultPort, defaultQueryPort }) => {
      expect(parseQueryInput(JSON.stringify({ game: id, host: "play.example.com" }))).toMatchObject(
        { game: id, port: defaultPort, queryPort: defaultQueryPort ?? defaultPort },
      );
    },
  );

  it("keys the cache by result-shaping fields but not the deadline", () => {
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
    expect(queryCacheKey(base)).toBe(queryCacheKey(shorter));
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
