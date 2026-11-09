import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRemoteAuth, resolveRemoteAccess, withRemoteAuth } from "./RemoteAccess.ts";
import { SecretError } from "./Secrets.ts";

const savedHome = process.env.KAYA_HOME;
let home: string | null = null;

/** Point KAYA_HOME at a temp dir whose secrets.json holds `content`. */
function secrets(content: Record<string, string> | string): void {
  home = mkdtempSync(join(tmpdir(), "remote-access-"));
  writeFileSync(join(home, "secrets.json"), typeof content === "string" ? content : JSON.stringify(content));
  process.env.KAYA_HOME = home;
}
afterEach(() => {
  if (savedHome === undefined) delete process.env.KAYA_HOME;
  else process.env.KAYA_HOME = savedHome;
  if (home !== null) rmSync(home, { recursive: true, force: true });
  home = null;
});
const opts = { secretPrefix: "svc", bindEnv: "SVC_BIND", tokenEnv: "SVC_TOKEN" };

describe("resolveRemoteAccess", () => {
  test("defaults to loopback with auth off", () => {
    secrets({ svc_token: "t" });
    expect(resolveRemoteAccess({ ...opts, env: {} })).toEqual({
      bind: "127.0.0.1",
      token: null,
    });
  });
  test("secrets bind activates secrets token", () => {
    secrets({ svc_bind: "0.0.0.0", svc_token: "t" });
    expect(resolveRemoteAccess({ ...opts, env: {} })).toEqual({ bind: "0.0.0.0", token: "t" });
  });
  test("non-loopback bind without a token throws", () => {
    secrets({});
    expect(() => resolveRemoteAccess({ ...opts, env: { SVC_BIND: "0.0.0.0" } })).toThrow(/requires a token/);
  });
  test("env token enforces auth on loopback", () => {
    secrets({});
    expect(resolveRemoteAccess({ ...opts, env: { SVC_TOKEN: "e" } }).token).toBe("e");
  });
  test("missing secrets file: loopback with auth off", () => {
    home = mkdtempSync(join(tmpdir(), "remote-access-"));
    process.env.KAYA_HOME = home;
    expect(resolveRemoteAccess({ ...opts, env: {} })).toEqual({ bind: "127.0.0.1", token: null });
  });
  test("malformed secrets file throws SecretError file-malformed with no secret text", () => {
    secrets('{"svc_bind": sk_live_SENTINEL');
    let caught: unknown;
    try {
      resolveRemoteAccess({ ...opts, env: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecretError);
    expect(caught instanceof SecretError ? caught.kind : null).toBe("file-malformed");
    expect(String(caught)).not.toContain("SENTINEL");
  });
  test("env bind skips the secrets file (malformed file not read)", () => {
    secrets("{not json");
    expect(resolveRemoteAccess({ ...opts, env: { SVC_BIND: "127.0.0.1" } })).toEqual({
      bind: "127.0.0.1",
      token: null,
    });
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
