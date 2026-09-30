import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRemoteAuth, resolveRemoteAccess, withRemoteAuth } from "./RemoteAccess.ts";

function secrets(obj: Record<string, string>): string {
  const p = join(mkdtempSync(join(tmpdir(), "remote-access-")), "secrets.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
const opts = { secretPrefix: "svc", bindEnv: "SVC_BIND", tokenEnv: "SVC_TOKEN" };

describe("resolveRemoteAccess", () => {
  test("defaults to loopback with auth off", () => {
    expect(resolveRemoteAccess({ ...opts, env: {}, secretsPath: secrets({ svc_token: "t" }) }))
      .toEqual({ bind: "127.0.0.1", token: null });
  });
  test("secrets bind activates secrets token", () => {
    expect(resolveRemoteAccess({ ...opts, env: {}, secretsPath: secrets({ svc_bind: "0.0.0.0", svc_token: "t" }) }))
      .toEqual({ bind: "0.0.0.0", token: "t" });
  });
  test("non-loopback bind without a token throws", () => {
    expect(() => resolveRemoteAccess({ ...opts, env: { SVC_BIND: "0.0.0.0" }, secretsPath: secrets({}) }))
      .toThrow(/requires a token/);
  });
  test("env token enforces auth on loopback", () => {
    expect(resolveRemoteAccess({ ...opts, env: { SVC_TOKEN: "e" }, secretsPath: secrets({}) }).token).toBe("e");
  });
});

describe("checkRemoteAuth", () => {
  const req = (path: string, cookie?: string) =>
    new Request("http://h" + path, cookie ? { headers: { cookie } } : undefined);
  test("auth off passes", () => expect(checkRemoteAuth(req("/"), null, "c").ok).toBe(true));
  test("open path passes", () => expect(checkRemoteAuth(req("/health"), "t", "c", ["/health"]).ok).toBe(true));
  test("no credentials rejected", () => expect(checkRemoteAuth(req("/"), "t", "c").ok).toBe(false));
  test("wrong query token rejected", () => expect(checkRemoteAuth(req("/?token=x"), "t", "c").ok).toBe(false));
  test("valid query token sets service-named cookie", () => {
    const r = checkRemoteAuth(req("/?token=t"), "t", "kaya_x");
    expect(r.ok).toBe(true);
    expect(r.setCookie).toStartWith("kaya_x=t;");
  });
  test("cookie accepted only under its own name", () => {
    expect(checkRemoteAuth(req("/", "kaya_x=t"), "t", "kaya_x").ok).toBe(true);
    expect(checkRemoteAuth(req("/", "kaya_board=t"), "t", "kaya_x").ok).toBe(false);
  });
});

test("withRemoteAuth returns 401 and attaches cookie", async () => {
  const h = withRemoteAuth(() => new Response("ok"), "t", "kaya_x");
  expect((await h(new Request("http://h/"))).status).toBe(401);
  const ok = await h(new Request("http://h/?token=t"));
  expect(ok.status).toBe(200);
  expect(ok.headers.get("set-cookie")).toStartWith("kaya_x=t;");
});
