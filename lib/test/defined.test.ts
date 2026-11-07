import { describe, expect, test } from "bun:test";
import { defined } from "./defined.ts";

describe("defined", () => {
  test("returns the value when it is present", () => {
    expect(defined([1, 2][0])).toBe(1);
    expect(defined(0)).toBe(0);
    expect(defined("")).toBe("");
    expect(defined(false)).toBe(false);
  });

  test("throws a clear error for undefined", () => {
    expect(() => defined([][0])).toThrow("Expected value to be defined, got undefined");
  });

  test("throws a clear error for null, naming the value", () => {
    expect(() => defined(null, "first row")).toThrow("Expected first row to be defined, got null");
  });
});
