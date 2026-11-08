import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTokenFile } from "./GoogleOAuth.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("writeTokenFile writes the authorized-user shape with ms expiry, creating dirs", () => {
  dir = mkdtempSync(join(tmpdir(), "goauth-"));
  const path = join(dir, "nested", "sheets-token.json");
  writeTokenFile(
    path,
    { access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "Bearer", scope: "s" },
    1_000,
  );
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    access_token: "a",
    refresh_token: "r",
    scope: "s",
    token_type: "Bearer",
    expiry_date: 3_601_000,
  });
});
