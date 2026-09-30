#!/usr/bin/env bun
/**
 * dancestudio-pro.test.ts — unit tests for DanceStudioProAdapter's pure
 * helpers (parseStudioParams, buildClassesPostBody). No network; the fetch
 * runner is exercised live via `cli.ts refresh thedancehouse-schedule`.
 */

import { describe, expect, test } from "bun:test";
import {
  buildClassesPostBody,
  parseStudioParams,
} from "../Tools/adapters/DanceStudioProAdapter.ts";

const DANCEHOUSE_URL =
  "https://dancestudio-pro.com/apps/api_classes.php?id=zaqlxajd29jd262a3d5852549209jasdklj21dx62a3d585254d1&s=99627";

describe("parseStudioParams", () => {
  test("extracts id and s from the iframe url", () => {
    expect(parseStudioParams(DANCEHOUSE_URL)).toEqual({
      id: "zaqlxajd29jd262a3d5852549209jasdklj21dx62a3d585254d1",
      s: "99627",
    });
  });

  test("throws loudly when id is missing", () => {
    expect(() =>
      parseStudioParams("https://dancestudio-pro.com/apps/api_classes.php?s=99627")
    ).toThrow(/missing the id\/s query params/);
  });

  test("throws loudly when s is missing", () => {
    expect(() =>
      parseStudioParams("https://dancestudio-pro.com/apps/api_classes.php?id=abc")
    ).toThrow(/missing the id\/s query params/);
  });

  test("throws on a non-URL string", () => {
    expect(() => parseStudioParams("not a url")).toThrow();
  });
});

describe("buildClassesPostBody", () => {
  test("mirrors the widget's own getClasses() request shape", () => {
    const body = buildClassesPostBody("abc123", "99627");
    const params = new URLSearchParams(body);
    expect(params.get("action")).toBe("get_classes");
    expect(params.get("id")).toBe("abc123");
    expect(params.get("s")).toBe("99627");
    expect(params.get("l")).toBe("0");
    // Blank filters = "all classes" — present but empty, as the widget sends.
    for (const key of ["tsearch", "f_wday", "f_age", "f_loc", "f_type"]) {
      expect(params.get(key)).toBe("");
    }
  });
});
