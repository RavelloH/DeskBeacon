import {describe,expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {page} from "../src/auth-page.js";

const auth=readFileSync(new URL("../src/auth.ts",import.meta.url),"utf8");
const setup=readFileSync(new URL("../../client/src/setup-flow.ts",import.meta.url),"utf8");
const callback="http://127.0.0.1:52781/callback";

describe("Device OAuth loopback callback CSP",()=>{
 it("allows the device's random-port HTTP loopback callback without permitting arbitrary HTTP",async()=>{
  const response=page("授权 DeskBeacon",'<form method="post" action="/authorize?client_id=device"><button>授权</button></form>');
  expect(response.status).toBe(200);
  const csp=response.headers.get("content-security-policy")??"";
  const formAction=csp.match(/(?:^|;)\s*form-action\s+([^;]+)/)?.[1]?.trim().split(/\s+/)??[];
  expect(formAction).toContain("'self'");
  expect(formAction).toContain("https:");
  expect(formAction).toContain("http://127.0.0.1:*");
  expect(formAction).not.toContain("http:");
  expect(formAction).not.toContain("*");
  expect(formAction).not.toContain("http://*");
  expect(formAction).not.toContain("http://localhost:*");
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(await response.text()).toContain('method="post"');
  expect(callback.startsWith("http://127.0.0.1:")).toBe(true);
 });
 it("keeps server-side redirect and binds the form submission to the authorization endpoint",()=>{
  expect(auth).toContain('import {htmlEscape, page} from "./auth-page.js"');
  expect(auth).toContain('status: 302, headers: approved.headers');
  expect(auth).toContain('approved.headers.set("location", redirectTo)');
  expect(auth).toContain('status: 302, headers: denied.headers');
  expect(auth).toContain('action="${htmlEscape(`${formActionUrl.pathname}${formActionUrl.search}`)}"');
 });
 it("keeps loopback host fixed and port OS-assigned instead of broadening insecure redirects",()=>{
  expect(setup).toContain("callback.listen(0,'127.0.0.1'");
  expect(setup).toContain("const redirect='http://127.0.0.1:'+addr.port+'/callback'");
  expect(setup).toContain("authorize.searchParams.set('redirect_uri',redirect)");
 });
});
