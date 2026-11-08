import { describe, expect, test } from "bun:test";
import { collectRepeatableFlag, parseFlags } from "./CliFlags.ts";

describe("CliFlags", () => {
  test("parseFlags splits flags, booleans and positionals", () => {
    expect(parseFlags(["query", "tacos", "--limit", "5", "--json", "--tag", "a", "--tag", "b"])).toEqual({
      flags: { limit: "5", json: "true", tag: "b" },
      positional: ["query", "tacos"],
    });
  });

  test("trailing flag is boolean", () => {
    expect(parseFlags(["--dry-run"]).flags).toEqual({ "dry-run": "true" });
  });

  test("collectRepeatableFlag keeps every occurrence in order", () => {
    expect(collectRepeatableFlag(["--tag", "a", "--x", "1", "--tag", "b", "--tag"], "tag")).toEqual(["a", "b"]);
  });
});
