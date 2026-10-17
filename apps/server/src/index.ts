import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { oauthOptionsFor } from "./auth.js";
import { DeviceSession } from "./device-session.js";
import type { Env } from "./env.js";
export { DeviceSession };
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return new OAuthProvider<Env>(oauthOptionsFor(env)).fetch(request, env, ctx);
  },
};
