var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// cloudflare/worker.js
var SESSION_COOKIE = "aircon_admin";
var SESSION_SECONDS = 60 * 60 * 8;
var MAX_DATA_BYTES = 1e6;
var MAX_TRANSLATION_LENGTH = 2e3;
var MAX_TRANSLATION_REQUEST_BYTES = 16e3;
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers
    }
  });
}
__name(json, "json");
function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
__name(bytesToBase64Url, "bytesToBase64Url");
function base64UrlToBytes(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
__name(base64UrlToBytes, "base64UrlToBytes");
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))
  );
}
__name(hmac, "hmac");
async function signSession(expiresAt, secret) {
  const payload = bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ expiresAt }))
  );
  const signature = bytesToBase64Url(await hmac(payload, secret));
  return `${payload}.${signature}`;
}
__name(signSession, "signSession");
async function hasAdminSession(request, secret) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match) return false;
  const [payload, signature, extra] = match[1].split(".");
  if (!payload || !signature || extra) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signature),
      new TextEncoder().encode(payload)
    );
    if (!valid) return false;
    const session = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    return Number.isSafeInteger(session.expiresAt) && session.expiresAt > Date.now();
  } catch {
    return false;
  }
}
__name(hasAdminSession, "hasAdminSession");
function hasSameOrigin(request) {
  return request.headers.get("origin") === new URL(request.url).origin;
}
__name(hasSameOrigin, "hasSameOrigin");
function setSessionCookie(value, maxAge) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${maxAge}`;
}
__name(setSessionCookie, "setSessionCookie");
async function login(request, env) {
  if (!hasSameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return json({ error: "Admin authentication is not configured" }, 503);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (typeof body.password !== "string" || body.password.length > 1024) {
    return json({ error: "Invalid password" }, 400);
  }
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.password)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.ADMIN_PASSWORD))
  ]);
  const actualBytes = new Uint8Array(actual);
  const expectedBytes = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < actualBytes.length; i += 1) {
    difference |= actualBytes[i] ^ expectedBytes[i];
  }
  if (difference !== 0) return json({ error: "Incorrect password" }, 401);
  const token = await signSession(Date.now() + SESSION_SECONDS * 1e3, env.SESSION_SECRET);
  return json(
    { authenticated: true },
    200,
    { "set-cookie": setSessionCookie(token, SESSION_SECONDS) }
  );
}
__name(login, "login");
async function translateSellingPoint(request, env) {
  if (!env.SESSION_SECRET || !await hasAdminSession(request, env.SESSION_SECRET)) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!hasSameOrigin(request)) return json({ error: "Forbidden" }, 403);
  if (!env.AI) return json({ error: "Cloudflare Workers AI is not configured" }, 503);
  if (Number(request.headers.get("content-length") || 0) > MAX_TRANSLATION_REQUEST_BYTES) {
    return json({ error: "Translation request is too large" }, 413);
  }
  let body;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_TRANSLATION_REQUEST_BYTES) {
      return json({ error: "Translation request is too large" }, 413);
    }
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object" || typeof body.text !== "string" || !body.text.trim() || body.text.length > MAX_TRANSLATION_LENGTH) {
    return json(
      { error: `Enter English text between 1 and ${MAX_TRANSLATION_LENGTH} characters` },
      400
    );
  }
  try {
    const result = await env.AI.run("@cf/meta/m2m100-1.2b", {
      text: body.text.trim(),
      source_lang: "en",
      target_lang: "zh"
    });
    if (typeof result?.translated_text !== "string" || !result.translated_text.trim()) {
      console.error("[aircon-compare] Workers AI returned an invalid translation response");
      return json({ error: "Translation service returned an invalid response" }, 502);
    }
    return json({ translation: result.translated_text.trim() });
  } catch (error) {
    console.error("[aircon-compare] Selling-point translation failed:", error);
    return json({ error: "Translation failed. Please try again." }, 502);
  }
}
__name(translateSellingPoint, "translateSellingPoint");
async function handleApi(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/data" && request.method === "GET") {
    const row = await env.DB.prepare("SELECT payload FROM site_data WHERE id = 1").first();
    return json(row ? JSON.parse(row.payload) : null);
  }
  if (pathname === "/api/admin/login" && request.method === "POST") {
    return login(request, env);
  }
  if (pathname === "/api/admin/translate" && request.method === "POST") {
    return translateSellingPoint(request, env);
  }
  if (pathname === "/api/admin/logout" && request.method === "POST") {
    if (!hasSameOrigin(request)) return json({ error: "Forbidden" }, 403);
    return json(
      { authenticated: false },
      200,
      { "set-cookie": setSessionCookie("", 0) }
    );
  }
  if (pathname === "/api/admin/data" && request.method === "PUT") {
    if (!env.SESSION_SECRET || !await hasAdminSession(request, env.SESSION_SECRET)) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (!hasSameOrigin(request)) return json({ error: "Forbidden" }, 403);
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_DATA_BYTES) return json({ error: "Data is too large" }, 413);
    let data;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_DATA_BYTES) {
        return json({ error: "Data is too large" }, 413);
      }
      data = JSON.parse(body);
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || !data.models || typeof data.models !== "object" || Array.isArray(data.models) || !data.specData || typeof data.specData !== "object" || Array.isArray(data.specData)) {
      return json({ error: "Expected models and specData objects" }, 400);
    }
    if ("brands" in data && (!Array.isArray(data.brands) || data.brands.some(
      (brand) => !brand || typeof brand !== "object" || typeof brand.b !== "string" || !brand.b.trim() || typeof brand.o !== "string" || typeof brand.sEn !== "string" || typeof brand.sCn !== "string" || typeof brand.kEn !== "string" || typeof brand.kCn !== "string" || typeof brand.c !== "string" || !/^#[0-9a-f]{6}(?:\|#[0-9a-f]{6})?$/i.test(brand.c) || !Number.isFinite(brand.lo) || !Number.isFinite(brand.hi) || ![1, 1.5, 2, 2.5, 3, 4].includes(brand.lo) || ![1, 1.5, 2, 2.5, 3, 4].includes(brand.hi) || brand.lo <= 0 || brand.hi < brand.lo || typeof brand.inv !== "boolean"
    ) || new Set(data.brands.map((brand) => brand.b.toLowerCase())).size !== data.brands.length)) {
      return json({ error: "Expected a valid, unique brands list" }, 400);
    }
    await env.DB.prepare(
      "INSERT INTO site_data (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at"
    ).bind(JSON.stringify(data), (/* @__PURE__ */ new Date()).toISOString()).run();
    return json({ saved: true });
  }
  if (pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
  return null;
}
__name(handleApi, "handleApi");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return env.ASSETS.fetch(new Request(new URL("/aircon.html", url), request));
    }
    const response = await handleApi(request, env);
    if (response) return response;
    return env.ASSETS.fetch(request);
  }
};

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-L4yhT4/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-L4yhT4/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
