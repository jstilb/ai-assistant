import { expect, test } from "bun:test";
import { generateId } from "./GenerateId.ts";

test("IDs are unique and namespaced across task, queue, work, and pipeline stores", () => {
  const prefixes = ["t", "p", "v", "q", "w", "pi"];
  const ids = prefixes.flatMap((prefix) => Array.from({ length: 25 }, () => generateId(prefix)));
  expect(new Set(ids).size).toBe(ids.length);
  for (let i = 0; i < prefixes.length; i++) {
    expect(ids[i * 25]?.startsWith(`${prefixes[i]}-`)).toBe(true);
  }
});
